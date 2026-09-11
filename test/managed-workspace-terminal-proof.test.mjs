import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createManagedWorkspaceRequestV2 } from "../packages/pi-subagents-enhanced/src/workspace/contract.ts";
import { createManagedWorkspaceService } from "../packages/pi-subagents-enhanced/src/workspace/service.ts";
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "terminal-proof-v2-")); const originRoot = join(root, "origin"); await mkdir(join(originRoot, "src"), { recursive: true });
  git(originRoot, "init", "-b", "main"); git(originRoot, "config", "user.email", "test@example.com"); git(originRoot, "config", "user.name", "Test"); await writeFile(join(originRoot, "src", "base"), "base\n"); git(originRoot, "add", "."); git(originRoot, "commit", "-m", "base");
  t.after(() => rm(root, { recursive: true, force: true })); return { root, originRoot, baseCommit: git(originRoot, "rev-parse", "HEAD") };
}
function request(f, id) { return createManagedWorkspaceRequestV2({ workspaceId: id, owner: { kind: "standalone-subagent", rootSessionId: "root-proof", toolCallId: `tool-${id}` }, originRoot: f.originRoot, requestedCwd: join(f.originRoot, "src"), originRef: "refs/heads/main", baseCommit: f.baseCommit, contractHash: "a".repeat(64), policy: { publication: "allowed", application: "allowed", writePaths: ["src/**"] } }); }
function proof(f, extra = {}) { return { state: "observed", conflict: false, runId: "run-proof", rootSessionId: "root-proof", asyncDir: join(f.root, "async"), processInstance: "proc-proof", proofId: "e".repeat(64), ...extra }; }
test("v2 terminal proof is exact and identity-bound while v1 remains legacy", async t => {
  const f = await fixture(t); const service = createManagedWorkspaceService({ stateRoot: join(f.root, "state") }); const active = service.ensureAllocated(request(f, "proof-v2")); service.bindRun({ workspaceId: active.workspaceId, run: { runId: "run-proof", asyncDir: join(f.root, "async") } });
  for (const invalid of [proof(f, { extra: true }), proof(f, { runId: undefined }), proof(f, { rootSessionId: "foreign" }), { state: "pending", extra: true }]) assert.throws(() => service.status({ workspaceId: active.workspaceId, terminalProof: invalid }), /terminal/i);
  const valid = service.status({ workspaceId: active.workspaceId, terminalProof: proof(f) }); assert.equal(valid.terminalProof.proofId, "e".repeat(64));
});
