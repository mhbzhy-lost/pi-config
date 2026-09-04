import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { installAcceptanceEvidence } from "../packages/pi-subagents-enhanced/child-extensions/acceptance-evidence.ts";

const sha = (char) => char.repeat(64);
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
  installAcceptanceEvidence(pi, { client: { submitAcceptanceEvidence() {} } });
  const schema = pi.tools[0].parameters;
  assert.equal(accepts(schema, input), true);
  for (const value of [{}, { ...input, identity: {} }, { ...input, extra: true }, { ...input, commandsRun: [{ ...input.commandsRun[0], outputRef: "secret-token" }] }]) {
    assert.equal(accepts(schema, value), false);
  }
});

test("coding child submits raw evidence through the authenticated broker without writing cwd", async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "child-evidence-no-workspace-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const calls = [];
  const pi = child();
  installAcceptanceEvidence(pi, { client: { async submitAcceptanceEvidence(value) { calls.push(value); return { fingerprint: sha("f"), path: `/async/acceptance-evidence/${sha("f")}.yaml` }; } } });

  const result = await pi.tools[0].execute("call", input);

  assert.equal(result.isError, false);
  assert.deepEqual(calls, [input]);
  assert.deepEqual(result.details, { fingerprint: sha("f"), path: `/async/acceptance-evidence/${sha("f")}.yaml` });
  assert.deepEqual(await readdir(cwd), []);
});

test("child evidence exposes broker failures and releases its tool on shutdown", async () => {
  const pi = child();
  const runtime = installAcceptanceEvidence(pi, { retryWindowMs: 0, client: { async submitAcceptanceEvidence() { throw Object.assign(new Error("Goal acceptance authority is not ready"), { code: "CONTEXT_NOT_READY" }); } } });
  assert.deepEqual(pi.tools.map((tool) => tool.name), ["submit_acceptance_evidence"]);
  const failed = await pi.tools[0].execute("call", input);
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /authority is not ready/);
  await runtime.dispose();
  assert.equal(runtime.closed, true);
  assert.equal((await pi.tools[0].execute("call", input)).isError, true);
});
