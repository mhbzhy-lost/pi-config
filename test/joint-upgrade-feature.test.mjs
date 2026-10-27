import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadPiTestRuntime } from "./helpers/pi-runtime.mjs";
import { resolvePiHostPackageEntry } from "./helpers/pi-host.mjs";
import { createSecurityGatesExtension } from "../src/security-gates/extension.ts";
import { createBashCwdExtension } from "../src/bash-cwd/extension.ts";
import { applyPatch } from "../src/apply-patch/index.ts";
// 现有公开入口回归；不以这些旧测试单独证明目标 pipeline。
import { createBasicMemoryExtension } from "../src/basic-memory/extension.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createProviderFallbackExtension } from "../src/provider-fallback/extension.ts";
import { createProviderCapture } from "./fixtures/joint-upgrade/provider-capture.mjs";
const { root, codingAgent } = await loadPiTestRuntime(import.meta.url);
const { runToolCall } = await import(pathToFileURL(resolvePiHostPackageEntry(root, "@earendil-works/pi-agent-core")));
const invoke = (tool, args, afterToolCall) => runToolCall({ id: "a7", name: tool.name, arguments: args }, {
  tools: [tool], assistantMessage: { role: "assistant", content: [] }, context: { messages: [], tools: [tool] }, afterToolCall,
});

test("1.3.0 官方 bash 合法结构来自实际执行，cwd 扩展保留 metadata 和非零 error 通道", async () => {
  const directory = await mkdtemp(join(tmpdir(), "a7-bash-"));
  try {
    await mkdir(join(directory, "child"));
    let tool;
    createBashCwdExtension({ registerTool: (value) => { tool = value; } }, { workspaceRoot: directory, createBashToolDefinition: codingAgent.createBashToolDefinition });
    assert.ok(tool.outputSchema);
    const outcome = await invoke(tool, { command: "printf '合法输出'; pwd", cwd: "child" });
    assert.equal(outcome.isError, false);
    assert.match(outcome.result.content[0].text, /合法输出/);
    assert.match(outcome.result.structuredContent.output, /child/);
    assert.equal(outcome.result.structuredContent.exit_code, 0);
    assert.equal(outcome.result.structuredContent.truncated, false);
    assert.equal(typeof outcome.result.structuredContent.wall_time_seconds, "number");
    const error = await invoke(tool, { command: "printf '失败输出'; exit 7" });
    assert.equal(error.isError, true);
    assert.equal(error.result.structuredContent.exit_code, 7);
    assert.match(error.result.content[0].text, /失败输出/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("真实 write 无 tool_result 注入；原始 content/details 保持原生合同不变", async () => {
  const directory = await mkdtemp(join(tmpdir(), "a7-write-"));
  try {
    const handlers = new Map();
    createSecurityGatesExtension({ on: (name, handler) => handlers.set(name, handler) });
    // M01 已删除 tool_result reminder handler；只剩 tool_call 门禁。
    assert.equal(handlers.get("tool_result"), undefined);
    assert.equal(typeof handlers.get("tool_call"), "function");
    const tool = codingAgent.createWriteToolDefinition(directory);
    assert.equal(tool.outputSchema, undefined);
    let raw, snapshot;
    const afterToolCall = async ({ result }) => {
      raw = result; snapshot = structuredClone(result);
      return result;
    };
    const actual = await invoke(tool, { path: "src/demo.ts", content: "export const value = 1;\n" }, afterToolCall);
    assert.equal(actual.isError, false);
    // 真实返回规范（pi-agent-core 1.3.0 finalizeExecutedToolCall + AfterToolCallResult 合并语义）：hook
    // 返回真值后按字段合并新建外层对象——content/details 沿用原值、显式带 usage/terminate；
    // structuredContent 为 undefined 时删除该键。因此不要求包装对象与 hook 收到的对象引用相同，
    // 只核对 content/details 原始内容与结构化字段语义，并证明 raw 本体未被改写。
    const { content, details, usage, terminate, ...undeclaredFields } = actual.result;
    assert.deepEqual(undeclaredFields, {}, "合同外的元数据字段不得注入 hook 结果");
    assert.deepEqual(content, snapshot.content);
    assert.equal(content.length, 1);
    assert.equal(content[0].type, "text");
    assert.equal(details, undefined);
    assert.equal(Object.hasOwn(actual.result, "details"), true, "details 按合同保留为原生 undefined");
    assert.equal(usage, undefined);
    assert.equal(terminate, undefined);
    assert.equal(actual.result.structuredContent, undefined);
    assert.equal(Object.hasOwn(actual.result, "structuredContent"), false, "未声明 outputSchema 时不得凭空生成 structuredContent");
    // 展示层未改写 raw 本体：hook 时刻的快照与 finalize 后的原对象逐字段一致。
    assert.deepEqual(raw, snapshot);
    assert.deepEqual(Object.keys(raw).sort(), ["content", "details"]);
    assert.equal(Object.hasOwn(raw, "structuredContent"), false);
    assert.equal(Object.hasOwn(raw, "usage"), false, "finalize 的 usage 只落在外层新对象上");
    assert.equal(Object.hasOwn(raw, "terminate"), false, "finalize 的 terminate 只落在外层新对象上");
    assert.doesNotMatch(raw.content[0].text, /test-driven-development/);
    assert.equal(await readFile(join(directory, "src/demo.ts"), "utf8"), "export const value = 1;\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("apply_patch 公开入口生成真实文件，未借助直接 projection fixture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "a7-patch-"));
  try {
    await applyPatch("*** Begin Patch\n*** Add File: demo.ts\n+export const value = 2;\n*** End Patch", directory);
    assert.equal(await readFile(join(directory, "demo.ts"), "utf8"), "export const value = 2;\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// 捕捉退役技能经原生 discovery 回流或合法技能丢失；selector 只作用于其声明 scope。
test("原生 resource discovery 合成 fixture：合法技能被发现，scoped selector 排除退役技能", async () => {
  const home = await mkdtemp(join(tmpdir(), "a7-skills-home-"));
  const previousHome = process.env.HOME;
  try {
    const agentDir = join(home, "agent");
    const project = join(home, "project");
    await mkdir(join(agentDir, "skills"), { recursive: true });
    // 项目内放置 .git，使原生祖先 .agents/skills 遍历停止在合成仓库根。
    await mkdir(join(project, ".git"), { recursive: true });
    for (const name of ["a7-demo", "plan-runner-dispatch"]) {
      await mkdir(join(agentDir, "skills", name), { recursive: true });
      await writeFile(join(agentDir, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: 合成技能\n---\n合成内容\n`);
    }
    // 隔离 HOME：用户级自动发现根只指向合成目录，不读真实 ~/.agents/skills。
    process.env.HOME = home;
    const { DefaultPackageManager, SettingsManager } = codingAgent;
    const settingsManager = SettingsManager.inMemory({ skills: ["!**/plan-runner-dispatch/**"] });
    const packageManager = new DefaultPackageManager({ cwd: project, agentDir, settingsManager });
    const resolved = await packageManager.resolve();
    const enabled = resolved.skills.filter((entry) => entry.enabled).map((entry) => entry.path);
    const retired = resolved.skills.filter((entry) => entry.path.includes("plan-runner-dispatch"));
    assert.ok(enabled.includes(join(agentDir, "skills", "a7-demo", "SKILL.md")));
    assert.ok(retired.length >= 1, "退役技能应由原生发现后按声明 selector 关闭");
    for (const entry of retired) {
      assert.equal(entry.enabled, false, `声明 selector 必须排除退役技能: ${entry.path}`);
      assert.equal(entry.metadata?.source, "auto");
    }
    assert.equal(enabled.some((path) => path.includes("plan-runner-dispatch")), false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

// 仅 CLI 边界为替身，生产 commandBuilder/execute 和目标 schema pipeline 保持真实。
test("BasicMemory 真实 factory/pipeline 使用合成 CLI，保留 local 参数和拒绝秘密", async () => {
  const directory = await mkdtemp(join(tmpdir(), "a7-memory-"));
  try {
    const fixturePath = join(directory, "memory-cli.mjs");
    await writeFile(fixturePath, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
    const tools = [];
    createBasicMemoryExtension({ registerTool: (tool) => tools.push(tool), async exec(command, args, options) {
      assert.equal(command, "basic-memory");
      const result = await promisify(execFile)(process.execPath, [fixturePath, ...args], { signal: options.signal, timeout: options.timeout });
      return { ...result, code: 0 };
    } });
    const tool = tools.find((value) => value.name === "memory_search");
    const outcome = await invoke(tool, { query: "合成查询", project: "a7" });
    assert.equal(outcome.isError, false);
    assert.deepEqual(JSON.parse(outcome.result.content[0].text), ["tool", "search-notes", "合成查询", "--local", "--project", "a7"]);
    assert.deepEqual(outcome.result.details, {});
    const rejected = await invoke(tools.find((value) => value.name === "memory_write"), { title: "合成", folder: "a7", content: "password=not-real-secret" });
    assert.equal(rejected.isError, true);
    assert.match(rejected.result.content[0].text, /秘密|secret/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// 可达定义是任意 HTTP 响应；503 不应被误当成网络不可达而切模型。
test("provider fallback 真实 session_start 经本地 HEAD 503 保持 primary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "a7-fallback-"));
  const fixture = await createProviderCapture();
  try {
    await mkdir(join(directory, "pi"));
    await writeFile(join(directory, "pi/models.json"), JSON.stringify({ providers: { "a7-local": { baseUrl: fixture.baseUrl } } }));
    let handler, switches = 0;
    createProviderFallbackExtension({ on: (_name, value) => { handler = value; }, setModel: async () => { switches++; return true; } }, { configRoot: directory });
    await handler({}, { model: { provider: "a7-local", id: "demo" }, modelRegistry: { find: (provider, id) => ({ provider, id }) } });
    assert.equal(switches, 0);
  } finally { await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});
