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

test("Standalone Plan Host runtime and its test are absent", async () => {
  for (const relative of ["scripts/lib/plan/plan-host-runtime.mjs", "test/plan-host-runtime.test.mjs"]) await missing(relative);
});

test("unused Parent lifecycle source and test are absent", async () => {
  for (const relative of ["scripts/lib/plan/parent-lifecycle.mjs", "test/parent-lifecycle.test.mjs"]) await missing(relative);
});

test("Launcher no longer retains Host implementation identifiers", async () => {
  const source = await readFile(path.join(root, "scripts/lib/plan/plan-launcher-extension.mjs"), "utf8");
  assert.doesNotMatch(source, /spawnPlanRunner|processIdentity|host-handle\.json|pi-plan-host-keeper/);
});

test("Widget no longer retains Host implementation identifiers", async () => {
  const widget = await readFile(path.join(root, "scripts/lib/plan/tui/plan-widget.mjs"), "utf8");
  assert.match(widget, /status\.json/);
  assert.doesNotMatch(widget, /host-handle\.json|hostRunId|Host:/);
});

test("Plan runtime tools no longer retain Standalone Runner terminology", async () => {
  const source = await readFile(path.join(root, "scripts/lib/plan/plan-runtime-tools.mjs"), "utf8");
  assert.doesNotMatch(source, /Standalone Plan Runner/);
});

test("Widget only projects status and broker-owned Executor facts", async () => {
  const widget = await readFile(path.join(root, "scripts/lib/plan/tui/plan-widget.mjs"), "utf8");
  assert.match(widget, /executorRuns/);
  assert.doesNotMatch(widget, /host-handle|hostRunId|Host:/i);
});

test("flat runtime architecture document states the six retirement boundaries", async () => {
  const source = await readFile(path.join(root, "docs/architecture/plan-runner-flat-runtime.md"), "utf8");
  for (const term of ["topology", "lifecycle", "dispatch", "authorization", "Supervisor", "retirement"]) assert.match(source, new RegExp(term, "i"));
});

test("capsule documentation no longer describes the retired Host topology", async () => {
  const source = await readFile(path.join(root, "docs/pi-plan-execution-capsule.md"), "utf8");
  assert.doesNotMatch(source, /thin Host|Standalone runner|host handle/i);
});

test("architecture audit preserves facts and appends its superseding decision", async () => {
  const source = await readFile(path.join(root, "docs/audits/2026-07-29-plan-runner-architecture-audit.md"), "utf8");
  assert.match(source, /Superseding Decision/);
  assert.match(source, /audit/i);
});

test("remaining fleet modules do not import the retired runtime directory", async () => {
  for (const relative of ["scripts/lib/tui/fleet-extension.mjs", "scripts/lib/tui/process-fleet-view.mjs"]) {
    const source = await readFile(path.join(root, relative), "utf8");
    assert.doesNotMatch(source, /lib\/runtime|\.\.\/runtime/);
  }
});
