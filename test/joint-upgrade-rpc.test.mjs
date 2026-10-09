import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { loadPiTestRuntime } from "./helpers/pi-runtime.mjs";

const { codingAgent: sdk, paths, root: hostRoot } = await loadPiTestRuntime(import.meta.url);

function safeEnv(root) {
  return {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(root, "home"), TMPDIR: "/tmp",
    PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0",
    PI_PACKAGE_DIR: hostRoot, PI_TEST_CODING_AGENT_ROOT: hostRoot,
    PI_REAL_BIN: join(hostRoot, "dist/cli.js"),
    PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: hostRoot,
    T8_PI_REAL_BIN: join(hostRoot, "dist/cli.js"),
  };
}

async function withRpc(args, check) {
  const root = await mkdtemp(join(tmpdir(), "joint-102-rpc-"));
  await mkdir(join(root, "home"));
  await mkdir(join(root, "agent"));
  const child = spawn(process.execPath, args, { cwd: root, env: safeEnv(root), stdio: ["pipe", "pipe", "pipe"] });
  const records = [];
  let buffer = "", stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (line.trim()) records.push(JSON.parse(line));
    }
  });
  const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
  async function response(id) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const record = records.find((r) => r.id === id && r.type === "response");
      if (record) return record;
      if (child.exitCode !== null) throw new Error(`RPC exited early: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`RPC response timeout: ${stderr}`);
  }
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 20000);
  try {
    await check({ child, records, response });
    child.stdin.end();
    const result = await closed;
    assert.deepEqual(result, { code: 0, signal: null }, stderr);
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null) child.kill("SIGKILL");
    await closed;
    await rm(root, { recursive: true, force: true });
  }
}

test("官方 physical CLI idle get_state 后 EOF 正常关闭，零 prompt/模型/扩展", async () => {
  await withRpc([join(hostRoot, "dist/cli.js"), "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-tools", "--offline"], async ({ child, response }) => {
    child.stdin.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);
    const state = await response("state");
    assert.equal(state.command, "get_state");
    assert.equal(state.success, true);
    assert.equal(state.data.isStreaming, false);
    assert.equal(state.data.messageCount, 0);
    assert.equal(state.data.pendingMessageCount, 0);
    assert.equal(typeof state.data.sessionId, "string");
  });
});

const setupSource = `
const credentials = { async read(){return undefined}, async list(){return []}, async modify(){throw Error('禁止凭据写入')}, async delete(){throw Error('禁止凭据删除')} };
const modelRuntime = await sdk.ModelRuntime.create({credentials, modelsPath:null, refreshOnCreate:false});
const settingsManager = sdk.SettingsManager.inMemory({compaction:{enabled:false}, retry:{enabled:false}, cacheWarming:'off'});
const loader = new sdk.DefaultResourceLoader({cwd:process.cwd(), agentDir:process.env.PI_CODING_AGENT_DIR, settingsManager,
 noExtensions:true, noSkills:true, noPromptTemplates:true, noThemes:true, noContextFiles:true,
 extensionFactories:[{name:'contract-handled', factory(pi){pi.registerCommand('handled', {description:'合成无模型命令', handler:async()=>{}});}}]});
await loader.reload();
const {session} = await sdk.createAgentSession({cwd:process.cwd(), agentDir:process.env.PI_CODING_AGENT_DIR, modelRuntime, settingsManager, resourceLoader:loader, sessionManager:sdk.SessionManager.inMemory(process.cwd()), noTools:true});
`;

test("官方 RPC disposition seam：真实 extension command handled 不产生 agent_settled", async () => {
  const source = `import * as sdk from ${JSON.stringify(paths.codingAgent)}; ${setupSource}
const services = {cwd:process.cwd(), agentDir:process.env.PI_CODING_AGENT_DIR, modelRuntime, settingsManager, resourceLoader:loader, diagnostics:[]};
const runtime = new sdk.AgentSessionRuntime(session, services, async()=>{throw Error('本测试禁止替换 session')});
await sdk.runRpcMode(runtime);`;
  await withRpc(["--input-type=module", "-e", source], async ({ child, records, response }) => {
    child.stdin.write(`${JSON.stringify({ id: "handled", type: "prompt", message: "/handled" })}\n`);
    const reply = await response("handled");
    assert.equal(reply.success, true);
    assert.deepEqual(reply.data, { disposition: "handled" });
    child.stdin.write(`${JSON.stringify({ id: "after", type: "get_state" })}\n`);
    const state = await response("after");
    assert.equal(state.data.isStreaming, false);
    assert.equal(state.data.messageCount, 0);
    assert.equal(records.some((r) => r.type === "agent_settled" || r.type === "agent_end"), false);
  });
});

test("SDK dispose 清理绑定但不发送 session_shutdown；上层必须单独发送生命周期关闭", async () => {
  const root = await mkdtemp(join(tmpdir(), "joint-102-dispose-"));
  const events = [];
  let session;
  try {
    const credentials = { async read() { return undefined; }, async list() { return []; }, async modify() { throw Error("禁止凭据写入"); }, async delete() { throw Error("禁止凭据删除"); } };
    const modelRuntime = await sdk.ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
    const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
    const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [{ name: "dispose-contract", factory(pi) {
      pi.on("session_start", () => events.push("start"));
      pi.on("session_shutdown", () => events.push("shutdown"));
    } }] });
    await loader.reload();
    ({ session } = await sdk.createAgentSession({ cwd: root, agentDir: root, modelRuntime, settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(root), noTools: true }));
    await session.bindExtensions({ mode: "rpc" });
    assert.deepEqual(events, ["start"]);
    session.dispose();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["start"]);
  } finally { session?.dispose(); await rm(root, { recursive: true, force: true }); }
});
