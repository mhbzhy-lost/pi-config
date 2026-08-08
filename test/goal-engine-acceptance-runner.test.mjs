import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTemporaryArenaSync } from "./helpers/temporary-arena.mjs";
import { createValidationWorkspace, runCleanValidation } from "../scripts/lib/goal-engine/acceptance-runner.mjs";

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
    limits: { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 },
    actions: [{ id: "clean-check", kind: "node", executable: process.execPath, args: ["check.mjs"] }],
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
    actions: [{ id: "environment", kind: "node", executable: process.execPath, args: ["-e", "const fs=require('fs'); if(process.env.SECRET_SENTINEL||!fs.existsSync(process.env.HOME)||!fs.existsSync(process.env.TMPDIR)) process.exit(7)"] }],
  };
  assert.throws(() => createValidationWorkspace({ originRoot: f.origin, stateRoot: f.state, goalId: "g", taskId: "bad", attempt: 1, integratedHead: f.head.slice(0, 7), validationPlan: plan }), /full|SHA|identity/i);
  const previous = process.env.SECRET_SENTINEL;
  process.env.SECRET_SENTINEL = "must-not-cross-validation-boundary";
  t.after(() => { if (previous === undefined) delete process.env.SECRET_SENTINEL; else process.env.SECRET_SENTINEL = previous; });
  const lease = createValidationWorkspace({ originRoot: f.origin, stateRoot: f.state, goalId: "g", taskId: "env", attempt: 1, integratedHead: f.head, validationPlan: plan });
  const result = await runCleanValidation({ lease, actionId: "environment" });
  assert.equal(result.status, "passed");
});

test("validation enforces byte limits and proves its whole process group terminal", async (t) => {
  const f = fixture(t);
  const plan = {
    schema: "dispatch-ir.v1.validation-plan", limits: { timeoutMs: 100, maxOutputBytes: 5 },
    actions: [{ id: "descendant", kind: "node", executable: process.execPath, args: ["-e", "process.stdout.write('ééé'); process.stderr.write('界'); const {spawn}=require('child_process'); spawn(process.execPath,['-e','process.on(\\\"SIGTERM\\\",()=>{});setInterval(()=>{},1000)'],{detached:false,stdio:'ignore'}); setTimeout(()=>process.exit(0),10)"] }],
  };
  const lease = createValidationWorkspace({ originRoot: f.origin, stateRoot: f.state, goalId: "g", taskId: "group", attempt: 1, integratedHead: f.head, validationPlan: plan });
  const result = await runCleanValidation({ lease, actionId: "descendant" });
  assert.equal(result.terminal, true);
  assert.match(result.processGroupTerminalProof, /.+/);
  assert.equal(result.outputBytes <= 5, true);
  assert.equal(result.truncated, true);
});
