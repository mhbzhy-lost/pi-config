#!/usr/bin/env node
import { inventoryRepositoryWorktrees } from "./lib/worktree-lifecycle/inventory.mjs";

const args = process.argv.slice(2);
const command = args.find((arg) => !arg.startsWith("-")) || "audit";
if (command !== "audit") {
  console.error("Only the read-only audit command is available.");
  process.exitCode = 2;
} else {
  const facts = await inventoryRepositoryWorktrees({ originRoot: process.cwd() });
  if (args.includes("--json")) console.log(JSON.stringify(facts));
  else for (const fact of facts) console.log(`${fact.state}\t${fact.registration.path}\t${fact.automaticAction}`);
}
