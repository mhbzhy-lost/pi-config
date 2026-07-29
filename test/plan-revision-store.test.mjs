import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPlanRevisionStore } from "../scripts/lib/plan/plan-revision-store.mjs";

const sourceBytes = Buffer.from(`# Approved plan  \r\n\r\n## Execution Contract\r\n\r\n\`\`\`json\r\n{"schemaVersion":"pi-plan.v1","verification":["npm test"],"requiredGates":["deterministic","plan-audit","external-review","final-completeness"]}\r\n\`\`\`\r\n\r\n### Task 1: Ship it  \r\n\r\n**Files:**\r\n- Create: \`src/a.mjs\`  \r\n`, "utf8");

const v3SourceBytes = Buffer.from(`# Complete IR plan\n\n**Goal:** preserve approved instructions\n\n## Execution Contract\n\n\`\`\`json\n{"schemaVersion":"pi-plan.v3","revision":1,"parentPlanHash":null,"verification":[{"id":"plan:test","command":"node --test","cwd":".","timeoutMs":900000}],"requiredGates":["deterministic","plan-audit","external-review","final-completeness"],"resourceCapacities":{},"executionDefaults":{"agent":"executor","risk":"normal","workflow":{"mode":"inherit-repository"},"timeoutMs":900000},"taskExecution":{"task-1":{"risk":"high","workflow":{"mode":"tdd"},"timeoutMs":1200000}},"taskAcceptance":{"task-1":{"strategy":"commands","commandIds":["plan:test"]}}}\n\`\`\`\n\n### Task 1: Compile semantics\n\n**Files:**\n- Modify: \`src/ir.mjs\`\n\n- [ ] Write a test first\n`, "utf8");


test("prepares immutable private source, IR, and manifest outside the worktree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-plan-revision-"));
  try {
    const store = createPlanRevisionStore({ stateRoot: root, now: () => "2026-07-29T00:00:00.000Z" });
    const prepared = await store.prepareRevision({ planId: "plan-1", sourceBytes, reason: "initial-approval", initiator: { kind: "launcher" } });
    assert.equal(prepared.revision, 1);
    assert.deepEqual(await readFile(prepared.sourcePath), sourceBytes);
    assert.equal(prepared.manifest.sourceBytesSha256, createHash("sha256").update(sourceBytes).digest("hex"));
    assert.equal(prepared.manifest.planHash, prepared.plan.sha256);
    assert.deepEqual(Object.keys(prepared.manifest).sort(), ["createdAt", "initiator", "irArtifactSha256", "irHash", "irVersion", "parentRevision", "planHash", "planId", "reason", "revision", "schemaVersion", "sourceBytesSha256", "taskHashes"].sort());
    assert.equal(prepared.manifest.parentRevision, null);
    assert.equal(prepared.manifest.irVersion, prepared.ir.version);
    assert.equal(prepared.manifest.irHash, prepared.ir.hash ?? createHash("sha256").update(await readFile(prepared.irPath)).digest("hex"));
    assert.equal((await stat(prepared.sourcePath)).mode & 0o777, 0o600);
    assert.equal((await stat(prepared.directory)).mode & 0o777, 0o700);
    await assert.rejects(access(path.join(root, "var", "plan-worktrees", "plan-1", ".pi-plan-runtime", "approved-plan.md")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("does not treat candidates or unpointed revisions as current and is idempotent only for exact input", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-plan-revision-"));
  try {
    const store = createPlanRevisionStore({ stateRoot: root });
    assert.equal(await store.readCurrent("plan-1"), null);
    const first = await store.prepareRevision({ planId: "plan-1", sourceBytes, reason: "initial-approval", initiator: { kind: "launcher" } });
    assert.equal(await store.readCurrent("plan-1"), null);
    const retry = await store.prepareRevision({ planId: "plan-1", sourceBytes, reason: "initial-approval", initiator: { kind: "launcher" } });
    assert.equal(retry.manifestSha256, first.manifestSha256);
    await assert.rejects(store.prepareRevision({ planId: "plan-1", sourceBytes: Buffer.concat([sourceBytes, Buffer.from("\n")]), reason: "initial-approval", initiator: { kind: "launcher" } }), /conflict|immutable/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("v3 revision identities fail closed for revision two, artifact tampering, candidates, and current pointers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-plan-revision-v3-"));
  try {
    const store = createPlanRevisionStore({ stateRoot: root });
    await assert.rejects(store.prepareRevision({ planId: "v3", sourceBytes: Buffer.from(v3SourceBytes.toString().replace('"revision":1,"parentPlanHash":null', `"revision":2,"parentPlanHash":"${"a".repeat(64)}"`)), reason: "initial-approval", initiator: { kind: "launcher" } }), /revision.*1|initial/i);
    const prepared = await store.prepareRevision({ planId: "v3", sourceBytes: v3SourceBytes, reason: "initial-approval", initiator: { kind: "launcher" } });
    assert.equal(await store.readCurrent("v3"), null);
    const artifact = JSON.parse(await readFile(prepared.irPath, "utf8"));
    artifact.nodes[0].title = "tampered";
    const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
    const manifestPath = path.join(prepared.directory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.irArtifactSha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(prepared.irPath, bytes);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(store.readRevision("v3", 1), /malformed/i);
    await assert.rejects(store.prepareRevision({ planId: "v3", sourceBytes: v3SourceBytes, reason: "initial-approval", initiator: { kind: "launcher" } }), /malformed|immutable/i);
    await writeFile(prepared.irPath, Buffer.from(`${JSON.stringify(prepared.ir, null, 2)}\n`));
    manifest.irArtifactSha256 = createHash("sha256").update(await readFile(prepared.irPath)).digest("hex");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const reread = await store.readRevision("v3", 1);
    await store.writeCurrent(reread);
    assert.equal((await store.readCurrent("v3")).manifestSha256, reread.manifestSha256);
    await store.reconcileCurrent("v3", 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
