import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { installAcceptanceEvidence } from "../pi/child-extensions/acceptance-evidence.ts";

const sha = (char) => char.repeat(64);
const identity = { goalId: "goal-1", taskId: "task-1", attempt: 1, runId: "run-1", contractHash: sha("a"), head: "b".repeat(40) };
const input = { criteria: [{ id: "criterion-1", status: "satisfied", evidence: ["sha256:" + sha("1")] }], commandsRun: [{ command: "node --test", result: "passed", outputRef: "sha256:" + sha("2") }], changedFiles: ["test/example.mjs"], outcome: "succeeded" };

function child() { const tools = []; const handlers = new Map(); return { tools, registerTool(tool) { tools.push(tool); }, on(type, handler) { handlers.set(type, handler); } }; }

function accepts(schema, value) {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if ((schema.required ?? []).some((key) => !Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(schema.properties ?? {}, key))) return false;
    return Object.entries(schema.properties ?? {}).every(([key, child]) => !Object.hasOwn(value, key) || accepts(child, value[key]));
  }
  if (schema.type === "array") return Array.isArray(value) && (schema.minItems === undefined || value.length >= schema.minItems) && (schema.maxItems === undefined || value.length <= schema.maxItems) && value.every((item) => accepts(schema.items, item));
  if (schema.type === "string") return typeof value === "string" && (schema.minLength === undefined || value.length >= schema.minLength) && (schema.maxLength === undefined || value.length <= schema.maxLength) && (!schema.pattern || new RegExp(schema.pattern).test(value)) && (!schema.enum || schema.enum.includes(value));
  return schema.type === "integer" ? Number.isInteger(value) && (schema.minimum === undefined || value >= schema.minimum) : Boolean(schema.enum?.includes(value));
}

test("model-facing schema accepts bound evidence fields only", () => {
  const pi = child();
  installAcceptanceEvidence(pi, { identity, expectedCriteria: ["criterion-1"], cwd: "/tmp" });
  const schema = pi.tools[0].parameters;
  assert.equal(accepts(schema, input), true);
  for (const value of [
    {},
    { ...input, identity },
    { ...input, extra: true },
    { ...input, commandsRun: [{ ...input.commandsRun[0], outputRef: "secret-token" }] },
  ]) assert.equal(accepts(schema, value), false);
});

test("coding child injects its exact identity into canonical evidence", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "child-evidence-"));
  const pi = child();
  installAcceptanceEvidence(pi, { identity, expectedCriteria: ["criterion-1"], cwd });
  assert.deepEqual(pi.tools.map((tool) => tool.name), ["submit_acceptance_evidence"]);
  const result = await pi.tools[0].execute("call", input);
  assert.equal(result.isError, false);
  assert.match(result.details.path, /[a-f0-9]{64}\.yaml$/);
  const artifact = await readFile(result.details.path, "utf8");
  assert.match(artifact, /goalId: "goal-1"/);
  assert.match(artifact, /runId: "run-1"/);
  assert.equal((await stat(result.details.path)).mode & 0o777, 0o600);
});

test("child evidence rejects unsafe or contradictory input and releases its tool on shutdown", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "child-evidence-"));
  const pi = child();
  const runtime = installAcceptanceEvidence(pi, { identity, expectedCriteria: ["criterion-1"], cwd });
  for (const value of [
    { ...input, identity },
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
