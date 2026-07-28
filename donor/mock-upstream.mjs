// Two fake OpenAI-compatible donors for testing the cascade.
//   :9101  -> always 402 (out of quota)  → gateway must skip it
//   :9102  -> succeeds, reports usage.total_tokens=42
import { createServer } from "node:http";
function donor(port, handler) {
  createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => handler(req, res, b));
  }).listen(port, () => console.log("mock donor on :" + port));
}
donor(9101, (_q, res) => { res.writeHead(402).end(JSON.stringify({ error: "no quota" })); });
donor(9102, (_q, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: "x", object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 32, total_tokens: 42 },
  }));
});
