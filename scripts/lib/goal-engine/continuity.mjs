import { createHash } from "node:crypto";
import path from "node:path";

const MAX_SNAPSHOT_BYTES = 2048;
const VALID_SOURCES = new Set(["user_intent", "mutation_gate", "compaction", "tool_error"]);
const VALID_CHECKPOINT_REASONS = new Set(["manual", "threshold", "overflow", "reload", "shutdown"]);

function fail(message) {
  throw new Error(`invalid continuity input: ${message}`);
}

function requiredString(value, location) {
  if (typeof value !== "string" || !value.trim()) fail(`${location} is required`);
  return value.trim();
}

function truncateUtf8(value, maxBytes) {
  const text = String(value);
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let result = "";
  for (const char of text) {
    if (Buffer.byteLength(result + char + "…", "utf8") > maxBytes) break;
    result += char;
  }
  return result + "…";
}

function redact(value) {
  return String(value)
    .replace(/\bAuthorization\s*:\s*Bearer\s+[^\s,;]+/gi, "Authorization: [REDACTED]")
    .replace(/\bAuthorization\s*:\s*[^\s,;]+/gi, "Authorization: [REDACTED]")
    .replace(/\bCookie\s*:\s*[^\s]+/gi, "Cookie: [REDACTED]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b[A-Za-z][A-Za-z0-9_]*(?:TOKEN|KEY)\s*=\s*[^\s,;]+/gi, (match) => `${match.split("=")[0].trim()}=[REDACTED]`);
}

function boundedPaths(paths, location) {
  if (!Array.isArray(paths)) fail(`${location} must be an array`);
  const normalized = paths.map((entry, index) => truncateUtf8(requiredString(entry, `${location}[${index}]`), 256));
  return [...new Set(normalized)].sort().slice(0, 32);
}

function taskValues(projection) {
  if (projection.tasks instanceof Map) return [...projection.tasks.values()];
  if (projection.tasks && typeof projection.tasks === "object") return Object.values(projection.tasks);
  return [];
}

function normalizedBoundary(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/").replace(/\/\*\*$/, "").replace(/\/$/, "");
}

function repoRelativePath(cwd, candidate) {
  const root = path.resolve(requiredString(cwd, "cwd"));
  const absolute = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(root, candidate);
  const relative = path.relative(root, absolute).replaceAll("\\", "/");
  if (!relative || relative === ".") return "";
  if (relative === ".." || relative.startsWith("../")) return null;
  return normalizedBoundary(relative);
}

function boundariesFor(projection) {
  return [...new Set([
    ...(Array.isArray(projection.scope) ? projection.scope : []),
    ...taskValues(projection).flatMap((task) => Array.isArray(task.writePaths) ? task.writePaths : []),
  ].map(normalizedBoundary).filter(Boolean))];
}

function intersects(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function resultForCandidates(candidates, selectedReason, ambiguousReason) {
  const ids = [...new Set(candidates.map((projection) => projection.goalId))].sort();
  if (ids.length === 1) return { status: "selected", goalId: ids[0], reason: selectedReason };
  if (ids.length > 1) return { status: "ambiguous", goalIds: ids, reason: ambiguousReason };
  return null;
}

export function selectContinuityCandidate({ projections, cwd, paths = [], sessionId } = {}) {
  if (!Array.isArray(projections)) fail("projections must be an array");
  const active = projections.filter((projection) => projection?.lifecycle === "active"
    && (projection.sessionBindings || [])[0]?.sessionId === sessionId
    && (projection.sessionBindings || [])[0]?.state === "watching");
  const activeResult = resultForCandidates(active, "unique_active", "multiple_active");
  if (activeResult) return activeResult;

  const watched = projections.filter((projection) => projection?.lifecycle === "completed"
    && (projection.sessionBindings || []).some((binding) => binding.sessionId === sessionId && binding.state === "watching"));
  const watchedResult = resultForCandidates(watched, "bound_completed", "multiple_bound_completed");
  if (watchedResult) return watchedResult;

  const relativePaths = boundedPaths(paths, "paths").map((candidate) => repoRelativePath(cwd, candidate)).filter((candidate) => candidate !== null);
  const pathMatches = projections.filter((projection) => projection?.lifecycle === "completed"
    && boundariesFor(projection).some((boundary) => relativePaths.some((candidate) => intersects(boundary, candidate))));
  const pathResult = resultForCandidates(pathMatches, "path_intersection", "multiple_path_matches");
  return pathResult || { status: "none", reason: "no_related_goal" };
}

export function buildSessionBinding({ projection, sessionId, leafId } = {}) {
  if (!projection?.goalId) fail("projection.goalId is required");
  return { sessionId: requiredString(sessionId, "sessionId"), leafId: requiredString(leafId, "leafId") };
}

export function buildDiscovery({ userText, userEntryId, paths = [], sessionId, source } = {}) {
  const entryId = requiredString(userEntryId, "userEntryId");
  const boundSessionId = requiredString(sessionId, "sessionId");
  const normalizedSource = requiredString(source, "source");
  if (!VALID_SOURCES.has(normalizedSource)) fail(`unsupported discovery source: ${normalizedSource}`);
  const summary = truncateUtf8(redact(requiredString(userText, "userText")).replace(/\s+/g, " "), 1200);
  const pathCandidates = boundedPaths(paths, "paths");
  const id = "obs-" + createHash("sha256")
    .update(JSON.stringify({ userEntryId: entryId, sessionId: boundSessionId, source: normalizedSource }))
    .digest("hex").slice(0, 24);
  const discovery = { id, summary, paths: [], source: normalizedSource, sessionId: boundSessionId, userEntryId: entryId };
  for (const candidate of pathCandidates) {
    const withCandidate = { ...discovery, paths: [...discovery.paths, candidate] };
    if (Buffer.byteLength(JSON.stringify(withCandidate), "utf8") <= MAX_SNAPSHOT_BYTES) discovery.paths.push(candidate);
  }
  return discovery;
}

export function buildContinuityCheckpoint({ projection, sessionId, reason, modifiedFiles = [], userEntryId } = {}) {
  if (!projection?.goalId || !Number.isSafeInteger(projection.epoch)) fail("projection goalId and epoch are required");
  const normalizedReason = requiredString(reason, "reason");
  if (!VALID_CHECKPOINT_REASONS.has(normalizedReason)) fail(`unsupported checkpoint reason: ${normalizedReason}`);
  const nextAction = truncateUtf8(redact(projection.nextAction || "Call goal_status before any Goal mutation"), 512);
  const checkpoint = {
    sessionId: requiredString(sessionId, "sessionId"),
    reason: normalizedReason,
    modifiedFiles: [],
    nextAction,
    userEntryId: userEntryId ? requiredString(userEntryId, "userEntryId") : null,
  };
  for (const candidate of boundedPaths(modifiedFiles, "modifiedFiles")) {
    const withCandidate = { ...checkpoint, modifiedFiles: [...checkpoint.modifiedFiles, candidate] };
    if (Buffer.byteLength(JSON.stringify(withCandidate), "utf8") <= MAX_SNAPSHOT_BYTES) checkpoint.modifiedFiles.push(candidate);
  }
  return checkpoint;
}

export function formatRecoveryInjection(projection) {
  if (!projection?.goalId || !Number.isSafeInteger(projection.epoch)) fail("projection goalId and epoch are required");
  const checkpoint = projection.continuity?.lastCheckpoint;
  const observations = Object.values(projection.continuity?.observations || {})
    .filter((observation) => observation.status === "untriaged")
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((observation) => `- ${observation.id}: ${truncateUtf8(redact(observation.summary), 256)}`);
  const lines = [
    `Goal recovery: ${projection.goalId} (epoch ${projection.epoch}).`,
    "Call goal_status before any Goal mutation; this recovery note is not authoritative state.",
    checkpoint ? `Checkpoint ${checkpoint.checkpointId || "unknown"}: ${checkpoint.reason}; next=${truncateUtf8(redact(checkpoint.nextAction || "goal_status"), 384)}` : "Checkpoint: none.",
    observations.length ? "Untriaged discoveries:" : "Untriaged discoveries: none.",
    ...observations,
  ];
  return truncateUtf8(lines.join("\n"), MAX_SNAPSHOT_BYTES);
}
