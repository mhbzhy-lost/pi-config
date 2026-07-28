import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

async function missing(relative) {
  await assert.rejects(access(path.join(root, relative)));
}

test("legacy generic Executor runtime and its tests are absent", async () => {
  for (const relative of [
    "scripts/lib/runtime/spawn.mjs",
    "scripts/lib/runtime/monitor.mjs",
    "scripts/lib/runtime/control.mjs",
    "scripts/lib/runtime/stream.mjs",
    "scripts/lib/runtime/index.mjs",
    "test/plan-runtime-spawn.test.mjs",
    "test/plan-runtime-monitor.test.mjs",
    "test/plan-runtime-control.test.mjs",
  ]) await missing(relative);
});

test("only the thin Host owns Plan Runner process control and no Executor path imports it", async () => {
  const host = await readFile(path.join(root, "scripts/lib/plan/plan-host-runtime.mjs"), "utf8");
  const coordinator = await readFile(path.join(root, "scripts/lib/plan/coordinator.mjs"), "utf8");
  const dependencies = await readFile(path.join(root, "scripts/lib/plan/plan-runner-dependencies.mjs"), "utf8");
  const backend = await readFile(path.join(root, "scripts/lib/plan/pi-subagents-execution-backend.mjs"), "utf8");

  assert.match(host, /node:child_process/);
  assert.doesNotMatch(host, /lib\/runtime|runtime\/spawn|spawnPiAgent|createMonitor|PI_SUBAGENT_DEPTH/);
  assert.doesNotMatch(host, /spawnExecutor|attemptId|executorCwd/);
  for (const source of [coordinator, dependencies, backend]) {
    assert.doesNotMatch(source, /spawnPiAgent|createMonitor|stopAgent|interruptAgent|import\s*\{\s*spawn\s*\}\s*from\s*["']node:child_process/);
  }
});

test("Plan widget reads typed projections instead of process stdout", async () => {
  const widget = await readFile(path.join(root, "scripts/lib/plan/tui/plan-widget.mjs"), "utf8");
  assert.match(widget, /status\.json/);
  assert.match(widget, /host-handle\.json/);
  assert.doesNotMatch(widget, /stdout|createProcessFleetView|createOutputStream|createMonitor/);
});

test("remaining fleet modules do not import the retired runtime directory", async () => {
  for (const relative of ["scripts/lib/tui/fleet-extension.mjs", "scripts/lib/tui/process-fleet-view.mjs"]) {
    const source = await readFile(path.join(root, relative), "utf8");
    assert.doesNotMatch(source, /lib\/runtime|\.\.\/runtime/);
  }
});
