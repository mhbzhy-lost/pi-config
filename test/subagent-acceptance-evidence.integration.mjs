import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { installAcceptanceEvidence } from "../pi/child-extensions/acceptance-evidence.ts";

const sha = (char) => char.repeat(64);
const identity = { goalId: "goal-1", taskId: "task-1", attempt: 1, runId: "run-1", contractHash: sha("a"), head: "b".repeat(40) };
const input = { identity, criteria: [{ id: "criterion-1", status: "satisfied", evidence: ["sha256:" + sha("1")] }], commandsRun: [{ command: "node --test", result: "passed", outputRef: "sha256:" + sha("2") }], changedFiles: ["test/example.mjs"], outcome: "succeeded" };

function child() { const tools = []; const handlers = new Map(); return { tools, registerTool(tool) { tools.push(tool); }, on(type, handler) { handlers.set(type, handler); } }; }

test("coding child materializes canonical evidence bound to its exact identity", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "child-evidence-"));
  const pi = child();
  installAcceptanceEvidence(pi, { identity, expectedCriteria: ["criterion-1"], cwd });
  assert.deepEqual(pi.tools.map((tool) => tool.name), ["submit_acceptance_evidence"]);
  const result = await pi.tools[0].execute("call", input);
  assert.equal(result.isError, false);
  assert.match(result.details.path, /[a-f0-9]{64}\.yaml$/);
  assert.match(await readFile(result.details.path, "utf8"), /goalId: "goal-1"/);
  assert.equal((await stat(result.details.path)).mode & 0o777, 0o600);
});

test("child evidence rejects unsafe or contradictory input and releases its tool on shutdown", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "child-evidence-"));
  const pi = child();
  const runtime = installAcceptanceEvidence(pi, { identity, expectedCriteria: ["criterion-1"], cwd });
  for (const value of [
    { ...input, extra: true },
    { ...input, criteria: [{ ...input.criteria[0], id: "unknown" }] },
    { ...input, changedFiles: ["test/a.mjs", "test/a.mjs"] },
    { ...input, changedFiles: ["/etc/passwd"] },
    { ...input, commandsRun: [{ ...input.commandsRun[0], outputRef: "secret-token" }] },
    { ...input, criteria: [{ ...input.criteria[0], status: "not-satisfied" }] },
  ]) assert.equal((await pi.tools[0].execute("call", value)).isError, true);
  await runtime.dispose();
  assert.equal(runtime.closed, true);
});
