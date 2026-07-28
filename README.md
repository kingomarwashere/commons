# Radical Commons

Shared AI-compute commons: pool **donated tokens** and **split-model GPU pools** behind one
OpenAI-compatible endpoint, with **weighted round-robin cascade** — as each donor's budget
drains, load shifts to the others; exhausted or failing pools are skipped automatically.

## Two layers (this is the whole idea)

```
   client ──▶ GATEWAY (Worker + Router DO)  ──weighted round-robin/cascade──▶ POOLS
                                                                              │
   within each pool the MODEL is SPLIT across machines (exo / mesh-llm) ──────┘
   so no single computer holds the whole model. LAN traffic stays local;
   only whole requests cross the internet, dodging per-token WAN latency.
```

- **Between pools** → gateway cascades (weighted by each pool's remaining donated tokens).
- **Within a pool** → the model is distributed across the donor's boxes.

**Live:** https://commons.theradicalparty.com — seeded with built-in "house" pools
backed by the Worker's Workers AI binding (Llama 3.3 70B, Llama 4 Scout, Qwen 2.5 Coder),
so the commons serves real inference out of the box. A donor with `base_url: "workers-ai://local"`
is served through the AI binding instead of an HTTP hop.

## Gateway (Cloudflare)

```bash
npm install
wrangler secret put ADMIN_TOKEN      # required
wrangler secret put DONATE_TOKEN      # optional: gate /donate
npm run deploy
```

Route `commons.theradicalparty.com` to the Worker (add a custom domain in the CF dashboard
or a route in `wrangler.jsonc`).

### API
| Method | Path | Notes |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI-compatible, streaming + non-streaming |
| GET | `/v1/models` | distinct models across live pools |
| POST | `/donate` | register / top up a pool |
| GET | `/stats` | public aggregate (no secrets) |
| GET/POST/DELETE | `/admin/pools[/:id/...]` | Bearer `ADMIN_TOKEN` |

### Donate an **API key** (whole-model, works instantly)
```bash
curl $COMMONS/donate -H 'content-type: application/json' -d '{
  "name":"deepseek-credit","kind":"api",
  "base_url":"https://api.deepseek.com/v1","api_key":"sk-...",
  "models":["deepseek-chat"],"tokens":2000000,"weight":1}'
```

### Donate a **split-model pool** (the real thing)
Run `donor/run-pool.sh` on your box(es) — it starts exo/mesh-llm/ollama, opens a Cloudflare
tunnel, and self-registers:
```bash
COMMONS=https://commons.theradicalparty.com \
MODE=exo MODEL=deepseek-v3 TOKENS=5000000 NAME=maverick-macs ./donor/run-pool.sh
```

## Metering & trust (v1 honesty model)
- Tokens are counted from each response's real `usage` (streaming forces
  `stream_options.include_usage`), **not** donor self-report.
- Donor keys/endpoints stay server-side; clients never see them.
- A pool that errors/rate-limits is tripped unhealthy and skipped; re-enable via
  `/admin/pools/:id/heal`.
- **Not yet:** cryptographic proof a remote pool actually ran the compute
  (see Prime Intellect's TOPLOC) — fine for a trusted donor circle; add before opening to strangers.

## Roadmap
- [ ] TOPLOC-style verification for untrusted pools
- [ ] Per-donor dashboards + attribution
- [ ] MoE-aware routing (prefer expert-parallel pools for DeepSeek/Qwen over WAN)
- [ ] Optional D1 mirror of the ledger for long-term analytics
