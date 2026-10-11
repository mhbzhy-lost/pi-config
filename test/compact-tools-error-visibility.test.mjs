import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { loadPiTestRuntime } from "./helpers/pi-runtime.mjs";
import { createCompactToolRenderers, sampleArgs } from "../src/compact-tools/renderer.ts";

const { codingAgent: sdk, piTui: tui, jiti } = await loadPiTestRuntime(import.meta.url);
sdk.initTheme("dark", false);
const compactFactory = (await jiti.import("../pi/extensions/compact-tools.ts")).default;
const resolvers = [];
const api = { registerToolRenderer(resolver) { resolvers.push(resolver); }, on() {} };
// 仅绑定显示 resolver，不初始化 bash 执行 owner、设置存储或 Host session。
compactFactory(api);
const shared = createCompactToolRenderers(tui);
const host = Object.fromEntries(Object.keys(sampleArgs).map((name) => [name, resolvers[0](name, () => undefined)]));
const theme = { bold: (text) => text, fg: (_color, text) => text };
const plain = (lines) => stripVTControlCharacters(lines.join("\n"));
const errorMessage = "Upstream response stream was interrupted";
const cases = [
  ...Object.entries(sampleArgs).map(([name, args]) => ({ label: name, name, args })),
  { label: "skill read", name: "read", args: { path: "/tmp/test-driven-development/SKILL.md" } },
];
const summary = { read: "2 lines", bash: "2 lines", edit: "done", write: "done", find: "2 matches", grep: "2 matches", ls: "2 entries" };

function context(args, isError) {
  return { args, isError, state: {}, expanded: false, isPartial: false, toolCallId: "fixture-call",
    cwd: "/tmp", executionStarted: true, argsComplete: true, showImages: false,
    lastComponent: undefined, invalidate() {} };
}

// 直接结果只含 content/details，捕获误依赖 result.isError 及入口二次折叠。
for (const [source, renderers] of Object.entries({ shared, host })) {
  for (const { label, name, args } of cases) {
    test(`${source} ${label}: context错误可见且成功→失败→成功不残留摘要`, () => {
      const renderer = renderers[name];
      const ctx = context(args, false);
      const success = { content: [{ type: "text", text: "first\nsecond" }], details: { nested: { values: [1, 2] } } };
      const failure = { content: [{ type: "text", text: errorMessage }], details: { nested: { values: [3] } } };
      const before = structuredClone({ success, failure, args });
      for (const [result, failed] of [[success, false], [failure, true], [success, false]]) {
        ctx.isError = failed;
        const call = renderer.renderCall(args, theme, ctx);
        const output = renderer.renderResult(result, { expanded: false, isPartial: false }, theme, ctx);
        const lines = [...call.render(100), ...output.render(100)].filter((line) => line.trim());
        const visible = plain(lines);
        if (failed) {
          assert.match(visible, /✗/);
          assert.match(visible, /Upstream response stream was interrupted/);
          assert.doesNotMatch(visible, /done/);
        } else {
          assert.equal(lines.length, 1, visible);
          assert.doesNotMatch(visible, /✗|失败|interrupted/);
          if (label !== "skill read") assert.ok(visible.trimEnd().endsWith(` · ${summary[name]}`), visible);
        }
      }
      assert.deepEqual({ success, failure, args }, before);
      assert.equal(ctx.args, args);
    });

    test(`${source} ${label}: 中文ANSI错误按物理行限高且展开/invalidate保留原文`, () => {
      const text = `\u001b[31m权限拒绝\u001b[0m\n${"中文宽字符".repeat(35)}\n第三行\n第四行\n第五行\n最后错误`;
      const result = { content: [{ type: "text", text }], details: { source: "fixture", nested: [1, 2] } };
      const before = structuredClone(result);
      const ctx = context(args, true);
      const collapsed = renderers[name].renderResult(result, { expanded: false, isPartial: false }, theme, ctx);
      for (const width of [40, 100]) {
        const lines = collapsed.render(width);
        assert.equal(lines.length, 4, JSON.stringify(lines));
        assert.ok(lines.every((line) => tui.visibleWidth(line) <= width));
        assert.match(plain(lines), /✗ 权限拒绝/);
        assert.match(plain(lines), /展开查看完整错误/);
        collapsed.invalidate();
        assert.deepEqual(collapsed.render(width), lines);
        const expanded = renderers[name].renderResult(result, { expanded: true, isPartial: false }, theme, { ...ctx, expanded: true });
        const full = expanded.render(width);
        assert.match(plain(full), /最后错误/);
        assert.ok(full.every((line) => tui.visibleWidth(line) <= width));
      }
      assert.deepEqual(result, before);
    });
  }
}

test("真实assistant toolCall-only error由实际Host工具卡显示具体原因", () => {
  const message = { role: "assistant", content: [{ type: "toolCall", id: "fixture-call", name: "bash", arguments: { command: "fixture-only" } }],
    stopReason: "error", errorMessage, timestamp: 1, api: "openai-completions", provider: "fixture", model: "fixture",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const before = structuredClone(message);
  const assistant = new sdk.AssistantMessageComponent(message, false);
  const card = new sdk.ToolExecutionComponent("bash", "fixture-call", message.content[0].arguments,
    { showImages: false }, host.bash, { requestRender() {} }, "/tmp");
  // 与官方interactive pending-tool错误投影一致；不执行工具或启动模型。
  const result = { content: [{ type: "text", text: errorMessage }], details: undefined, isError: true };
  const raw = structuredClone(result);
  card.updateResult(result);
  assert.equal(plain(assistant.render(100)), "");
  const visible = plain([...assistant.render(100), ...card.render(100)]);
  assert.match(visible, /✗/);
  assert.match(visible, /Upstream response stream was interrupted/);
  assert.deepEqual(message, before);
  assert.deepEqual(result, raw);
});

for (const { label, name, args } of cases) {
  test(`真实Host ${label}: 展开收起/invalidate和success-error-success保持raw数据`, () => {
    const card = new sdk.ToolExecutionComponent(name, "fixture-call", args,
      { showImages: false }, host[name], { requestRender() {} }, "/tmp");
    const success = { content: [{ type: "text", text: "first\nsecond" }, { type: "image", data: "fixture-image", mimeType: "image/png" }], details: { nested: [1] }, structuredContent: { ok: true }, isError: false };
    const failure = { content: [{ type: "text", text: "权限拒绝\nwrite conflict\n第三行\n第四行\n最后错误" }], details: { nested: [2] }, structuredContent: { ok: false }, isError: true };
    const before = structuredClone({ success, failure, args });
    const references = [success.content, success.details, success.structuredContent, failure.content, failure.details, failure.structuredContent, success.content[1]];
    card.updateResult(success);
    assert.equal(card.render(100).filter((line) => line.trim()).length, 1);
    card.updateResult(failure);
    for (const width of [40, 100]) {
      for (const expanded of [false, true, false]) {
        card.setExpanded(expanded);
        card.invalidate();
        const lines = card.render(width);
        assert.ok(lines.every((line) => tui.visibleWidth(line) <= width));
        assert.match(plain(lines), /权限拒绝/);
        assert.doesNotMatch(plain(lines), /done/);
        if (expanded) assert.match(plain(lines), /最后错误/);
        else assert.match(plain(lines), /✗/);
      }
    }
    card.updateResult(success);
    card.invalidate();
    const visible = card.render(100).filter((line) => line.trim());
    assert.equal(visible.length, 1);
    assert.doesNotMatch(plain(visible), /✗|失败|权限拒绝/);
    assert.deepEqual({ success, failure, args }, before);
    [success.content, success.details, success.structuredContent, failure.content, failure.details, failure.structuredContent, success.content[1]]
      .forEach((value, index) => assert.equal(value, references[index]));
  });
}

for (const [source, renderers] of Object.entries({ shared, host })) {
  test(`${source}: 单逻辑行错误先换行再按四物理行截断`, () => {
    const text = `原因：${"中文".repeat(20)}结束`;
    const result = { content: [{ type: "text", text }], details: undefined };
    const output = renderers.bash.renderResult(result, { expanded: false, isPartial: false }, theme, context(sampleArgs.bash, true));
    const lines = output.render(40);
    assert.ok(lines.length > 1 && lines.length <= 4);
    assert.ok(lines.every((line) => tui.visibleWidth(line) <= 40));
    assert.ok(plain(lines).replace(/\s/g, "").includes(text));
  });

  test(`${source}: 错误组件invalidate后使用当前主题颜色`, () => {
    let color = "\u001b[31m";
    const changingTheme = { ...theme, fg: (_token, text) => `${color}${text}\u001b[0m` };
    const result = { content: [{ type: "text", text: "permission denied" }], details: undefined };
    const output = renderers.bash.renderResult(result, { expanded: false, isPartial: false }, changingTheme, context(sampleArgs.bash, true));
    assert.ok(output.render(100).join("\n").includes("\u001b[31m"));
    color = "\u001b[32m";
    output.invalidate();
    const next = output.render(100).join("\n");
    assert.ok(next.includes("\u001b[32m"));
    assert.ok(!next.includes("\u001b[31m"));
    assert.match(stripVTControlCharacters(next), /✗ permission denied/);
  });

  test(`${source}: 空错误仍可见，直接result.isError调用兼容`, () => {
    for (const text of ["", "   ", "explicit failure"]) {
      for (const { name, args } of cases) {
        for (const direct of [false, true]) {
          const result = { content: [{ type: "text", text }], details: undefined, ...(direct ? { isError: true } : {}) };
          const before = structuredClone(result);
          const ctx = { ...context(args, true), isError: direct ? undefined : true };
          const output = renderers[name].renderResult(result, { expanded: false, isPartial: false }, theme, ctx);
          const visible = plain(output.render(40));
          assert.match(visible, /✗/);
          assert.match(visible, text.trim() ? /explicit failure/ : /工具执行失败/);
          assert.deepEqual(result, before);
        }
      }
    }
  });
}
