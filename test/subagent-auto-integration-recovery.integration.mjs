import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createChildIntegrationLifecycle, resetChildIntegrationLifecyclesForTest } from "../packages/pi-subagents-enhanced/src/workspace/child-integration-lifecycle.ts";

class Bus {
  handlers = new Map();
  on(type, fn) { const list = this.handlers.get(type) ?? []; list.push(fn); this.handlers.set(type, list); return () => list.splice(list.indexOf(fn), 1); }
  async emit(type) { for (const fn of [...this.handlers.get(type) ?? []]) await fn({}); }
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function lifecycle(bus, coordinator, messages, options = {}) {
  return createChildIntegrationLifecycle({ pi: { on: bus.on.bind(bus), async sendMessage(message, delivery) { messages.push({ message, delivery }); } }, coordinator,
    resolveBinding: () => ({ runId: "run" }), key: "root/run", pollDelayMs: 0, maxAdmissionPolls: 1, ...options });
}

async function settle(bus) { await bus.emit("agent_end"); await bus.emit("agent_settled"); }

test("extension reload shares one generation and duplicate terminal events do not repeat queue advancement", async () => {
  resetChildIntegrationLifecyclesForTest(); const bus = new Bus(); const messages = []; const calls = [];
  const coordinator = { async prepareAutoIntegration() { calls.push("prepare"); return { queueState: "queued" }; }, async advanceAutoIntegration() { calls.push("advance"); return { queueState: "completed" }; }, async preserveIntegrationDebt() { calls.push("preserve"); } };
  const first = lifecycle(bus, coordinator, messages); const second = lifecycle(bus, coordinator, messages);
  await bus.emit("agent_end"); await bus.emit("agent_end"); await bus.emit("agent_settled"); await bus.emit("agent_settled");
  assert.deepEqual(calls, ["prepare", "advance"]); first.dispose(); second.dispose();
});

test("duplicate lifecycle handlers emit at most one conflict follow-up for one agent_end", async () => {
  resetChildIntegrationLifecyclesForTest(); const bus = new Bus(); const messages = []; const calls = [];
  const states = [{ queueState: "queued" }, { queueState: "resolving-conflict", conflictDigest: "a", continuationAttempt: 1 }];
  const coordinator = { async prepareAutoIntegration() { calls.push("prepare"); return states.shift(); }, async advanceAutoIntegration() { calls.push("advance"); return states.shift(); }, async preserveIntegrationDebt() { calls.push("preserve"); } };
  const first = lifecycle(bus, coordinator, messages); const second = lifecycle(bus, coordinator, messages);
  await bus.emit("agent_end");
  assert.deepEqual(calls, ["prepare", "advance"]); assert.equal(messages.length, 1);
  first.dispose(); second.dispose();
});

test("late trusted prepare result after dispose is discarded and cannot advance or message a later generation", async () => {
  resetChildIntegrationLifecyclesForTest(); const bus = new Bus(); const messages = []; const gate = deferred(); const entered = deferred(); const calls = [];
  const coordinator = { async prepareAutoIntegration() { calls.push("prepare"); entered.resolve(); return gate.promise; }, async advanceAutoIntegration() { calls.push("advance"); return { queueState: "resolving-conflict", conflictDigest: "late" }; }, async preserveIntegrationDebt() { calls.push("preserve"); } };
  const old = lifecycle(bus, coordinator, messages); const pending = bus.emit("agent_end"); await entered.promise; old.dispose();
  const replacement = lifecycle(bus, coordinator, messages); gate.resolve({ queueState: "queued" }); await pending;
  assert.deepEqual(calls, ["prepare"]); assert.equal(messages.length, 0); replacement.dispose();
});

test("only an unchanged conflict digest exhausts the no-progress guard", async () => {
  resetChildIntegrationLifecyclesForTest();
  for (const [digests, expectedMessages, expectedPreserves] of [[["a", "a"], 1, 1], [["a", "b", "c"], 3, 0]]) {
    const bus = new Bus(); const messages = []; const calls = []; const states = [{ queueState: "queued" }, ...digests.map(conflictDigest => ({ queueState: "resolving-conflict", conflictDigest }))];
    const coordinator = { async prepareAutoIntegration() { calls.push("prepare"); return states.shift(); }, async advanceAutoIntegration() { calls.push("advance"); return states.shift(); }, async preserveIntegrationDebt() { calls.push("preserve"); } };
    const item = lifecycle(bus, coordinator, messages);
    for (let index = 0; index < digests.length; index++) await settle(bus);
    assert.equal(messages.length, expectedMessages); assert.equal(calls.filter(x => x === "preserve").length, expectedPreserves); item.dispose(); resetChildIntegrationLifecyclesForTest();
  }
});

test("real coordinator child exit and restart preserves all six recovery stages", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-recovery-process-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queueModule = path.resolve("packages/pi-subagents-enhanced/src/workspace/integration-queue.ts");
  const stages = ["queued", "admitted", "rebasing", "resolving-conflict", "prepared", "completed-awaiting-proof"];
  const run = (mode, stage, index) => new Promise((resolve, reject) => {
    const script = mode === "write"
      ? `import { createIntegrationQueue } from ${JSON.stringify(queueModule)}; const q=createIntegrationQueue({stateRoot:process.env.STATE,repositoryId:process.env.REPO}); const ownerScope={kind:"standalone-subagent",rootSessionId:"root-${index}"}; const item=q.enqueueIntegration({requestId:"restart-${index}",repositoryId:process.env.REPO,workspaceId:"restart-ws-${index}",leaseId:"${"a".repeat(64)}",ownerScope,childRunId:"run-${index}",strategy:"rebase-ff",targetRef:"refs/heads/main",authorizedWorkspaceHead:"${"b".repeat(40)}",observedTargetHead:"${"b".repeat(40)}"}); q.recoveryIntent({queueItemId:item.queueItemId,workspaceId:item.workspaceId,ownerScope,runId:"run-${index}",attempt:1,generation:${index},reason:"root close at ${stage}",requiredAction:"preserve"}); process.stdout.write("ready\\n"); process.on("SIGTERM",()=>process.exit(0)); setInterval(()=>{},1000);`
      : `import { createIntegrationQueue } from ${JSON.stringify(queueModule)}; const q=createIntegrationQueue({stateRoot:process.env.STATE,repositoryId:process.env.REPO}); process.stdout.write(JSON.stringify(q.listRecoveryIntents())+"\\n");`;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { env: { ...process.env, STATE: root, REPO: "c".repeat(64) }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let error = ""; let settled = false;
    const timer = setTimeout(() => { if (settled) return; settled = true; child.kill("SIGKILL"); reject(new Error(`restart child timed out (${mode}/${stage}): ${error}`)); }, 5_000);
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    child.stdout.on("data", chunk => { output += chunk; if (output.includes("\n")) finish({ child, output }); }); child.stderr.on("data", chunk => { error += chunk; }); child.once("error", errorValue => { if (!settled) { settled = true; clearTimeout(timer); reject(errorValue); } }); child.once("exit", (code, signal) => { if (mode === "read" && code !== 0 && !settled) { settled = true; clearTimeout(timer); reject(new Error(`restart child exited ${code}/${signal}: ${error}`)); } });
  });
  const waitExit = (child, label) => new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${label} did not exit within 2s`)); }, 2_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  for (const [index, stage] of stages.entries()) {
    const started = await run("write", stage, index); assert.match(started.output, /ready/); started.child.kill("SIGTERM"); await waitExit(started.child, `writer/${stage}`);
    const restarted = await run("read", stage, index); const intents = JSON.parse(restarted.output.trim()); assert.equal(intents.some(value => value.reason.includes(stage) && value.state === "preserved"), true, stage); if (restarted.child.exitCode === null) { restarted.child.kill("SIGTERM"); await waitExit(restarted.child, `reader/${stage}`); }
  }
});

test("provider, lease, and target failures preserve once without follow-up loops or false success", async () => {
  resetChildIntegrationLifecyclesForTest();
  for (const reason of ["provider error", "lease drift", "target drift", "broker disconnected"]) {
    resetChildIntegrationLifecyclesForTest(); const bus = new Bus(); const messages = []; let preserves = 0; let advances = 0;
    const item = lifecycle(bus, { async prepareAutoIntegration() { throw new Error(reason); }, async advanceAutoIntegration() { advances++; return { queueState: "completed" }; }, async preserveIntegrationDebt() { preserves++; } }, messages);
    await bus.emit("agent_end"); await bus.emit("agent_end");
    assert.equal(preserves, 1, reason); assert.equal(advances, 0, reason); assert.equal(messages.length, 0, reason); item.dispose();
  }
});

test("non-managed lifecycle observes events without creating auto integration state", async () => {
  resetChildIntegrationLifecyclesForTest(); const bus = new Bus(); const calls = [];
  const item = lifecycle(bus, { async prepareAutoIntegration() { calls.push("prepare"); }, async preserveIntegrationDebt() { calls.push("preserve"); } }, [], { managed: false });
  await settle(bus); assert.deepEqual(calls, []); item.dispose();
});
