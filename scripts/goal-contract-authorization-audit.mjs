#!/usr/bin/env node

import { auditGoalContractIntegrity } from "./lib/goal-contract/authorization-audit.mjs";

const goalRoot = process.argv[2];
if (!goalRoot) {
  console.error("Usage: node scripts/goal-contract-authorization-audit.mjs <goal-contract-directory>");
  process.exit(2);
}

try {
  const errors = auditGoalContractIntegrity(goalRoot);
  if (errors.length > 0) {
    for (const error of errors) console.error(`ERROR: ${error}`);
    process.exit(1);
  }
  console.log(`Goal Contract integrity valid: ${goalRoot}`);
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exit(2);
}
