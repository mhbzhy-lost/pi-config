import { createServer } from "node:http";
// 仅监听本任务独占 loopback 随机端口；不转发请求、无真实 token。
export async function createProviderCapture({ failFirst = false, stall = false } = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.method === "HEAD") { response.writeHead(503); response.end(); return; }
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, authorization: request.headers.authorization, body: JSON.parse(body) });
    if (failFirst && requests.length === 1) {
      response.writeHead(429, { "Content-Type": "application/json", "retry-after": "0" });
      response.end(JSON.stringify({ error: { message: "fixture rate limit", type: "rate_limit_error" } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream", "x-a7-fixture": "local" });
    response.flushHeaders();
    if (stall) return;
    for (const value of [
      { id: "a7", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "合成响应" }, finish_reason: null }] },
      { id: "a7", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
    ]) response.write(`data: ${JSON.stringify(value)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}
