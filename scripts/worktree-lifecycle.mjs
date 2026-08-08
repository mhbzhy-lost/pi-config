#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { inventoryRepositoryWorktrees } from "./lib/worktree-lifecycle/inventory.mjs";
import { createManagedWorktree, preserveManagedWorktree, releaseManagedWorktree } from "./lib/worktree-lifecycle/managed-worktree.mjs";
import { activateAllocation, beginAllocation } from "./lib/worktree-lifecycle/registry.mjs";

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("-") ? args[0] : "audit";
const flags = command === "audit" && args[0]?.startsWith("-") ? args : args.slice(1);

function option(name, { required = true } = {}) {
  const index = flags.indexOf(`--${name}`);
  const value = index >= 0 ? flags[index + 1] : undefined;
  if (value !== undefined && !value.startsWith("--")) return value;
  if (!required) return undefined;
  const error = new Error(`Missing --${name}`);
  error.code = "WORKTREE_LIFECYCLE_CLI_USAGE";
  throw error;
}

function print(value) {
  if (flags.includes("--json")) console.log(JSON.stringify(value));
  else if (Array.isArray(value)) {
    for (const fact of value) console.log(`${fact.state}\t${fact.registration.path}\t${fact.automaticAction}`);
  } else console.log(`${value.state}\t${value.id}\t${value.path}`);
}

function owner() {
  return { kind: option("owner-kind"), id: option("owner-id") };
}

try {
  if (command === "audit") {
    print(await inventoryRepositoryWorktrees({ originRoot: process.cwd() }));
  } else if (command === "create") {
    print(createManagedWorktree({
      originRoot: process.cwd(),
      id: option("id"),
      branch: option("branch"),
      baseCommit: option("base"),
      owner: owner(),
    }));
  } else if (command === "adopt") {
    const allocation = beginAllocation({
      originRoot: process.cwd(),
      id: option("id"),
      path: option("path"),
      branch: option("branch"),
      baseCommit: option("base"),
      owner: owner(),
    });
    const headCommit = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: allocation.path,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    print(activateAllocation({
      originRoot: process.cwd(),
      id: allocation.id,
      ownerToken: allocation.ownerToken,
      headCommit,
    }));
  } else if (command === "release") {
    print(releaseManagedWorktree({
      originRoot: process.cwd(),
      id: option("id"),
      ownerToken: option("owner-token"),
    }));
  } else if (command === "preserve") {
    print(preserveManagedWorktree({
      originRoot: process.cwd(),
      id: option("id"),
      ownerToken: option("owner-token"),
      reason: option("reason"),
    }));
  } else {
    const error = new Error(`Unknown command: ${command}`);
    error.code = "WORKTREE_LIFECYCLE_CLI_USAGE";
    throw error;
  }
} catch (error) {
  console.error(`${error.code || "WORKTREE_LIFECYCLE_ERROR"}: ${error.message}`);
  process.exitCode = 2;
}
