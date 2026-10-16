import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";
import { resolvePiCodingAgentRoot } from "./helpers/pi-runtime.mjs";
import { captureProcessBirthIdentity, processBirthIdentityMatches } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/process-birth-identity.ts";
import { brokerSocketPath } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-protocol.ts";

const exec = promisify(execFile);
// harness 读取侧 ps 采样统一固定 C locale：fixture Host 以 fixtureEnvironment 白名单的
// LANG=C/LC_ALL=C 计算权威 birth，而 harness 若继承执笔 shell 的 zh_CN，会对本地化 lstart
// 生成不同 sha256（H1p run3 失败类别2根因，:178/:196/:208/:215/:252 假阴性）。仅通过
// production helper 既有公开 {execFile} options 注入读取侧 env，不改生产 helper，
// 不做字符串归一化 fallback；LC_ALL=C 覆盖全部 LC_* 分类，{...process.env} 其余项照常继承。
async function cLocaleExecFile(file, args) {
  return exec(file, args, { encoding: "buffer", maxBuffer: 1024 * 1024, env: { ...process.env, LANG: "C", LC_ALL: "C" } });
}
const repo = resolve(import.meta.dirname, "..");
const parentProbe = join(repo, "test/fixtures/heartbeat-parent-host.ts");
const provider = join(repo, "test/fixtures/heartbeat-provider.ts");
const runtime = join(repo, "packages/pi-subagents-enhanced/extensions/subagent-runtime.ts");
const PREPARE = "PI_RUNTIME_HEARTBEAT_PREPARE_ONLY";
const KILL = "PI_RUNTIME_HEARTBEAT_PARENT_KILL";

export function experimentMode(env) {
  if (env[PREPARE] === "1" && env[KILL] === "1") throw new Error("prepare-only 与 H2 门禁互斥");
  if (env[KILL] === "1") return "parent-death";
  if (env[PREPARE] === "1") return "prepare-only";
  return "disabled";
}

function contained(root, path) {
  if (typeof path !== "string" || !isAbsolute(path)) return false;
  const rel = relative(root, path);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

export function assertReady(ready) {
  for (const key of ["parentPid", "runnerPid", "childPid", "ownerGeneration", "workflowPid"]) assert.ok(Number.isSafeInteger(ready[key]) && ready[key] > 0, `缺少 ${key}`);
  for (const key of ["parentBirth", "runnerBirth", "childBirth"]) assert.match(ready[key] ?? "", /^[a-f0-9]{64}$/, `缺少 ${key}`);
  for (const key of ["runId", "rootSessionId", "workflowRunId", "leaseId"]) assert.ok(typeof ready[key] === "string" && ready[key].length > 0, `缺少 ${key}`);
  for (const key of ["leaseReceivedAt", "lastRenewedAt", "expiresAt", "ackAt", "boundAt", "barrierAt", "toolExitAt"]) assert.ok(Number.isFinite(ready[key]) && ready[key] > 0, `缺少 ${key}`);
  assert.equal(ready.bound, true); assert.equal(ready.acknowledged, true); assert.equal(ready.toolExit, "success");
  assert.equal(ready.directSpawn, true); assert.equal(ready.workflowPid, ready.parentPid);
  // upstream Node detached runner 内嵌 AgentSession；没有虚构第三个 child OS PID。
  assert.equal(ready.runnerPid, ready.childPid); assert.equal(ready.runnerBirth, ready.childBirth);
  assert.notEqual(ready.parentPid, ready.childPid); assert.notEqual(ready.workflowRunId, ready.runId);
  assert.ok(ready.lastRenewedAt <= ready.leaseReceivedAt && ready.expiresAt > ready.leaseReceivedAt);
  assert.ok(ready.ackAt <= ready.barrierAt && ready.boundAt <= ready.barrierAt);
  assert.ok(ready.renewalSequence >= 1, "至少观察一次真实续租，非仅首个 lease");
  for (const key of ["asyncDir", "workflowAsyncDir", "dispatchCwd"]) assert.ok(contained(ready.fixtureRoot, ready[key]), `${key} 越过 fixture`);
  assert.ok(ready.readyAt >= Math.max(ready.barrierAt, ready.toolExitAt, ready.leaseReceivedAt));
}

// 仅固定非敏感基础环境；不复制 process.env，不继承 provider/credential/真实 session 标记。
export function fixtureEnvironment(root, hostRoot, node = process.execPath) {
  return {
    PATH: `${dirname(node)}:/usr/bin:/bin`, HOME: join(root, "home"), TMPDIR: join(root, "tmp"),
    XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_CACHE_HOME: join(root, "xdg-cache"), XDG_DATA_HOME: join(root, "xdg-data"),
    LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    PI_CODING_AGENT_DIR: join(root, "agent"), PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
    PI_CODING_WORKSPACE_DIR: join(root, "state"), PI_HEARTBEAT_FIXTURE_ROOT: root,
    PI_HOST_ROOT: hostRoot, PI_HOST_NODE: node, PI_REAL_BIN: join(hostRoot, "dist/cli.js"), PI_PACKAGE_DIR: hostRoot,
    PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: hostRoot, PI_OFFLINE: "1", PI_TELEMETRY: "0",
  };
}

async function lines(file) {
  let source;
  try { source = await readFile(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  // append 正在进行时只消费完整 LF frame。
  return source.split("\n").slice(0, -1).filter(Boolean).map(line => JSON.parse(line));
}
async function until(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(100); }
  throw new Error(`${label} 超时；保留 fixture，禁止自动补杀`);
}
async function record(root, filename, value) { await writeFile(join(root, filename), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }

async function fixture() {
  // 短 TMPDIR 保持 Unix socket 路径长度合法；每次独立 common-dir/registry/state。
  const root = await realpath(await mkdtemp(join(tmpdir(), "hb-")));
  const hostRoot = resolvePiCodingAgentRoot({ env: {} });
  const env = fixtureEnvironment(root, hostRoot);
  const repository = join(root, "repository");
  for (const directory of [repository, env.HOME, env.TMPDIR, env.PI_CODING_AGENT_DIR, env.PI_CODING_AGENT_SESSION_DIR, env.PI_CODING_WORKSPACE_DIR, join(root, "agent/agents"), join(root, "agent/extensions")]) await mkdir(directory, { recursive: true });
  await writeFile(join(repository, "probe.txt"), "只读 heartbeat fixture\n");
  for (const name of ["delegate", "executor", "reviewer"]) await writeFile(join(root, "agent/agents", `${name}.md`), `---\nname: ${name}\ndescription: 隔离 heartbeat fixture\nmodel: heartbeat-fixture/local\ntools: read\nextensions: ${provider}\n---\n只等待本地 barrier，禁止修改文件、网络、shell 或新增委派。\n`);
  // 同一物理 production 共享入口，不伪造 required ACK。
  await symlink(join(repo, "pi/extensions/agents-shared.ts"), join(root, "agent/extensions/agents-shared.ts"));
  const git = args => exec("git", args, { cwd: repository, env, encoding: "utf8" });
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Heartbeat Fixture"]);
  await git(["config", "user.email", "heartbeat@example.invalid"]);
  await git(["add", "probe.txt"]);
  // 仅临时仓最小 commit；不操作当前仓 index，遵循 git-commit-convention。
  await git(["commit", "-m", "test(heartbeat): 增加隔离只读探针"]);
  const common = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
  assert.ok(contained(root, common));
  const cli = join(hostRoot, "dist/cli.js");
  const rootSessionId = `heartbeat-${randomUUID()}`;
  const brokerNamespace = brokerSocketPath(rootSessionId);
  // 只检查本次精确随机 namespace 是否冲突，绝不枚举共享目录。
  try { await lstat(brokerNamespace); throw new Error("fixture broker namespace 已存在；停止，不接管"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const args = [cli, "--mode", "rpc", "--session-id", rootSessionId, "--no-extensions", "-e", provider, "-e", runtime, "-e", parentProbe,
    "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-mcp", "--offline", "--no-approve",
    "--provider", "heartbeat-fixture", "--model", "heartbeat-fixture/local", "--thinking", "off", "--session-dir", env.PI_CODING_AGENT_SESSION_DIR];
  const host = spawn(process.execPath, args, { cwd: repository, env, stdio: ["pipe", "pipe", "pipe"] });
  const records = [];
  let buffer = "", stderr = "", exit;
  host.stdout.setEncoding("utf8"); host.stderr.setEncoding("utf8");
  host.stdout.on("data", chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (line.trim()) records.push({ observedAt: Date.now(), ...JSON.parse(line) });
    }
  });
  host.stderr.on("data", chunk => { stderr += chunk; });
  host.on("error", error => { exit = { error: String(error), at: Date.now() }; });
  host.on("exit", (code, signal) => { exit = { code, signal, at: Date.now() }; });
  const send = message => host.stdin.write(`${JSON.stringify(message)}\n`);
  // pre-title 观测：spawn 瞬间取样，早于 SDK setup 的 process.title 改写；异常仍 fail-closed，不猜 registry。
  // 读取侧同样固定 C locale 与 post-title 权威取样同域，但仍只作历史诊断，不参与任何身份校验。
  let spawnBirth;
  try {
    assert.ok(host.pid);
    spawnBirth = await captureProcessBirthIdentity(host.pid, { execFile: cLocaleExecFile });
  } catch (error) {
    await record(root, "bootstrap-failure.json", { root, rootSessionId, brokerNamespace, parentPid: host.pid ?? null, stage: "pre-title-spawn-birth-capture",
      error: String(error), childSupplementaryKill: false, cleanupDisposition: "retained; request supervisor exact fixture cleanup" });
    host.unref(); for (const stream of [host.stdin, host.stdout, host.stderr]) stream.unref?.();
    throw error;
  }
  await record(root, "launch.json", { root, common, rootSessionId, brokerNamespace, brokerNamespaceAbsentBeforeLaunch: true, parentPid: host.pid,
    // spawnBirth 是 pre-title 历史观测：早于 dist/cli/setup.js:4 `process.title = APP_NAME`
    // （它会改写 ps -o command= 的 argv 内存）。只作诊断，不参与任何后续身份校验；
    // 它与 post-title 权威值不同是预期事实，不得当作 PID 复用。权威父身份见 parent-started.hostBirth。
    spawnBirth, spawnBirthCapturedBeforeProcessTitle: true,
    spawnBirthPreTitleBasis: "physical SDK dist/cli/setup.js:4 在任何 extension/broker 代码之前赋值 process.title，改写 ps -o command= 输入",
    harnessPid: process.pid, cli, args, repository, credentialEnvironmentInherited: false,
    brokerNamespaceException: "固定 uid 公共目录，仅使用本次随机 rootSessionId 派生的精确 namespace，禁止枚举其它 root" });
  send({ id: "heartbeat-prompt", type: "prompt", message: "HEARTBEAT_FIXTURE_PARENT" });
  return { root, host, spawnBirth, rootSessionId, brokerNamespace, records, send,
    detach() { host.unref(); for (const stream of [host.stdin, host.stdout, host.stderr]) stream.unref?.(); },
    get exit() { return exit; }, get stderr() { return stderr; } };
}

async function collectReady(f) {
  return until(async () => {
    assert.equal(f.exit, undefined, "fixture parent 提前退出");
    const dispatch = f.records.find(entry => entry.type === "tool_execution_end" && entry.toolName === "subagent");
    if (!dispatch) return;
    assert.notEqual(dispatch.isError, true); assert.notEqual(dispatch.result?.isError, true);
    const handle = dispatch.result?.details;
    if (!handle?.runId || !handle.workspace_id) return;
    const parent = await lines(join(f.root, "parent-observations.jsonl"));
    const started = parent.find(entry => entry.kind === "started" && entry.runId === handle.runId);
    if (!started) return;
    const workflow = parent.find(entry => entry.kind === "started" && entry.runId === started.parentWorkflowRunId);
    if (!workflow) return;
    const childLog = await lines(join(f.root, `child-${started.pid}.jsonl`));
    const owner = childLog.find(entry => entry.kind === "owner");
    const ack = childLog.find(entry => entry.kind === "acknowledged");
    const barrier = childLog.find(entry => entry.kind === "barrier-entered");
    const lease = childLog.filter(entry => entry.kind === "lease").at(-1);
    assert.ok(!childLog.some(entry => entry.kind === "observation-error"), "公开 lease 观测失败");
    if (!owner || !ack || !barrier || !lease || lease.data.renewalSequence < 1) return;
    const parentStarted = parent.find(entry => entry.kind === "parent-started");
    if (!parentStarted?.registry) return;
    assert.equal(parentStarted.sessionId, f.rootSessionId);
    assert.equal(parentStarted.registry.rootSessionId, f.rootSessionId);
    assert.equal(parentStarted.registry.endpoint, f.brokerNamespace);
    assert.equal(parentStarted.registry.pid, f.host.pid);
    // 双 post-title 取样一致：production registry 与 parent probe 在 session_start 内各自独立捕获，
    // 均晚于 process.title 改写；相等才允许作为父权威身份。不因摘要不同误判 PID 复用。
    assert.match(parentStarted.hostBirth ?? "", /^[a-f0-9]{64}$/, "parent-started 缺少 post-title hostBirth");
    assert.equal(parentStarted.registry.processBirthIdentity, parentStarted.hostBirth);
    assert.ok(await processBirthIdentityMatches(parentStarted.registry.pid, parentStarted.registry.processBirthIdentity, { execFile: cLocaleExecFile }),
      "registry birth 与活父进程不符");
    assert.equal(owner.rootSessionId, f.rootSessionId);
    assert.equal(owner.runId, handle.runId); assert.equal(ack.runId, handle.runId); assert.equal(barrier.runId, handle.runId);
    assert.equal(owner.rootSessionId, lease.rootSessionId); assert.equal(lease.callerRunId, handle.runId);
    assert.equal(lease.data.runId, handle.runId); assert.equal(owner.ownerGeneration, lease.data.ownerGeneration);
    assert.equal(started.asyncDir, handle.asyncDir); assert.equal(owner.cwd, handle.dispatch_cwd);
    assert.ok(contained(f.root, handle.asyncDir));
    // public status 只投影进程字段；不读 session/authority/启动私有 handshake。
    const status = JSON.parse(await readFile(join(handle.asyncDir, "status.json"), "utf8"));
    assert.equal(status.runId, handle.runId); assert.equal(status.pid, started.pid);
    assert.equal(status.state, "running");
    assert.equal(owner.pid, started.pid);
    // parentBirth 取 post-title 权威值（hostBirth == registry 且经活体复核）；
    // spawnBirth 仅 pre-title 历史观测。后续 remaining/H2 全部沿用同一权威 birth。
    const ready = { fixtureRoot: f.root, parentPid: f.host.pid,
      parentBirth: parentStarted.hostBirth, hostBirth: parentStarted.hostBirth,
      registryBirth: parentStarted.registry.processBirthIdentity, spawnBirth: f.spawnBirth, directSpawn: true,
      runnerPid: started.pid, runnerBirth: await captureProcessBirthIdentity(started.pid, { execFile: cLocaleExecFile }),
      childPid: owner.pid, childBirth: owner.processBirth, runnerContainsChildSession: true,
      workflowPid: workflow.pid, workflowRunId: workflow.runId, workflowAsyncDir: workflow.asyncDir,
      runId: handle.runId, rootSessionId: owner.rootSessionId, ownerGeneration: owner.ownerGeneration,
      asyncDir: handle.asyncDir, dispatchCwd: handle.dispatch_cwd, workspaceId: handle.workspace_id,
      leaseId: lease.data.leaseId, leaseReceivedAt: lease.observedAt, lastRenewedAt: lease.data.lastRenewedAt, expiresAt: lease.data.expiresAt,
      renewalSequence: lease.data.renewalSequence, bound: true, boundAt: owner.observedAt, acknowledged: true, ackAt: ack.observedAt,
      barrierAt: barrier.observedAt, toolExit: "success", toolExitAt: dispatch.observedAt, readyAt: Date.now(),
      registry: parentStarted.registry,
      startupOrder: { parentStartedAt: parentStarted.observedAt, workflowStartedAt: workflow.observedAt, lifecycleStartAt: started.observedAt, ownerReadAt: owner.observedAt, ackAt: ack.observedAt, barrierAt: barrier.observedAt, leaseReceivedAt: lease.observedAt },
    };
    assertReady(ready);
    assert.ok(await processBirthIdentityMatches(f.host.pid, ready.parentBirth, { execFile: cLocaleExecFile }), "ready 时父身份已消失");
    return ready;
  }, 120_000, "公开身份/ACK/lease readiness");
}

async function identityEnded(pid, birth) {
  try {
    const currentBirth = await captureProcessBirthIdentity(pid, { execFile: cLocaleExecFile });
    return currentBirth === birth ? undefined : { state: "pid-reused", currentBirth };
  } catch (cause) {
    // birth helper 不可用不等于退出；独立 ps 缺失事实佐证，权限/格式失败仍 fail closed。
    try {
      const result = await exec("ps", ["-p", String(pid), "-o", "pid="], { encoding: "utf8", env: { ...process.env, LANG: "C", LC_ALL: "C" } });
      if (result.stdout.trim() === "") return { state: "absent" };
    } catch (error) {
      if (error.code === 1 && error.stdout === "" && error.stderr === "") return { state: "absent" };
    }
    throw new Error(`PID ${pid} birth 不可用但不能证明退出`, { cause });
  }
}

async function remaining(ready) {
  const identities = [["parent", ready.parentPid, ready.parentBirth], ["runner-child", ready.runnerPid, ready.runnerBirth]];
  return (await Promise.all(identities.map(async ([role, pid, birth]) => await identityEnded(pid, birth) ? undefined : { role, pid, birth }))).filter(Boolean);
}

async function prepareDispose(f, ready) {
  await writeFile(join(f.root, "release-barrier"), "normal dispose\n");
  await until(() => identityEnded(ready.runnerPid, ready.runnerBirth), 45_000, "prepare-only child 自然完成");
  // 由 fake 父回合调用 public workspace API；未允许处置时不删 managed 根。
  f.send({ id: "heartbeat-cleanup", type: "prompt", message: "HEARTBEAT_FIXTURE_CLEANUP" });
  await until(() => f.records.some(entry => entry.type === "message_end" && JSON.stringify(entry.message).includes("HEARTBEAT_FIXTURE_DISPOSED")), 30_000, "public workspace dispose");
  f.host.stdin.end();
  await until(() => f.exit, 30_000, "prepare-only normal Host dispose");
  assert.deepEqual(await remaining(ready), []);
  await record(f.root, "prepare-result.json", { mode: "prepare-only", parentDeathExperiment: false, ready, parentExit: f.exit, remainingFixturePids: [], childSupplementaryKill: false, cleanupDisposition: "public-workspace-disposed; evidence-root-retained" });
}

async function parentDeath(f, ready) {
  assert.equal(process.env[KILL], "1", "缺少显式 H2 门禁");
  assertReady(ready);
  assert.equal(ready.parentPid, f.host.pid); assert.notEqual(f.host.pid, process.pid);
  assert.equal(f.exit, undefined);
  assert.ok(ready.expiresAt > Date.now(), "SIGKILL 前已记录 lease 已过期");
  assert.ok(await processBirthIdentityMatches(f.host.pid, ready.parentBirth, { execFile: cLocaleExecFile }), "SIGKILL 前父 PID birth 不符");
  assert.ok(await processBirthIdentityMatches(ready.runnerPid, ready.runnerBirth, { execFile: cLocaleExecFile }), "SIGKILL 前 child 身份不符");
  const killAt = Date.now();
  await record(f.root, "before-sigkill.json", { ready, killAt, birthRecheck: true, target: "direct-spawned-parent-pid-only", childSupplementaryKill: false });
  // 本文件唯一 kill；不使用负 PID、不杀组、不对 runner/child 发信号。
  assert.equal(f.host.kill("SIGKILL"), true);
  const deadline = Math.min(killAt + 90_000, ready.expiresAt + 15_000);
  let childExitAt, childIdentityEnd;
  while (Date.now() < deadline) {
    childIdentityEnd = await identityEnded(ready.runnerPid, ready.runnerBirth);
    if (childIdentityEnd) { childExitAt = Date.now(); break; }
    await delay(250);
  }
  const remainingFixturePids = await remaining(ready);
  let publicProof;
  try { const status = JSON.parse(await readFile(join(ready.asyncDir, "status.json"), "utf8")); publicProof = status.processTerminal; } catch { /* 不补读私有 sidecar */ }
  await record(f.root, "parent-death-result.json", { ready, killAt, parentExit: f.exit, childExitAt: childExitAt ?? null,
    exitSignal: publicProof?.signal ?? null, terminationReason: null, terminationReasonAvailability: "production watchdog 未公开 reason；不推断",
    latencyMs: childExitAt ? childExitAt - killAt : null, childIdentityEnd: childIdentityEnd ?? null, observedUntil: Date.now(), birthRecheck: true, childSupplementaryKill: false,
    remainingFixturePids, publicProcessProof: publicProof ?? null, cleanupDisposition: "fixture-root-retained; public-workspace-cleanup-requires-live-owner-decision" });
  assert.ok(childExitAt, "90s 仅 harness fail 上限；申请精确 fixture cleanup，不补杀 child");
  assert.deepEqual(remainingFixturePids, []);
  assert.equal(f.exit?.signal, "SIGKILL");
}

// 此单测不启动 Host；资源授权后可独立检查默认门禁和环境白名单。
test("heartbeat harness 默认关闭，prepare/H2 互斥，环境不继承真实 provider", () => {
  assert.equal(experimentMode({}), "disabled");
  assert.equal(experimentMode({ [PREPARE]: "1" }), "prepare-only");
  assert.equal(experimentMode({ [KILL]: "1" }), "parent-death");
  assert.throws(() => experimentMode({ [PREPARE]: "1", [KILL]: "1" }), /互斥/);
  const env = fixtureEnvironment("/tmp/fixture", "/repo/node_modules/pi", "/node/bin/node");
  for (const key of Object.keys(env)) assert.ok(!/API_KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION/.test(key));
  assert.equal(env.HOME, "/tmp/fixture/home"); assert.equal(env.PI_CODING_WORKSPACE_DIR, "/tmp/fixture/state");
  assert.throws(() => assertReady({}), /parentPid/);
});

test("readiness 静态字段矩阵缺身份/ACK/lease 任一项均拒绝", () => {
  // 仅 gate 单元样本，绝不作为实际进程 readiness 或租约证据持久化。
  const sample = {
    fixtureRoot: "/tmp/unit", parentPid: 10, runnerPid: 11, childPid: 11, workflowPid: 10,
    parentBirth: "a".repeat(64), runnerBirth: "b".repeat(64), childBirth: "b".repeat(64),
    ownerGeneration: 1, runId: "leaf", workflowRunId: "root", rootSessionId: "session", leaseId: "lease",
    leaseReceivedAt: 40, lastRenewedAt: 35, expiresAt: 100, ackAt: 20, boundAt: 15, barrierAt: 25,
    toolExitAt: 30, readyAt: 45, renewalSequence: 1, bound: true, acknowledged: true, toolExit: "success", directSpawn: true,
    asyncDir: "/tmp/unit/leaf", workflowAsyncDir: "/tmp/unit/root", dispatchCwd: "/tmp/unit/workspace",
  };
  assertReady(sample);
  for (const key of Object.keys(sample)) {
    const missing = { ...sample }; delete missing[key];
    assert.throws(() => assertReady(missing), undefined, `缺少 ${key} 不得 ready`);
  }
  for (const bad of [{ acknowledged: false }, { bound: false }, { directSpawn: false }, { renewalSequence: 0 }, { childPid: 12 }, { dispatchCwd: "/outside" }, { expiresAt: 20 }]) {
    assert.throws(() => assertReady({ ...sample, ...bad }));
  }
});

test("隔离 managed coding 实际父 Host/child heartbeat", { skip: experimentMode(process.env) === "disabled" }, async t => {
  const mode = experimentMode(process.env);
  const f = await fixture();
  t.diagnostic(`fixtureRoot=${f.root}；失败需精确 cleanup，harness 不补杀不删现场`);
  let ready;
  try {
    ready = await collectReady(f);
    await record(f.root, "ready.json", ready);
    if (mode === "prepare-only") await prepareDispose(f, ready);
    else await parentDeath(f, ready);
  } catch (error) {
    const parent = await lines(join(f.root, "parent-observations.jsonl"));
    await record(f.root, "failure.json", { error: String(error), mode, ready: ready ?? null, parentExit: f.exit ?? null,
      remainingFixturePids: ready ? await remaining(ready) : parent.filter(entry => entry.kind === "started").map(({ runId, pid }) => ({ runId, pid, birth: "unconfirmed" })),
      childSupplementaryKill: false, cleanupDisposition: "retained; request supervisor exact fixture cleanup", stderr: f.stderr });
    // 无 finally kill/rm；失败后让测试 runner 可报告失败，不以清理挂起掩盖现场。
    // 若 parent 尚活，harness 退出后的 stdin EOF 仅是正常 Host disposal，不计父死实验。
    f.detach();
    throw error;
  }
});
