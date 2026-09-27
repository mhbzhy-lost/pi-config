import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const helperUrl = new URL("./pi-process-group.mjs", import.meta.url);

async function loadHelper() {
  try {
    return await import(helperUrl);
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      assert.fail("pi-process-group.mjs must exist before behavior tests run");
    }
    throw error;
  }
}

const nodeScript = (body) => [process.execPath, ["-e", body]];

test("exports a process-group launcher", async () => {
  const helper = await loadHelper();
  assert.equal(typeof helper.spawnIsolatedProcessGroup, "function");
});

test("normal exit does not signal the owned process group", async () => {
  const { spawnIsolatedProcessGroup } = await loadHelper();
  const [command, args] = nodeScript("process.stdout.write('finished')");
  const result = await spawnIsolatedProcessGroup({ command, args, totalTimeoutMs: 2_000, termGraceMs: 100 });
  assert.equal(result.timedOut, false);
  assert.equal(result.code, 0);
  assert.deepEqual(result.termination.signalsSent, []);
  assert.equal(result.stdout, "finished");
  assert.equal(result.termination.groupAliveAfterKill, false);
});

test("timeout terminates a fake parent and its child with TERM then KILL", async () => {
  const { spawnIsolatedProcessGroup } = await loadHelper();
  const root = await mkdtemp(join(tmpdir(), "pi-process-group-"));
  try {
    const script = [
      "const { spawn } = require('node:child_process');",
      "process.on('SIGTERM', () => {});",
      "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' });",
      "process.stdout.write(String(child.pid));",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const [command, args] = nodeScript(script);
    const result = await spawnIsolatedProcessGroup({
      command,
      args,
      cwd: root,
      totalTimeoutMs: 150,
      termGraceMs: 120,
      maxOutputBytes: 256,
    });
    assert.equal(result.timedOut, true);
    assert.deepEqual(result.termination.signalsSent, ["SIGTERM", "SIGKILL"]);
    assert.equal(result.termination.groupAliveAfterTerm, true);
    assert.equal(result.termination.groupAliveAfterKill, false);
    assert.equal(result.termination.leaderClosed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an unknown process-group identity instead of falling back to child.kill", async () => {
  const { spawnIsolatedProcessGroup } = await loadHelper();
  await assert.rejects(
    spawnIsolatedProcessGroup({ command: process.execPath, args: ["-e", ""], pid: 1 }),
    /pid|group|owned/i,
  );
});
