import { createHash, randomUUID } from "node:crypto";

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

export function ownerSessionId(projection) {
  const bindings = projection?.sessionBindings || [];
  return [...bindings].reverse().find((binding) => binding.state !== "transferred")?.sessionId || null;
}

export function workspaceReleased(projection) {
  return [...(projection?.tasks?.values?.() || [])].every((task) => !task.workspace || (task.workspace.phase === "disposed" && (task.workspace.released === true || task.workspace.preservedResourcesReleased === true)));
}

export function transferEligibility(projection, sessionId, { targetHasActiveGoal = false } = {}) {
  if (projection?.lifecycle !== "active") return "GOAL_NOT_ACTIVE";
  if (ownerSessionId(projection) === sessionId) return "ALREADY_OWNER";
  if (targetHasActiveGoal) return "TARGET_SESSION_HAS_ACTIVE_GOAL";
  if (!workspaceReleased(projection)) return "ACTIVE_WORKSPACE";
  return null;
}

export function listCwdGoals(projections, sessionId) {
  return projections.map((projection) => {
    const owner = ownerSessionId(projection);
    const targetHasActiveGoal = projections.some((candidate) => candidate.goalId !== projection.goalId && candidate.lifecycle === "active" && ownerSessionId(candidate) === sessionId);
    const blocked = transferEligibility(projection, sessionId, { targetHasActiveGoal });
    return { goalId: projection.goalId, lifecycle: projection.lifecycle, ownerSessionId: owner, ownedByCurrentSession: owner === sessionId, transferEligible: blocked === null, transferBlockedReason: blocked };
  }).sort((a, b) => a.goalId.localeCompare(b.goalId));
}

export function buildTransferChallenge({ projection, toSessionId, reason, cwd, requestedAt = new Date().toISOString() }) {
  required(toSessionId, "toSessionId"); required(reason, "reason"); required(cwd, "cwd");
  const blocked = transferEligibility(projection, toSessionId);
  if (blocked) throw new Error(`transfer blocked: ${blocked}`);
  return { id: randomUUID(), kind: "session_transfer_approval", goalId: projection.goalId, fromOwnerSessionId: ownerSessionId(projection), toSessionId, ownershipRevision: projection.ownershipRevision || 1, epoch: projection.epoch, cwd: createHash("sha256").update(cwd).digest("hex"), requestedAt, reason: reason.trim(), choices: ["approve", "reject"] };
}

export function transferChallengeState(record, projection, sessionId, cwd) {
  if (!record?.challenge || record.consumed || record.stale) return "STALE";
  const c = record.challenge;
  if (c.toSessionId !== sessionId || c.cwd !== createHash("sha256").update(cwd).digest("hex") || c.ownershipRevision !== (projection.ownershipRevision || 1) || c.epoch !== projection.epoch || c.fromOwnerSessionId !== ownerSessionId(projection)) return "STALE";
  if (record.decision?.choice === "reject") return "REJECTED";
  return record.decision?.choice === "approve" ? "APPROVED" : "PENDING";
}
