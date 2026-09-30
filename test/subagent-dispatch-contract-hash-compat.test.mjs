import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compileCodingDispatchIR } from "../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts";
import { createManagedWorkspaceRequestV2 } from "../packages/pi-subagents-enhanced/src/workspace/contract.ts";
import { createManagedWorkspaceLedger } from "../packages/pi-subagents-enhanced/src/workspace/ledger.ts";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const canonicalize = (value) => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
    : value;
const hashCanonical = (value) => createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "dispatch-contract-hash-compat-"));
  const originRoot = join(root, "origin");
  const stateRoot = join(root, "state");
  await mkdir(originRoot);
  git(originRoot, "init", "-b", "main");
  git(originRoot, "config", "user.email", "test@example.com");
  git(originRoot, "config", "user.name", "Test User");
  await writeFile(join(originRoot, "README.md"), "initial\n");
  git(originRoot, "add", "README.md");
  git(originRoot, "commit", "-m", "initial");
  t.after(() => rm(root, { recursive: true, force: true }));
  return { originRoot, stateRoot, baseCommit: git(originRoot, "rev-parse", "HEAD") };
}

function dispatchContract() {
  return {
    version: "dispatch-ir.v1",
    taskId: "legacy-contract-hash-pin",
    title: "Legacy contract hash persistence",
    agent: "executor",
    risk: "normal",
    objective: "Preserve a legacy hash string in workspace persistence.",
    requirements: ["Keep old persisted contractHash values loadable."],
    context: { knownFacts: [], decisions: [], relevantFiles: [] },
    boundaries: { writePaths: ["README.md"], excludedWork: [], forbiddenActions: [] },
    acceptance: { criteria: ["Legacy request loads with a self-consistent requestHash."] },
    execution: { cwd: "/repo", timeoutMs: 1800000 },
  };
}

function request(f, contractHash) {
  return createManagedWorkspaceRequestV2({
    workspaceId: "legacy-contract-hash",
    owner: { kind: "standalone-subagent", rootSessionId: "root-1", toolCallId: "tool-1" },
    originRoot: f.originRoot,
    requestedCwd: f.originRoot,
    originRef: "refs/heads/main",
    baseCommit: f.baseCommit,
    contractHash,
    policy: { publication: "allowed", application: "allowed", writePaths: ["README.md"] },
  });
}

test("persists and loads an old IR hash containing workflow without putting workflow in request v2", async (t) => {
  const f = await fixture(t);
  const currentIR = compileCodingDispatchIR(dispatchContract(), { cwd: "/repo" });
  // The current 0.71 IR has no workflow field; preserve a legacy hash that
  // was computed from the retired field while loading it as opaque data.
  const legacyIR = { ...currentIR, workflow: { mode: "legacy" } };
  delete legacyIR.hash;
  const legacyHash = hashCanonical(legacyIR);
  const currentHash = currentIR.hash;
  assert.notEqual(currentHash, legacyHash);

  const input = request(f, legacyHash);
  assert.equal(Object.hasOwn(input, "workflow"), false);
  const ledger = createManagedWorkspaceLedger({ stateRoot: f.stateRoot });
  const reserved = ledger.reserve(input);
  const loaded = ledger.load(input.workspaceId);
  const listed = ledger.list({ originRoot: f.originRoot });

  assert.equal(loaded.record.requestHash, createHash("sha256").update(JSON.stringify(loaded.record.request)).digest("hex"));
  assert.equal(loaded.record.request.contractHash, legacyHash);
  assert.equal(listed[0].request.contractHash, legacyHash);
  assert.equal(reserved.record.request.contractHash, legacyHash);
  assert.throws(() => createManagedWorkspaceRequestV2({ ...input, contractHash: "z".repeat(64) }), /digest/i);
});
