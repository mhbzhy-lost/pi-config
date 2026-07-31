import { parseProcessTerminal } from "../../scripts/lib/subagent-dispatch/root-broker-protocol.ts";

function runFingerprint(runs, terminals) {
  return JSON.stringify(runs.map(({ runId, asyncDir }) => ({ runId, asyncDir, terminal: terminals.get(runId) })));
}

function validateRuns(runs) {
  if (!Array.isArray(runs)) throw new Error("Harness actual runs must be an array");
  const runIds = new Set();
  const asyncDirs = new Set();
  for (const run of runs) {
    if (!run?.runId || typeof run.runId !== "string" || !run.runId.trim()) throw new Error("Harness actual runId must be non-empty");
    if (!run?.asyncDir || typeof run.asyncDir !== "string" || !run.asyncDir.trim()) throw new Error(`Harness actual asyncDir must be non-empty for ${run.runId}`);
    if (runIds.has(run.runId)) throw new Error(`Harness actual runId must be unique: ${run.runId}`);
    if (asyncDirs.has(run.asyncDir)) throw new Error(`Harness actual asyncDir must be unique: ${run.asyncDir}`);
    runIds.add(run.runId);
    asyncDirs.add(run.asyncDir);
  }
}

function isOfficialObservedTerminal(terminal, runId) {
  if (!terminal || typeof terminal !== "object" || Array.isArray(terminal) || terminal.runId !== runId) return false;
  const { runId: _runId, ...value } = terminal;
  try { parseProcessTerminal(value); } catch { return false; }
  return value.state === "observed";
}

export async function waitForHarnessRunQuiescence({ requiredRuns, listRuns, readOfficialTerminal, timeoutMs, quietMs, pollIntervalMs }) {
  validateRuns(requiredRuns);
  if (requiredRuns.length === 0) throw new Error("Harness run quiescence requires at least one initial run");
  const required = new Map(requiredRuns.map((run) => [run.runId, run.asyncDir]));
  const seen = new Map(required);
  const deadline = Date.now() + timeoutMs;
  let fingerprint;
  let quietSince;
  let lastChangeAt;
  let missingRunIds = [];
  let lastRunIds = [];

  while (Date.now() < deadline) {
    const runs = await listRuns();
    validateRuns(runs);
    const current = new Map(runs.map((run) => [run.runId, run.asyncDir]));
    for (const [runId, asyncDir] of required) {
      if (!current.has(runId)) throw new Error(`Harness required actual run is missing: ${runId}`);
      if (current.get(runId) !== asyncDir) throw new Error(`Harness required actual run identity changed: ${runId}`);
    }
    for (const [runId, asyncDir] of seen) {
      if (!current.has(runId)) throw new Error(`Harness actual run disappeared after observation: ${runId}`);
      if (current.get(runId) !== asyncDir) throw new Error(`Harness actual run identity changed after observation: ${runId}`);
    }
    for (const [runId, asyncDir] of current) seen.set(runId, asyncDir);

    const sortedRuns = [...runs].sort((left, right) => left.runId.localeCompare(right.runId));
    lastRunIds = sortedRuns.map((run) => run.runId);
    const terminals = new Map(await Promise.all(sortedRuns.map(async (run) => [run.runId, await readOfficialTerminal(run)])));
    missingRunIds = sortedRuns.filter((run) => !isOfficialObservedTerminal(terminals.get(run.runId), run.runId)).map((run) => run.runId);
    const nextFingerprint = runFingerprint(sortedRuns, terminals);
    const now = Date.now();
    if (nextFingerprint !== fingerprint) {
      fingerprint = nextFingerprint;
      quietSince = now;
      lastChangeAt = now;
    }
    if (missingRunIds.length === 0 && now - quietSince >= quietMs) return sortedRuns;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  const snapshot = `last run ids: ${lastRunIds.join(",") || "none"}; last change: ${lastChangeAt ?? "none"}`;
  if (missingRunIds.length > 0) throw new Error(`Harness run quiescence timed out; ${missingRunIds.map((runId) => `${runId} missing official terminal proof`).join(", ")}; ${snapshot}`);
  throw new Error(`Harness run quiescence timed out; quiet window not reached; ${snapshot}; quietMs=${quietMs}`);
}
