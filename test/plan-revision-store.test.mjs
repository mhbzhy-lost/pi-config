import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPlanRevisionStore } from "../scripts/lib/plan/plan-revision-store.mjs";

const sourceBytes = Buffer.from(`# Approved plan  \r\n\r\n## Execution Contract\r\n\r\n\`\`\`json\r\n{"schemaVersion":"pi-plan.v1","verification":["npm test"],"requiredGates":["deterministic","plan-audit","external-review","final-completeness"]}\r\n\`\`\`\r\n\r\n### Task 1: Ship it  \r\n\r\n**Files:**\r\n- Create: \`src/a.mjs\`  \r\n`, "utf8");

test("prepares immutable private source, IR, and manifest outside the worktree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-plan-revision-"));
  try {
    const store = createPlanRevisionStore({ stateRoot: root, now: () => "2026-07-29T00:00:00.000Z" });
    const prepared = await store.prepareRevision({ planId: "plan-1", sourceBytes, reason: "initial-approval", initiator: { kind: "launcher" } });
    assert.equal(prepared.revision, 1);
    assert.deepEqual(await readFile(prepared.sourcePath), sourceBytes);
    assert.equal(prepared.manifest.sourceBytesSha256, createHash("sha256").update(sourceBytes).digest("hex"));
    assert.equal(prepared.manifest.planHash, prepared.plan.sha256);
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
