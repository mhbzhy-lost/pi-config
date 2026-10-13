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
// apply_patch/bash_async 不在 sampleArgs（全局循环以七工具一行摘要为前提），单独绑定同一 resolver。
const host = Object.fromEntries([...Object.keys(sampleArgs), "apply_patch", "bash_async"].map((name) => [name, resolvers[0](name, () => undefined)]));
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

test("真实Host apply_patch: 折叠展开均工具名+完整A/M/D列表，长路径按列宽换行且raw不变", () => {
  const args = { patch: "*** Begin Patch\n*** Add File: docs/长路径.md\n+内容\n*** End Patch" };
  const longPath = `docs/very-long-${"路径".repeat(40)}.md`;
  const success = {
    content: [{ type: "text", text: `A ${longPath}\nM test/b.ts\nD old/c.txt` }],
    details: { added: [longPath], modified: ["test/b.ts"], deleted: ["old/c.txt"] },
    structuredContent: { added: [longPath], modified: ["test/b.ts"], deleted: ["old/c.txt"] },
    isError: false,
  };
  const before = structuredClone({ success, args });
  const references = [success.content, success.details, success.structuredContent, success.content[0]];
  const card = new sdk.ToolExecutionComponent("apply_patch", "fixture-apply", args,
    { showImages: false }, host.apply_patch, { requestRender() {} }, "/tmp");
  card.updateResult(success);
  for (const expanded of [false, true, false]) {
    card.setExpanded(expanded);
    card.invalidate();
    const lines = card.render(60);
    const visible = plain(lines);
    assert.ok(lines.every((line) => tui.visibleWidth(line) <= 60), JSON.stringify(lines));
    assert.match(visible, /apply_patch/);
    assert.match(visible, /M test\/b\.ts/);
    assert.match(visible, /D old\/c\.txt/);
    assert.doesNotMatch(visible, /Begin Patch|内容|done/);
    // 长路径换行后逐行拼接仍完整可见，列表条数不被截断。
    const joined = lines.map((line) => plain([line]).trim()).join("");
    assert.ok(joined.includes(longPath), JSON.stringify(lines));
    assert.ok(lines.filter((line) => line.trim()).length >= 5, JSON.stringify(lines));
  }
  assert.deepEqual({ success, args }, before);
  [success.content, success.details, success.structuredContent, success.content[0]]
    .forEach((value, index) => assert.equal(value, references[index]));
});

test("真实Host bash_async: launch折叠已接受待完成+展开完整身份，raw与引用不变", () => {
  const args = { command: "sleep 5", cwd: "/tmp", timeout: 15 };
  const receipt = {
    kind: "bash-async-launch", jobId: "aabbccdd-1234", toolCallId: "fixture-async",
    sessionId: "fixture-session", generation: 1, branchEpoch: 0, command: "sleep 5", cwd: "/tmp",
    acceptedAt: "2026-10-13T00:00:00.000Z",
  };
  const result = { content: [{ type: "text", text: JSON.stringify(receipt) }], details: receipt, isError: false };
  const before = structuredClone({ args, result });
  const references = [result.content, result.details, result.content[0]];
  const card = new sdk.ToolExecutionComponent("bash_async", "fixture-async", args,
    { showImages: false }, host.bash_async, { requestRender() {} }, "/tmp");
  card.updateResult(result);
  for (const expanded of [false, true, false]) {
    card.setExpanded(expanded);
    card.invalidate();
    const lines = card.render(100);
    const visible = plain(lines);
    assert.match(visible, /bash_async/);
    assert.doesNotMatch(visible, /succeeded|已完成/);
    if (expanded) {
      // 展开显示完整身份（receipt JSON 原文，由 Text 按列宽换行）。
      assert.match(visible, /aabbccdd-1234/);
      assert.match(visible, /acceptedAt/);
    } else {
      // 折叠摘要只表达接受语义，不泄露内部字段。
      assert.match(visible, /已接受，待完成 \(aabbccdd\)/);
      assert.doesNotMatch(visible, /sessionId|branchEpoch|acceptedAt/);
    }
  }
  assert.deepEqual({ args, result }, before);
  references.forEach((value, index) => assert.equal(value, [result.content, result.details, result.content[0]][index]));
});

test("真实Host bash_async: 失败原因可见、旧接受摘要清理且raw不变", () => {
  const args = { command: "sleep 5", cwd: "/tmp", timeout: 15 };
  const receipt = { kind: "bash-async-launch", jobId: "aabbccdd-1234", toolCallId: "fixture-async-error", command: "sleep 5", cwd: "/tmp", acceptedAt: "t" };
  const launch = { content: [{ type: "text", text: JSON.stringify(receipt) }], details: receipt, isError: false };
  const failure = { content: [{ type: "text", text: "权限拒绝\nwrite conflict\n第三行\n第四行\n最后错误" }], details: undefined, isError: true };
  const before = structuredClone({ args, launch, failure });
  const references = [launch.content, launch.details, failure.content, failure.details];
  const card = new sdk.ToolExecutionComponent("bash_async", "fixture-async-error", args,
    { showImages: false }, host.bash_async, { requestRender() {} }, "/tmp");
  card.updateResult(launch);
  card.updateResult(failure);
  for (const expanded of [false, true, false]) {
    card.setExpanded(expanded);
    card.invalidate();
    const lines = card.render(100);
    const visible = plain(lines);
    assert.ok(lines.every((line) => tui.visibleWidth(line) <= 100), JSON.stringify(lines));
    assert.match(visible, /权限拒绝/);
    assert.doesNotMatch(visible, /已接受/);
    if (expanded) assert.match(visible, /最后错误/);
    else assert.match(visible, /✗/);
  }
  // 切回合法 launch 后恢复接受摘要，不残留错误。
  card.updateResult(launch);
  card.invalidate();
  const visible = plain(card.render(100));
  assert.match(visible, /已接受，待完成 \(aabbccdd\)/);
  assert.doesNotMatch(visible, /✗|权限拒绝/);
  assert.deepEqual({ args, launch, failure }, before);
  references.forEach((value, index) => assert.equal(value, [launch.content, launch.details, failure.content, failure.details][index]));
});

test("真实Host bash_async: partial不提前已接受，unknown格式中性显示且直接isError兼容", () => {
  const args = { command: "sleep 5" };
  const receipt = { kind: "bash-async-launch", jobId: "aabbccdd-1234", toolCallId: "fixture-async-partial", command: "sleep 5", cwd: "/tmp", acceptedAt: "t" };
  const partialLaunch = { content: [{ type: "text", text: JSON.stringify(receipt) }], details: receipt };
  const unknown = { content: [{ type: "text", text: "{\"unexpected\":true}" }], details: { unexpected: true } };
  const before = structuredClone({ args, partialLaunch, unknown });
  const card = new sdk.ToolExecutionComponent("bash_async", "fixture-async-partial", args,
    { showImages: false }, host.bash_async, { requestRender() {} }, "/tmp");
  card.updateResult(partialLaunch, true);
  let visible = plain(card.render(120));
  assert.doesNotMatch(visible, /已接受/);
  // 中性显示原文（receipt JSON），不提前接受。
  assert.match(visible, /bash-async-launch/);
  card.updateResult(unknown);
  visible = plain(card.render(120));
  assert.match(visible, /unexpected/);
  assert.doesNotMatch(visible, /已接受|succeeded|done|1 lines/);
  // 直接result.isError调用兼容（无context.isError）。
  const direct = { content: [{ type: "text", text: "explicit failure" }], details: undefined, isError: true };
  const directOutput = host.bash_async.renderResult(direct, { expanded: false, isPartial: false }, theme, context(args, undefined));
  assert.match(plain(directOutput.render(100)), /✗ explicit failure/);
  assert.deepEqual(direct, { content: [{ type: "text", text: "explicit failure" }], details: undefined, isError: true });
  assert.deepEqual({ args, partialLaunch, unknown }, before);
});

test("真实Host apply_patch: 失败原因可见、展开保留完整错误，切回成功不残留错误", () => {
  const args = { patch: "*** Begin Patch\n*** Delete File: missing.txt\n*** End Patch" };
  const card = new sdk.ToolExecutionComponent("apply_patch", "fixture-apply-error", args,
    { showImages: false }, host.apply_patch, { requestRender() {} }, "/tmp");
  const failure = { content: [{ type: "text", text: "Error: patch 不匹配：missing.txt 不存在" }], details: undefined, isError: true };
  const success = {
    content: [{ type: "text", text: "D other.txt" }],
    details: { added: [], modified: [], deleted: ["other.txt"] },
    structuredContent: { added: [], modified: [], deleted: ["other.txt"] },
    isError: false,
  };
  const before = structuredClone({ failure, success, args });
  const references = [failure.content, success.content, success.details, success.structuredContent];
  card.updateResult(failure);
  for (const expanded of [false, true, false]) {
    card.setExpanded(expanded);
    card.invalidate();
    const lines = card.render(60);
    const visible = plain(lines);
    assert.ok(lines.every((line) => tui.visibleWidth(line) <= 60));
    assert.match(visible, /apply_patch/);
    assert.match(visible, /patch 不匹配/);
    if (expanded) assert.match(visible, /missing\.txt 不存在/);
    else assert.match(visible, /✗/);
    assert.doesNotMatch(visible, /Begin Patch/);
  }
  card.updateResult(success);
  card.invalidate();
  const visible = plain(card.render(60));
  assert.match(visible, /D other\.txt/);
  assert.doesNotMatch(visible, /✗|patch 不匹配/);
  assert.deepEqual({ failure, success, args }, before);
  references.forEach((value, index) => assert.equal(value, [failure.content, success.content, success.details, success.structuredContent][index]));
});
