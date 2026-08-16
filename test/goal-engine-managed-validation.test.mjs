import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createTemporaryArenaSync } from "./helpers/temporary-arena.mjs";

const modulePath = "../scripts/lib/goal-engine/managed-validation.mjs";
const missing = (name) => () => { throw new Error(`RED: managed validation API ${name} is not implemented`); };
const service = await import(modulePath).catch(() => ({
  prepareManagedValidation: missing("prepareManagedValidation"),
  startManagedValidation: missing("startManagedValidation"),
  inspectManagedValidation: missing("inspectManagedValidation"),
  recoverManagedValidation: missing("recoverManagedValidation"),
  releaseManagedValidation: missing("releaseManagedValidation"),
}));
const { prepareManagedValidation, startManagedValidation, inspectManagedValidation, recoverManagedValidation, releaseManagedValidation } = service;

function git(cwd, ...args) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function fixture(t) {
  const arena = createTemporaryArenaSync("managed-validation-"); t.after(() => arena.disposeSync());
  const originRoot = arena.mkdtempSync("origin-"); const stateRoot = arena.mkdtempSync("state-");
  git(originRoot, "init"); git(originRoot, "config", "user.email", "test@example.invalid"); git(originRoot, "config", "user.name", "Test");
  writeFileSync(join(originRoot, ".gitignore"), ".state/\n"); writeFileSync(join(originRoot, "check.mjs"), "process.stdout.write('ok')\n");
  git(originRoot, "add", "."); git(originRoot, "commit", "-m", "initial");
  return { originRoot, stateRoot, integratedHead: git(originRoot, "rev-parse", "HEAD") };
}
function plan() { return { schema: "dispatch-ir.v1.validation-plan", limits: { timeoutMs: 2_000, maxOutputBytes: 1024, terminationGraceMs: 50, maxConcurrentWorkspaces: 4 }, actions: [{ id: "check", kind: "validation", executable: process.execPath, args: ["check.mjs"] }] }; }
function input(f, ownerId = "run-one", resourceClaims = [], validationPlan = plan()) { return { ownerKind: "goal-validation", ownerId, originRoot: f.originRoot, stateRoot: f.stateRoot, integratedHead: f.integratedHead, plan: validationPlan, resourceClaims }; }
function markerPlan(marker) { return { ...plan(), actions: [{ id: "check", kind: "validation", executable: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`] }] }; }

test("prepare durably allocates one lease and rejects conflicting exclusive resource claims", async (t) => {
  const f = fixture(t);
  const first = prepareManagedValidation(input(f, "run-one", [{ key: "port:3100", mode: "exclusive", capacity: 1, reset: "clean" }]));
  assert.equal(inspectManagedValidation(first).phase, "lease_allocated");
  assert.throws(() => prepareManagedValidation(input(f, "run-two", [{ key: "port:3100", mode: "shared", capacity: 1, reset: "clean" }])), /resource|lease|conflict/i);
  await startManagedValidation(first);
  releaseManagedValidation(first, { expectedHead: f.integratedHead });
});

test("shared resource claims admit capacity holders and reject the next holder", async (t) => {
  const f = fixture(t); const claim = [{ key: "fixture:seed", mode: "shared", capacity: 2, reset: "clean" }];
  const first = prepareManagedValidation(input(f, "shared-one", claim));
  const second = prepareManagedValidation(input(f, "shared-two", claim));
  assert.throws(() => prepareManagedValidation(input(f, "shared-three", claim)), /resource|lease|conflict/i);
  await startManagedValidation(first); await startManagedValidation(second);
  releaseManagedValidation(first, { expectedHead: f.integratedHead }); releaseManagedValidation(second, { expectedHead: f.integratedHead });
});

test("start records one terminal artifact and reload recovery is idempotent before owner-CAS release", async (t) => {
  const f = fixture(t); const prepared = prepareManagedValidation(input(f));
  const completed = await startManagedValidation(prepared);
  const inspected = inspectManagedValidation(completed);
  assert.equal(inspected.phase, "recorded"); assert.equal(inspected.terminal.status, "passed"); assert.equal(inspected.recordCount, 1);
  assert.deepEqual(await recoverManagedValidation(completed), inspected);
  assert.deepEqual(await recoverManagedValidation(completed), inspected);
  assert.equal(releaseManagedValidation(completed, { expectedHead: f.integratedHead }).phase, "released");
  assert.equal(inspectManagedValidation(completed).phase, "released");
});

test("recover validates a pending process-bound callback without starting business work", { timeout: 10_000 }, async (t) => {
  const f = fixture(t); const marker = join(f.stateRoot, "business-marker"); const prepared = prepareManagedValidation(input(f, "run-one", [], markerPlan(marker)));
  let resolveAck, enteredCallback; const acknowledged = new Promise((resolve) => { resolveAck = resolve; }); const entered = new Promise((resolve) => { enteredCallback = resolve; });
  const running = startManagedValidation(prepared, { onProcessBound: async (bound) => {
    assert.equal(Object.isFrozen(bound), true);
    assert.deepEqual(Object.keys(bound).sort(), ["managedReceipt", "pid", "pidBirthIdentity", "processGroupId", "processIdentityHash"].sort());
    const durable = JSON.parse(readFileSync(prepared.receiptPath, "utf8"));
    assert.equal(durable.phase, "process_bound");
    assert.deepEqual(durable.process, { pid: bound.pid, pidBirthIdentity: bound.pidBirthIdentity, processGroupId: bound.processGroupId, processIdentityHash: bound.processIdentityHash });
    enteredCallback();
    await acknowledged;
  } });
  try {
    await entered;
    assert.equal((await recoverManagedValidation(prepared)).phase, "process_bound");
    assert.equal((await recoverManagedValidation(prepared)).phase, "process_bound");
    assert.equal(existsSync(marker), false);
    resolveAck();
    const completed = await running;
    assert.equal(existsSync(marker), true);
    assert.equal(completed.phase, "recorded");
    releaseManagedValidation(completed, { expectedHead: f.integratedHead });
  } finally { resolveAck?.(); }
});

test("callback rejection cleanup debt retains its resource claim", { timeout: 10_000 }, async (t) => {
  const f = fixture(t); const marker = join(f.stateRoot, "rejected-business-marker"); const claim = [{ key: "callback-debt", mode: "exclusive", capacity: 1, reset: "clean" }]; const prepared = prepareManagedValidation(input(f, "run-one", claim, markerPlan(marker)));
  await assert.rejects(startManagedValidation(prepared, { onProcessBound: async () => { throw Error("durable ack rejected"); } }), /durable ack rejected/);
  const failed = inspectManagedValidation(prepared);
  assert.equal(failed.phase, "cleanup_debt"); assert.equal(existsSync(marker), false); assert.equal(existsSync(prepared.workspacePath), true);
  assert.throws(() => releaseManagedValidation(prepared, { expectedHead: f.integratedHead }), /debt|terminal|release/i);
  assert.throws(() => prepareManagedValidation(input(f, "run-two", [{ key: "callback-debt", mode: "exclusive", capacity: 1, reset: "clean" }])), /resource|lease|conflict/i);
});

test("terminal barrier persists parent terminal before nested lease is returned active", async (t) => {
  const f = fixture(t); const prepared = prepareManagedValidation(input(f)); let observed = false;
  const completed = await startManagedValidation(prepared, { onTerminalBound: async () => {
    const parent = JSON.parse(readFileSync(prepared.receiptPath, "utf8"));
    const nested = JSON.parse(readFileSync(join(f.stateRoot, "validation-leases", `${parent.workspaceLease.id}.json`), "utf8"));
    assert.equal(parent.phase, "terminal"); assert.equal(nested.state, "running");
    observed = true;
  } });
  assert.equal(observed, true); assert.equal(completed.phase, "recorded");
  releaseManagedValidation(completed, { expectedHead: f.integratedHead });
});

test("recover converts a parent process-group mismatch to cleanup debt", async (t) => {
  const f = fixture(t); const prepared = prepareManagedValidation(input(f)); const stored = JSON.parse(readFileSync(prepared.receiptPath, "utf8"));
  const parentProcess = { pid: process.pid, pidBirthIdentity: "unprovable", processGroupId: process.pid + 1 }; parentProcess.processIdentityHash = createHash("sha256").update(JSON.stringify(parentProcess)).digest("hex");
  writeFileSync(prepared.receiptPath, JSON.stringify({ ...stored, phase: "process_bound", process: parentProcess, terminal: null, recorded: null }), { mode: 0o600 });
  await assert.rejects(recoverManagedValidation(prepared), /receipt is invalid/i);
});

test("recover leaves an unprovable process-bound receipt as cleanup debt without recording or releasing", async (t) => {
  const f = fixture(t); const prepared = prepareManagedValidation(input(f));
  const stored = JSON.parse(readFileSync(prepared.receiptPath, "utf8"));
  writeFileSync(prepared.receiptPath, JSON.stringify({ ...stored, phase: "process_bound", terminal: null, recorded: null }), { mode: 0o600 });
  const recovered = await recoverManagedValidation(prepared);
  assert.deepEqual({ phase: recovered.phase, debt: recovered.cleanupDebt, recorded: recovered.recorded }, { phase: "cleanup_debt", debt: true, recorded: null });
  assert.throws(() => releaseManagedValidation(recovered, { expectedHead: f.integratedHead }), /debt|terminal|release/i);
  assert.equal(existsSync(recovered.workspacePath), true);
});

const crashHost = fileURLToPath(new URL("./fixtures/goal-observation/managed-crash-host.mjs", import.meta.url));
const crashAction = fileURLToPath(new URL("./fixtures/goal-observation/managed-crash-action.mjs", import.meta.url));
async function pollRegular(file, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (existsSync(file)) { const stat = lstatSync(file); if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600) return readFileSync(file, "utf8"); }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error(`handshake timed out: ${file}`);
}
async function killChild(child) { if (child.exitCode !== null || child.signalCode !== null) return; const exited = new Promise((resolve) => child.once("exit", resolve)); child.kill("SIGKILL"); await exited; }
async function groupIsEmpty(pgid, timeout = 2_000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const members = execFileSync("ps", ["-axo", "pid=,pgid="], { encoding: "utf8" }).split("\n").filter((line) => line.trim().split(/\s+/)[1] === String(pgid)); if (members.length === 0) return true; await new Promise((resolve) => setTimeout(resolve, 20)); } return false; }
function crashPlan(marker, started, finish) { return { ...plan(), actions: [{ id: "check", kind: "validation", executable: process.execPath, args: [crashAction, marker, started, finish] }] }; }
async function crashScenario(t, mode, round) {
  const f = fixture(t), baseline = git(f.originRoot, "worktree", "list", "--porcelain");
  const prefix = join(f.stateRoot, `${mode}-${round}`), marker = `${prefix}.marker`, started = `${prefix}.started`, finish = `${prefix}.finish`, handshake = `${prefix}.handshake`;
  const prepared = prepareManagedValidation(input(f, `${mode}-${round}`, [{ key: `${mode}-${round}`, mode: "exclusive", capacity: 1, reset: "clean" }], crashPlan(marker, started, finish)));
  const child = spawn(process.execPath, [crashHost, mode, JSON.stringify(prepared), handshake], { stdio: "ignore" });
  try {
    if (mode === "before_process_ack") await pollRegular(handshake);
    else if (mode === "action_running") await pollRegular(started);
    else { await pollRegular(started); writeFileSync(finish, "finish", { mode: 0o600, flag: "wx" }); await pollRegular(handshake); }
    await killChild(child);
    if (mode !== "terminal_bound" && !existsSync(finish)) writeFileSync(finish, "finish", { mode: 0o600, flag: "wx" });
    const recovering = recoverManagedValidation(prepared, mode === "before_process_ack" ? { onProcessBound: async () => {} } : {});
    const recovered = await recovering;
    assert.equal(recovered.phase, "recorded"); assert.equal(recovered.recordCount, 1); assert.equal(recovered.terminal.status, "passed"); assert.equal(readFileSync(marker, "utf8"), "started");
    assert.equal(releaseManagedValidation(recovered, { expectedHead: f.integratedHead }).phase, "released");
    assert.equal(readdirSync(join(f.stateRoot, "managed-validations")).filter((name) => JSON.parse(readFileSync(join(f.stateRoot, "managed-validations", name), "utf8")).phase !== "released").length, 0);
    assert.equal(readdirSync(join(f.stateRoot, "validation-leases")).filter((name) => name.endsWith(".json") && JSON.parse(readFileSync(join(f.stateRoot, "validation-leases", name), "utf8")).state !== "released").length, 0);
    assert.equal(readdirSync(join(f.stateRoot, "validation-runtime")).length, 0);
    assert.equal(readdirSync(join(f.stateRoot, "validation-worktrees")).length, 0);
    assert.equal(git(f.originRoot, "worktree", "list", "--porcelain"), baseline);
  } finally { if (child.exitCode === null && child.signalCode === null) await killChild(child); }
}
test("real child Host SIGKILL recovery covers callback, running action, and terminal barriers twice", { timeout: 60_000 }, async (t) => {
  for (let round = 1; round <= 2; round++) for (const mode of ["before_process_ack", "action_running", "terminal_bound"]) await crashScenario(t, mode, round);
});

test("malformed durable status fails closed without authorizing an action", { timeout: 15_000 }, async (t) => {
  const f = fixture(t), marker = join(f.stateRoot, "malformed-marker"), started = join(f.stateRoot, "malformed-started"), finish = join(f.stateRoot, "malformed-finish"), handshake = join(f.stateRoot, "malformed-handshake");
  const prepared = prepareManagedValidation(input(f, "malformed", [{ key: "malformed", mode: "exclusive", capacity: 1, reset: "clean" }], crashPlan(marker, started, finish)));
  const child = spawn(process.execPath, [crashHost, "before_process_ack", JSON.stringify(prepared), handshake], { stdio: "ignore" });
  try {
    await pollRegular(handshake); const parent = JSON.parse(readFileSync(prepared.receiptPath, "utf8"));
    const supervisorPid = Number(JSON.parse(await pollRegular(handshake)).pid);
    writeFileSync(join(parent.workspaceLease.runtime?.path || JSON.parse(readFileSync(join(f.stateRoot, "validation-leases", `${parent.workspaceLease.id}.json`), "utf8")).runtime.path, "status"), "not-json", { mode: 0o600 });
    await killChild(child);
    const result = await recoverManagedValidation(prepared, { onProcessBound: async () => { throw Error("must not acknowledge malformed status"); } });
    assert.equal(result.phase, "cleanup_debt"); assert.equal(await groupIsEmpty(supervisorPid), true); assert.equal(existsSync(marker), false);
    assert.throws(() => prepareManagedValidation(input(f, "malformed-next", [{ key: "malformed", mode: "exclusive", capacity: 1, reset: "clean" }])), /resource|lease|conflict/i);
  } finally { if (child.exitCode === null && child.signalCode === null) await killChild(child); }
});

test("parent terminal, recorded hash, and phase authority reject corrupted receipts", async (t) => {
  const cases = [
    (record) => ({ ...record, terminal: { ...record.terminal, actualOutputBytes: 0 } }),
    (record) => ({ ...record, recorded: { ...record.recorded, artifactHash: "0".repeat(64) } }),
    (record) => ({ ...record, phase: "recorded", terminal: null }),
    (record) => ({ ...record, phase: "terminal", recorded: record.recorded }),
  ];
  for (const corrupt of cases) {
    const f = fixture(t); const completed = await startManagedValidation(prepareManagedValidation(input(f, `authority-${cases.indexOf(corrupt)}`)));
    const record = JSON.parse(readFileSync(completed.receiptPath, "utf8"));
    writeFileSync(completed.receiptPath, JSON.stringify(corrupt(record)), { mode: 0o600 });
    assert.throws(() => inspectManagedValidation(completed), /receipt is invalid/i);
    await assert.rejects(recoverManagedValidation(completed), /receipt is invalid/i);
  }
});
