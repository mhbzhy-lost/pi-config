import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertIndependentSettlementEvidence,
  fingerprintSettlementEvidence,
  materializeSettlementEvidence,
  normalizeSettlementEvidence,
  serializeSettlementEvidenceYaml,
} from "../src/goal-engine/settlement-evidence.ts";

const sha = (char) => char.repeat(64);
const identity = { goalId: "goal-1", taskId: "task-1", runId: "run-1", attempt: 1, contractHash: sha("a"), head: "b".repeat(40) };
const expectedCriteria = ["criterion-a", "criterion-b"];
function evidence(overrides = {}) {
  return {
    identity,
    criteria: [
      { id: "criterion-b", status: "satisfied", evidence: ["sha256:" + sha("2")] },
      { id: "criterion-a", status: "satisfied", evidence: ["sha256:" + sha("1")] },
    ],
    commandsRun: [{ command: "node --test", result: "passed", outputRef: "sha256:" + sha("3") }],
    changedFiles: ["src/goal-engine/settlement-evidence.mjs"],
    ...overrides,
  };
}

const options = { expectedIdentity: identity, expectedCriteria, outcome: "succeeded" };

test("normalizes exact settlement evidence and fingerprints semantic canonical form", () => {
  const normalized = normalizeSettlementEvidence(evidence(), options);
  assert.deepEqual(normalized.criteria.map(({ id }) => id), ["criterion-a", "criterion-b"]);
  assert.equal(normalized.changedFiles[0], "src/goal-engine/settlement-evidence.mjs");
  assert.equal(fingerprintSettlementEvidence(evidence(), options), fingerprintSettlementEvidence(evidence({ criteria: [...evidence().criteria].reverse() }), options));
});

test("fails closed for coverage, unknown fields, sizes, relative refs, and outcome conflicts", () => {
  assert.throws(() => normalizeSettlementEvidence(evidence({ criteria: evidence().criteria.slice(0, 1) }), options), /exactly cover/);
  assert.throws(() => normalizeSettlementEvidence(evidence({ unexpected: true }), options), /unknown field/);
  assert.throws(() => normalizeSettlementEvidence(evidence({ commandsRun: [{ command: "x".repeat(5000), result: "passed", outputRef: "sha256:" + sha("3") }] }), options), /exceeds/);
  assert.throws(() => normalizeSettlementEvidence(evidence({ criteria: [{ id: "criterion-a", status: "satisfied", evidence: ["relative/ref"] }, evidence().criteria[0]] }), options), /immutable reference/);
  assert.throws(() => normalizeSettlementEvidence(evidence({ criteria: [{ ...evidence().criteria[0], status: "not-satisfied" }, evidence().criteria[1]] }), options), /succeeded/);
});

test("does not regard reordered, relabeled, or ref-reused evidence as an independent path", () => {
  const executor = normalizeSettlementEvidence(evidence(), options);
  assert.throws(() => assertIndependentSettlementEvidence(executor, executor), /different/);
  const relabeled = evidence({ criteria: [{ ...evidence().criteria[0], id: "other" }, evidence().criteria[1]] });
  assert.throws(() => normalizeSettlementEvidence(relabeled, options), /exactly cover/);
  const reviewer = normalizeSettlementEvidence(evidence({
    criteria: evidence().criteria.map((item) => ({ ...item, evidence: ["sha256:" + sha(item.id === "criterion-a" ? "4" : "5")] })),
    commandsRun: [{ command: "node --test", result: "passed", outputRef: "sha256:" + sha("6") }],
  }), options);
  assert.doesNotThrow(() => assertIndependentSettlementEvidence(executor, reviewer));
  assert.throws(() => assertIndependentSettlementEvidence(executor, normalizeSettlementEvidence(evidence({ criteria: reviewer.criteria, commandsRun: executor.commandsRun }), options)), /reuses immutable reference/);
});

test("serializes stable YAML and materializes it content-addressed with mode 0600", async () => {
  const normalized = normalizeSettlementEvidence(evidence(), options);
  const yaml = serializeSettlementEvidenceYaml(normalized);
  assert.equal(yaml, serializeSettlementEvidenceYaml(normalizeSettlementEvidence(evidence({ criteria: [...evidence().criteria].reverse() }), options)));
  assert.match(yaml, /outputRef:/);
  const directory = await mkdtemp(path.join(os.tmpdir(), "settlement-evidence-"));
  const receipt = await materializeSettlementEvidence(normalized, { directory });
  assert.match(receipt.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(receipt.path, "utf8"), yaml);
  assert.equal((await stat(receipt.path)).mode & 0o777, 0o600);
});
