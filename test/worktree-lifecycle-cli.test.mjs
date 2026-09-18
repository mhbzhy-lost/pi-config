import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(process.cwd(), "scripts/worktree-lifecycle.ts");

test("audit emits read-only administration report and does not create a cleanup plan", () => {
  const stateRoot = join(mkdtempSync(join(tmpdir(), "managed-cli-")), "state");
  const output = execFileSync(process.execPath, ["--experimental-strip-types", script, "audit", "--json"], {
    env: { ...process.env, PI_CODING_WORKSPACE_DIR: stateRoot },
    encoding: "utf8",
  });
  const report = JSON.parse(output);
  assert.equal(report.schemaVersion, "managed-workspace-administration.v1");
  assert.equal(report.inventory.schemaVersion, "managed-workspace-inventory.v2");
  assert.deepEqual(report.inventory.workspaces, []);
  assert.deepEqual(report.queue.items, []);
});

test("reconcile apply requires explicit lease authorizations", () => {
  const stateRoot = join(mkdtempSync(join(tmpdir(), "managed-cli-")), "state");
  const result = spawnSync(process.execPath, ["--experimental-strip-types", script, "reconcile", "--apply", "--authorization-stdin", "--json"], {
    env: { ...process.env, PI_CODING_WORKSPACE_DIR: stateRoot }, input: JSON.stringify({ plan: {}, authorizations: [] }), encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid|authorization/i);
});
