import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

const SHA256_RE = /^[0-9a-f]{64}$/;
const PRACTICE_PROFILE_MARKER_RE = /^Practice-Profile-SHA256:\s*([0-9a-f]{64})\s*$/m;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJsonSha256(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function parseJsonLines(filePath) {
  const records = [];
  for (const [index, line] of readFileSync(filePath, "utf8").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`${path.basename(filePath)}:${index + 1} is not valid JSON: ${error.message}`);
    }
  }
  return records;
}

function isGoalRelative(rawPath) {
  if (typeof rawPath !== "string" || !rawPath) return false;
  const parsed = path.posix.normalize(rawPath.replaceAll("\\", "/"));
  return !path.isAbsolute(rawPath) && parsed !== ".." && !parsed.startsWith("../");
}

export function auditAmendmentAuthorizations(goalRoot) {
  const errors = [];
  const root = path.resolve(goalRoot);
  const amendmentsPath = path.join(root, "amendments.jsonl");
  if (!existsSync(amendmentsPath)) return ["amendments.jsonl does not exist"];

  let records;
  try {
    records = parseJsonLines(amendmentsPath);
  } catch (error) {
    return [error.message];
  }

  const rootReal = realpathSync(root);
  for (const [index, record] of records.entries()) {
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const authorization = record.authorization;
    if (authorization == null) {
      if (record.status === "applied" && record.risk === "high") {
        errors.push(`amendments.jsonl[${index}].authorization is required for applied high-risk amendment`);
      }
      continue;
    }
    if (typeof authorization !== "object" || Array.isArray(authorization)) {
      errors.push(`amendments.jsonl[${index}].authorization must be an object`);
      continue;
    }

    const artifact = authorization.artifact;
    if (!isGoalRelative(artifact)) {
      errors.push(`amendments.jsonl[${index}].authorization.artifact must be goal-relative`);
      continue;
    }
    const artifactPath = path.resolve(root, artifact);
    if (!existsSync(artifactPath)) {
      errors.push(`amendments.jsonl[${index}].authorization artifact does not exist: ${artifact}`);
      continue;
    }

    const artifactReal = realpathSync(artifactPath);
    if (artifactReal !== rootReal && !artifactReal.startsWith(`${rootReal}${path.sep}`)) {
      errors.push(`amendments.jsonl[${index}].authorization.artifact must be goal-relative`);
      continue;
    }
    if (!lstatSync(artifactReal).isFile()) {
      errors.push(`amendments.jsonl[${index}].authorization artifact is not a file: ${artifact}`);
      continue;
    }

    const expectedHash = authorization.artifactSha256;
    if (typeof expectedHash !== "string" || !SHA256_RE.test(expectedHash)) {
      errors.push(`amendments.jsonl[${index}].authorization.artifactSha256 must be lowercase SHA-256`);
      continue;
    }
    const actualHash = createHash("sha256").update(readFileSync(artifactReal)).digest("hex");
    if (actualHash !== expectedHash) {
      errors.push(`amendments.jsonl[${index}].authorization artifact hash mismatch: ${artifact}`);
    }
  }

  return errors;
}

export function auditPracticeProfileSync(goalRoot) {
  const errors = [];
  const root = path.resolve(goalRoot);
  const statePath = path.join(root, "state.json");
  const contractPath = path.join(root, "goal-contract.md");
  if (!existsSync(statePath)) errors.push("state.json does not exist");
  if (!existsSync(contractPath)) errors.push("goal-contract.md does not exist");
  if (errors.length > 0) return errors;

  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (error) {
    return [`state.json is not valid JSON: ${error.message}`];
  }
  const practiceProfile = state?.practice_profile;
  if (!practiceProfile || typeof practiceProfile !== "object" || Array.isArray(practiceProfile)) {
    return ["state.json.practice_profile must be an object"];
  }

  const actualHash = canonicalJsonSha256(practiceProfile);
  const declaredHash = state.practice_profile_sha256;
  if (typeof declaredHash !== "string" || !SHA256_RE.test(declaredHash)) {
    errors.push("state.json.practice_profile_sha256 must be lowercase SHA-256");
  } else if (declaredHash !== actualHash) {
    errors.push("state.json practice profile state hash mismatch");
  }

  const contract = readFileSync(contractPath, "utf8");
  const marker = contract.match(PRACTICE_PROFILE_MARKER_RE)?.[1];
  if (!marker) {
    errors.push("goal-contract.md practice profile marker is missing or invalid");
  } else if (marker !== actualHash) {
    errors.push("goal-contract.md practice profile contract marker mismatch");
  }

  return errors;
}

export function auditGoalContractIntegrity(goalRoot) {
  return [
    ...auditAmendmentAuthorizations(goalRoot),
    ...auditPracticeProfileSync(goalRoot),
  ];
}
