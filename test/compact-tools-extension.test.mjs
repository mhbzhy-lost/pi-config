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
const compactToolsModule = await jiti.import("../pi/extensions/compact-tools.ts");
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

test("compact resolver拥有七工具显示并保留next其余字段及未知fallback", () => {
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
  for (const name of ["unknown", "__proto__", "constructor"]) {
    let nextCalls = 0;
    const fallback = { renderCall() {} };
    assert.equal(resolve(name, () => { nextCalls++; return fallback; }), fallback);
    assert.equal(nextCalls, 1);
    assert.equal(resolve(name, () => undefined), undefined);
  }
});

test("compact resolver绑定apply_patch显示，不进入折叠且不注册/激活/执行", () => {
  const { resolvers, registered, activated } = registerCompactTools(compactTools);
  const [resolve] = resolvers;
  const mine = resolve("apply_patch", () => undefined);
  assert.equal(mine.renderShell, "self");
  assert.equal(typeof mine.renderCall, "function");
  assert.equal(typeof mine.renderResult, "function");
  // 调用只显示工具名，不显示 patch 参数。
  const theme = { bold: (text) => text, fg: (_color, text) => text };
  const context = { isError: false, state: {}, expanded: false, args: { patch: "*** Begin Patch\n*** Add File: docs/a.md\n*** End Patch" } };
  assert.deepEqual(mine.renderCall(context.args, theme, context).render(100), ["∗ apply_patch"]);
  // 显示字段覆盖，next 其余 metadata（含 execute）原样保留；未知名称仍 fallback。
  const sentinel = {};
  const nativeExecute = async () => ({ content: [] });
  const base = { renderShell: "default", renderCall() {}, renderResult() {}, execute: nativeExecute, sentinel };
  const merged = resolve("apply_patch", () => base);
  assert.equal(merged.renderCall, mine.renderCall);
  assert.equal(merged.renderResult, mine.renderResult);
  assert.equal(merged.execute, nativeExecute);
  assert.equal(merged.sentinel, sentinel);
  assert.equal(base.renderShell, "default");
  assert.deepEqual(resolve("unknown", () => undefined), undefined);
  assert.deepEqual(registered, []);
  assert.deepEqual(activated, []);
  // 不进入单行折叠：折叠成功状态显示 A/M/D 列表而非空组件/一行摘要。
  const output = mine.renderResult(
    { content: [{ type: "text", text: "A docs/a.md" }], details: { added: ["docs/a.md"], modified: [], deleted: [] } },
    { expanded: false, isPartial: false },
    theme,
    context,
  );
  const visible = output.render(100).map((line) => line.trim()).filter((line) => line);
  assert.deepEqual(visible, ["A docs/a.md"]);
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
  const args = { command: "sleep 5", cwd: "/tmp", timeout: 15 };
  assert.match(mine.renderCall(args, theme, { expanded: false, state: {} }).render(100).join(""), /∗ bash_async "sleep 5"/);
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
  const receipt = { kind: "bash-async-launch", jobId: "aabbccdd-1234", toolCallId: "call-x", command: "sleep 5", cwd: "/tmp", acceptedAt: "t" };
  const result = { content: [{ type: "text", text: JSON.stringify(receipt) }], details: receipt };
  const ctx = { args, state: {}, isError: false, expanded: false, isPartial: false };
  const output = mine.renderResult(result, { expanded: false, isPartial: false }, theme, ctx);
  const lines = [...mine.renderCall(args, theme, ctx).render(100), ...output.render(100)].filter((line) => line.trim());
  assert.equal(lines.length, 1);
  assert.match(lines.join(""), /已接受，待完成 \(aabbccdd\)/);
  assert.doesNotMatch(lines.join(""), /succeeded|已完成|1 lines/);
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
  assert.match(failed.render(100).join("\n"), /✗ edit conflict/);
  context.isError = false;
  context.expanded = false;
  const success = { content: [{ type: "text", text: "updated" }], details: undefined };
  const output = tool.renderResult(success, { expanded: false, isPartial: false }, theme, context);
  const lines = [...tool.renderCall(args, theme, context).render(100), ...output.render(100)].filter((line) => line.trim());
  assert.deepEqual(lines, ["∗ edit /tmp/fixture.txt (1 edit) · done"]);
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
