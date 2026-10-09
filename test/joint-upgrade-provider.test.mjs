import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { resolvePiCodingAgentRoot } from "./helpers/pi-runtime.mjs";
import { resolvePiHostPackageEntry } from "./helpers/pi-host.mjs";
import { createProviderCapture } from "./fixtures/joint-upgrade/provider-capture.mjs";
const api = await import(pathToFileURL(resolvePiHostPackageEntry(resolvePiCodingAgentRoot(), "@earendil-works/pi-ai/compat")));
const modelFor = (baseUrl) => ({ id: "a7-local", name: "A7 local fixture", api: "openai-completions", provider: "openai", baseUrl, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1024, maxTokens: 128 });
const context = { messages: [{ role: "user", content: "合成请求", timestamp: 1 }] };
// 捕捉 compat 请求转换、usage/SSE 或重试丢失；不证明外部 endpoint 能力。
test("目标 public compat 经本地 HTTP 完成 SSE/usage/request metadata 与 429 retry", async () => {
  const fixture = await createProviderCapture({ failFirst: true });
  try {
    const stream = api.stream(modelFor(fixture.baseUrl), context, { apiKey: "a7-synthetic", maxTokens: 32, maxRetries: 1 });
    const events = [];
    for await (const event of stream) events.push(event.type);
    const result = await stream.result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal(result.content[0].text, "合成响应");
    assert.equal(result.usage.totalTokens, 5);
    assert.ok(events.includes("text_delta"));
    assert.equal(events.at(-1), "done");
    assert.equal(fixture.requests.length, 2);
    assert.equal(fixture.requests[0].path, "/v1/chat/completions");
    assert.equal(fixture.requests[0].authorization, "Bearer a7-synthetic");
    assert.equal(fixture.requests[0].body.model, "a7-local");
    assert.equal(fixture.requests[0].body.stream, true);
    assert.deepEqual(context.messages, [{ role: "user", content: "合成请求", timestamp: 1 }]);
  } finally { await fixture.close(); }
});

test("目标 public compat 取消 stalled SSE 返回 aborted 而非成功", async () => {
  const fixture = await createProviderCapture({ stall: true });
  const controller = new AbortController();
  try {
    const stream = api.stream(modelFor(fixture.baseUrl), context, { apiKey: "a7-synthetic", signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      const result = await stream.result();
      assert.equal(result.stopReason, "aborted");
      assert.ok(result.errorMessage);
    } finally { clearTimeout(timer); }
  } finally { await fixture.close(); }
});
