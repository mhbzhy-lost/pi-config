import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProjection } from "./store.mjs";

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

export function auditGoal(goalId, stateRoot) {
  const projection = loadProjection(stateRoot, goalId);
  if (!projection) throw new Error(`goal not found: ${goalId}`);

  const eventsPath = join(stateRoot, "goals", goalId, "events.jsonl");
  const events = readEvents(eventsPath);

  const failedAttempts = countFailedSettles(events);
  const { hasExternalEvidence, allSelfProduced, evidenceCount } = analyzeEvidence(projection);
  const checkpointGap = hasLongCheckpointGap(events);
  const neverBlockedSuspicious = isNeverBlockedSuspicious(events, projection);

  const signals = [];
  if (failedAttempts >= 3) signals.push("HIGH_RETRY_RATE");
  if (allSelfProduced) signals.push("ALL_SELF_PRODUCED_EVIDENCE");
  if (checkpointGap) signals.push("LONG_CHECKPOINT_GAP");
  if (neverBlockedSuspicious) signals.push("NEVER_BLOCKED_SUSPICIOUS");

  const verdict = signals.length >= 2 ? "DEGRADED" : signals.length === 1 ? "AT_RISK" : "HEALTHY";

  const totalTasks = projection.tasks.size;
  let acceptedTasks = 0;
  for (const [, task] of projection.tasks) {
    if (task.status === "accepted") acceptedTasks++;
  }

  return {
    goal_id: goalId,
    lifecycle: projection.lifecycle,
    total_events: events.length,
    checkpoint_count: projection.checkpointCount,
    progress: { total: totalTasks, accepted: acceptedTasks },
    failed_attempts: failedAttempts,
    has_external_evidence: hasExternalEvidence,
    signals,
    verdict,
  };
}

function readEvents(eventsPath) {
  if (!existsSync(eventsPath)) return [];
  return readFileSync(eventsPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function countFailedSettles(events) {
  let count = 0;
  for (const e of events) {
    if (e.type === "task.settled" && e.data.outcome === "failed") count++;
  }
  return count;
}

function analyzeEvidence(projection) {
  let evidenceCount = 0;
  let selfProducedCount = 0;

  for (const [, task] of projection.tasks) {
    for (const ev of task.evidence) {
      evidenceCount++;
      if (ev.source === "self_produced") selfProducedCount++;
    }
  }

  return {
    hasExternalEvidence: evidenceCount > 0 && selfProducedCount < evidenceCount,
    allSelfProduced: evidenceCount > 0 && selfProducedCount === evidenceCount,
    evidenceCount,
  };
}

function hasLongCheckpointGap(events) {
  const checkpoints = events.filter((e) => e.type === "goal.checkpoint");
  for (let i = 1; i < checkpoints.length; i++) {
    const prev = new Date(checkpoints[i - 1].occurredAt).getTime();
    const curr = new Date(checkpoints[i].occurredAt).getTime();
    if (curr - prev > TWO_HOURS_MS) return true;
  }
  return false;
}

function isNeverBlockedSuspicious(events, projection) {
  if (events.length <= 20) return false;
  const hasBlockedOutcome = events.some(
    (e) => e.type === "task.settled" && e.data.outcome === "blocked",
  );
  return !hasBlockedOutcome && !projection.blockedReason;
}
