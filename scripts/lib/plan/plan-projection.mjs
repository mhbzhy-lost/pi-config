import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { applyEvent, createProjection } from "./plan-events.mjs";

const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function createPlanStatus({ entries, artifacts = new Map() }) {
  let projection = createProjection();
  for (const entry of entries) projection = applyEvent(projection, entry);

  return {
    schemaVersion: "pi-plan-status.v1",
    derived: true,
    planId: projection.planId,
    lifecycle: projection.lifecycle,
    headCommit: projection.workspace?.headCommit ?? null,
    validatedHead: projection.validatedHead,
    tasks: [...projection.tasks].map(([taskId, task]) => ({
      taskId,
      ...task,
      attempts: [...projection.attempts]
        .filter(([, attempt]) => attempt.taskId === taskId)
        .map(([attemptId, attempt]) => ({ attemptId, status: attempt.status, artifacts: artifacts.get(attemptId) ?? null })),
    })),
    gates: [...projection.gates.values()],
  };
}

export async function writePlanStatus({ stateRoot, status }) {
  if (typeof status?.planId !== "string" || !PLAN_ID.test(status.planId) || status.planId.includes("..")) {
    throw new Error("Invalid planId");
  }
  const planRunsRoot = path.resolve(stateRoot, "var", "plan-runs");
  const directory = path.resolve(planRunsRoot, status.planId);
  const relativeDirectory = path.relative(planRunsRoot, directory);
  if (!relativeDirectory || relativeDirectory.startsWith("..") || path.isAbsolute(relativeDirectory)) {
    throw new Error("Plan status path escapes plan-runs");
  }
  const outputFile = path.join(directory, "status.json");
  const temporaryFile = path.join(directory, `.status-${process.pid}-${crypto.randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });
  await writeFile(temporaryFile, `${JSON.stringify(status, null, 2)}\n`);
  await rename(temporaryFile, outputFile);
  return outputFile;
}
