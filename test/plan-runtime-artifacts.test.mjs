import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readRuntimeArtifacts } from "../scripts/lib/plan/runtime-artifacts.mjs";

async function withArtifacts(fn) {
  const artifactDir = await mkdtemp(path.join(os.tmpdir(), "pi-runtime-artifacts-"));
  try {
    await fn(artifactDir);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
}

test("returns transient status for an atomically incomplete status file without inventing a terminal lifecycle", async () => {
  await withArtifacts(async (artifactDir) => {
    await writeFile(path.join(artifactDir, "status.json"), '{"state":"complete"');

    const artifacts = await readRuntimeArtifacts({ artifactDir });

    assert.equal(artifacts.artifactDir, artifactDir);
    assert.equal(artifacts.status.kind, "transient");
    assert.equal(artifacts.status.value, null);
  });
});

test("tolerates missing artifacts and keeps deleted result references as attempted work", async () => {
  await withArtifacts(async (artifactDir) => {
    await writeFile(path.join(artifactDir, "status.json"), JSON.stringify({
      runId: "run-1",
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      state: "complete",
      results: [{ outputFile: "results/deleted.json", state: "complete" }],
      text: "formatted TUI output must not become state",
      ignored: true,
    }));

    const artifacts = await readRuntimeArtifacts({ artifactDir });

    assert.equal(artifacts.status.kind, "stable");
    assert.deepEqual(artifacts.status.value, {
      runId: "run-1",
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      state: "complete",
      asyncDir: artifactDir,
      sessionFile: null,
      outputFile: null,
      results: [{ outputFile: "results/deleted.json", state: "complete" }],
      children: [],
      model: null,
      attemptedModels: [],
    });
    assert.deepEqual(artifacts.results, [{
      outputFile: path.join(artifactDir, "results/deleted.json"),
      exists: false,
      value: null,
    }]);
  });
});

test("reads only committed event lines and preserves a UUID session identity distinct from its file path", async () => {
  await withArtifacts(async (artifactDir) => {
    await mkdir(path.join(artifactDir, "sessions"));
    await writeFile(path.join(artifactDir, "status.json"), JSON.stringify({
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      sessionFile: "sessions/worker.json",
      children: [{ runId: "child-1", state: "running", unexpected: true }],
      model: "model-a",
      attemptedModels: ["model-a", "model-b"],
    }));
    await writeFile(path.join(artifactDir, "events.jsonl"), [
      JSON.stringify({ type: "child.started", runId: "child-1" }),
      JSON.stringify({ type: "future.event", data: { ignored: true } }),
      '{"type":"child.finished"',
    ].join("\n"));

    const artifacts = await readRuntimeArtifacts({ artifactDir });

    assert.equal(artifacts.status.value.sessionId, "550e8400-e29b-41d4-a716-446655440000");
    assert.equal(artifacts.status.value.sessionFile, path.join(artifactDir, "sessions/worker.json"));
    assert.deepEqual(artifacts.events, [{ type: "child.started", runId: "child-1" }]);
    assert.equal(artifacts.eventsTransient, true);
  });
});

test("projects stable single-step model and nested child fields from the real status shape", async () => {
  await withArtifacts(async (artifactDir) => {
    await writeFile(path.join(artifactDir, "status.json"), JSON.stringify({
      runId: "plan-run",
      state: "running",
      text: "must stay ignored",
      steps: [{
        model: "model-a",
        attemptedModels: ["model-a", "model-b"],
        sessionFile: "sessions/plan.jsonl",
        children: [{
          id: "nested-run",
          state: "complete",
          sessionFile: "sessions/nested.jsonl",
          unexpected: true,
        }],
      }],
    }));

    const artifacts = await readRuntimeArtifacts({ artifactDir });

    assert.equal(artifacts.status.value.model, "model-a");
    assert.deepEqual(artifacts.status.value.attemptedModels, ["model-a", "model-b"]);
    assert.equal(artifacts.status.value.sessionFile, path.join(artifactDir, "sessions/plan.jsonl"));
    assert.deepEqual(artifacts.status.value.children, [{
      runId: "nested-run",
      state: "complete",
      sessionFile: path.join(artifactDir, "sessions/nested.jsonl"),
    }]);
  });
});
