// Router — a single global Durable Object that is the authoritative ledger for
// all donor pools. Because one DO instance serializes every call, quota
// decrements are atomic with no double-spend races (which a plain D1 UPDATE
// can't guarantee under concurrency).
import { DurableObject } from "cloudflare:workers";

export class Router extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS pools (
          id             TEXT PRIMARY KEY,
          name           TEXT NOT NULL,
          kind           TEXT NOT NULL,            -- 'api' | 'endpoint'
          base_url       TEXT NOT NULL,            -- OpenAI-compatible base, e.g. https://api.deepseek.com/v1
          api_key        TEXT,                     -- server-side only, never returned to clients
          models         TEXT NOT NULL DEFAULT '["*"]',
          weight         REAL NOT NULL DEFAULT 1,  -- donor priority multiplier
          parallelism    TEXT NOT NULL DEFAULT 'none', -- 'expert'|'pipeline'|'none'
          tokens_donated INTEGER NOT NULL DEFAULT 0,
          tokens_used    INTEGER NOT NULL DEFAULT 0,
          requests       INTEGER NOT NULL DEFAULT 0,
          errors         INTEGER NOT NULL DEFAULT 0,
          healthy        INTEGER NOT NULL DEFAULT 1,
          enabled        INTEGER NOT NULL DEFAULT 1,
          last_error     TEXT,
          last_seen      INTEGER NOT NULL DEFAULT 0,
          created        INTEGER NOT NULL DEFAULT 0
        );
      `);
      // defensive: add column if upgrading from a pre-parallelism ledger
      try { this.sql.exec(`ALTER TABLE pools ADD COLUMN parallelism TEXT NOT NULL DEFAULT 'none'`); }
      catch { /* already exists */ }
    });
  }

  // MoE families distribute well over WAN (a token only visits its chosen experts),
  // so we prefer expert-parallel pools for them. Dense models are latency-bound and
  // stay best on whole-model / LAN pools.
  _isMoE(model) {
    if (!model) return false;
    const m = model.toLowerCase();
    return /deepseek|qwen.*(moe|3)|mixtral|mixture|kimi|glm-4\.?[5-9]|minimax/.test(m);
  }

  _rows(cursor) { return cursor.toArray(); }

  register(p) {
    const now = Date.now();
    const id = p.id || crypto.randomUUID();
    const models = JSON.stringify(
      Array.isArray(p.models) && p.models.length ? p.models : ["*"]
    );
    const existing = this.sql.exec(`SELECT id FROM pools WHERE id=?`, id).toArray()[0];
    if (existing) {
      this.sql.exec(
        `UPDATE pools SET name=?, kind=?, base_url=?, api_key=COALESCE(?,api_key),
           models=?, weight=?, parallelism=?, tokens_donated=tokens_donated+?, last_seen=?, healthy=1 WHERE id=?`,
        p.name, p.kind, p.base_url, p.api_key ?? null, models,
        p.weight ?? 1, p.parallelism ?? "none", p.add_tokens ?? 0, now, id
      );
    } else {
      this.sql.exec(
        `INSERT INTO pools (id,name,kind,base_url,api_key,models,weight,parallelism,tokens_donated,last_seen,created)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        id, p.name, p.kind, p.base_url, p.api_key ?? null, models,
        p.weight ?? 1, p.parallelism ?? "none", p.tokens ?? 0, now, now
      );
    }
    return { id };
  }

  // Weighted-round-robin selection among eligible pools.
  // Eligible = enabled, healthy, remaining>0, and serves `model` (or advertises "*").
  pick(model, exclude = []) {
    const ex = new Set(exclude);
    const rows = this.sql.exec(
      `SELECT * FROM pools WHERE enabled=1 AND healthy=1 AND (tokens_donated-tokens_used)>0`
    ).toArray();
    const eligible = rows.filter((r) => {
      if (ex.has(r.id)) return false;
      let ms;
      try { ms = JSON.parse(r.models); } catch { ms = ["*"]; }
      return ms.includes("*") || (model && ms.includes(model));
    });
    if (!eligible.length) return null;

    // weight = donor weight × remaining donated tokens  → busy/near-empty pools bleed off gradually.
    // MoE-aware bias: for MoE models, favour expert-parallel pools (2×); penalise pipeline pools
    // reaching over WAN (0.5×) since sequential layer hops there are latency-bound.
    const moe = this._isMoE(model);
    const weighted = eligible.map((r) => {
      let bias = 1;
      if (moe && r.parallelism === "expert") bias = 2;
      else if (moe && r.parallelism === "pipeline") bias = 0.5;
      return { r, w: bias * Math.max(0, r.weight) * (r.tokens_donated - r.tokens_used) };
    });
    const total = weighted.reduce((s, x) => s + x.w, 0);
    if (total <= 0) return null;
    let roll = Math.random() * total;
    for (const x of weighted) {
      roll -= x.w;
      if (roll <= 0) return x.r;
    }
    return weighted[weighted.length - 1].r;
  }

  recordUsage(id, tokensUsed, ok, errMsg) {
    const now = Date.now();
    if (ok) {
      this.sql.exec(
        `UPDATE pools SET tokens_used=tokens_used+?, requests=requests+1, last_seen=?, healthy=1 WHERE id=?`,
        Math.max(0, tokensUsed | 0), now, id
      );
    } else {
      // trip the pool unhealthy on error so the cascade skips it until it recovers
      this.sql.exec(
        `UPDATE pools SET errors=errors+1, last_error=?, last_seen=?, healthy=0 WHERE id=?`,
        String(errMsg || "error").slice(0, 300), now, id
      );
    }
  }

  setHealthy(id, healthy) {
    this.sql.exec(`UPDATE pools SET healthy=? WHERE id=?`, healthy ? 1 : 0, id);
  }
  setEnabled(id, enabled) {
    this.sql.exec(`UPDATE pools SET enabled=? WHERE id=?`, enabled ? 1 : 0, id);
  }
  remove(id) { this.sql.exec(`DELETE FROM pools WHERE id=?`, id); }

  // Admin view — secrets redacted to a boolean.
  listPools() {
    return this.sql.exec(`SELECT * FROM pools ORDER BY created`).toArray().map((r) => ({
      ...r,
      api_key: r.api_key ? "set" : null,
      models: safeParse(r.models),
      remaining: r.tokens_donated - r.tokens_used,
    }));
  }

  // Distinct advertised models across healthy, non-empty pools (for /v1/models).
  models() {
    const rows = this.sql.exec(
      `SELECT models FROM pools WHERE enabled=1 AND healthy=1 AND (tokens_donated-tokens_used)>0`
    ).toArray();
    const set = new Set();
    for (const r of rows) for (const m of safeParse(r.models)) if (m !== "*") set.add(m);
    return [...set];
  }

  // Public aggregate — no secrets, safe to expose on the landing page.
  stats() {
    const a = this.sql.exec(`
      SELECT COUNT(*) pools,
             SUM(enabled=1 AND healthy=1) healthy,
             SUM(tokens_donated) donated,
             SUM(tokens_used) used,
             SUM(requests) requests
      FROM pools`).toArray()[0] || {};
    const donated = a.donated || 0, used = a.used || 0;
    return {
      pools: a.pools || 0,
      healthy: a.healthy || 0,
      tokens_donated: donated,
      tokens_used: used,
      tokens_remaining: Math.max(0, donated - used),
      requests: a.requests || 0,
    };
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return ["*"]; } }
