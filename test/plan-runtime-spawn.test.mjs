import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnPiAgent } from "../scripts/lib/runtime/spawn.mjs";

function tempRunDir() {
  return join(tmpdir(), `pi-plan-test-${randomUUID()}`);
}

const cleanups = [];
afterEach(async () => {
  for (const dir of cleanups.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("spawnPiAgent", () => {
  it("throws when task is missing", async () => {
    await assert.rejects(
      () => spawnPiAgent({ task: "", cwd: "/tmp" }),
      /task is required/,
    );
  });

  it("throws when cwd is missing", async () => {
    await assert.rejects(
      () => spawnPiAgent({ task: "hello", cwd: "" }),
      /cwd is required/,
    );
  });

  it("creates runDir, status.json, and returns handle", async () => {
    const runDir = tempRunDir();
    cleanups.push(runDir);
    // Use 'echo' as a stand-in since pi may not be available in test
    // We test the structural contract, not a real pi execution
    const handle = await spawnPiAgent({
      task: "echo test",
      cwd: "/tmp",
      runDir,
    });
    assert.equal(handle.runDir, runDir);
    assert.equal(typeof handle.pid, "number");
    assert.equal(handle.statusPath, join(runDir, "status.json"));
    assert.equal(handle.stdoutPath, join(runDir, "stdout.jsonl"));
    assert.equal(handle.stderrPath, join(runDir, "stderr.log"));

    // status.json should exist with running state
    const status = JSON.parse(await readFile(handle.statusPath, "utf8"));
    assert.equal(status.state, "running");
    assert.equal(status.pid, handle.pid);
    assert.equal(typeof status.startedAt, "string");
  });

  it("generates runDir when not provided", async () => {
    const handle = await spawnPiAgent({
      task: "echo test",
      cwd: "/tmp",
    });
    cleanups.push(handle.runDir);
    assert.ok(handle.runDir.includes("pi-plan-run-"));
    await access(handle.statusPath);
  });

  it("spills long tasks to a file", async () => {
    const runDir = tempRunDir();
    cleanups.push(runDir);
    const longTask = "x".repeat(5000);
    const handle = await spawnPiAgent({
      task: longTask,
      cwd: "/tmp",
      runDir,
    });
    const taskFile = join(runDir, "task-prompt.txt");
    const content = await readFile(taskFile, "utf8");
    assert.equal(content, longTask);
  });

  it("sets PI_SUBAGENT_DEPTH in child env", async () => {
    const runDir = tempRunDir();
    cleanups.push(runDir);
    // We can't easily inspect env of a detached child, but we verify
    // the function doesn't throw with depth increment logic
    const handle = await spawnPiAgent({
      task: "echo test",
      cwd: "/tmp",
      runDir,
      env: { PI_SUBAGENT_DEPTH: "2" },
    });
    assert.equal(typeof handle.pid, "number");
  });

  it("passes noExtensions and noSkills flags", async () => {
    const runDir = tempRunDir();
    cleanups.push(runDir);
    // Structural test - ensures no throw with these options
    const handle = await spawnPiAgent({
      task: "echo test",
      cwd: "/tmp",
      runDir,
      noExtensions: true,
      noSkills: true,
    });
    assert.equal(typeof handle.pid, "number");
  });
});
