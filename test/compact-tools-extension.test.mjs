import assert from "node:assert/strict";
import { after, test } from "node:test";
import { loadPiTestRuntime } from "./helpers/pi-runtime.mjs";

const previousExperimental = process.env.PI_EXPERIMENTAL;
process.env.PI_EXPERIMENTAL = "1";
after(() => {
  if (previousExperimental === undefined) delete process.env.PI_EXPERIMENTAL;
  else process.env.PI_EXPERIMENTAL = previousExperimental;
});

const { codingAgent, jiti } = await loadPiTestRuntime(import.meta.url);
const compactToolsModule = await jiti.import("../src/compact-tools/compact-tools.ts");
const compactTools = compactToolsModule.default;
const names = ["read", "bash", "edit", "write", "find", "grep", "ls"];
const factories = Object.fromEntries(names.map((name) => [
  name,
  codingAgent[`create${name[0].toUpperCase()}${name.slice(1)}ToolDefinition`],
]));

function registerCompactTools(factory, tools = new Map()) {
  const resolvers = [];
  const registered = [];
  const activated = [];
  factory({
    registerToolRenderer: (resolver) => resolvers.push(resolver),
    registerTool: (tool) => { registered.push(tool); tools.set(tool.name, tool); },
    setActiveTools: (names) => activated.push(names),
    on() {},
  });
  return { resolvers, registered, activated };
}

test("compact resolver拥有七工具显示并保留next其余字段，未知工具兜底单行渲染", () => {
  const { resolvers, registered, activated } = registerCompactTools(compactTools);

  assert.equal(resolvers.length, 1);
  assert.deepEqual(registered, []);
  assert.deepEqual(activated, []);
  const [resolve] = resolvers;
  for (const name of names) {
    let nextCalls = 0;
    const mine = resolve(name, () => { nextCalls++; return undefined; });
    assert.equal(nextCalls, 1);
    assert.equal(mine.renderShell, "self");
    assert.equal(typeof mine.renderCall, "function");
    assert.equal(typeof mine.renderResult, "function");
    const native = factories[name](process.cwd());
    const sentinel = {};
    const base = { renderShell: "default", renderCall() {}, renderResult() {}, sentinel };
    const merged = resolve(name, () => base);
    assert.equal(merged.renderCall, mine.renderCall);
    assert.equal(merged.renderResult, mine.renderResult);
    assert.equal(merged.sentinel, sentinel);
    assert.equal(base.renderShell, "default");
    const nativeRendering = resolve(name, () => native);
    for (const field of ["parameters", "promptSnippet", "promptGuidelines", "prepareArguments", "constrainedSampling", "execute"]) {
      assert.equal(nativeRendering[field], native[field], `${name}.${field} identity`);
    }
  }
  // 无人认领工具的字段级补齐：next() 只包含本 resolver 之后注册的 resolver 与内置渲染器。
  for (const name of ["unknown", "__proto__", "constructor"]) {
    let nextCalls = 0;
    // a：next() 产物同时具备 renderCall 与 renderResult（如 powershell 完整原生渲染）→ 原样放行。
    const complete = { renderShell: "default", renderCall() {}, renderResult() {}, sentinel: "a" };
    assert.equal(resolve(name, () => { nextCalls++; return complete; }), complete);
    assert.equal(nextCalls, 1);
    // b：有 renderCall 缺 renderResult → 只补 renderResult，原 renderCall/renderShell 与其余字段不动。
    const callOnly = { renderShell: "default", renderCall() {}, sentinel: "b" };
    const patchedResult = resolve(name, () => callOnly);
    assert.equal(patchedResult.renderCall, callOnly.renderCall);
    assert.equal(patchedResult.renderShell, "default");
    assert.equal(patchedResult.sentinel, "b");
    assert.equal(typeof patchedResult.renderResult, "function");
    assert.equal(callOnly.renderResult, undefined);
    // c：缺 renderCall → 补 renderCall 并设 renderShell:"self"；已有 renderResult 与其余字段保留。
    const resultOnly = { renderShell: "default", renderResult() {}, sentinel: "c" };
    const patchedCall = resolve(name, () => resultOnly);
    assert.equal(patchedCall.renderShell, "self");
    assert.equal(typeof patchedCall.renderCall, "function");
    assert.equal(patchedCall.renderResult, resultOnly.renderResult);
    assert.equal(patchedCall.sentinel, "c");
    // d：next() 为 undefined（工具名未注册）→ 全量兜底：self 外壳 + 两个渲染函数。
    const fallback = resolve(name, () => undefined);
    assert.equal(fallback.renderShell, "self");
    assert.equal(typeof fallback.renderCall, "function");
    assert.equal(typeof fallback.renderResult, "function");
  }
  // d 兜底内容：单行显示工具名与首个字符串参数（空白折叠为单空格）。
  const plainTheme = { bold: (text) => text, fg: (_color, text) => text };
  const fallback = resolve("unknown", () => undefined);
  const header = fallback.renderCall({ query: "hello   world", count: 3 }, plainTheme, { state: {} }).render(80);
  assert.equal(header.length, 1);
  assert.match(header[0], /unknown "hello world"/);
  assert.doesNotMatch(header[0], /count/);
});

test("compact resolver绑定bash_async显示，launch摘要已接受待完成且不注册/激活/执行", () => {
  const { resolvers, registered, activated } = registerCompactTools(compactTools);
  const [resolve] = resolvers;
  const mine = resolve("bash_async", () => undefined);
  assert.equal(mine.renderShell, "self");
  assert.equal(typeof mine.renderCall, "function");
  assert.equal(typeof mine.renderResult, "function");
  // 调用显示真实工具名 bash_async 与命令，不伪装同步 bash。
  const theme = { bold: (text) => text, fg: (_color, text) => text };
  const longCommand = "printf 'this is a deliberately long bash command whose complete tail must remain visible'";
  const args = { command: longCommand, cwd: "/tmp", timeout: 15 };
  // 预览不再使用固定 70 字符预算，按当前 render(width) 截断并使用 TUI 省略号。
  assert.match(mine.renderCall(args, theme, { expanded: false, state: {} }).render(100).join(""), /bash_async .*…/);
  assert.match(mine.renderCall(args, theme, { expanded: true, state: {} }).render(32).join("\n"), /complete tail must remain\s+visible/);
  // 显示字段覆盖，next 其余 metadata（含 execute）原样保留。
  const nativeExecute = async () => ({ content: [] });
  const sentinel = {};
  const base = { renderShell: "default", renderCall() {}, renderResult() {}, execute: nativeExecute, sentinel };
  const merged = resolve("bash_async", () => base);
  assert.equal(merged.renderCall, mine.renderCall);
  assert.equal(merged.renderResult, mine.renderResult);
  assert.equal(merged.execute, nativeExecute);
  assert.equal(merged.sentinel, sentinel);
  assert.equal(base.renderShell, "default");
  assert.deepEqual(registered, []);
  assert.deepEqual(activated, []);
  // 合法 launch 回执折叠只表达接受/待完成语义，不误报命令成功。
  const receipt = { kind: "bash-async-launch", jobId: "aabbccdd-1234", toolCallId: "call-x", command: longCommand, cwd: "/tmp", acceptedAt: "t" };
  const result = { content: [{ type: "text", text: JSON.stringify(receipt) }], details: receipt };
  const ctx = { args, state: {}, isError: false, expanded: false, isPartial: false };
  const output = mine.renderResult(result, { expanded: false, isPartial: false }, theme, ctx);
  const lines = [...mine.renderCall(args, theme, ctx).render(100), ...output.render(100)].filter((line) => line.trim());
  assert.equal(lines.length, 1);
  assert.match(lines.join(""), /已接受，待完成 \(aabbccdd\)/);
  assert.doesNotMatch(lines.join(""), /succeeded|已完成|1 lines/);
});

test("compact resolver绑定tool_search显示查询词", () => {
  const { resolvers } = registerCompactTools(compactTools);
  const tool = resolvers[0]("tool_search", () => undefined);
  const theme = { bold: (text) => text, fg: (_color, text) => text };
  const output = tool.renderCall({ query: "web search" }, theme, { state: {} }).render(100).join("\n");
  assert.match(output, /tool_search web search/);
});

test("Host折叠入口在展开错误后恢复成功摘要且不重复添加状态", () => {
  const tool = registerCompactTools(compactTools).resolvers[0]("edit", () => undefined);
  const theme = { bold: (text) => text, fg: (_color, text) => text };
  const args = { path: "/tmp/fixture.txt", edits: [{ oldText: "a", newText: "b" }] };
  const context = { args, state: {}, isError: true, expanded: true };
  const failure = { content: [{ type: "text", text: "edit conflict" }], details: undefined };
  tool.renderResult(failure, { expanded: true, isPartial: false }, theme, context);
  context.expanded = false;
  const failed = tool.renderResult(failure, { expanded: false, isPartial: false }, theme, context);
  assert.match(failed.render(100).join("\n"), /edit conflict/);
  context.isError = false;
  context.expanded = false;
  const success = { content: [{ type: "text", text: "updated" }], details: undefined };
  const output = tool.renderResult(success, { expanded: false, isPartial: false }, theme, context);
  const lines = [...tool.renderCall(args, theme, context).render(100), ...output.render(100)].filter((line) => line.trim());
  assert.deepEqual(lines, ["✓ edit /tmp/fixture.txt (1 edit) · done"]);
});

test("compact不注册或激活工具，原生definition/metadata/execute身份保持", () => {
  // 只创建原生 definition 对照，不执行工具或启动 Host。
  const tools = new Map(names.map((name) => [name, Object.freeze(factories[name](process.cwd()))]));
  const before = new Map([...tools].map(([name, tool]) => [name, { tool, fields: { ...tool } }]));
  const { resolvers, registered, activated } = registerCompactTools(compactTools, tools);
  for (const name of names) {
    const tool = tools.get(name);
    resolvers[0](name, () => ({ renderShell: tool.renderShell, renderCall: tool.renderCall, renderResult: tool.renderResult }));
    assert.equal(tool, before.get(name).tool, `${name} definition identity`);
    for (const field of Object.keys(tool)) assert.equal(tool[field], before.get(name).fields[field], `${name}.${field} identity`);
  }
  assert.deepEqual(registered, []);
  assert.deepEqual(activated, []);
});
