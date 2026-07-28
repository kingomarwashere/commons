import { Hono } from "hono";
import { cors } from "hono/cors";
import { Router } from "./router.js";
export { Router };

const app = new Hono();
app.use("/v1/*", cors());
app.use("/stats", cors());

const MAX_TRIES = 4; // how far the cascade will fall through exhausted/failed pools

function router(env) {
  return env.ROUTER.get(env.ROUTER.idFromName("global"));
}

// ---- OpenAI-compatible surface -------------------------------------------

app.post("/v1/chat/completions", async (c) => {
  const stub = router(c.env);
  let body;
  try { body = await c.req.json(); } catch { return c.json(err("invalid JSON body"), 400); }
  const model = body?.model || null;
  const stream = !!body?.stream;

  // Ask each donor to report usage even when streaming, so metering is exact.
  if (stream) body.stream_options = { ...(body.stream_options || {}), include_usage: true };

  const tried = [];
  let lastErr = "no capacity";

  for (let i = 0; i < MAX_TRIES; i++) {
    const pool = await stub.pick(model, tried);
    if (!pool) break;
    tried.push(pool.id);

    // Built-in "house" donor backed by the Worker's Workers AI binding — no HTTP hop.
    if (pool.base_url === "workers-ai://local") {
      try {
        const r = await c.env.AI.run(model, {
          messages: body.messages, max_tokens: body.max_tokens ?? 512,
        });
        const content = r?.response ?? "";
        const used = (r?.usage?.total_tokens) || estimateTokens(body.messages, content);
        c.executionCtx.waitUntil(stub.recordUsage(pool.id, used, true));
        return houseResponse(content, model, used, stream, pool.name);
      } catch (e) {
        lastErr = `workers-ai: ${e}`;
        await stub.recordUsage(pool.id, 0, false, lastErr);
        continue;
      }
    }

    let upstream;
    try {
      upstream = await fetch(joinUrl(pool.base_url, "/chat/completions"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(pool.api_key ? { authorization: `Bearer ${pool.api_key}` } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      lastErr = `fetch failed: ${e}`;
      await stub.recordUsage(pool.id, 0, false, lastErr);
      continue; // cascade to next donor
    }

    if (!upstream.ok) {
      lastErr = `upstream ${upstream.status}`;
      // 402/429 = donor out of quota/rate-limited → trip unhealthy, cascade on
      await stub.recordUsage(pool.id, 0, false, lastErr);
      continue;
    }

    // ---- success: proxy back, meter tokens ----
    if (stream) {
      const metered = meterStream(upstream.body, (used) =>
        c.executionCtx.waitUntil(stub.recordUsage(pool.id, used, true))
      );
      return new Response(metered, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          "x-commons-pool": pool.name,
        },
      });
    } else {
      const text = await upstream.text();
      const used = extractUsage(text);
      c.executionCtx.waitUntil(stub.recordUsage(pool.id, used, true));
      return new Response(text, {
        headers: { "content-type": "application/json", "x-commons-pool": pool.name },
      });
    }
  }

  return c.json(err(`all donor pools exhausted or unavailable (${lastErr})`), 503);
});

app.get("/v1/models", async (c) => {
  const models = await router(c.env).models();
  return c.json({
    object: "list",
    data: models.map((id) => ({ id, object: "model", owned_by: "commons" })),
  });
});

// ---- donations & stats ----------------------------------------------------

// Register a donated pool: an API key+budget, OR a self-hosted split-model endpoint.
app.post("/donate", async (c) => {
  if (c.env.DONATE_TOKEN && c.req.header("authorization") !== `Bearer ${c.env.DONATE_TOKEN}`)
    return c.json(err("unauthorized"), 401);
  let b;
  try { b = await c.req.json(); } catch { return c.json(err("invalid JSON"), 400); }
  if (!b.name || !b.base_url) return c.json(err("name and base_url required"), 400);
  const res = await router(c.env).register({
    id: b.id,
    name: String(b.name).slice(0, 80),
    kind: b.kind === "endpoint" ? "endpoint" : "api",
    base_url: b.base_url,
    api_key: b.api_key ?? null,
    models: b.models,          // array; omit or ["*"] to serve anything
    weight: Number(b.weight) || 1,
    parallelism: ["expert", "pipeline"].includes(b.parallelism) ? b.parallelism : "none",
    tokens: Math.max(0, (b.tokens | 0)),      // for a brand-new pool
    add_tokens: Math.max(0, (b.add_tokens | 0)), // top up an existing pool
  });
  return c.json({ ok: true, ...res });
});

app.get("/stats", async (c) => c.json(await router(c.env).stats()));

// ---- admin ----------------------------------------------------------------

app.use("/admin/*", async (c, next) => {
  if (c.req.header("authorization") !== `Bearer ${c.env.ADMIN_TOKEN}`)
    return c.json(err("unauthorized"), 401);
  await next();
});
app.get("/admin/pools", async (c) => c.json({ pools: await router(c.env).listPools() }));
app.post("/admin/pools/:id/enable", async (c) => {
  await router(c.env).setEnabled(c.req.param("id"), true); return c.json({ ok: true });
});
app.post("/admin/pools/:id/disable", async (c) => {
  await router(c.env).setEnabled(c.req.param("id"), false); return c.json({ ok: true });
});
app.post("/admin/pools/:id/heal", async (c) => {
  await router(c.env).setHealthy(c.req.param("id"), true); return c.json({ ok: true });
});
app.delete("/admin/pools/:id", async (c) => {
  await router(c.env).remove(c.req.param("id")); return c.json({ ok: true });
});

export default app;

// ---- helpers --------------------------------------------------------------

function err(message) { return { error: { message, type: "commons_error" } }; }
function joinUrl(base, path) { return base.replace(/\/+$/, "") + path; }

function estimateTokens(messages, content) {
  const chars = (messages || []).reduce((n, m) => n + String(m.content || "").length, 0) + content.length;
  return Math.ceil(chars / 4); // rough fallback when the backend omits usage
}

// Wrap a plain completion string in OpenAI chat.completion shape (stream or not).
function houseResponse(content, model, used, stream, poolName) {
  const hdr = { "x-commons-pool": poolName };
  if (!stream) {
    return Response.json({
      id: "cmpl-" + crypto.randomUUID(), object: "chat.completion", model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { total_tokens: used },
    }, { headers: hdr });
  }
  const id = "cmpl-" + crypto.randomUUID();
  const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
  const body = sse({ id, object: "chat.completion.chunk", model,
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })
    + sse({ id, object: "chat.completion.chunk", model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { total_tokens: used } })
    + "data: [DONE]\n\n";
  return new Response(body, { headers: { ...hdr, "content-type": "text/event-stream; charset=utf-8" } });
}

// Pull usage.total_tokens out of a non-streaming JSON response.
function extractUsage(text) {
  try { return JSON.parse(text)?.usage?.total_tokens | 0; } catch { return 0; }
}

// Pass an SSE stream straight through while sniffing the final usage chunk.
function meterStream(body, onDone) {
  let buf = "";
  let used = 0;
  const dec = new TextDecoder();
  const transform = new TransformStream({
    transform(chunk, ctrl) {
      ctrl.enqueue(chunk);
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (data && data !== "[DONE]") {
            try {
              const j = JSON.parse(data);
              if (j?.usage?.total_tokens) used = j.usage.total_tokens | 0;
            } catch { /* partial/non-JSON keepalive */ }
          }
        }
      }
    },
    flush() { onDone(used); },
  });
  return body.pipeThrough(transform);
}
