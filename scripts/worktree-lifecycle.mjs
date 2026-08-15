#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { applyStaleRegistrationCleanup, inventoryRepositoryWorktrees, planStaleRegistrationCleanup, reconcileManagedWorktrees } from "./lib/worktree-lifecycle/inventory.mjs";
import { createManagedWorktree, preserveManagedWorktree, releaseManagedWorktree, reanchorManagedWorktree } from "./lib/worktree-lifecycle/managed-worktree.mjs";
import { activateAllocation, beginAllocation } from "./lib/worktree-lifecycle/registry.mjs";

const SCHEMAS = {
  audit: { flags: new Set(["json"]), values: new Set() },
  reconcile: { flags: new Set(["json", "apply"]), values: new Set() },
  "prune-stale-registrations": { flags: new Set(["json", "apply"]), values: new Set(["challenge"]) },
  create: { flags: new Set(["json"]), values: new Set(["id", "branch", "base", "owner-kind", "owner-id"]) },
  adopt: { flags: new Set(["json"]), values: new Set(["id", "branch", "base", "owner-kind", "owner-id", "path"]) },
  release: { flags: new Set(["json", "owner-token-stdin"]), values: new Set(["id"]) },
  preserve: { flags: new Set(["json", "owner-token-stdin"]), values: new Set(["id", "reason"]) },
  reanchor: { flags: new Set(["json", "owner-token-stdin"]), values: new Set(["id", "expected-head", "target-head"]) },
};

function usage(message) {
  const error = new Error(message);
  error.code = "WORKTREE_LIFECYCLE_CLI_USAGE";
  throw error;
}

function parseCommand(argv) {
  const first = argv[0];
  const command = !first || first.startsWith("-") ? "audit" : first;
  const schema = SCHEMAS[command];
  if (!schema) usage(`Unknown command: ${command}`);
  const tokens = command === "audit" && first?.startsWith("-") ? argv : argv.slice(1);
  const values = Object.create(null);
  const flags = new Set();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) usage(`Unexpected value: ${token}`);
    if (token.includes("=")) usage(`Option values must use a separate argument: ${token}`);
    const name = token.slice(2);
    if (!schema.flags.has(name) && !schema.values.has(name)) usage(`Unknown or irrelevant option: ${token}`);
    if (flags.has(name)) usage(`Duplicate ${token}`);
    flags.add(name);
    if (schema.values.has(name)) {
      const value = tokens[++index];
      if (value === undefined || value === "" || value.startsWith("--")) usage(`Missing --${name}`);
      values[name] = value;
    }
  }
  for (const name of schema.values) if (values[name] === undefined && !(command === "prune-stale-registrations" && name === "challenge" && !flags.has("apply"))) usage(`Missing --${name}`);
  if (["release", "preserve", "reanchor"].includes(command) && !flags.has("owner-token-stdin")) usage(`${command} requires --owner-token-stdin`);
  if (command === "prune-stale-registrations" && !flags.has("apply") && values.challenge !== undefined) usage("--challenge requires --apply");
  if (command === "prune-stale-registrations" && flags.has("apply") && values.challenge === undefined) usage("Missing --challenge");
  return { command, json: flags.has("json"), apply: flags.has("apply"), values };
}

async function readOwnerToken() {
  const token = await new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => resolve(input.trim()));
    process.stdin.on("error", reject);
  });
  if (!token) usage("owner token stdin is empty");
  return token;
}

function escapeSingleLine(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => {
    const escapes = { "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r" };
    return escapes[character] ?? `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

function print(value, json) {
  const safeValue = value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "ownerToken")) : value;
  if (json) return console.log(JSON.stringify(safeValue));
  const items = Array.isArray(safeValue) ? safeValue : safeValue?.items;
  if (items) {
    for (const fact of items) console.log(`${fact?.state ?? "unknown"}\t${escapeSingleLine(fact?.path ?? fact?.registration?.path)}\t${fact?.automaticAction ?? "none"}`);
    return;
  }
  console.log(`${safeValue?.state ?? "unknown"}\t${safeValue?.id ?? ""}\t${escapeSingleLine(safeValue?.path)}`);
}

const parsed = (() => {
  try { return parseCommand(process.argv.slice(2)); }
  catch (error) {
    console.error(`${error.code || "WORKTREE_LIFECYCLE_ERROR"}: ${error.message}`);
    process.exitCode = error.code === "WORKTREE_LIFECYCLE_CLI_USAGE" ? 2 : 1;
    return null;
  }
})();

if (parsed) {
  try {
    const { command, json, apply, values } = parsed;
    const owner = () => ({ kind: values["owner-kind"], id: values["owner-id"] });
    if (command === "audit") {
      print(await inventoryRepositoryWorktrees({ originRoot: process.cwd() }), json);
    } else if (command === "reconcile") {
      print(await reconcileManagedWorktrees({ originRoot: process.cwd(), apply }), json);
    } else if (command === "prune-stale-registrations") {
      print(apply ? await applyStaleRegistrationCleanup({ originRoot: process.cwd(), challenge: values.challenge }) : await planStaleRegistrationCleanup({ originRoot: process.cwd() }), json);
    } else if (command === "create") {
      print(createManagedWorktree({ originRoot: process.cwd(), id: values.id, branch: values.branch, baseCommit: values.base, owner: owner() }), json);
    } else if (command === "adopt") {
      const allocation = beginAllocation({ originRoot: process.cwd(), id: values.id, path: values.path, branch: values.branch, baseCommit: values.base, owner: owner() });
      const headCommit = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: allocation.path, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      print(activateAllocation({ originRoot: process.cwd(), id: allocation.id, ownerToken: allocation.ownerToken, headCommit }), json);
    } else if (command === "release") {
      print(releaseManagedWorktree({ originRoot: process.cwd(), id: values.id, ownerToken: await readOwnerToken() }), json);
    } else if (command === "reanchor") {
      print(reanchorManagedWorktree({ originRoot: process.cwd(), id: values.id, ownerToken: await readOwnerToken(), expectedHead: values["expected-head"], targetHead: values["target-head"] }), json);
    } else {
      print(preserveManagedWorktree({ originRoot: process.cwd(), id: values.id, ownerToken: await readOwnerToken(), reason: values.reason }), json);
    }
  } catch (error) {
    console.error(`${error.code || "WORKTREE_LIFECYCLE_ERROR"}: ${error.message}`);
    process.exitCode = 1;
  }
}
