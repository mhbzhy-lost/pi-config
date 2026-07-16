import { access, readFile } from "node:fs/promises";
import path from "node:path";

const STABLE_FIELDS = [
  "runId",
  "sessionId",
  "state",
  "asyncDir",
  "sessionFile",
  "outputFile",
  "results",
  "children",
  "model",
  "attemptedModels",
];

export async function readRuntimeArtifacts({ artifactDir }) {
  const statusFile = path.join(artifactDir, "status.json");
  const eventsFile = path.join(artifactDir, "events.jsonl");
  const status = await readJson(statusFile, normalizeStatus(artifactDir));
  const eventLog = await readEventLog(eventsFile);
  const results = await readResults(artifactDir, status.value?.results ?? []);

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

function normalizeStatus(artifactDir) {
  return (raw) => {
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
    for (const field of ["runId", "sessionId", "state", "model"]) value[field] ??= null;
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

async function readResults(artifactDir, results) {
  return Promise.all(results.map(async (result) => {
    const outputFile = resolveReference(artifactDir, result.outputFile);
    if (!outputFile) return { outputFile: null, exists: false, value: null };
    try {
      await access(outputFile);
      return { outputFile, exists: true, value: await readJson(outputFile, (value) => value) };
    } catch (error) {
      if (error.code === "ENOENT") return { outputFile, exists: false, value: null };
      throw error;
    }
  }));
}
