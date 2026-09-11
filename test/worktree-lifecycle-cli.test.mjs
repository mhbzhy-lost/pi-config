import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(process.cwd(), "scripts/worktree-lifecycle.ts");

test("audit emits v2 inventory and does not create a cleanup plan", () => {
  const stateRoot = join(mkdtempSync(join(tmpdir(), "managed-cli-")), "state");
  const output = execFileSync(process.execPath, ["--experimental-strip-types", script, "audit", "--json"], {
    env: { ...process.env, PI_CODING_WORKSPACE_DIR: stateRoot },
    encoding: "utf8",
  });
  const report = JSON.parse(output);
  assert.equal(report.schemaVersion, "managed-workspace-inventory.v2");
  assert.deepEqual(report.workspaces, []);
});
