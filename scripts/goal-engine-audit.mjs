#!/usr/bin/env node
import { auditGoal } from "./lib/goal-engine/audit.mjs";
import { join } from "node:path";

const goalId = process.argv[2];
const stateRoot = join(process.cwd(), ".state/goal-engine");

if (!goalId) {
  console.error("Usage: node scripts/goal-engine-audit.mjs <goal-id>");
  process.exit(2);
}

try {
  const report = auditGoal(goalId, stateRoot);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.verdict === "DEGRADED" ? 1 : 0);
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
