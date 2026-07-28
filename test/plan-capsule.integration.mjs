import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPlanRunnerDependencies } from "../scripts/lib/plan/plan-runner-dependencies.mjs";
import { parsePlanDocument } from "../scripts/lib/plan/plan-document.mjs";

async function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const domainPlanSource = `# Approved plan

## Execution Contract

\`\`\`json
{"schemaVersion":"pi-plan.v1","verification":["true"],"requiredGates":["deterministic","plan-audit","external-review","final-completeness"]}
\`\`\`

### Task 1: Ship it

**Files:**
- Create: \`src/a.mjs\`
`;

async function persistedDomainFixture(t, planId) {
  const origin = await mkdtemp(join(tmpdir(), "pi-plan-capsule-domain-"));
  const worktree = join(origin, "var", "plan-worktrees", planId);
  const planPath = join(origin, "approved-plan.md");
  await writeFile(join(origin, "README.md"), "base\n");
  await git(origin, "init");
  await git(origin, "config", "user.email", "plan@example.test");
  await git(origin, "config", "user.name", "Plan Test");
  await git(origin, "add", "README.md");
  await git(origin, "commit", "-m", "base");
  const baseCommit = await git(origin, "rev-parse", "HEAD");
  await git(origin, "worktree", "add", "-b", `pi-plan/${planId}`, worktree, baseCommit);
  await writeFile(planPath, domainPlanSource);
  t.after(() => rm(origin, { recursive: true, force: true }));

  const { sha256, tasks } = parsePlanDocument(domainPlanSource, planPath);
  const statusPath = join(origin, "var", "plan-runs", planId, "status.json");
  const eventsPath = join(origin, "events.jsonl");
  const append = async (entry) => writeFile(eventsPath, `${JSON.stringify(entry)}\n`, { flag: "a" });
  await append({
    schemaVersion: "pi-plan-event.v1",
    eventId: "created",
    planId,
    occurredAt: "2026-07-15T00:00:00.000Z",
    type: "plan.created",
    data: {
      workspace: { originRoot: origin, worktree, baseCommit, headCommit: baseCommit, planPath, planHash: sha256 },
      tasks: tasks.map((task) => task.id),
    },
  });

  async function replayContext() {
    const persisted = (await readFile(eventsPath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
    return { cwd: worktree, sessionManager: { getBranch: () => persisted.map((data) => ({ customType: "pi-plan-event-v1", data })) } };
  }
  function factory(options = {}) {
    return createPlanRunnerDependencies({
      pi: { appendEntry(_type, entry) { return append(entry); } },
      originRoot: origin,
      stateRoot: origin,
      ...options,
    });
  }
  return { origin, worktree, planId, statusPath, eventsPath, append, replayContext, factory };
}

test("persisted domain integration: stale gate evidence is not reused after HEAD advances", async (t) => {
  const repo = await persistedDomainFixture(t, "persisted-stale-gate");
  await writeFile(join(repo.worktree, "src-a.mjs"), "export default 1;\n");
  await git(repo.worktree, "add", "src-a.mjs");
  await git(repo.worktree, "commit", "-m", "first change");
  const firstHead = await git(repo.worktree, "rev-parse", "HEAD");
  await repo.append({ schemaVersion: "pi-plan-event.v1", eventId: "accepted", planId: repo.planId, occurredAt: "2026-07-15T00:00:01.000Z", type: "task.accepted", data: { taskId: "task-1" } });

  const first = repo.factory({
    audit: async () => {
      await writeFile(join(repo.worktree, "src-b.mjs"), "export default 2;\n");
      await git(repo.worktree, "add", "src-b.mjs");
      await git(repo.worktree, "commit", "-m", "head advanced during gates");
      return { findings: [] };
    },
    externalReview: async () => ({ available: true, findings: [] }),
  });
  assert.equal((await first.verifyPlan({ ctx: await repo.replayContext() })).validated, false);
  const currentHead = await git(repo.worktree, "rev-parse", "HEAD");
  const restarted = repo.factory({ audit: async () => ({ findings: [] }), externalReview: async () => ({ available: true, findings: [] }) });
  const status = await restarted.status({ ctx: await repo.replayContext() });

  assert.equal(status.lifecycle, "verifying");
  assert.equal(status.validatedHead, null);
  assert.equal((await restarted.verifyPlan({ ctx: await repo.replayContext() })).validated, true);
  const observedHeads = (await readFile(repo.eventsPath, "utf8")).trim().split("\n").map(JSON.parse)
    .filter((entry) => entry.type === "workspace.head-observed").map((entry) => entry.data.headCommit);
  assert.deepEqual(observedHeads, [firstHead, currentHead]);
});

test("persisted domain integration: unavailable external review prevents validation", async (t) => {
  const repo = await persistedDomainFixture(t, "persisted-review-unavailable");
  await writeFile(join(repo.worktree, "src-a.mjs"), "export default 1;\n");
  await git(repo.worktree, "add", "src-a.mjs");
  await git(repo.worktree, "commit", "-m", "change");
  await repo.append({ schemaVersion: "pi-plan-event.v1", eventId: "accepted", planId: repo.planId, occurredAt: "2026-07-15T00:00:01.000Z", type: "task.accepted", data: { taskId: "task-1" } });

  const runner = repo.factory({ audit: async () => ({ findings: [] }), externalReview: async () => ({ available: false, findings: [] }) });
  const result = await runner.verifyPlan({ ctx: await repo.replayContext() });
  const entries = (await readFile(repo.eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
  const status = JSON.parse(await readFile(repo.statusPath, "utf8"));

  assert.equal(result.validated, false);
  const external = entries.filter((entry) => entry.type === "gate.finished").find((entry) => entry.data.type === "external-review");
  assert.equal(external.data.status, "unavailable");
  assert.equal(entries.some((entry) => entry.type === "plan.validated"), false);
  assert.equal(status.lifecycle, "verifying");
  assert.equal(status.validatedHead, null);
});
