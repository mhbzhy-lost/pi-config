import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_CONTRACT_ARRAY_ITEMS, MAX_CONTRACT_STRING_BYTES } from "./contract-limits.ts";
import { normalizeRepoRelativePosixPath } from "./repo-path.ts";

const TOP_KEYS = ["identity", "criteria", "commandsRun", "changedFiles"];
const IDENTITY_KEYS = ["goalId", "taskId", "runId", "attempt", "contractHash", "head"] as const;
const CRITERION_KEYS = ["id", "status", "evidence"];
const COMMAND_KEYS = ["command", "result", "outputRef"];
const STATUSES = new Set<SettlementEvidenceStatus>(["satisfied", "not-satisfied", "not-applicable"]);
const RESULTS = new Set<SettlementEvidenceCommandResult>(["passed", "failed"]);
const SHA256_REF = /^(?:sha256:[a-f0-9]{64}|cas:\/\/sha256\/[a-f0-9]{64})$/;

export type SettlementEvidenceStatus = "satisfied" | "not-satisfied" | "not-applicable";
export type SettlementEvidenceCommandResult = "passed" | "failed";
export type SettlementEvidenceOutcome = "succeeded" | "failed";

export interface SettlementEvidenceIdentity {
  readonly goalId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly contractHash: string;
  readonly head: string;
}

export interface SettlementEvidenceCriterion {
  readonly id: string;
  readonly status: SettlementEvidenceStatus;
  readonly evidence: readonly string[];
}

export interface SettlementEvidenceCommand {
  readonly command: string;
  readonly result: SettlementEvidenceCommandResult;
  readonly outputRef: string;
}

export interface SettlementEvidence {
  readonly identity: SettlementEvidenceIdentity;
  readonly criteria: readonly SettlementEvidenceCriterion[];
  readonly commandsRun: readonly SettlementEvidenceCommand[];
  readonly changedFiles: readonly string[];
}

export interface SettlementEvidenceOptions {
  readonly expectedIdentity?: SettlementEvidenceIdentity;
  readonly expectedCriteria?: readonly (string | Pick<SettlementEvidenceCriterion, "id">)[];
  readonly outcome?: SettlementEvidenceOutcome;
}

export interface MaterializeSettlementEvidenceOptions extends SettlementEvidenceOptions {
  readonly directory: string;
}

type PlainObject = Record<string, unknown>;

function fail(message: string): never { throw new Error(message); }
function plain(value: unknown): value is PlainObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
function strictObject(value: unknown, label: string, keys: readonly string[]): PlainObject {
  if (!plain(value)) fail(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${label} contains unknown field ${key}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${label} is missing required field ${key}`);
  return value;
}
function string(value: unknown, label: string, maxBytes = MAX_CONTRACT_STRING_BYTES): string {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`);
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, "utf8") > maxBytes) fail(`${label} exceeds ${maxBytes} bytes`);
  return normalized;
}
function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  if (value.length > MAX_CONTRACT_ARRAY_ITEMS) fail(`${label} exceeds ${MAX_CONTRACT_ARRAY_ITEMS} items`);
  return value;
}
function immutableRef(value: unknown, label: string): string {
  const ref = string(value, label);
  if (!SHA256_REF.test(ref)) fail(`${label} must be an immutable reference, not a relative ref`);
  return ref;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!plain(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
function freeze<T>(value: T): Readonly<T> {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}
function errorCode(error: unknown): unknown {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return undefined;
  return Reflect.get(error, "code");
}
function isStatus(value: string): value is SettlementEvidenceStatus { return STATUSES.has(value as SettlementEvidenceStatus); }
function isCommandResult(value: string): value is SettlementEvidenceCommandResult { return RESULTS.has(value as SettlementEvidenceCommandResult); }
function expectedIds(value: SettlementEvidenceOptions["expectedCriteria"]): string[] | undefined {
  if (value === undefined) return undefined;
  const ids = list(value, "options.expectedCriteria").map((item, index) => string(typeof item === "string" ? item : plain(item) ? item.id : undefined, `options.expectedCriteria[${index}].id`, 160));
  if (!ids.length || new Set(ids).size !== ids.length) fail("options.expectedCriteria must contain unique IDs");
  return ids.sort();
}
function normalizeIdentity(value: unknown, expected?: SettlementEvidenceIdentity): SettlementEvidenceIdentity {
  const input = strictObject(value, "identity", IDENTITY_KEYS);
  const attempt = input.attempt;
  if (typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1) fail("identity.attempt must be a positive safe integer");
  const normalized: SettlementEvidenceIdentity = {
    goalId: string(input.goalId, "identity.goalId", 160), taskId: string(input.taskId, "identity.taskId", 160),
    runId: string(input.runId, "identity.runId", 160), attempt,
    contractHash: string(input.contractHash, "identity.contractHash", 64), head: string(input.head, "identity.head", 40),
  };
  if (!/^[a-f0-9]{64}$/.test(normalized.contractHash)) fail("identity.contractHash must be SHA-256 hex");
  if (!/^[a-f0-9]{40}$/.test(normalized.head)) fail("identity.head must be a full Git SHA");
  if (expected !== undefined) {
    const normalizedExpected = normalizeIdentity(expected);
    for (const key of IDENTITY_KEYS) if (normalized[key] !== normalizedExpected[key]) fail(`identity.${key} does not match expected identity`);
  }
  return normalized;
}

/** Strictly decode untrusted executor or reviewer settlement evidence. */
export function normalizeSettlementEvidence(input: unknown, options: SettlementEvidenceOptions = {}): Readonly<SettlementEvidence> {
  const evidence = strictObject(input, "evidence", TOP_KEYS);
  const identity = normalizeIdentity(evidence.identity, options.expectedIdentity);
  const requiredIds = expectedIds(options.expectedCriteria);
  const criteria: SettlementEvidenceCriterion[] = list(evidence.criteria, "criteria").map((item, index) => {
    const criterion = strictObject(item, `criteria[${index}]`, CRITERION_KEYS);
    const status = string(criterion.status, `criteria[${index}].status`, 32);
    if (!isStatus(status)) fail(`criteria[${index}].status is invalid`);
    const refs = list(criterion.evidence, `criteria[${index}].evidence`).map((ref, refIndex) => immutableRef(ref, `criteria[${index}].evidence[${refIndex}]`));
    if (!refs.length) fail(`criteria[${index}].evidence must not be empty`);
    if (new Set(refs).size !== refs.length) fail(`criteria[${index}].evidence contains duplicate references`);
    return { id: string(criterion.id, `criteria[${index}].id`, 160), status, evidence: [...refs].sort() };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (!criteria.length || new Set(criteria.map((item) => item.id)).size !== criteria.length) fail("criteria must contain unique IDs");
  if (requiredIds && (criteria.length !== requiredIds.length || criteria.some((item, index) => item.id !== requiredIds[index]))) fail("criteria must exactly cover expected criteria");
  const commandsRun: SettlementEvidenceCommand[] = list(evidence.commandsRun, "commandsRun").map((item, index) => {
    const command = strictObject(item, `commandsRun[${index}]`, COMMAND_KEYS);
    const result = string(command.result, `commandsRun[${index}].result`, 16);
    if (!isCommandResult(result)) fail(`commandsRun[${index}].result is invalid`);
    return { command: string(command.command, `commandsRun[${index}].command`), result, outputRef: immutableRef(command.outputRef, `commandsRun[${index}].outputRef`) };
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const changedFiles = list(evidence.changedFiles, "changedFiles").map((file, index) => normalizeRepoRelativePosixPath(string(file, `changedFiles[${index}]`), `changedFiles[${index}]`)).sort();
  if (new Set(changedFiles).size !== changedFiles.length) fail("changedFiles contains duplicates");
  if (options.outcome !== undefined) {
    if (options.outcome !== "succeeded" && options.outcome !== "failed") fail("options.outcome is invalid");
    const allSatisfied = criteria.every((item) => item.status === "satisfied");
    if ((options.outcome === "succeeded") !== allSatisfied) fail(`criteria statuses conflict with ${options.outcome} outcome`);
  }
  return freeze({ identity, criteria, commandsRun, changedFiles });
}

export function fingerprintSettlementEvidence(input: unknown, options: SettlementEvidenceOptions = {}): string {
  const normalized = normalizeSettlementEvidence(input, options);
  return createHash("sha256").update(JSON.stringify(canonical(normalized))).digest("hex");
}

/** Require independent producers to have no shared immutable evidence/output object. */
export function assertIndependentSettlementEvidence(first: unknown, second: unknown): Readonly<{ executor: Readonly<SettlementEvidence>; reviewer: Readonly<SettlementEvidence> }> {
  const left = normalizeSettlementEvidence(first);
  const right = normalizeSettlementEvidence(second, { expectedIdentity: left.identity, expectedCriteria: left.criteria.map((item) => item.id) });
  if (fingerprintSettlementEvidence(left, { expectedIdentity: left.identity, expectedCriteria: left.criteria.map((item) => item.id) }) === fingerprintSettlementEvidence(right, { expectedIdentity: left.identity, expectedCriteria: left.criteria.map((item) => item.id) })) fail("independent evidence must have different fingerprints");
  const refs = new Set([...left.criteria.flatMap((item) => item.evidence), ...left.commandsRun.map((item) => item.outputRef)]);
  for (const ref of [...right.criteria.flatMap((item) => item.evidence), ...right.commandsRun.map((item) => item.outputRef)]) if (refs.has(ref)) fail("independent evidence reuses immutable reference");
  return freeze({ executor: left, reviewer: right });
}

function yaml(value: unknown, indent = ""): string {
  if (Array.isArray(value)) return value.map((item) => `${indent}- ${plain(item) ? `\n${yaml(item, `${indent}  `)}` : JSON.stringify(item)}`).join("\n");
  if (!plain(value)) fail("YAML value must be an object or array");
  return Object.keys(value).sort().map((key) => {
    const item = value[key];
    return plain(item) || Array.isArray(item) ? `${indent}${key}:\n${yaml(item, `${indent}  `)}` : `${indent}${key}: ${JSON.stringify(item)}`;
  }).join("\n");
}

export function serializeSettlementEvidenceYaml(input: unknown, options: SettlementEvidenceOptions = {}): string {
  return `${yaml(normalizeSettlementEvidence(input, options))}\n`;
}

/** Atomically store only canonical references, never command output, under a content-addressed name. */
export async function materializeSettlementEvidence(input: unknown, { directory, ...options }: MaterializeSettlementEvidenceOptions): Promise<Readonly<{ fingerprint: string; path: string }>> {
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
    if (errorCode(error) !== "EEXIST") throw error;
    const existing = await readFile(target, "utf8");
    if (existing !== content) throw new Error("content-addressed settlement evidence collision");
    await unlink(temporary);
  }
  await chmod(target, 0o600);
  return freeze({ fingerprint, path: target });
}
