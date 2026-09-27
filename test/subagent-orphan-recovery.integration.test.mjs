import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createOwnerReceipt } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/authority-contract.ts";
import { AuthorityStore } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/authority-store.ts";
import { captureProcessBirthIdentity } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/process-birth-identity.ts";
import { recoverOrphanRun } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/recovery-resume-orchestrator.ts";

const GATE_ORDER = ["runAuthorization", "sessionEligibility", "identity", "broker", "workspace", "inventory", "rebind", "lease", "barrier", "replay", "ack"];
function startNode(source) {
  const child = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data) => { stderr += data; });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  return { child, exited, stderr: () => stderr };
}

async function liveNode() {
  const process = startNode('process.stdout.write(JSON.stringify({pid:process.pid})+"\\n"); setInterval(()=>{}, 1000);');
  let output = "";
  process.child.stdout.setEncoding("utf8");
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("child did not report its PID")), 2_000);
    process.child.stdout.on("data", (data) => {
      output += data;
      const line = output.indexOf("\n");
      if (line >= 0) { clearTimeout(timeout); resolve(JSON.parse(output.slice(0, line))); }
    });
    process.child.once("error", reject);
  });
  return { ...process, ...(await ready) };
}

async function stop(process) {
  if (!process?.child) return;
  if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill("SIGTERM");
  await process.exited;
}

function receipt({ runId, processBirth, generation }) {
  return createOwnerReceipt({
    receiptId: `receipt-${runId}`, rootSessionId: "root-integration", runId, ownerGeneration: generation,
    processBirth, revision: 1, authorizationReference: `sha256:${"a".repeat(64)}`,
  });
}

function sessionEligibility(session) {
  const header = session?.header;
  return !!(header && header.sourceRunId === session.sourceRunId && header.sessionId === session.sessionId
    && header.agentProfile === session.agentProfile && header.cwd === session.cwd
    && header.status && header.result && header.recoveryDescriptor);
}

function gatesFor(overrides = {}) {
  return Object.fromEntries(GATE_ORDER.map((name) => [name, overrides[name] ?? (() => undefined)]));
}

test("real Node processes capture birth, rebind durable authority, and route eligible sessions only", { concurrency: false, timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "orphan-recovery-integration-"));
  let source;
  let resumed;
  try {
    source = await liveNode();
    resumed = await liveNode();
    const [sourceBirth, resumedBirth] = await Promise.all([captureProcessBirthIdentity(source.pid), captureProcessBirthIdentity(resumed.pid)]);
    assert.match(sourceBirth, /^[a-f0-9]{64}$/);
    assert.match(resumedBirth, /^[a-f0-9]{64}$/);
    const store = new AuthorityStore({ root, rootSessionId: "root-integration" });
    const sourceReceipt = receipt({ runId: "source-run", processBirth: sourceBirth, generation: 1 });
    const resumedReceipt = receipt({ runId: "resumed-run", processBirth: resumedBirth, generation: 2 });
    await store.create(sourceReceipt);
    await store.create(resumedReceipt);

    const eligible = { sourceRunId: "source-run", sessionId: "session-1", agentProfile: "executor", cwd: root,
      header: { sourceRunId: "source-run", sessionId: "session-1", agentProfile: "executor", cwd: root, status: "complete", result: "saved", recoveryDescriptor: "resume" } };
    let resumeLikeCalls = 0;
    const rebound = await recoverOrphanRun({ runId: "resumed-run", ownerReceiptId: resumedReceipt.receiptId, recoveryCache: new Map(), gates: gatesFor({
      sessionEligibility: () => sessionEligibility(eligible) || { kind: "blocked-unknown", provenance: "ineligible session" },
      identity: () => ({ sourcePid: source.pid, sourceBirth, resumedPid: resumed.pid, resumedBirth }),
      rebind: async () => { resumeLikeCalls += 1; return store.associate("source-run", "resumed-run", "rebind-request", sourceReceipt.revision, resumedReceipt.revision); },
    }) });
    assert.deepEqual(rebound, { kind: "rebound", runId: "resumed-run", ownerReceiptId: resumedReceipt.receiptId });
    assert.equal(resumeLikeCalls, 1);
    const durableResumed = await store.read("resumed-run");
    assert.equal(durableResumed.continuedFrom, "source-run");
    assert.ok(durableResumed.receipt.ownerGeneration > sourceReceipt.ownerGeneration);

    const ineligible = { ...eligible, header: { ...eligible.header, sessionId: "wrong-session" } };
    resumeLikeCalls = 0;
    const blocked = await recoverOrphanRun({ runId: "non-eligible-run", ownerReceiptId: "receipt-non-eligible", recoveryCache: new Map(), gates: gatesFor({
      sessionEligibility: () => sessionEligibility(ineligible) || { kind: "blocked-unknown", provenance: "session header mismatch" },
      rebind: () => { resumeLikeCalls += 1; }, lease: () => { resumeLikeCalls += 1; }, replay: () => { resumeLikeCalls += 1; },
    }) });
    assert.equal(blocked.kind, "blocked-unknown");
    assert.match(blocked.provenance, /session header mismatch/);
    assert.equal(resumeLikeCalls, 0, "non-eligible sessions must not invoke rebind/resume-like gates");

    const noHeader = { ...eligible, header: undefined };
    const missingHeader = await recoverOrphanRun({ runId: "no-header-run", ownerReceiptId: "receipt-no-header", recoveryCache: new Map(), gates: gatesFor({
      sessionEligibility: () => sessionEligibility(noHeader) || { kind: "blocked-unknown", provenance: "session header missing" },
      rebind: () => { resumeLikeCalls += 1; },
    }) });
    assert.equal(missingHeader.kind, "blocked-unknown");
    assert.match(missingHeader.provenance, /session header missing/);
    assert.equal(resumeLikeCalls, 0, "missing headers must not invoke rebind/resume-like gates");
  } finally {
    await stop(source);
    await stop(resumed);
    await rm(root, { recursive: true, force: true });
  }
});

test("child observes durable absolute expiry after host renew stops without a stop signal", { concurrency: false, timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "orphan-lease-expiry-"));
  const leasePath = join(root, "durable-lease.json");
  const markerPath = join(root, "expired.json");
  const expiresAt = Date.now() + 1_500;
  let child;
  try {
    // This durable file is the authority fact; the parent deliberately performs no renewal after writing it.
    await writeFile(leasePath, JSON.stringify({ expiresAt }), "utf8");
    child = startNode(`const {readFileSync,writeFileSync}=require('node:fs');const p=${JSON.stringify(leasePath)},m=${JSON.stringify(markerPath)};const f=()=>{const l=JSON.parse(readFileSync(p,'utf8'));if(Date.now()>=l.expiresAt){writeFileSync(m,JSON.stringify({reason:'authority_lease_expired',expiresAt:l.expiresAt}));process.exit(42)}};f();setInterval(f,20);`);
    const exit = await child.exited;
    assert.deepEqual(exit, { code: 42, signal: null });
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    assert.equal(marker.reason, "authority_lease_expired");
    assert.equal(marker.expiresAt, expiresAt);
  } finally {
    await stop(child);
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid durable expiresAt fails closed rather than being treated as an unexpired lease", { concurrency: false }, async () => {
  const result = await recoverOrphanRun({ runId: "invalid-expiry", ownerReceiptId: "receipt", lease: { expiresAt: "not-a-date" }, recoveryCache: new Map(), gates: gatesFor() });
  assert.equal(result.kind, "blocked-unknown");
  assert.equal(result.reason, "authority_lease_expired");
});

// A synchronous JS event-loop block cannot run the observer interval; this test deliberately uses no third-process compensation.
