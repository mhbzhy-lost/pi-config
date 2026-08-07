import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_CONTRACT_ARRAY_ITEMS, MAX_CONTRACT_STRING_BYTES } from "./contract-limits.mjs";
import { normalizeRepoRelativePosixPath } from "./repo-path.mjs";

const TOP_KEYS = ["identity", "criteria", "commandsRun", "changedFiles"];
const IDENTITY_KEYS = ["goalId", "taskId", "runId", "attempt", "contractHash", "head"];
const CRITERION_KEYS = ["id", "status", "evidence"];
const COMMAND_KEYS = ["command", "result", "outputRef"];
const STATUSES = new Set(["satisfied", "not-satisfied", "not-applicable"]);
const RESULTS = new Set(["passed", "failed"]);
const SHA256_REF = /^(?:sha256:[a-f0-9]{64}|cas:\/\/sha256\/[a-f0-9]{64})$/;

function fail(message) { throw new Error(message); }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function strictObject(value, label, keys) {
  if (!plain(value)) fail(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${label} contains unknown field ${key}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${label} is missing required field ${key}`);
  return value;
}
function string(value, label, maxBytes = MAX_CONTRACT_STRING_BYTES) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`);
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, "utf8") > maxBytes) fail(`${label} exceeds ${maxBytes} bytes`);
  return normalized;
}
function list(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  if (value.length > MAX_CONTRACT_ARRAY_ITEMS) fail(`${label} exceeds ${MAX_CONTRACT_ARRAY_ITEMS} items`);
  return value;
}
function immutableRef(value, label) {
  const ref = string(value, label);
  if (!SHA256_REF.test(ref)) fail(`${label} must be an immutable reference, not a relative ref`);
  return ref;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!plain(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}
function expectedIds(value) {
  if (value === undefined) return undefined;
  const ids = list(value, "options.expectedCriteria").map((item, index) => string(typeof item === "string" ? item : item?.id, `options.expectedCriteria[${index}].id`, 160));
  if (!ids.length || new Set(ids).size !== ids.length) fail("options.expectedCriteria must contain unique IDs");
  return ids.sort();
}
function normalizeIdentity(value, expected) {
  strictObject(value, "identity", IDENTITY_KEYS);
  const normalized = {
    goalId: string(value.goalId, "identity.goalId", 160), taskId: string(value.taskId, "identity.taskId", 160),
    runId: string(value.runId, "identity.runId", 160), attempt: value.attempt,
    contractHash: string(value.contractHash, "identity.contractHash", 64), head: string(value.head, "identity.head", 40),
  };
  if (!Number.isSafeInteger(normalized.attempt) || normalized.attempt < 1) fail("identity.attempt must be a positive safe integer");
  if (!/^[a-f0-9]{64}$/.test(normalized.contractHash)) fail("identity.contractHash must be SHA-256 hex");
  if (!/^[a-f0-9]{40}$/.test(normalized.head)) fail("identity.head must be a full Git SHA");
  if (expected !== undefined) {
    const normalizedExpected = normalizeIdentity(expected);
    for (const key of IDENTITY_KEYS) if (normalized[key] !== normalizedExpected[key]) fail(`identity.${key} does not match expected identity`);
  }
  return normalized;
}

/** Strictly decode untrusted executor or reviewer settlement evidence. */
export function normalizeSettlementEvidence(input, options = {}) {
  strictObject(input, "evidence", TOP_KEYS);
  const identity = normalizeIdentity(input.identity, options.expectedIdentity);
  const requiredIds = expectedIds(options.expectedCriteria);
  const criteria = list(input.criteria, "criteria").map((item, index) => {
    strictObject(item, `criteria[${index}]`, CRITERION_KEYS);
    const status = string(item.status, `criteria[${index}].status`, 32);
    if (!STATUSES.has(status)) fail(`criteria[${index}].status is invalid`);
    const refs = list(item.evidence, `criteria[${index}].evidence`).map((ref, refIndex) => immutableRef(ref, `criteria[${index}].evidence[${refIndex}]`));
    if (!refs.length) fail(`criteria[${index}].evidence must not be empty`);
    if (new Set(refs).size !== refs.length) fail(`criteria[${index}].evidence contains duplicate references`);
    return { id: string(item.id, `criteria[${index}].id`, 160), status, evidence: [...refs].sort() };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (!criteria.length || new Set(criteria.map((item) => item.id)).size !== criteria.length) fail("criteria must contain unique IDs");
  if (requiredIds && (criteria.length !== requiredIds.length || criteria.some((item, index) => item.id !== requiredIds[index]))) fail("criteria must exactly cover expected criteria");
  const commandsRun = list(input.commandsRun, "commandsRun").map((item, index) => {
    strictObject(item, `commandsRun[${index}]`, COMMAND_KEYS);
    const result = string(item.result, `commandsRun[${index}].result`, 16);
    if (!RESULTS.has(result)) fail(`commandsRun[${index}].result is invalid`);
    return { command: string(item.command, `commandsRun[${index}].command`), result, outputRef: immutableRef(item.outputRef, `commandsRun[${index}].outputRef`) };
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const changedFiles = list(input.changedFiles, "changedFiles").map((file, index) => normalizeRepoRelativePosixPath(string(file, `changedFiles[${index}]`), `changedFiles[${index}]`)).sort();
  if (new Set(changedFiles).size !== changedFiles.length) fail("changedFiles contains duplicates");
  if (options.outcome !== undefined) {
    if (options.outcome !== "succeeded" && options.outcome !== "failed") fail("options.outcome is invalid");
    const allSatisfied = criteria.every((item) => item.status === "satisfied");
    if ((options.outcome === "succeeded") !== allSatisfied) fail(`criteria statuses conflict with ${options.outcome} outcome`);
  }
  return freeze({ identity, criteria, commandsRun, changedFiles });
}

export function fingerprintSettlementEvidence(input, options = {}) {
  const normalized = normalizeSettlementEvidence(input, options);
  return createHash("sha256").update(JSON.stringify(canonical(normalized))).digest("hex");
}

/** Require independent producers to have no shared immutable evidence/output object. */
export function assertIndependentSettlementEvidence(first, second) {
  const left = normalizeSettlementEvidence(first, { expectedIdentity: first?.identity, expectedCriteria: first?.criteria?.map((item) => item.id) });
  const right = normalizeSettlementEvidence(second, { expectedIdentity: left.identity, expectedCriteria: left.criteria.map((item) => item.id) });
  if (fingerprintSettlementEvidence(left, { expectedIdentity: left.identity, expectedCriteria: left.criteria.map((item) => item.id) }) === fingerprintSettlementEvidence(right, { expectedIdentity: left.identity, expectedCriteria: left.criteria.map((item) => item.id) })) fail("independent evidence must have different fingerprints");
  const refs = new Set([...left.criteria.flatMap((item) => item.evidence), ...left.commandsRun.map((item) => item.outputRef)]);
  for (const ref of [...right.criteria.flatMap((item) => item.evidence), ...right.commandsRun.map((item) => item.outputRef)]) if (refs.has(ref)) fail("independent evidence reuses immutable reference");
  return freeze({ executor: left, reviewer: right });
}

function yaml(value, indent = "") {
  if (Array.isArray(value)) return value.map((item) => `${indent}- ${plain(item) ? `\n${yaml(item, `${indent}  `)}` : JSON.stringify(item)}`).join("\n");
  return Object.keys(value).sort().map((key) => {
    const item = value[key];
    return plain(item) || Array.isArray(item) ? `${indent}${key}:\n${yaml(item, `${indent}  `)}` : `${indent}${key}: ${JSON.stringify(item)}`;
  }).join("\n");
}

export function serializeSettlementEvidenceYaml(input, options = {}) {
  return `${yaml(normalizeSettlementEvidence(input, options))}\n`;
}

/** Atomically store only canonical references, never command output, under a content-addressed name. */
export async function materializeSettlementEvidence(input, { directory, ...options } = {}) {
  const targetDirectory = string(directory, "options.directory");
  if (!path.isAbsolute(targetDirectory)) fail("options.directory must be absolute");
  const normalized = normalizeSettlementEvidence(input, options);
  const fingerprint = fingerprintSettlementEvidence(normalized, { expectedIdentity: normalized.identity, expectedCriteria: normalized.criteria.map((item) => item.id) });
  const content = serializeSettlementEvidenceYaml(normalized, { expectedIdentity: normalized.identity, expectedCriteria: normalized.criteria.map((item) => item.id) });
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  const target = path.join(targetDirectory, `${fingerprint}.yaml`);
  const temporary = path.join(targetDirectory, `.${fingerprint}.${randomUUID()}.tmp`);
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  try { await rename(temporary, target); } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readFile(target, "utf8");
    if (existing !== content) throw new Error("content-addressed settlement evidence collision");
    await unlink(temporary);
  }
  await chmod(target, 0o600);
  return freeze({ fingerprint, path: target });
}
