#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { inspectGoalState, resetGoalState } from "../src/goal-engine/state-lifecycle.ts";

function usage(message) { throw Object.assign(new Error(message), { code: "GOAL_STATE_LIFECYCLE_USAGE" }); }
function parse(argv) {
  const command = argv.shift();
  if (!new Set(["inspect", "reset"]).has(command)) usage("command must be inspect or reset");
  const values = Object.create(null);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--") || token.includes("=")) usage(`invalid option: ${token}`);
    const name = token.slice(2);
    if (!new Set(["repo-root", "expected-state-hash", "authorization-id"]).has(name) || Object.hasOwn(values, name)) usage(`unknown or duplicate option: ${token}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) usage(`missing --${name}`);
    values[name] = value;
  }
  if (!values["repo-root"]) usage("missing --repo-root");
  if (command === "inspect" && (values["expected-state-hash"] || values["authorization-id"])) usage("inspect accepts only --repo-root");
  if (command === "reset" && (!values["expected-state-hash"] || !values["authorization-id"])) usage("reset requires expected state hash and authorization id");
  return { command, values };
}
function exactRepositoryRoot(value) {
  let requested;
  try { requested = realpathSync(resolve(value)); } catch { throw Object.assign(new Error("--repo-root must exist"), { code: "GOAL_STATE_LIFECYCLE_REPOSITORY" }); }
  let actual;
  try { actual = resolve(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: requested, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()); }
  catch { throw Object.assign(new Error("--repo-root must be a Git repository root"), { code: "GOAL_STATE_LIFECYCLE_REPOSITORY" }); }
  if (actual !== requested) usage("--repo-root must be the exact Git repository root");
  return actual;
}
try {
  const { command, values } = parse(process.argv.slice(2));
  const repoRoot = exactRepositoryRoot(values["repo-root"]);
  const stateRoot = resolve(repoRoot, ".state", "goal-engine");
  const output = command === "inspect" ? inspectGoalState({ stateRoot }) : resetGoalState({ stateRoot, expectedStateHash: values["expected-state-hash"], authorizationId: values["authorization-id"] });
  process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  process.stderr.write(`${error.code || "GOAL_STATE_LIFECYCLE_ERROR"}: ${error.message}\n`);
  process.exitCode = error.code === "GOAL_STATE_LIFECYCLE_USAGE" ? 2 : 1;
}
