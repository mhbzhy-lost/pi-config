import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");

async function snapshot(paths) {
  const entries = [];
  for (const path of paths) {
    try {
      for (const entry of await readdir(path, { recursive: true })) entries.push(join(path, entry));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return entries.sort();
}

test("focused runtime fixtures do not add files to repository runtime paths", { timeout: 120_000 }, async () => {
  const paths = [join(repoRoot, "pi", "sessions"), join(repoRoot, "var", "sessions"), join(repoRoot, ".state")];
  const before = await snapshot(paths);
  await execFileAsync(process.execPath, [
    "--test", "--test-name-pattern=waitForRecord|owner-less RPC", "test/session-owner-runtime.integration.mjs",
  ], { cwd: repoRoot, env: { ...process.env, PI_REAL_BIN: "" } });
  const after = await snapshot(paths);
  assert.deepEqual(after, before, "focused test fixtures must not create repository runtime entries");
});
