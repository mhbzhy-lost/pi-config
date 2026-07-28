import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as runtimeArtifacts from "../scripts/lib/plan/runtime-artifacts.mjs";

const { readRuntimeArtifacts } = runtimeArtifacts;

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
      cwd: null,
      pid: null,
      startedAt: null,
      endedAt: null,
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

test("validates authoritative status identity against the execution binding", async () => {
  await withArtifacts(async (artifactDir) => {
    await writeFile(path.join(artifactDir, "status.json"), JSON.stringify({
      runId: "run-1",
      sessionId: "session-1",
      state: "running",
      cwd: "/attempts/attempt-1",
      pid: 123,
      startedAt: 1000,
      endedAt: null,
    }));

    const artifacts = await readRuntimeArtifacts({
      artifactDir,
      binding: { runId: "run-1", sessionId: "session-1", cwd: "/attempts/attempt-1" },
    });
    assert.equal(artifacts.status.value.cwd, "/attempts/attempt-1");
    assert.equal(artifacts.status.value.pid, 123);
    assert.equal(artifacts.status.value.startedAt, 1000);
    assert.equal(artifacts.status.value.endedAt, null);

    for (const binding of [
      { runId: "other", sessionId: "session-1", cwd: "/attempts/attempt-1" },
      { runId: "run-1", sessionId: "other", cwd: "/attempts/attempt-1" },
      { runId: "run-1", sessionId: "session-1", cwd: "/attempts/other" },
    ]) {
      await assert.rejects(
        readRuntimeArtifacts({ artifactDir, binding }),
        (error) => error.code === "RUNTIME_ARTIFACT_BINDING_MISMATCH",
      );
    }
  });
});

test("rejects a status artifact that declares another async directory", async () => {
  await withArtifacts(async (artifactDir) => {
    await writeFile(path.join(artifactDir, "status.json"), JSON.stringify({
      runId: "run-1",
      sessionId: "session-1",
      cwd: "/attempts/attempt-1",
      asyncDir: "/forged/async-dir",
    }));
    await assert.rejects(
      readRuntimeArtifacts({
        artifactDir,
        binding: { runId: "run-1", sessionId: "session-1", cwd: "/attempts/attempt-1" },
      }),
      (error) => error.code === "RUNTIME_ARTIFACT_BINDING_MISMATCH",
    );
  });
});

test("reads only the output path authorized by the execution binding", async () => {
  await withArtifacts(async (artifactDir) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "pi-runtime-output-"));
    try {
      const authorized = path.join(outside, "authorized.json");
      const forged = path.join(outside, "forged.json");
      await writeFile(authorized, JSON.stringify({ ok: true }));
      await writeFile(forged, JSON.stringify({ secret: true }));
      const status = {
        runId: "run-1",
        sessionId: "session-1",
        state: "complete",
        cwd: "/attempts/attempt-1",
        results: [{ outputFile: forged, state: "complete" }],
      };
      await writeFile(path.join(artifactDir, "status.json"), JSON.stringify(status));
      const binding = { runId: "run-1", sessionId: "session-1", cwd: "/attempts/attempt-1", output: authorized };

      await assert.rejects(
        readRuntimeArtifacts({ artifactDir, binding }),
        (error) => error.code === "RUNTIME_ARTIFACT_OUTPUT_MISMATCH",
      );

      await writeFile(path.join(artifactDir, "status.json"), JSON.stringify({
        ...status,
        results: [{ outputFile: authorized, state: "complete" }],
      }));
      const artifacts = await readRuntimeArtifacts({ artifactDir, binding });
      assert.deepEqual(artifacts.results[0].value, { kind: "stable", value: { ok: true } });

      const linked = path.join(outside, "linked.json");
      await symlink(forged, linked);
      await writeFile(path.join(artifactDir, "status.json"), JSON.stringify({
        ...status,
        results: [{ outputFile: linked, state: "complete" }],
      }));
      await assert.rejects(
        readRuntimeArtifacts({ artifactDir, binding: { ...binding, output: linked } }),
        (error) => error.code === "RUNTIME_ARTIFACT_OUTPUT_MISMATCH",
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
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

test("reads the bounded structured blocked disposition written to the authoritative Attempt output", async () => {
  assert.equal(typeof runtimeArtifacts.readAttemptDisposition, "function");
  await withArtifacts(async (artifactDir) => {
    const output = path.join(artifactDir, "attempt-1.json");
    await writeFile(output, JSON.stringify({
      attempt_id: "attempt-1",
      task_id: "task-1",
      status: "blocked",
      reason: "real-module-candidates-not-ready",
      blockers: ["cocoapods", "tbctx7_code_auth"],
      artifact: {
        path: "materials/evidence/real-module-candidates.json",
        sha256: "a".repeat(64),
      },
      changed_files: [],
      commit: null,
    }));

    const disposition = await runtimeArtifacts.readAttemptDisposition({
      output,
      attemptId: "attempt-1",
      taskId: "task-1",
    });

    assert.deepEqual(disposition, {
      status: "blocked",
      reason: "real-module-candidates-not-ready",
      blockers: ["cocoapods", "tbctx7_code_auth"],
      evidenceSha256: "a".repeat(64),
    });
    assert.equal((await stat(output)).mode & 0o777, 0o600);
  });
});

test("rejects malformed blocked evidence instead of bypassing commit validation", async () => {
  await withArtifacts(async (artifactDir) => {
    const output = path.join(artifactDir, "attempt-1.json");
    const valid = {
      attempt_id: "attempt-1",
      task_id: "task-1",
      status: "blocked",
      reason: "real-module-candidates-not-ready",
      blockers: ["cocoapods"],
      changed_files: [],
      commit: null,
    };
    for (const artifact of ["not-an-object", null, {}]) {
      await writeFile(output, JSON.stringify({ ...valid, artifact }));
      assert.equal(await runtimeArtifacts.readAttemptDisposition({
        output,
        attemptId: "attempt-1",
        taskId: "task-1",
      }), null);
    }
  });
});
