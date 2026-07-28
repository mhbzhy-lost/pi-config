import { constants } from "node:fs";
import { access, lstat, open, readFile } from "node:fs/promises";
import path from "node:path";

const MAX_ATTEMPT_RESULT_BYTES = 64 * 1024;
const BLOCKER_CODE = /^[a-z0-9][a-z0-9:_-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const STABLE_FIELDS = [
  "runId",
  "sessionId",
  "state",
  "asyncDir",
  "cwd",
  "pid",
  "startedAt",
  "endedAt",
  "sessionFile",
  "outputFile",
  "results",
  "children",
  "model",
  "attemptedModels",
];

export async function readAttemptDisposition({ output, attemptId, taskId } = {}) {
  if (typeof output !== "string" || !output || typeof attemptId !== "string" || !attemptId
    || typeof taskId !== "string" || !taskId) {
    throw new Error("Attempt output identity is required");
  }
  let handle;
  try {
    handle = await open(output, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_ATTEMPT_RESULT_BYTES) return null;
    await handle.chmod(0o600);
    const raw = JSON.parse(await handle.readFile("utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || raw.status !== "blocked" || raw.attempt_id !== attemptId || raw.task_id !== taskId
      || raw.commit !== null || !Array.isArray(raw.changed_files) || raw.changed_files.length !== 0
      || !BLOCKER_CODE.test(raw.reason ?? "") || !Array.isArray(raw.blockers)
      || raw.blockers.length === 0 || raw.blockers.length > 32
      || raw.blockers.some((blocker) => typeof blocker !== "string" || !BLOCKER_CODE.test(blocker))
      || new Set(raw.blockers).size !== raw.blockers.length
      || raw.blockers.some((blocker, index) => index > 0 && raw.blockers[index - 1] > blocker)) {
      return null;
    }
    const hasArtifact = Object.hasOwn(raw, "artifact");
    if (hasArtifact && (!raw.artifact || typeof raw.artifact !== "object" || Array.isArray(raw.artifact))) {
      return null;
    }
    const evidenceSha256 = hasArtifact ? raw.artifact.sha256 : undefined;
    if (hasArtifact && (typeof evidenceSha256 !== "string" || !SHA256.test(evidenceSha256))) {
      return null;
    }
    return {
      status: "blocked",
      reason: raw.reason,
      blockers: [...raw.blockers],
      ...(evidenceSha256 ? { evidenceSha256 } : {}),
    };
  } catch (error) {
    if (["ENOENT", "ELOOP"].includes(error?.code) || error instanceof SyntaxError) return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function readRuntimeArtifacts({ artifactDir, binding } = {}) {
  const statusFile = path.join(artifactDir, "status.json");
  const eventsFile = path.join(artifactDir, "events.jsonl");
  const status = await readJson(statusFile, normalizeStatus(artifactDir, binding));
  const eventLog = await readEventLog(eventsFile);
  const results = await readResults(artifactDir, status.value?.results ?? [], binding);

  return {
    artifactDir,
    status,
    events: eventLog.events,
    eventsTransient: eventLog.transient,
    results,
  };
}

async function readJson(file, normalize) {
  try {
    return { kind: "stable", value: normalize(JSON.parse(await readFile(file, "utf8"))) };
  } catch (error) {
    if (error.code === "ENOENT") return { kind: "missing", value: null };
    if (error instanceof SyntaxError) return { kind: "transient", value: null };
    throw error;
  }
}

function bindingMismatch(field, expected, actual) {
  return Object.assign(new Error(`Runtime artifact ${field} does not match execution binding`), {
    code: "RUNTIME_ARTIFACT_BINDING_MISMATCH",
    detail: { field, expected, actual },
  });
}

function normalizeStatus(artifactDir, binding) {
  return (raw) => {
    if (raw?.asyncDir !== undefined && path.resolve(raw.asyncDir) !== path.resolve(artifactDir)) {
      throw bindingMismatch("asyncDir", path.resolve(artifactDir), path.resolve(raw.asyncDir));
    }
    if (binding) {
      for (const field of ["runId", "sessionId", "cwd"]) {
        if (typeof binding[field] !== "string" || raw?.[field] !== binding[field]) {
          throw bindingMismatch(field, binding[field], raw?.[field]);
        }
      }
    }
    const steps = Array.isArray(raw?.steps) ? raw.steps : [];
    const singleStep = steps.length === 1 ? steps[0] : undefined;
    const value = {};
    for (const field of STABLE_FIELDS) value[field] = raw?.[field];
    value.model ??= singleStep?.model;
    value.attemptedModels ??= singleStep?.attemptedModels;
    value.sessionFile ??= singleStep?.sessionFile;
    if (!Array.isArray(value.children)) {
      value.children = steps.flatMap((step) => Array.isArray(step?.children) ? step.children : []);
    }
    value.asyncDir = artifactDir;
    value.sessionFile = resolveReference(artifactDir, value.sessionFile);
    value.outputFile = resolveReference(artifactDir, value.outputFile);
    value.results = Array.isArray(value.results) ? value.results.map(normalizeResult) : [];
    value.children = Array.isArray(value.children) ? value.children.map((child) => normalizeChild(artifactDir, child)) : [];
    value.attemptedModels = Array.isArray(value.attemptedModels) ? value.attemptedModels : [];
    for (const field of ["runId", "sessionId", "state", "cwd", "pid", "startedAt", "endedAt", "model"]) value[field] ??= null;
    return value;
  };
}

function normalizeResult(result) {
  return pick(result, ["runId", "sessionId", "state", "asyncDir", "sessionFile", "outputFile", "model", "attemptedModels"]);
}

function normalizeChild(artifactDir, child) {
  const normalized = pick(child, STABLE_FIELDS);
  if (normalized.runId === undefined && typeof child?.id === "string") normalized.runId = child.id;
  if (normalized.sessionFile !== undefined) normalized.sessionFile = resolveReference(artifactDir, normalized.sessionFile);
  if (normalized.outputFile !== undefined) normalized.outputFile = resolveReference(artifactDir, normalized.outputFile);
  return normalized;
}

function pick(value, fields) {
  const result = {};
  for (const field of fields) if (value?.[field] !== undefined) result[field] = value[field];
  return result;
}

function resolveReference(artifactDir, reference) {
  return typeof reference === "string" && reference !== "" ? path.resolve(artifactDir, reference) : null;
}

async function readEventLog(file) {
  let content;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { events: [], transient: false };
    throw error;
  }
  const complete = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n").slice(0, -1);
  const events = [];
  for (const line of complete) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === "child.started") events.push(pick(event, ["type", "runId"]));
    } catch {
      // A malformed committed line is non-authoritative, like an unknown event.
    }
  }
  return { events, transient: !content.endsWith("\n") && content !== "" };
}

async function authorizedOutputFile(outputFile, binding) {
  if (!binding?.output) return outputFile;
  const expected = path.resolve(binding.output);
  if (outputFile !== expected) throw bindingMismatch("output", expected, outputFile);
  try {
    const metadata = await lstat(outputFile);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw bindingMismatch("output", expected, outputFile);
    }
  } catch (error) {
    if (error?.code === "ENOENT") return outputFile;
    throw error;
  }
  return outputFile;
}

async function readResults(artifactDir, results, binding) {
  return Promise.all(results.map(async (result) => {
    const outputFile = resolveReference(artifactDir, result.outputFile);
    if (!outputFile) return { outputFile: null, exists: false, value: null };
    try {
      await authorizedOutputFile(outputFile, binding);
      await access(outputFile);
      return { outputFile, exists: true, value: await readJson(outputFile, (value) => value) };
    } catch (error) {
      if (error.code === "ENOENT") return { outputFile, exists: false, value: null };
      if (error.code === "RUNTIME_ARTIFACT_BINDING_MISMATCH" && error.detail?.field === "output") {
        error.code = "RUNTIME_ARTIFACT_OUTPUT_MISMATCH";
      }
      throw error;
    }
  }));
}
