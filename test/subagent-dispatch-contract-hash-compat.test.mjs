import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compileDispatchIR } from "../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts";

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
    title: "Contract hash persistence",
    agent: "executor",
    task: "Preserve a contract hash in workspace persistence. Keep persisted contractHash values loadable.",
    writePaths: ["README.md"],
    acceptance: { criteria: ["Request loads with a self-consistent requestHash."] },
    cwd: "/repo",

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
  const currentIR = compileDispatchIR(dispatchContract(), { cwd: "/repo" });
  const legacyIR = { ...currentIR, workflow: { mode: "tdd" } };
  delete legacyIR.contractHash;
  const legacyHash = hashCanonical(legacyIR);
  const currentHash = currentIR.contractHash;

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
