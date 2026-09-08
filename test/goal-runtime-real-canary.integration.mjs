import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { RootBrokerServer } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts";
import { bindRootBroker, unbindRootBroker } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-registry.ts";
import { createProductionGoalRuntimeHost } from "../src/goal-engine/production-runtime-host.ts";
import { inventoryManagedWorkspaces } from "../packages/pi-subagents-enhanced/src/workspace/administration.ts";
import { createRunAuthorization } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/run-authorization.ts";
import { resolveGoalStateScope, selectGoalStateRoot } from "../src/goal-engine/state-scope.ts";
import { listGoals, loadProjection } from "../src/goal-engine/store.ts";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StringDecoder } from "node:string_decoder";
import test from "node:test";


const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const globalModules = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piRoot = join(globalModules, "@earendil-works/pi-coding-agent");
const { createAgentSession, DefaultResourceLoader, SessionManager } = await import(pathToFileURL(join(piRoot, "dist/index.js")).href);
const toolNames = ["goal_accept", "goal_amend", "goal_dispatch", "goal_finalize", "goal_init", "goal_integrate", "goal_settle", "goal_status"];

function redactRpc(value) {
  return JSON.stringify(value)
    .replace(/("(?:api[_-]?key|token|secret|password|authorization)"\s*:\s*")([^"]*)"/gi, "$1[REDACTED]\"")
    .replace(/bearer\s+[^\s\"]+/gi, "bearer [REDACTED]");
}

class JsonlRpcClient {
  constructor(command, args, { cwd, env, spawnImpl = spawn, maxEvents = 512, maxStderr = 16_384 } = {}) {
    this.events = []; this.toolEvents = []; this.messageEvents = []; this.stderr = ""; this.pending = new Map(); this.settled = false; this.closed = false;
    this.child = spawnImpl(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.done = new Promise((resolve) => { this.resolveDone = resolve; });
    this.attach(this.child.stdout, (record) => this.receive(record), maxEvents);
    this.attachStderr(this.child.stderr, maxStderr);
    this.child.once("error", (error) => this.close(error));
    this.child.once("close", (code, signal) => this.close(new Error(`RPC child closed code=${code} signal=${signal}`)));
  }
  attach(stream, consume, maxRecords) {
    const decoder = new StringDecoder("utf8"); let buffer = "";
    stream.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      for (;;) { const index = buffer.indexOf("\n"); if (index < 0) break; let line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (line.endsWith("\r")) line = line.slice(0, -1); if (line) consume(line); }
    });
    stream.on("end", () => { buffer += decoder.end(); if (buffer) consume(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer); });
    this.maxEvents = maxRecords;
  }
  attachStderr(stream, maxStderr) {
    const decoder = new StringDecoder("utf8");
    const append = (chunk) => { this.stderr = (this.stderr + chunk).slice(-maxStderr); };
    stream.on("data", (chunk) => append(decoder.write(chunk)));
    stream.on("end", () => append(decoder.end()));
  }
  receive(line) {
    let record; try { record = JSON.parse(line); } catch (error) { this.close(new Error(`invalid RPC JSONL: ${error.message}`)); return; }
    if (record.type === "response" && record.id && this.pending.has(record.id)) { const { resolve, reject, timer } = this.pending.get(record.id); clearTimeout(timer); this.pending.delete(record.id); record.success ? resolve(record) : reject(new Error(`RPC ${record.command} failed: ${record.error || "unknown"}`)); return; }
    if (record.type === "extension_ui_request") this.respondUi(record);
    this.events.push(record); if (this.events.length > this.maxEvents) this.events.shift();
    if (["tool_execution_start", "tool_execution_end"].includes(record.type)) { this.toolEvents.push(record); if (this.toolEvents.length > 64) this.toolEvents.shift(); }
    if (record.type === "message_end") { this.messageEvents.push(record); if (this.messageEvents.length > 32) this.messageEvents.shift(); }
    if (record.type === "agent_settled") { this.settled = true; this.resolveDone(record); }
  }
  respondUi(request) {
    if (!request.id || !["confirm", "select", "input", "editor"].includes(request.method)) return;
    const response = request.method === "confirm" ? { type: "extension_ui_response", id: request.id, confirmed: true }
      : request.method === "select" ? { type: "extension_ui_response", id: request.id, value: request.options?.[0] }
        : { type: "extension_ui_response", id: request.id, cancelled: true };
    this.send(response);
  }
  send(message) { if (!this.closed && this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  request(type, payload = {}, timeoutMs = 30_000) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC ${type} response deadline exceeded`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer }); this.send({ id, type, ...payload });
    });
  }
  async waitForSettled(timeoutMs) {
    if (this.settled) return;
    let timer;
    try { await Promise.race([this.done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("RPC agent_settled deadline exceeded")), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  close(error) {
    if (this.closed) return; this.closed = true;
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); } this.pending.clear(); this.resolveDone();
  }
  async terminate() {
    if (!this.closed) { try { await this.request("abort", {}, 2_000); } catch {} }
    this.child.stdin.end();
    await Promise.race([this.done, new Promise((resolve) => setTimeout(resolve, 500))]);
    if (!this.child.killed) this.child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => this.child.once("close", resolve)), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (!this.child.killed) this.child.kill("SIGKILL");
  }
  diagnostic() { return { events: this.events.map(redactRpc), toolEvents: this.toolEvents.map(redactRpc), messageEvents: this.messageEvents.map(redactRpc), stderr: redactRpc(this.stderr) }; }
}

function parseToolResultJson(event, expectedToolCallId) {
  if (!event || event.type !== "tool_execution_end" || event.toolCallId !== expectedToolCallId) throw new Error("tool result does not match its tool call");
  const result = event.result;
  if (!result || result.isError === true) throw new Error(`tool ${event.toolName || "unknown"} returned an error`);
  if (!Array.isArray(result.content)) throw new Error("tool result has no public content array");
  const text = result.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("");
  if (!text) throw new Error("tool result has no text JSON content");
  try { return JSON.parse(text); } catch (error) { throw new Error(`tool result text is not JSON: ${error.message}`); }
}

function toolEndForStart(events, name) {
  const start = events.find((event) => event.type === "tool_execution_start" && event.toolName === name);
  if (!start?.toolCallId) throw new Error(`missing ${name} tool start`);
  const end = events.find((event) => event.type === "tool_execution_end" && event.toolCallId === start.toolCallId);
  if (!end) throw new Error(`missing ${name} tool end for ${start.toolCallId}`);
  return { start, end };
}

function canaryStateEnvironment(agentDir, parentEnv = process.env) {
  const env = { ...parentEnv };
  for (const key of Object.keys(env)) if (key.startsWith("PI_SUBAGENT_")) delete env[key];
  return {
    ...env,
    PI_CODING_GOAL_DIR: join(agentDir, "goal-state"),
    PI_CODING_WORKSPACE_DIR: join(agentDir, "workspace-state"),
  };
}

function goalLedgerLocator(cwd, env, goalId) {
  const scope = resolveGoalStateScope({ cwd, env });
  const selected = selectGoalStateRoot(scope, {
    operation: "read",
    goalId,
    listActive: listGoals,
    hasGoal: (root, candidateGoalId) => Boolean(loadProjection(root, candidateGoalId)),
  });
  return { root: selected.root, path: join(selected.root, "goals", goalId, "events.jsonl") };
}

// The upstream writer is TypeScript under node_modules and cannot be imported
// by Node's native type stripper. This is its exact atomic-write shape, not a
// hand-made status/processTerminal fallback.
function upstreamWriteAtomicJson(file, value) {
  const temporary = `${file}.${process.pid}.canary.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, file);
}

function restartAuthorization(authority, pid) {
  return createRunAuthorization({
    kind: "coding",
    binding: { runId: authority.runId, asyncDir: authority.asyncDir, sessionId: authority.sessionId, pid, agentProfile: authority.agentProfile },
    goal: { ticketId: authority.ticketId, goalId: authority.goalId, taskId: authority.taskId, attempt: authority.attempt, contractHash: authority.contractHash, workspaceId: authority.workspaceId, executionRevision: authority.executionRevision, expectedCriteria: authority.expectedCriteria },
  });
}

async function registerRestartAuthority(broker, authority, pid) {
  await broker.registerAuthorizedRun(restartAuthorization(authority, pid));
  await broker.observeStarted({ runId: authority.runId, id: authority.runId, agent: authority.agentProfile, pid, asyncDir: authority.asyncDir, sessionId: authority.sessionId });
  const { workspaceId: _workspaceId, ...sidecar } = authority;
  broker.persistGoalBindingAuthority({ version: "root-broker.goal-run-binding-authority.v2", ...sidecar });
}

function git(cwd, ...args) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
const productionEntry = join(repoRoot, "pi/extensions/goal-engine.ts");
const subagentRuntimeEntry = join(repoRoot, "packages/pi-subagents-enhanced/extensions/subagent-runtime.ts");
const productionRuntimeHost = {
  adapters: [{
    ref: "canary-oracle", version: "1", deterministic: true, reset: "clean", resourceClaims: [],
    artifactClassifier: { pass: "PASS", fail: "FAIL", inconclusive: "UNKNOWN", infrastructure_error: "INFRA" },
    validationPlan: { schema: "dispatch-ir.v1.validation-plan", limits: { timeoutMs: 5000, maxOutputBytes: 4096, terminationGraceMs: 100, maxConcurrentWorkspaces: 1 }, actions: [{ id: "pass-json", kind: "validation", executable: "/bin/echo", args: ["{\"code\":\"PASS\"}"] }] },
  }],
  environments: { "canary-local": { fingerprint: "canary-environment-v1", available: true } },
  fixtures: { "canary-fixture": { fingerprint: "canary-fixture-v1", available: true } },
  resources: {},
};

function productionSettings() {
  return {
    goalEngine: {
      enabled: true,
      runtimeHost: productionRuntimeHost,
    },
  };
}

function realCanaryGoalEntry(settingsPath) {
  return `import { createGoalEngineEntry } from ${JSON.stringify(pathToFileURL(productionEntry).href)};\nexport default (pi) => createGoalEngineEntry(pi, { settingsPath: ${JSON.stringify(settingsPath)} });\n`;
}

function loader(cwd, agentDir) {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return new DefaultResourceLoader({ cwd, agentDir, additionalExtensionPaths: [subagentRuntimeEntry, productionEntry], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
}
async function start(cwd, agentDir, sessionManager, { sessionStart = true } = {}) {
  const resourceLoader = loader(cwd, agentDir);
  await resourceLoader.reload();
  const extensionsResult = resourceLoader.getExtensions();
  const extensionErrors = [
    ...(extensionsResult.errors || []),
    ...(extensionsResult.diagnostics || []).filter((diagnostic) => diagnostic?.level === "error" || diagnostic?.severity === "error"),
  ];
  assert.deepEqual(extensionErrors, [], `extension load errors: ${JSON.stringify(extensionsResult)}`);
  const loadedPaths = (extensionsResult.extensions || []).map((extension) => extension?.path || extension?.name).filter(Boolean);
  assert.equal(loadedPaths.some((path) => String(path).includes("subagent-runtime.ts")), true, `subagent runtime was not loaded: ${JSON.stringify(loadedPaths)}`);
  assert.equal(loadedPaths.some((path) => String(path).includes("goal-engine.ts")), true, `goal entry was not loaded: ${JSON.stringify(loadedPaths)}`);
  const host = await createAgentSession({ cwd, agentDir, resourceLoader, sessionManager });
  await host.session.bindExtensions({ mode: "rpc", shutdownHandler() {}, onError(error) { throw error; } });
  if (sessionStart) await host.session.extensionRunner.emit({ type: "session_start" });
  await host.session.extensionRunner.emitBeforeAgentStart();
  host.cwd = cwd;
  host.loadedExtensionPaths = loadedPaths;
  return host;
}
function publicTool(host, name) {
  const tools = host.session.agent?.state?.tools;
  const values = tools instanceof Map ? [...tools.values()] : Array.isArray(tools) ? tools : tools && typeof tools === "object" ? Object.values(tools) : [];
  return values.find((tool) => tool?.name === name);
}
async function call(host, name, id, params, signal = AbortSignal.timeout(900_000)) {
  return host.session.getToolDefinition(name).execute(id, params, signal, undefined, { cwd: host.cwd, sessionManager: host.session.sessionManager });
}
const resultValue = async (...args) => JSON.parse((await call(...args)).details.value);

test("RPC JSONL client uses LF framing, correlates responses, consumes UI, aborts, and bounds diagnostics", async () => {
  const program = String.raw`let b=""; process.stdin.on("data", c => { b += c; for (;;) { const n=b.indexOf("\n"); if(n<0) break; const r=JSON.parse(b.slice(0,n)); b=b.slice(n+1); if(r.type === "extension_ui_response") process.stdout.write(JSON.stringify({type:"ui_answer",confirmed:r.confirmed})+"\n"); else if(r.type === "abort") { process.stdout.write(JSON.stringify({id:r.id,type:"response",command:"abort",success:true})+"\n"); process.exit(0); } else { const out=JSON.stringify({id:r.id,type:"response",command:r.type,success:true,data:{model:{provider:"openai-codex",id:"gpt-5.6-luna"}}})+"\n"; process.stdout.write(Buffer.from(out).subarray(0,9)); process.stdout.write(Buffer.from(out).subarray(9)); process.stdout.write(JSON.stringify({type:"extension_ui_request",id:"ui-1",method:"confirm"})+"\n"); process.stdout.write(JSON.stringify({type:"message_update",text:"x y"})+"\n"); process.stdout.write(JSON.stringify({type:"agent_settled"})+"\n"); } } }); process.stderr.write("x".repeat(20000));`;
  const client = new JsonlRpcClient(process.execPath, ["-e", program], { maxStderr: 64 });
  try {
    const state = await client.request("get_state");
    assert.equal(state.data.model.id, "gpt-5.6-luna");
    await client.waitForSettled(2_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(client.events.some((event) => event.type === "ui_answer" && event.confirmed), true);
    assert.equal(client.events.some((event) => event.type === "message_update" && event.text === "x y"), true, "U+2028 is data, not a delimiter");
    assert.equal(client.stderr.length, 64);
  } finally { await client.terminate(); }
});

test("RPC tool result parser uses only matching public text content", () => {
  const event = { type: "tool_execution_end", toolName: "goal_init", toolCallId: "init-1", isError: false, result: { isError: false, content: [{ type: "text", text: "{\"goal" }, { type: "image", data: "ignored" }, { type: "text", text: "Id\":\"g-1\"}" }] } };
  assert.deepEqual(parseToolResultJson(event, "init-1"), { goalId: "g-1" });
  assert.throws(() => parseToolResultJson({ ...event, toolCallId: "other" }, "init-1"), /does not match/);
  assert.throws(() => parseToolResultJson({ ...event, result: { ...event.result, isError: true } }, "init-1"), /returned an error/);
  assert.throws(() => parseToolResultJson({ ...event, result: { isError: false, content: [{ type: "image" }] } }, "init-1"), /no text JSON/);
});
// This intentionally uses the globally installed SDK and the actual production
// entry, rather than a test-only Pi/Host double or a wrapper extension.
test("真实 Pi production entry loads exact-eight without a model provider", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "goal-runtime-real-canary-")));
  const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "goal-runtime-real-agent-")));
  const inheritedAgentDir = process.env.PI_CODING_AGENT_DIR;
  const inheritedGoalDir = process.env.PI_CODING_GOAL_DIR;
  let host;
  try {
    git(cwd, "init", "-b", "main"); git(cwd, "config", "user.email", "canary@example.invalid"); git(cwd, "config", "user.name", "Runtime Canary");
    writeFileSync(join(cwd, ".gitignore"), ".state/\n"); git(cwd, "add", ".gitignore"); git(cwd, "commit", "-m", "test: 初始化 runtime canary 仓库");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(productionSettings()), { mode: 0o600 });
    delete process.env.PI_CODING_GOAL_DIR;
    host = await start(cwd, agentDir, SessionManager.create(cwd, join(agentDir, "sessions")));
    assert.deepEqual(toolNames.map(name => host.session.getToolDefinition(name)?.name).sort(), toolNames);
    assert.equal(host.session.getToolDefinition("goal_observe"), undefined);
    // Entry loading must not create resources before a real Goal operation.
    const inventory = inventoryManagedWorkspaces({ stateRoot: join(agentDir, "workspaces"), originRoot: cwd });
    assert.deepEqual(inventory.workspaces, []);
    assert.deepEqual(inventory.orphanRegistrations, []);
  } finally {
    try { host?.session?.dispose(); } catch {}
    if (inheritedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = inheritedAgentDir;
    if (inheritedGoalDir === undefined) delete process.env.PI_CODING_GOAL_DIR; else process.env.PI_CODING_GOAL_DIR = inheritedGoalDir;
    rmSync(agentDir, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true });
  }
});

test("fresh local canary isolates state roots and locates its exact Goal ledger", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "goal-runtime-local-canary-")));
  const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "goal-runtime-local-agent-")));
  const inherited = { PATH: process.env.PATH, PI_CODING_GOAL_DIR: "/main-session/goals", PI_CODING_WORKSPACE_DIR: "/main-session/workspaces" };
  const env = canaryStateEnvironment(agentDir, inherited);
  const saved = Object.fromEntries(["PI_CODING_GOAL_DIR", "PI_CODING_WORKSPACE_DIR", "PI_CODING_AGENT_DIR"].map((key) => [key, process.env[key]]));
  let host;
  try {
    assert.notEqual(env.PI_CODING_GOAL_DIR, inherited.PI_CODING_GOAL_DIR, "canary must not inherit the main session Goal root");
    assert.notEqual(env.PI_CODING_WORKSPACE_DIR, inherited.PI_CODING_WORKSPACE_DIR, "canary must not inherit the main session workspace root");
    const childEnv = JSON.parse(execFileSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify({ goal: process.env.PI_CODING_GOAL_DIR, workspace: process.env.PI_CODING_WORKSPACE_DIR }))"], { env, encoding: "utf8" }));
    assert.deepEqual(childEnv, { goal: env.PI_CODING_GOAL_DIR, workspace: env.PI_CODING_WORKSPACE_DIR }, "the canary child receives explicit isolated roots");
    process.env.PI_CODING_GOAL_DIR = env.PI_CODING_GOAL_DIR;
    process.env.PI_CODING_WORKSPACE_DIR = env.PI_CODING_WORKSPACE_DIR;
    git(cwd, "init", "-b", "main"); git(cwd, "config", "user.email", "canary@example.invalid"); git(cwd, "config", "user.name", "Runtime Canary");
    writeFileSync(join(cwd, ".gitignore"), ".state/\n"); git(cwd, "add", ".gitignore"); git(cwd, "commit", "-m", "test: local canary origin");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(productionSettings()), { mode: 0o600 });
    host = await start(cwd, agentDir, SessionManager.create(cwd, join(agentDir, "sessions")));
    const initialized = await resultValue(host, "goal_init", "local-canary-init", {
      objective: "Local canary ledger locator",
      tasks: [{ id: "ledger", description: "Write no files", writePaths: ["docs/ledger.md"], acceptance: { criteria: [{ id: "ledger-proof", statement: "ledger exists", evidenceKinds: ["tests"] }] }, workflow: "tdd" }],
    });
    const locator = goalLedgerLocator(cwd, env, initialized.goalId);
    assert.equal(locator.root, resolveGoalStateScope({ cwd, env }).preferredRoot);
    assert.equal(locator.path, join(locator.root, "goals", initialized.goalId, "events.jsonl"));
    assert.equal(readFileSync(locator.path, "utf8").includes("goal.created"), true);
    assert.equal(loadProjection(locator.root, initialized.goalId)?.goalId, initialized.goalId);
    assert.equal(loadProjection(join(cwd, ".state", "goal-engine"), initialized.goalId), null, "locator must not fall back to origin/.state");
  } finally {
    try { host?.session?.dispose(); } catch {}
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(agentDir, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true });
  }
});

test("real root RPC binds one Goal typed subagent", { skip: process.env.PI_RUN_GOAL_REAL_CANARY !== "1" }, async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "goal-runtime-rpc-canary-")));
  const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "goal-runtime-rpc-agent-")));
  const env = canaryStateEnvironment(agentDir);
  const taskId = "goal-t9d-persist-real-smoke-test";
  const settingsPath = join(agentDir, "settings.json");
  const goalEntry = join(agentDir, "goal-engine-real-canary-entry.mjs");
  let client;
  try {
    assert.equal(execFileSync(process.execPath, ["--version"], { encoding: "utf8" }).trim().startsWith("v"), true, "Node runtime is required before the real RPC canary");
    assert.equal(execFileSync("/opt/homebrew/bin/pi", ["--version"], { encoding: "utf8" }).trim(), "0.84.4", "the pinned Pi executable is required");
    git(cwd, "init", "-b", "main"); git(cwd, "config", "user.email", "canary@example.invalid"); git(cwd, "config", "user.name", "Runtime Canary");
    writeFileSync(join(cwd, ".gitignore"), ".state/\n"); git(cwd, "add", ".gitignore"); git(cwd, "commit", "-m", "test: real RPC canary origin");
    assert.equal(env.PI_CODING_AGENT_DIR, process.env.PI_CODING_AGENT_DIR, "the child must retain the parent agent directory for credential resolution");
    writeFileSync(settingsPath, JSON.stringify(productionSettings()), { mode: 0o600 });
    writeFileSync(goalEntry, realCanaryGoalEntry(settingsPath), { mode: 0o600 });
    const prompt = `Use only the listed Goal tools in this exact order: goal_init, goal_status, goal_dispatch, then the returned typed subagent contract. Create exactly one task with id ${taskId}, agentProfile executor, workflow tdd, writePaths ["docs/bugs/2026-09-08-goal-real-smoke-test-missing.md"], and one acceptance criterion. Do not call any other tool. The executor task must make no file changes and report completion. After subagent starts, stop.`;
    client = new JsonlRpcClient("/opt/homebrew/bin/pi", [
      "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
      "-e", subagentRuntimeEntry, "-e", goalEntry,
      "--provider", "openai-codex", "--model", "gpt-5.6-luna",
      "--tools", "goal_init,goal_status,goal_dispatch,subagent",
    ], { cwd, env });
    await client.request("prompt", { message: prompt }, 30_000);
    await client.waitForSettled(900_000);

    const init = toolEndForStart(client.toolEvents, "goal_init");
    const status = toolEndForStart(client.toolEvents, "goal_status");
    const dispatch = toolEndForStart(client.toolEvents, "goal_dispatch");
    const subagent = toolEndForStart(client.toolEvents, "subagent");
    const initialized = parseToolResultJson(init.end, init.start.toolCallId);
    parseToolResultJson(status.end, status.start.toolCallId);
    const dispatched = parseToolResultJson(dispatch.end, dispatch.start.toolCallId);
    const details = subagent.end.result?.details;
    assert.equal(initialized.goalId, dispatched.goalId, JSON.stringify({ initialized, dispatched }));
    assert.equal(dispatched.contract?.taskId, taskId, JSON.stringify(dispatched));
    assert.equal(typeof dispatched.contract_hash, "string");
    assert.match(dispatched.contract_hash, /^[a-f0-9]{64}$/);
    assert.equal(typeof details?.runId, "string", JSON.stringify(subagent.end));
    assert.equal(typeof details?.asyncDir, "string", JSON.stringify(subagent.end));
    assert.equal(details.contractHash, dispatched.contract_hash, JSON.stringify(details));
    const locator = goalLedgerLocator(cwd, env, initialized.goalId);
    const projection = loadProjection(locator.root, initialized.goalId);
    const binding = projection?.tasks.get(taskId)?.executorBinding;
    assert.deepEqual(binding && { runId: binding.runId, asyncDir: binding.asyncDir, contractHash: binding.contractHash }, {
      runId: details.runId, asyncDir: details.asyncDir, contractHash: dispatched.contract_hash,
    });
  } catch (error) {
    writeFileSync(join(agentDir, "rpc-smoke-blocked-events.json"), JSON.stringify(client?.diagnostic() ?? { error: String(error) }), { mode: 0o600 });
    throw error;
  } finally {
    await client?.terminate();
    rmSync(agentDir, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true });
  }
});

test("真实 production Host 在 Root Broker restart 后恢复 exact failed terminal proof", async () => {
  const asyncDir = mkdtempSync(join(tmpdir(), "goal-runtime-real-restart-"));
  const runId = "real-canary-failed-executor";
  const sessionId = "real-canary-root-session";
  const terminal = {
    version: 1, runId, runnerProcessInstanceId: "real-canary-runner", state: "observed", observedAt: 1_700_000_000_000,
    instances: [{ processInstanceId: "real-canary-runner", kind: "runner", closeObservedAt: 1_700_000_000_000, exitCode: 1, signal: null }],
  };
  const upstream = { async ping() { return {}; }, async stop() { throw Error("terminal recovery must not stop a process"); }, async dispose() {} };
  const pi = { events: {} };
  const pid = 43123;
  const brokerA = new RootBrokerServer({ rootSessionId: sessionId, lifecycleSessionId: sessionId, captureProcessBirthIdentity: async () => "real-canary-birth", writeGrant: async () => "/tmp/real-canary-grant", upstream });
  try {
    const authority = { goalId: "real-canary-goal", taskId: "real-canary-task", attempt: 1, runId, asyncDir, workspacePath: "/tmp/real-canary-workspace", leaseId: "c".repeat(64), sessionId, baseHead: "a".repeat(40), headAtDispatch: "a".repeat(40), executionRevision: 1, contractHash: "b".repeat(64), expectedCriteria: ["criterion-1"], agentProfile: "executor", ticketId: "d".repeat(64), workspaceId: "real-canary-workspace" };
    await registerRestartAuthority(brokerA, authority, pid);
    upstreamWriteAtomicJson(join(asyncDir, "process-terminal.json"), terminal);
    brokerA.observeTerminal(terminal);
    await brokerA.closeRootSession();

    const brokerB = new RootBrokerServer({ rootSessionId: sessionId, lifecycleSessionId: sessionId, captureProcessBirthIdentity: async () => "real-canary-birth", writeGrant: async () => "/tmp/real-canary-grant", upstream });
    try {
      bindRootBroker(pi, brokerB);
      // Fresh Host registration re-establishes the live authorization. The
      // durable sidecar is then re-read and checked by the public broker API.
      await registerRestartAuthority(brokerB, authority, pid);
      const persisted = await brokerB.inspectExecutorProofAsync(runId);
      assert.equal(persisted.terminal.outcome, "failed");
      const host = createProductionGoalRuntimeHost(pi);
      const { expectedCriteria: _expectedCriteria, agentProfile: _agentProfile, ticketId: _ticketId, workspaceId: _workspaceId, ...stopAuthority } = authority;
      const recovered = await host.stopOwnedRun({ ...stopAuthority, agent: "executor" });
      assert.equal(recovered.state, "observed");
      assert.equal(recovered.proof.runId, runId);
      assert.equal(recovered.proof.instances[0].exitCode, 1, "failed proof remains failed terminal evidence");
    } finally {
      unbindRootBroker(pi, brokerB);
      await brokerB.closeRootSession();
    }
  } finally {
    await brokerA.closeRootSession().catch(() => undefined);
    rmSync(asyncDir, { recursive: true, force: true });
  }
});

test("未注册 Goal authority 的 restart fixture 保持 fail-closed attention", async () => {
  const asyncDir = mkdtempSync(join(tmpdir(), "goal-runtime-real-restart-unregistered-"));
  const runId = "real-canary-unregistered";
  const sessionId = "real-canary-unregistered-session";
  const pi = { events: {} };
  const broker = new RootBrokerServer({ rootSessionId: sessionId, lifecycleSessionId: sessionId, upstream: { async ping() { return {}; }, async stop() { throw Error("must not stop an unregistered run"); }, async dispose() {} } });
  try {
    bindRootBroker(pi, broker);
    const host = createProductionGoalRuntimeHost(pi);
    const result = await host.stopOwnedRun({ goalId: "unregistered-goal", taskId: "unregistered-task", attempt: 1, runId, asyncDir, workspacePath: "/tmp/unregistered-workspace", leaseId: "c".repeat(64), sessionId, baseHead: "a".repeat(40), headAtDispatch: "a".repeat(40), executionRevision: 1, contractHash: "b".repeat(64), agent: "executor" });
    assert.deepEqual(result, { state: "attention", code: "OWNED_STOP_IDENTITY_UNKNOWN" });
  } finally {
    unbindRootBroker(pi, broker);
    await broker.closeRootSession();
    rmSync(asyncDir, { recursive: true, force: true });
  }
});
