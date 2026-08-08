import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createTemporaryArenaSync } from "./helpers/temporary-arena.mjs";
import { createValidationWorkspace, runCleanValidation, releaseValidationWorkspace } from "../scripts/lib/goal-engine/acceptance-runner.mjs";

function git(cwd, ...args) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function fixture(t) {
  const arena = createTemporaryArenaSync("acceptance-runner-");
  t.after(() => arena.disposeSync());
  const origin = arena.mkdtempSync("origin-");
  const state = arena.mkdtempSync("state-");
  mkdirSync(join(origin, "home"));
  mkdirSync(join(origin, "tmp"));
  git(origin, "init"); git(origin, "config", "user.email", "test@test.com"); git(origin, "config", "user.name", "Test");
  writeFileSync(join(origin, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(origin, "check.mjs"), "import { existsSync } from 'node:fs'; if (existsSync('ignored.txt')) process.exit(9);\n");
  git(origin, "add", "."); git(origin, "commit", "-m", "init");
  return { origin, state, head: git(origin, "rev-parse", "HEAD") };
}

function strictPlan() {
  return {
    schema: "dispatch-ir.v1.validation-plan",
    limits: { timeoutMs: 5_000, maxOutputBytes: 64 * 1024, terminationGraceMs: 50, maxConcurrentWorkspaces: 1 },
    actions: [{ id: "clean-check", kind: "validation", executable: process.execPath, args: ["check.mjs"] }],
  };
}

test("validation binds an immutable trusted exact Host plan and rejects caller commands", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.origin, "ignored.txt"), "executor-only\n");
  const plan = strictPlan();
  const lease = createValidationWorkspace({
    originRoot: f.origin, stateRoot: f.state, goalId: "g", taskId: "t", attempt: 1,
    integratedHead: f.head, validationPlan: plan,
  });

  assert.deepEqual(lease.validationPlan, plan);
  plan.actions[0].args[0] = "tampered.mjs";
  assert.deepEqual(lease.validationPlan.actions[0].args, ["check.mjs"]);
  assert.throws(() => runCleanValidation({ lease, command: process.execPath, args: ["-e", "process.exit(0)"] }), /actionId|command|plan/i);
  assert.throws(() => runCleanValidation({ lease, actionId: "unknown" }), /actionId|unknown|plan/i);
  assert.equal(existsSync(join(lease.path, "ignored.txt")), false);
});

test("validation rejects non-current/full identity and isolates HOME TMPDIR and inherited secrets", async (t) => {
  const f = fixture(t);
  const plan = {
    ...strictPlan(),
    actions: [{ id: "environment", kind: "validation", executable: process.execPath, args: ["-e", "const fs=require('fs'); if(process.env.SECRET_SENTINEL||!fs.existsSync(process.env.HOME)||!fs.existsSync(process.env.TMPDIR)) process.exit(7)"] }],
  };
  assert.throws(() => createValidationWorkspace({ originRoot: f.origin, stateRoot: f.state, goalId: "g", taskId: "bad", attempt: 1, integratedHead: f.head.slice(0, 7), validationPlan: plan }), /full|SHA|identity/i);
  const previous = process.env.SECRET_SENTINEL;
  process.env.SECRET_SENTINEL = "must-not-cross-validation-boundary";
  t.after(() => { if (previous === undefined) delete process.env.SECRET_SENTINEL; else process.env.SECRET_SENTINEL = previous; });
  const lease = createValidationWorkspace({ originRoot: f.origin, stateRoot: f.state, goalId: "g", taskId: "env", attempt: 1, integratedHead: f.head, validationPlan: plan });
  const result = await runCleanValidation({ lease, actionId: "environment" });
  assert.equal(result.status, "passed");
});

function leaseFile(lease) { return join(lease.stateRoot, "validation-leases", `${lease.id}.json`); }
function worktreeCount(origin) { return git(origin, "worktree", "list", "--porcelain").split("\nworktree ").length; }
function release(t, lease) { t.after(() => { try { releaseValidationWorkspace(lease, { expectedHead: lease.integratedHead }); } catch {} }); }

// This table deliberately exercises preflight only: no invalid input may allocate Git or lease state.
test("preflight rejects malformed plans without allocating a worktree, branch, manifest, or lease", (t) => {
  const f = fixture(t); const baseline = worktreeCount(f.origin);
  const cases = [
    { ...strictPlan(), extra: true },
    { ...strictPlan(), limits: { ...strictPlan().limits, extra: true } },
    { ...strictPlan(), actions: [{ ...strictPlan().actions[0], extra: true }] },
    { ...strictPlan(), actions: [{ ...strictPlan().actions[0] }, { ...strictPlan().actions[0] }] },
    { ...strictPlan(), actions: [{ ...strictPlan().actions[0], kind: "setup" }] },
    { ...strictPlan(), actions: [{ ...strictPlan().actions[0], executable: "node" }] },
    { ...strictPlan(), actions: [{ ...strictPlan().actions[0], args: ["\0"] }] },
    { ...strictPlan(), limits: { ...strictPlan().limits, timeoutMs: 1 } },
  ];
  for (const plan of cases) assert.throws(() => createValidationWorkspace({ originRoot: f.origin, stateRoot: f.state, goalId: "g", taskId: `bad${cases.indexOf(plan)}`, attempt: 1, integratedHead: f.head, validationPlan: plan }));
  assert.equal(worktreeCount(f.origin), baseline);
  assert.equal(existsSync(join(f.state, "validation-leases")), false);
  assert.equal(existsSync(join(f.origin, ".state", "worktree-lifecycle", "leases")), false);
});

test("run rejects a symlink-replaced durable lease before the action marker is produced", async (t) => {
  const f = fixture(t); const marker = join(f.state, "marker");
  const plan = { ...strictPlan(), actions: [{ id: "marker", kind: "validation", executable: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`] }] };
  const lease = createValidationWorkspace({ originRoot: f.origin, stateRoot: f.state, goalId: "g", taskId: "symlink", attempt: 1, integratedHead: f.head, validationPlan: plan }); release(t, lease);
  const file = leaseFile(lease); assert.equal(statSync(file).mode & 0o777, 0o600); const saved = readFileSync(file); const replacement = join(f.state, "replacement.json"); writeFileSync(replacement, saved); rmSync(file); symlinkSync(replacement, file);
  try { await assert.rejects(runCleanValidation({ lease, actionId: "marker" }), /symlink|lease|identity/i); assert.equal(existsSync(marker), false); }
  finally { rmSync(file); writeFileSync(file, saved, { mode: 0o600 }); }
});

test("run records durable running state while an action is live and restores no runtime after success", async (t) => {
  const f = fixture(t);
  const plan = { ...strictPlan(), actions: [{ id: "wait", kind: "validation", executable: process.execPath, args: ["-e", "setTimeout(()=>process.exit(0),200)"] }] };
  const lease = createValidationWorkspace({ originRoot: f.origin, stateRoot: f.state, goalId: "g", taskId: "running", attempt: 1, integratedHead: f.head, validationPlan: plan }); release(t, lease);
  const run = runCleanValidation({ lease, actionId: "wait" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  try { assert.equal(JSON.parse(readFileSync(leaseFile(lease))).state, "running"); }
  finally { await run; }
  const runtimeRoot = join(f.state, "validation-runtime");
  assert.equal(!existsSync(runtimeRoot) || readdirSync(runtimeRoot).length === 0, true);
});

test("spawn infrastructure failure leaves a diagnostic runtime and durable cleanup debt", async (t) => {
  const f = fixture(t); const plan = { ...strictPlan(), actions: [{ id: "missing", kind: "validation", executable: join(f.state, "does-not-exist"), args: [] }] };
  const lease = createValidationWorkspace({ originRoot: f.origin, stateRoot: f.state, goalId: "g", taskId: "infra", attempt: 1, integratedHead: f.head, validationPlan: plan });
  await assert.rejects(runCleanValidation({ lease, actionId: "missing" }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(JSON.parse(readFileSync(leaseFile(lease))).state, "cleanup-debt");
  assert.equal(existsSync(join(f.state, "validation-runtime")), true);
});

test("validation enforces byte limits and proves its whole process group terminal", async (t) => {
  const f = fixture(t);
  const plan = {
    schema: "dispatch-ir.v1.validation-plan", limits: { timeoutMs: 100, maxOutputBytes: 5, terminationGraceMs: 50, maxConcurrentWorkspaces: 1 },
    actions: [{ id: "descendant", kind: "validation", executable: process.execPath, args: ["-e", "process.stdout.write('ééé'); process.stderr.write('界'); const {spawn}=require('child_process'); spawn(process.execPath,['-e','process.on(\\\"SIGTERM\\\",()=>{});setInterval(()=>{},1000)'],{detached:false,stdio:'ignore'}); setTimeout(()=>process.exit(0),10)"] }],
  };
  const lease = createValidationWorkspace({ originRoot: f.origin, stateRoot: f.state, goalId: "g", taskId: "group", attempt: 1, integratedHead: f.head, validationPlan: plan });
  const result = await runCleanValidation({ lease, actionId: "descendant" });
  assert.equal(result.terminal, true);
  assert.match(result.processGroupTerminalProof, /.+/);
  assert.equal(result.outputBytes <= 5, true);
  assert.equal(result.truncated, true);
});
