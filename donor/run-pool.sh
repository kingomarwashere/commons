#!/usr/bin/env bash
# run-pool.sh — bring up a donated pool and register it with Radical Commons.
#
# A "pool" is one OpenAI-compatible endpoint. It can be:
#   exo   — a model SPLIT across several of YOUR boxes over LAN (no single
#           machine holds the whole model — this is the real distribution).
#   mesh  — Mesh LLM: split across LAN or internet peers via iroh/QUIC.
#   ollama— a whole model on one box (simplest; good for API-style donation).
#
# Inter-machine model traffic stays on the pool's fast LAN; only whole requests
# cross the internet to the gateway — so you never pay the per-token WAN latency.
#
# Usage:
#   COMMONS=https://commons.theradicalparty.com \
#   MODE=exo MODEL=deepseek-v3 TOKENS=5000000 NAME=maverick-macs \
#   ./run-pool.sh
set -euo pipefail

COMMONS="${COMMONS:-https://commons.theradicalparty.com}"
MODE="${MODE:-ollama}"
MODEL="${MODEL:-qwen3}"
TOKENS="${TOKENS:-1000000}"
NAME="${NAME:-$(hostname -s)-pool}"
PORT="${PORT:-8000}"
WEIGHT="${WEIGHT:-1}"
# 'expert' if this pool splits an MoE model across peers (exo/mesh MoE),
# 'pipeline' if it splits a dense model by layers, else 'none'.
PARALLELISM="${PARALLELISM:-none}"

echo "▸ Starting local OpenAI-compatible server (mode=$MODE, model=$MODEL) on :$PORT"
case "$MODE" in
  exo)
    # Cluster: run this on EACH of your machines; exo auto-discovers peers on the
    # LAN and splits $MODEL across them. It exposes an OpenAI API on the head node.
    command -v exo >/dev/null || { echo "install exo: https://github.com/exo-explore/exo"; exit 1; }
    exo --inference-engine mlx --chatgpt-api-port "$PORT" >/tmp/exo.log 2>&1 &
    ;;
  mesh)
    # Mesh LLM: 18MB binary, splits $MODEL across LAN/internet peers via iroh.
    command -v mesh-llm >/dev/null || { echo "install mesh-llm: github.com/michaelneale/decentralized-inference"; exit 1; }
    mesh-llm serve --model "$MODEL" --openai-port "$PORT" >/tmp/mesh.log 2>&1 &
    ;;
  ollama)
    command -v ollama >/dev/null || { echo "install ollama: https://ollama.com"; exit 1; }
    ollama serve >/tmp/ollama.log 2>&1 & sleep 2
    ollama pull "$MODEL"
    PORT=11434   # ollama's fixed OpenAI-compatible port (/v1)
    ;;
  *) echo "unknown MODE=$MODE (exo|mesh|ollama)"; exit 1 ;;
esac

sleep 3
echo "▸ Publishing local endpoint via Cloudflare quick tunnel"
command -v cloudflared >/dev/null || { echo "install cloudflared"; exit 1; }
cloudflared tunnel --url "http://localhost:$PORT" >/tmp/cf-tunnel.log 2>&1 &
# scrape the assigned trycloudflare URL
for i in $(seq 1 20); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/cf-tunnel.log | head -1 || true)
  [ -n "${URL:-}" ] && break; sleep 1
done
[ -z "${URL:-}" ] && { echo "tunnel URL not found; see /tmp/cf-tunnel.log"; exit 1; }
echo "▸ Public base_url: $URL/v1"

echo "▸ Registering pool with $COMMONS"
curl -fsS "$COMMONS/donate" -H "content-type: application/json" \
  ${DONATE_TOKEN:+-H "authorization: Bearer $DONATE_TOKEN"} \
  -d "$(cat <<JSON
{"name":"$NAME","kind":"endpoint","base_url":"$URL/v1",
 "models":["$MODEL"],"tokens":$TOKENS,"weight":$WEIGHT,"parallelism":"$PARALLELISM"}
JSON
)"
echo
echo "✓ Pool '$NAME' donated $TOKENS tokens of '$MODEL'. Leave this running; Ctrl-C to stop."
wait
