import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createValidationWorkspace, runCleanValidation, releaseValidationWorkspace } from "../scripts/lib/goal-engine/acceptance-runner.mjs";

function git(cwd, ...args) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-runner-"));
  git(dir, "init"); git(dir, "config", "user.email", "test@test.com"); git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, ".gitignore"), "ignored.txt\n"); writeFileSync(join(dir, "check.mjs"), "import { existsSync } from 'node:fs'; if (existsSync('ignored.txt')) process.exit(9);\n");
  git(dir, "add", "."); git(dir, "commit", "-m", "init"); return dir;
}

test("validation uses a clean managed checkout rather than executor ignored files", async () => {
  const origin = repo(); const state = mkdtempSync(join(tmpdir(), "acceptance-state-"));
  writeFileSync(join(origin, "ignored.txt"), "executor-only\n");
  const lease = createValidationWorkspace({ originRoot: origin, stateRoot: state, goalId: "g", taskId: "t", attempt: 1, integratedHead: git(origin, "rev-parse", "HEAD") });
  const result = await runCleanValidation({ lease, command: process.execPath, args: ["check.mjs"], timeoutMs: 5_000 });
  assert.equal(result.status, "passed"); assert.equal(result.terminal, true); assert.equal(result.workspaceClean, true);
  releaseValidationWorkspace(lease, { expectedHead: lease.integratedHead });
});

test("timeout kills the controlled process group and proves terminal identity", async () => {
  const origin = repo(); const state = mkdtempSync(join(tmpdir(), "acceptance-state-"));
  const lease = createValidationWorkspace({ originRoot: origin, stateRoot: state, goalId: "g2", taskId: "t", attempt: 1, integratedHead: git(origin, "rev-parse", "HEAD") });
  const result = await runCleanValidation({ lease, command: process.execPath, args: ["-e", "setInterval(()=>{}, 1000)"], timeoutMs: 100 });
  assert.equal(result.status, "timed_out"); assert.equal(result.terminal, true); assert.match(result.pidBirthIdentity, /.+/);
  releaseValidationWorkspace(lease, { expectedHead: lease.integratedHead });
});
