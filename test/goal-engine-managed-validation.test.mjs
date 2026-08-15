import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
function plan() { return { schema: "dispatch-ir.v1.validation-plan", limits: { timeoutMs: 2_000, maxOutputBytes: 1024, terminationGraceMs: 50, maxConcurrentWorkspaces: 2 }, actions: [{ id: "check", kind: "validation", executable: process.execPath, args: ["check.mjs"] }] }; }
function input(f, ownerId = "run-one", resourceClaims = []) { return { ownerKind: "goal-validation", ownerId, originRoot: f.originRoot, stateRoot: f.stateRoot, integratedHead: f.integratedHead, plan: plan(), resourceClaims }; }

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

test("recover leaves an unprovable process-bound receipt as cleanup debt without recording or releasing", async (t) => {
  const f = fixture(t); const prepared = prepareManagedValidation(input(f));
  const stored = JSON.parse(readFileSync(prepared.receiptPath, "utf8"));
  writeFileSync(prepared.receiptPath, JSON.stringify({ ...stored, phase: "process_bound", terminal: null, recorded: null }), { mode: 0o600 });
  const recovered = await recoverManagedValidation(prepared);
  assert.deepEqual({ phase: recovered.phase, debt: recovered.cleanupDebt, recorded: recovered.recorded }, { phase: "cleanup_debt", debt: true, recorded: null });
  assert.throws(() => releaseManagedValidation(recovered, { expectedHead: f.integratedHead }), /debt|terminal|release/i);
  assert.equal(existsSync(recovered.workspacePath), true);
});
