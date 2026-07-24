import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createMonitor } from "../scripts/lib/runtime/monitor.mjs";

function tempDir() {
  return join(tmpdir(), `pi-plan-monitor-test-${randomUUID()}`);
}

const cleanups = [];
afterEach(async () => {
  for (const dir of cleanups.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("createMonitor", () => {
  it("returns unknown when status.json does not exist", async () => {
    const dir = tempDir();
    await mkdir(dir, { recursive: true });
    cleanups.push(dir);
    const monitor = createMonitor(dir);
    assert.equal(await monitor.state(), "unknown");
    monitor.dispose();
  });

  it("returns running when status says running and pid is alive", async () => {
    const dir = tempDir();
    await mkdir(dir, { recursive: true });
    cleanups.push(dir);
    // Use current process pid (guaranteed alive)
    await writeFile(join(dir, "status.json"), JSON.stringify({ state: "running", pid: process.pid, startedAt: new Date().toISOString() }));
    const monitor = createMonitor(dir);
    assert.equal(await monitor.state(), "running");
    monitor.dispose();
  });

  it("returns failed when pid is dead", async () => {
    const dir = tempDir();
    await mkdir(dir, { recursive: true });
    cleanups.push(dir);
    // Use an impossibly high pid
    await writeFile(join(dir, "status.json"), JSON.stringify({ state: "running", pid: 2147483647, startedAt: new Date().toISOString() }));
    const monitor = createMonitor(dir);
    assert.equal(await monitor.state(), "failed");
    monitor.dispose();
  });

  it("returns complete when status says complete", async () => {
    const dir = tempDir();
    await mkdir(dir, { recursive: true });
    cleanups.push(dir);
    await writeFile(join(dir, "status.json"), JSON.stringify({ state: "complete", pid: 123, exitCode: 0, endedAt: new Date().toISOString() }));
    const monitor = createMonitor(dir);
    assert.equal(await monitor.state(), "complete");
    monitor.dispose();
  });

  it("returns pid from status", async () => {
    const dir = tempDir();
    await mkdir(dir, { recursive: true });
    cleanups.push(dir);
    await writeFile(join(dir, "status.json"), JSON.stringify({ state: "running", pid: 42, startedAt: new Date().toISOString() }));
    const monitor = createMonitor(dir);
    assert.equal(await monitor.pid(), 42);
    monitor.dispose();
  });

  it("waitForTerminal resolves immediately if already terminal", async () => {
    const dir = tempDir();
    await mkdir(dir, { recursive: true });
    cleanups.push(dir);
    await writeFile(join(dir, "status.json"), JSON.stringify({ state: "complete", pid: 1, exitCode: 0 }));
    await writeFile(join(dir, "stdout.jsonl"), "");
    const monitor = createMonitor(dir);
    const result = await monitor.waitForTerminal({ timeoutMs: 1000 });
    assert.equal(result, "complete");
    monitor.dispose();
  });

  it("output returns empty string when no stdout", async () => {
    const dir = tempDir();
    await mkdir(dir, { recursive: true });
    cleanups.push(dir);
    const monitor = createMonitor(dir);
    assert.equal(await monitor.output(), "");
    monitor.dispose();
  });
});
