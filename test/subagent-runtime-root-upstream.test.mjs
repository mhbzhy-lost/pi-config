import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { createJiti } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const npmRoot = join(process.cwd(), "pi/npm/node_modules");
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-ai/compat": `${npmRoot}/@earendil-works/pi-ai/dist/compat.js`,
    "@earendil-works/pi-tui": `${npmRoot}/@earendil-works/pi-tui/dist/index.js`,
    "@earendil-works/pi-coding-agent": `${npmRoot}/@earendil-works/pi-coding-agent/dist/index.js`,
    "@earendil-works/pi-ai": `${npmRoot}/@earendil-works/pi-ai/dist/index.js`,
    "@earendil-works/pi-agent-core": "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/index.js",
  },
});
const runtimeModule = await jiti.import("../pi/extensions/subagent-runtime.ts");
const asyncResumeModule = await jiti.import("../pi/npm/node_modules/pi-subagents/src/runs/background/async-resume.ts");
const piArgsModule = await jiti.import("../pi/npm/node_modules/pi-subagents/src/runs/shared/pi-args.ts");

async function createRecoveryFixture(t, { agent = "plan-runner", sourceRunId, asyncDir } = {}) {
  const root = await mkdtemp(join(tmpdir(), "root-upstream-recovery-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const asyncDirRoot = join(root, "async");
  const runId = "plan-runner-recovery-123";
  const runDir = asyncDir ?? join(asyncDirRoot, runId);
  const descriptorPath = join(runDir, "recovery-descriptor.json");
  await mkdir(runDir, { recursive: true });
  const descriptor = {
    version: 1,
    sourceRunId: sourceRunId ?? runId,
    agent,
    cwd: join(root, "project"),
    systemPromptMode: "append",
    outputMode: "inline",
    inheritProjectContext: true,
    inheritSkills: true,
    share: true,
    maxSubagentDepth: 2,
    tools: ["read"],
    extensions: ["sentinel-extension"],
    skills: ["test-driven-development", "writing-good-tests"],
    artifactConfig: {
      enabled: true,
      includeInput: true,
      includeOutput: true,
      includeJsonl: true,
      includeMetadata: true,
      cleanupDays: 7,
    },
  };
  await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });
  return { asyncDirRoot, runId, runDir, descriptorPath, descriptor };
}

function createUpstream(asyncDirRoot) {
  return runtimeModule.createRootBrokerUpstream({
    rpc: Object.fromEntries(["ping", "spawn", "status", "resume", "steer", "interrupt", "stop", "dispose"].map((method) => [method, () => ({ method })])),
    executeSupervisor: () => undefined,
    asyncDirRoot,
  });
}

test("Root broker upstream exposes only frozen RPC forwarding methods including private resume", () => {
  const { createRootBrokerUpstream } = runtimeModule;
  assert.equal(typeof createRootBrokerUpstream, "function");

  const calls = [];
  const rpc = Object.fromEntries([
    "ping", "spawn", "status", "resume", "steer", "interrupt", "stop", "dispose",
  ].map((method) => [method, (...args) => {
    const result = { method, args };
    calls.push({ method, args, result });
    return result;
  }]));
  const supervisorCalls = [];
  const executeSupervisor = (params, context) => {
    const result = { params, context };
    supervisorCalls.push({ params, context, result });
    return result;
  };

  const upstream = createRootBrokerUpstream({ rpc, executeSupervisor });
  assert.deepEqual(Object.keys(upstream).sort(), [
    "dispose", "executeSupervisor", "interrupt", "ping", "preparePlanRunnerRecovery", "resume", "spawn", "status", "steer", "stop",
  ]);
  assert.equal(Object.isFrozen(upstream), true);

  for (const method of ["ping", "spawn", "status", "steer", "interrupt", "stop", "dispose"]) {
    const args = [{ method }, { requestId: `${method}-request` }];
    const result = upstream[method](...args);
    const call = calls.at(-1);
    assert.equal(call.method, method);
    assert.strictEqual(call.args[0], args[0]);
    assert.strictEqual(call.args[1], args[1]);
    assert.strictEqual(result, call.result);
  }

  const resumeParams = { sessionId: "child-resume-123", message: "continue from checkpoint" };
  const supervisorContext = { sessionId: "root-session-456", source: "private-resume" };
  const resumeResult = upstream.resume(resumeParams, supervisorContext);
  const resumeCall = calls.at(-1);
  assert.equal(resumeCall.method, "resume");
  assert.strictEqual(resumeCall.args[0], resumeParams);
  assert.strictEqual(resumeCall.args[1], supervisorContext);
  assert.strictEqual(resumeResult, resumeCall.result);

  const supervisorParams = { request: "resume supervision" };
  const supervisorResult = upstream.executeSupervisor(supervisorParams, supervisorContext);
  assert.strictEqual(supervisorCalls[0].params, supervisorParams);
  assert.strictEqual(supervisorCalls[0].context, supervisorContext);
  assert.strictEqual(supervisorResult, supervisorCalls[0].result);
});

test("Root broker upstream recovery deletes tools from a trusted plan-runner descriptor", async (t) => {
  const fixture = await createRecoveryFixture(t);
  assert.deepEqual(asyncResumeModule.readAsyncRecoveryDescriptor(fixture.runDir), fixture.descriptor);
  const upstream = createUpstream(fixture.asyncDirRoot);
  await (upstream.preparePlanRunnerRecovery?.({ role: "plan-runner", runId: fixture.runId, asyncDir: fixture.runDir }) ?? Promise.resolve());

  const recovered = JSON.parse(await readFile(fixture.descriptorPath, "utf8"));
  assert.equal(Object.hasOwn(recovered, "tools"), false);
  assert.deepEqual(recovered, Object.fromEntries(Object.entries(fixture.descriptor).filter(([key]) => key !== "tools")));
  assert.deepEqual(asyncResumeModule.readAsyncRecoveryDescriptor(fixture.runDir), recovered);
  assert.equal((await stat(fixture.descriptorPath)).mode & 0o777, 0o600);
});

test("Root broker upstream recovery descriptor omission does not authorize fanout", async (t) => {
  const fixture = await createRecoveryFixture(t);
  assert.deepEqual(asyncResumeModule.readAsyncRecoveryDescriptor(fixture.runDir), fixture.descriptor);
  const upstream = createUpstream(fixture.asyncDirRoot);
  await (upstream.preparePlanRunnerRecovery?.({ role: "plan-runner", runId: fixture.runId, asyncDir: fixture.runDir }) ?? Promise.resolve());

  const recovered = JSON.parse(await readFile(fixture.descriptorPath, "utf8"));
  assert.deepEqual(asyncResumeModule.readAsyncRecoveryDescriptor(fixture.runDir), recovered);
  const toolPlan = piArgsModule.resolvePiLaunchToolPlan({
    tools: recovered.tools,
    extensions: recovered.extensions,
    subagentOnlyExtensions: recovered.subagentOnlyExtensions,
    mcpDirectTools: recovered.mcpDirectTools,
    cwd: recovered.cwd,
  });

  assert.equal(toolPlan.fanoutAuthorized, false);
  assert.equal(toolPlan.explicitToolAllowlist, false);
  assert.equal(toolPlan.runtimeExtensions.some((extension) => basename(extension) === "fanout-child.ts"), false);
  assert.equal(toolPlan.extensionArgs.some((extension) => basename(extension) === "fanout-child.ts"), false);
});

test("Root broker upstream rejects recovery descriptors outside its configured async root without changing bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "root-upstream-outside-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const fixture = await createRecoveryFixture(t, { asyncDir: join(root, "sibling", "plan-runner-recovery-123") });
  const before = await readFile(fixture.descriptorPath);
  const upstream = createUpstream(join(root, "async"));
  await assert.rejects(upstream.preparePlanRunnerRecovery?.({ role: "plan-runner", runId: fixture.runId, asyncDir: fixture.runDir }) ?? Promise.resolve());
  assert.deepEqual(await readFile(fixture.descriptorPath), before);
});

test("Root broker upstream rejects a symlinked recovery descriptor without changing its target bytes", async (t) => {
  const fixture = await createRecoveryFixture(t);
  const targetPath = join(fixture.runDir, "recovery-descriptor-target.json");
  const before = await readFile(fixture.descriptorPath);
  await writeFile(targetPath, before, { mode: 0o600 });
  await rm(fixture.descriptorPath);
  await symlink(targetPath, fixture.descriptorPath);
  const upstream = createUpstream(fixture.asyncDirRoot);
  await assert.rejects(upstream.preparePlanRunnerRecovery?.({ role: "plan-runner", runId: fixture.runId, asyncDir: fixture.runDir }) ?? Promise.resolve());
  assert.equal((await lstat(fixture.descriptorPath)).isSymbolicLink(), true);
  assert.deepEqual(await readFile(targetPath), before);
});

test("Root broker upstream rejects a recovery descriptor with a mismatched source run id without changing bytes", async (t) => {
  const fixture = await createRecoveryFixture(t, { sourceRunId: "other-run" });
  const before = await readFile(fixture.descriptorPath);
  const upstream = createUpstream(fixture.asyncDirRoot);
  await assert.rejects(upstream.preparePlanRunnerRecovery?.({ role: "plan-runner", runId: fixture.runId, asyncDir: fixture.runDir }) ?? Promise.resolve());
  assert.deepEqual(await readFile(fixture.descriptorPath), before);
});

test("Root broker upstream rejects a recovery descriptor for a non-plan-runner agent without changing bytes", async (t) => {
  const fixture = await createRecoveryFixture(t, { agent: "executor" });
  const before = await readFile(fixture.descriptorPath);
  const upstream = createUpstream(fixture.asyncDirRoot);
  await assert.rejects(upstream.preparePlanRunnerRecovery?.({ role: "plan-runner", runId: fixture.runId, asyncDir: fixture.runDir }) ?? Promise.resolve());
  assert.deepEqual(await readFile(fixture.descriptorPath), before);
});
