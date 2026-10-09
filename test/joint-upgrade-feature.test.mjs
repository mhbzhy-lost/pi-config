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
import createSkillWhitelistExtension from "../src/skill-whitelist/extension.ts";
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

test("1.0.4 官方 bash 合法结构来自实际执行，cwd 扩展保留 metadata 和非零 error 通道", async () => {
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

test("真实 write reminder 不改 raw；带结构 fixture 的 content-only 删除仅为 characterization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "a7-write-"));
  try {
    const handlers = new Map();
    createSecurityGatesExtension({ on: (name, handler) => handlers.set(name, handler) });
    const tool = codingAgent.createWriteToolDefinition(directory);
    assert.equal(tool.outputSchema, undefined);
    let raw, copy;
    const afterToolCall = async ({ args, result, isError }) => {
      raw = result; copy = structuredClone(result);
      return handlers.get("tool_result")({ toolName: "write", input: args, ...result, isError }, { cwd: directory });
    };
    const actual = await invoke(tool, { path: "src/demo.ts", content: "export const value = 1;\n" }, afterToolCall);
    assert.equal(actual.isError, false);
    assert.match(actual.result.content[0].text, /test-driven-development/);
    assert.equal(await readFile(join(directory, "src/demo.ts"), "utf8"), "export const value = 1;\n");
    assert.deepEqual(raw, copy);
    assert.equal(raw.structuredContent, undefined);
    // 此结构非官方 write 可达数据；不据此修改安全策略或宣称 production bug。
    const fixture = { ...tool, execute: async () => ({ content: [{ type: "text", text: "Wrote src/demo.ts" }], details: { changed: true }, structuredContent: { changed: true } }) };
    const synthetic = await invoke(fixture, { path: "src/demo.ts", content: "unused" }, afterToolCall);
    assert.equal(synthetic.result.structuredContent, undefined);
    assert.deepEqual(synthetic.result.details, { changed: true });
    assert.deepEqual(raw, copy);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("apply_patch 公开入口生成真实文件，未借助直接 projection fixture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "a7-patch-"));
  try {
    await applyPatch("*** Begin Patch\n*** Add File: demo.ts\n+export const value = 2;\n*** End Patch", directory);
    assert.equal(await readFile(join(directory, "demo.ts"), "utf8"), "export const value = 2;\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// 捕捉 whitelist 退役技能回流或发现合法项目技能丢失。
test("Skill whitelist 真实 resources_discover 仅发现合成项目合法技能", async () => {
  const directory = await mkdtemp(join(tmpdir(), "a7-skills-"));
  try {
    for (const name of ["a7-demo", "plan-runner-dispatch"]) {
      await mkdir(join(directory, ".agents/skills", name), { recursive: true });
      await writeFile(join(directory, ".agents/skills", name, "SKILL.md"), "---\nname: demo\ndescription: 合成技能\n---\n合成内容\n");
    }
    let handler;
    createSkillWhitelistExtension({ on: (_name, value) => { handler = value; } });
    const discovered = await handler({ cwd: directory });
    assert.ok(discovered.skillPaths.includes(join(directory, ".agents/skills/a7-demo")));
    assert.ok(!discovered.skillPaths.includes(join(directory, ".agents/skills/plan-runner-dispatch")));
  } finally { await rm(directory, { recursive: true, force: true }); }
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
