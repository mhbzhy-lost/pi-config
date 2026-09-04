import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, statSync, readdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createTemporaryArenaSync } from "./helpers/temporary-arena.mjs";
import { createValidationWorkspace, runCleanValidation, releaseValidationWorkspace } from "../src/goal-engine/acceptance-runner.ts";

const fs = createRequire(import.meta.url)("node:fs");

function git(cwd, ...args) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function fixture(t) {
  const arena = createTemporaryArenaSync("acceptance-runner-");
  t.after(() => arena.disposeSync());
  const origin = arena.mkdtempSync("origin-");
  const state = arena.mkdtempSync("state-");
  mkdirSync(join(origin, "home"));
  mkdirSync(join(origin, "tmp"));
  git(origin, "init"); git(origin, "config", "user.email", "test@test.com"); git(origin, "config", "user.name", "Test");
  writeFileSync(join(origin, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(origin, "check.mjs"), "import { existsSync } from 'node:fs'; if (existsSync('ignored.txt')) process.exit(9);\n");
  git(origin, "add", "."); git(origin, "commit", "-m", "init");
  return { origin, state, head: git(origin, "rev-parse", "HEAD") };
}

function strictPlan() {
  return {
    schema: "dispatch-ir.v1.validation-plan",
    limits: { timeoutMs: 5_000, maxOutputBytes: 64 * 1024, terminationGraceMs: 50, maxConcurrentWorkspaces: 1 },
    actions: [{ id: "clean-check", kind: "validation", executable: process.execPath, args: ["check.mjs"] }],
  };
}

async function waitUntil(check, message, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

function workerResult(child) {
  return new Promise((resolve, reject) => {
    let receipt;
    child.once("message", (message) => { receipt = message; });
    child.once("error", reject);
    child.once("exit", (code) => {
      try { assert.equal(code, 0, "capacity worker did not exit cleanly"); assert.ok(receipt, "capacity worker omitted IPC receipt"); resolve(receipt); }
      catch (error) { reject(error); }
    });
  });
}

test("validation allocation serializes cross-process capacity before managed Git creation", async (t) => {
  const f = fixture(t); const barrier = join(f.state, "capacity-barrier"); mkdirSync(barrier);
  const workers = []; const results = []; const receipts = []; const runnerUrl = pathToFileURL(join(process.cwd(), "src/goal-engine/acceptance-runner.mjs")).href;
  const source = String.raw`const fs=require('node:fs'),path=require('node:path'),{syncBuiltinESMExports}=require('node:module');const [configText,index]=process.argv.slice(1),c=JSON.parse(configText),ready=path.join(c.barrier,'ready-'+index),start=path.join(c.barrier,'start'),reached=path.join(c.barrier,'reached-'+index),release=path.join(c.barrier,'release');const original=fs.writeFileSync;let intercepted=false;const initialLeaseTemp=file=>typeof file==='string'&&path.basename(path.dirname(file))==='validation-leases'&&/^\.validation-[a-f0-9]{64}\.\d+\.\d+$/.test(path.basename(file));fs.writeFileSync=(file,...args)=>{if(!intercepted&&initialLeaseTemp(file)){intercepted=true;original(reached,'',{flag:'wx',mode:0o600});const cell=new Int32Array(new SharedArrayBuffer(4)),end=Date.now()+5000;while(!fs.existsSync(release)&&Date.now()<end)Atomics.wait(cell,0,0,10);if(!fs.existsSync(release))throw Error('release barrier timeout')}return original(file,...args)};syncBuiltinESMExports();const waitStart=()=>{const end=Date.now()+5000;while(!fs.existsSync(start)){if(Date.now()>=end)throw Error('start barrier timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)}};(async()=>{try{const m=await import(c.runnerUrl);original(ready,'',{flag:'wx',mode:0o600});waitStart();const lease=m.createValidationWorkspace({...c.input,taskId:'capacity-'+index});process.send({success:true,lease})}catch(error){process.send({success:false,capacityConflict:/capacity conflict/i.test(String(error&&error.message))})}})();`;
  const config = JSON.stringify({ runnerUrl, barrier, input: { originRoot: f.origin, stateRoot: f.state, goalId: "g", taskId: "placeholder", attempt: 1, integratedHead: f.head, validationPlan: strictPlan() } });
  try {
    for (let i = 0; i < 10; i++) { const child = spawn(process.execPath, ["-e", source, config, String(i)], { stdio: ["ignore", "ignore", "ignore", "ipc"] }); workers.push(child); results.push(workerResult(child)); }
    await waitUntil(() => readdirSync(barrier).filter((name) => name.startsWith("ready-")).length === workers.length, "capacity workers did not reach the start barrier");
    writeFileSync(join(barrier, "start"), "", { mode: 0o600 });
    await waitUntil(() => readdirSync(barrier).some((name) => name.startsWith("reached-")), "no capacity worker reached initial reservation");
    await new Promise((resolve) => setTimeout(resolve, 400));
    writeFileSync(join(barrier, "release"), "", { mode: 0o600 });
    const outcomes = await Promise.all(results); receipts.push(...outcomes.filter((outcome) => outcome.success));
    const durable = readdirSync(join(f.state, "validation-leases")).map((name) => JSON.parse(readFileSync(join(f.state, "validation-leases", name), "utf8"))).filter((lease) => lease.state !== "released");
    assert.equal(durable.length, 1, "capacity reservation exceeded one durable nonreleased lease");
    assert.equal(worktreeCount(f.origin), 2, "capacity conflicts must occur before managed Git creation");
    assert.equal(outcomes.filter((outcome) => outcome.success).length, 1, "anonymous success count");
    assert.equal(outcomes.filter((outcome) => !outcome.success && outcome.capacityConflict).length, workers.length - 1, "anonymous capacity-conflict count");
  } finally {
    if (!existsSync(join(barrier, "release"))) writeFileSync(join(barrier, "release"), "", { mode: 0o600 });
    const outcomes = await Promise.all(results.map((result) => result.catch(() => null))); for (const outcome of outcomes) if (outcome?.success && !receipts.includes(outcome)) receipts.push(outcome);
    for (const receipt of receipts) try { releaseValidationWorkspace(receipt.lease, { expectedHead: f.head }); } catch {}
    await Promise.all(workers.map(async (child) => { if (child.exitCode === null) { await new Promise((resolve) => setTimeout(resolve, 200)); if (child.exitCode === null) child.kill("SIGKILL"); } }));
  }
});

test("run fails closed when a preexisting start authorization is forged", async (t) => {
  const f = fixture(t); const marker = join(f.state, "forged-start-marker");
  const plan = { ...strictPlan(), actions: [{ id: "marker", kind: "validation", executable: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`] }] };
  const lease = createValidationWorkspace({ originRoot: f.origin, stateRoot: f.state, goalId: "g", taskId: "forged-start", attempt: 1, integratedHead: f.head, validationPlan: plan }); release(t, lease);
  const run = runCleanValidation({ lease, actionId: "marker" });
  const running = JSON.parse(readFileSync(leaseFile(lease), "utf8")); const runtime = running.runtime.path;
  writeFileSync(join(runtime, "start"), JSON.stringify({ forged: true }), { mode: 0o600 });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  const error = await run.then(() => null, (reason) => reason);
  const durable = JSON.parse(readFileSync(leaseFile(lease), "utf8")); const supervisorPid = durable.runtime?.pid;
  let supervisorGone = false; try { process.kill(supervisorPid, 0); } catch (reason) { supervisorGone = reason.code === "ESRCH"; }
  assert.deepEqual({ failedClosed: error instanceof Error, markerAbsent: !existsSync(marker), cleanupDebt: durable.state === "cleanup-debt", exactSupervisorGone: supervisorGone }, { failedClosed: true, markerAbsent: true, cleanupDebt: true, exactSupervisorGone: true });
});

test("validation binds an immutable trusted exact Host plan and rejects caller commands", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.origin, "ignored.txt"), "executor-only\n");
  const plan = strictPlan();
  const lease = createValidationWorkspace({
    originRoot: f.origin, stateRoot: f.state, goalId: "g", taskId: "t", attempt: 1,
    integratedHead: f.head, validationPlan: plan,
  });

  assert.deepEqual(lease.validationPlan, plan);
  plan.actions[0].args[0] = "tampered.mjs";
  assert.deepEqual(lease.validationPlan.actions[0].args, ["check.mjs"]);
  assert.throws(() => runCleanValidation({ lease, command: process.execPath, args: ["-e", "process.exit(0)"] }), /actionId|command|plan/i);
  assert.throws(() => runCleanValidation({ lease, actionId: "unknown" }), /actionId|unknown|plan/i);
  assert.equal(existsSync(join(lease.path, "ignored.txt")), false);
});

test("validation rejects non-current/full identity and isolates HOME TMPDIR and inherited secrets", async (t) => {
  const f = fixture(t);
  const plan = {
    ...strictPlan(),
    actions: [{ id: "environment", kind: "validation", executable: process.execPath, args: ["-e", "const fs=require('fs'); if(process.env.SECRET_SENTINEL||!fs.existsSync(process.env.HOME)||!fs.existsSync(process.env.TMPDIR)) process.exit(7)"] }],
  };
  assert.throws(() => createValidationWorkspace({ originRoot: f.origin, stateRoot: f.state, goalId: "g", taskId: "bad", attempt: 1, integratedHead: f.head.slice(0, 7), validationPlan: plan }), /full|SHA|identity/i);
  const previous = process.env.SECRET_SENTINEL;
  process.env.SECRET_SENTINEL = "must-not-cross-validation-boundary";
  t.after(() => { if (previous === undefined) delete process.env.SECRET_SENTINEL; else process.env.SECRET_SENTINEL = previous; });
  const lease = createValidationWorkspace({ originRoot: f.origin, stateRoot: f.state, goalId: "g", taskId: "env", attempt: 1, integratedHead: f.head, validationPlan: plan });
  const result = await runCleanValidation({ lease, actionId: "environment" });
  assert.equal(result.status, "passed");
});

test("validation supervisor has a safe environment and managed-worktree cwd", async (t) => {
  const f = fixture(t); const sentinel = "VALIDATION_SUPERVISOR_SENTINEL"; const previous = process.env[sentinel]; const observation = join(f.state, "supervisor-observation.json");
  process.env[sentinel] = "fixed-non-sensitive-sentinel";
  t.after(() => { if (previous === undefined) delete process.env[sentinel]; else process.env[sentinel] = previous; });
  const managedPath = join(f.state, "validation-worktrees", "g-supervisor-isolation-1");
  const source = `const{execFileSync}=require('child_process'),fs=require('fs');const p=process.ppid;const environment=execFileSync('/bin/ps',['eww','-p',String(p),'-o','command='],{encoding:'utf8'});const cwd=execFileSync('/usr/sbin/lsof',['-a','-p',String(p),'-d','cwd','-Fn'],{encoding:'utf8'}).split('\\n').find(x=>x.startsWith('n'))?.slice(1);fs.writeFileSync(${JSON.stringify(observation)},JSON.stringify({noSentinel:!environment.includes(${JSON.stringify(sentinel)}),managedCwd:cwd===${JSON.stringify(managedPath)}}));`;
  const plan = { ...strictPlan(), actions: [{ id: "clean-check", kind: "validation", executable: process.execPath, args: ["-e", source] }] };
  const lease = createValidationWorkspace({ originRoot: f.origin, stateRoot: f.state, goalId: "g", taskId: "supervisor-isolation", attempt: 1, integratedHead: f.head, validationPlan: plan });
  assert.equal(lease.path, managedPath);
  const result = await runCleanValidation({ lease, actionId: "clean-check" });
  const observed = JSON.parse(readFileSync(observation, "utf8"));
  assert.deepEqual(observed, { noSentinel: true, managedCwd: true }, "supervisor environment or cwd is not isolated");
  assert.equal(result.status, "passed");
});

function leaseFile(lease) { return join(lease.stateRoot, "validation-leases", `${lease.id}.json`); }
function worktreeCount(origin) { return git(origin, "worktree", "list", "--porcelain").split("\nworktree ").length; }
function release(t, lease) { t.after(() => { try { releaseValidationWorkspace(lease, { expectedHead: lease.integratedHead }); } catch {} }); }

test("validation initial lease publication never replaces a file raced into its final path", (t) => {
  const f = fixture(t); const taskId = "initial-lease-race"; const leaseFile = join(f.state, "validation-leases", `validation-${createHash("sha256").update(`${realpathSync(f.origin)}\0g\0${taskId}\0${1}`).digest("hex")}.json`);
  const originalRename = fs.renameSync; const originalLink = fs.linkSync; const originalOpen = fs.openSync; const originalWrite = fs.writeFileSync; const racedContents = "existing-0600-lease"; let injected = false; let created;
  const inject = (file) => {
    if (!injected && file === leaseFile) { injected = true; originalWrite(file, racedContents, { mode: 0o600, flag: "wx" }); }
  };
  t.after(() => { if (created) try { releaseValidationWorkspace(created, { expectedHead: f.head }); } catch {} });
  fs.renameSync = (from, to, ...args) => { inject(to); return originalRename(from, to, ...args); };
  fs.linkSync = (from, to, ...args) => { inject(to); return originalLink(from, to, ...args); };
  fs.openSync = (file, ...args) => { inject(file); return originalOpen(file, ...args); };
  fs.writeFileSync = (file, ...args) => { inject(file); return originalWrite(file, ...args); };
  syncBuiltinESMExports();
  try {
    assert.throws(() => { created = createValidationWorkspace({ originRoot: f.origin, stateRoot: f.state, goalId: "g", taskId, attempt: 1, integratedHead: f.head, validationPlan: strictPlan() }); }, /lease|exist|replace|publish/i);
  } finally {
    fs.renameSync = originalRename;
    fs.linkSync = originalLink;
    fs.openSync = originalOpen;
    fs.writeFileSync = originalWrite;
    syncBuiltinESMExports();
  }
  assert.equal(injected, true);
  assert.equal(readFileSync(leaseFile, "utf8"), racedContents);
  assert.equal(statSync(leaseFile).mode & 0o777, 0o600);
  assert.equal(worktreeCount(f.origin), 1);
  assert.equal(existsSync(join(f.origin, ".state", "worktree-lifecycle", "leases")), false);
  assert.equal(spawnSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/ge-validation/g/initial-lease-race/1"], { cwd: f.origin }).status, 1);
});

// This table deliberately exercises preflight only: no invalid input may allocate Git or lease state.
test("preflight rejects malformed plans without allocating a worktree, branch, manifest, or lease", (t) => {
  const f = fixture(t); const baseline = worktreeCount(f.origin);
  const cases = [
    { ...strictPlan(), extra: true },
    { ...strictPlan(), limits: { ...strictPlan().limits, extra: true } },
    { ...strictPlan(), actions: [{ ...strictPlan().actions[0], extra: true }] },
    { ...strictPlan(), actions: [{ ...strictPlan().actions[0] }, { ...strictPlan().actions[0] }] },
    { ...strictPlan(), actions: [{ ...strictPlan().actions[0], kind: "setup" }] },
    { ...strictPlan(), actions: [{ ...strictPlan().actions[0], executable: "node" }] },
    { ...strictPlan(), actions: [{ ...strictPlan().actions[0], args: ["\0"] }] },
    { ...strictPlan(), limits: { ...strictPlan().limits, timeoutMs: 1 } },
  ];
  for (const plan of cases) assert.throws(() => createValidationWorkspace({ originRoot: f.origin, stateRoot: f.state, goalId: "g", taskId: `bad${cases.indexOf(plan)}`, attempt: 1, integratedHead: f.head, validationPlan: plan }));
  assert.equal(worktreeCount(f.origin), baseline);
  assert.equal(existsSync(join(f.state, "validation-leases")), false);
  assert.equal(existsSync(join(f.origin, ".state", "worktree-lifecycle", "leases")), false);
});

test("run rejects a symlink-replaced durable lease before the action marker is produced", async (t) => {
  const f = fixture(t); const marker = join(f.state, "marker");
  const plan = { ...strictPlan(), actions: [{ id: "marker", kind: "validation", executable: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`] }] };
  const lease = createValidationWorkspace({ originRoot: f.origin, stateRoot: f.state, goalId: "g", taskId: "symlink", attempt: 1, integratedHead: f.head, validationPlan: plan }); release(t, lease);
  const file = leaseFile(lease); assert.equal(statSync(file).mode & 0o777, 0o600); const saved = readFileSync(file); const replacement = join(f.state, "replacement.json"); writeFileSync(replacement, saved); rmSync(file); symlinkSync(replacement, file);
  try { await assert.rejects(runCleanValidation({ lease, actionId: "marker" }), /symlink|lease|identity/i); assert.equal(existsSync(marker), false); }
  finally { rmSync(file); writeFileSync(file, saved, { mode: 0o600 }); }
});

test("run records durable running state while an action is live and restores no runtime after success", async (t) => {
  const f = fixture(t);
  const plan = { ...strictPlan(), actions: [{ id: "wait", kind: "validation", executable: process.execPath, args: ["-e", "setTimeout(()=>process.exit(0),200)"] }] };
  const lease = createValidationWorkspace({ originRoot: f.origin, stateRoot: f.state, goalId: "g", taskId: "running", attempt: 1, integratedHead: f.head, validationPlan: plan }); release(t, lease);
  const run = runCleanValidation({ lease, actionId: "wait" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  try { assert.equal(JSON.parse(readFileSync(leaseFile(lease))).state, "running"); }
  finally { await run; }
  const runtimeRoot = join(f.state, "validation-runtime");
  assert.equal(!existsSync(runtimeRoot) || readdirSync(runtimeRoot).length === 0, true);
});

test("spawn infrastructure failure leaves a diagnostic runtime and durable cleanup debt", async (t) => {
  const f = fixture(t); const plan = { ...strictPlan(), actions: [{ id: "missing", kind: "validation", executable: join(f.state, "does-not-exist"), args: [] }] };
  const lease = createValidationWorkspace({ originRoot: f.origin, stateRoot: f.state, goalId: "g", taskId: "infra", attempt: 1, integratedHead: f.head, validationPlan: plan });
  await assert.rejects(runCleanValidation({ lease, actionId: "missing" }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(JSON.parse(readFileSync(leaseFile(lease))).state, "cleanup-debt");
  assert.equal(existsSync(join(f.state, "validation-runtime")), true);
});

test("validation bounds a SIGTERM-ignoring timeout leader and returns a terminal proof", async (t) => {
  const f = fixture(t); const marker = join(f.state, "timeout-leader.pid");
  const plan = {
    ...strictPlan(), limits: { ...strictPlan().limits, timeoutMs: 100, terminationGraceMs: 50 },
    actions: [{ id: "ignore-term", kind: "validation", executable: process.execPath, args: ["-e", `const fs=require('fs'); fs.writeFileSync(${JSON.stringify(marker)},String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)`] }],
  };
  const lease = createValidationWorkspace({ originRoot: f.origin, stateRoot: f.state, goalId: "g", taskId: "timeout-leader", attempt: 1, integratedHead: f.head, validationPlan: plan });
  const run = runCleanValidation({ lease, actionId: "ignore-term" }); let pending = true;
  void run.catch(() => {}); run.then(() => { pending = false; }, () => { pending = false; });
  let pid; let deadline;
  try {
    const result = await Promise.race([
      run,
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("SIGTERM-ignoring leader did not terminate within 1500ms")), 1500); }),
    ]);
    pid = Number(readFileSync(marker, "utf8"));
    assert.equal(result.status, "timed_out"); assert.equal(result.terminal, true);
    assert.match(result.processGroupTerminalProof, /^[a-f0-9]{64}$/);
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally {
    clearTimeout(deadline);
    if (existsSync(marker)) {
      pid ??= Number(readFileSync(marker, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 0) try { process.kill(pid, "SIGKILL"); } catch {}
    }
    if (pending) await Promise.race([run.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 500))]);
  }
});

test("run rejects managed owner drift before the action marker is produced", async (t) => {
  const f = fixture(t); const marker = join(f.state, "owner-drift-marker");
  const plan = { ...strictPlan(), actions: [{ id: "marker", kind: "validation", executable: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`] }] };
  const lease = createValidationWorkspace({ originRoot: f.origin, stateRoot: f.state, goalId: "g", taskId: "owner-drift", attempt: 1, integratedHead: f.head, validationPlan: plan });
  const manifestFile = join(f.origin, ".state", "worktree-lifecycle", "leases", `${lease.id}.json`);
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")); const replacementOwner = `worktree-owner.v1:${"a".repeat(64)}`;
  assert.notEqual(replacementOwner, manifest.ownerToken);
  writeFileSync(manifestFile, JSON.stringify({ ...manifest, ownerToken: replacementOwner }));
  await assert.rejects(runCleanValidation({ lease, actionId: "marker" }), /owner|identity|managed|lease/i);
  assert.equal(existsSync(marker), false);
  assert.equal(JSON.parse(readFileSync(manifestFile, "utf8")).ownerToken, replacementOwner);
});

test("run rechecks managed ownership after recording its supervisor and before action start", async (t) => {
  const f = fixture(t); const marker = join(f.state, "post-supervisor-owner-marker");
  const plan = { ...strictPlan(), actions: [{ id: "marker", kind: "validation", executable: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`] }] };
  const lease = createValidationWorkspace({ originRoot: f.origin, stateRoot: f.state, goalId: "g", taskId: "post-supervisor-owner", attempt: 1, integratedHead: f.head, validationPlan: plan });
  const manifestFile = join(f.origin, ".state", "worktree-lifecycle", "leases", `${lease.id}.json`); const saved = readFileSync(manifestFile);
  let runtimePid;
  try {
    const run = runCleanValidation({ lease, actionId: "marker" });
    const running = JSON.parse(readFileSync(leaseFile(lease), "utf8")).state === "running";
    const manifest = JSON.parse(saved); writeFileSync(manifestFile, JSON.stringify({ ...manifest, ownerToken: `worktree-owner.v1:${"b".repeat(64)}` }));
    const rejected = await run.then(() => false, () => true);
    const durable = JSON.parse(readFileSync(leaseFile(lease), "utf8")); runtimePid = durable.runtime.pid;
    let supervisorGone = false; try { process.kill(runtimePid, 0); } catch (error) { supervisorGone = error.code === "ESRCH"; }
    assert.deepEqual({ running, rejected, markerAbsent: !existsSync(marker), cleanupDebt: durable.state === "cleanup-debt", exactSupervisorGone: supervisorGone }, { running: true, rejected: true, markerAbsent: true, cleanupDebt: true, exactSupervisorGone: true });
  } finally {
    writeFileSync(manifestFile, saved, { mode: 0o600 });
    if (Number.isSafeInteger(runtimePid) && runtimePid > 0) assert.throws(() => process.kill(runtimePid, 0), /ESRCH/);
  }
});

test("run rejects a detached validation worktree even at the integrated HEAD before action", async (t) => {
  const f = fixture(t); const marker = join(f.state, "detached-marker");
  const plan = { ...strictPlan(), actions: [{ id: "marker", kind: "validation", executable: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`] }] };
  const lease = createValidationWorkspace({ originRoot: f.origin, stateRoot: f.state, goalId: "g", taskId: "detached", attempt: 1, integratedHead: f.head, validationPlan: plan });
  git(lease.path, "switch", "--detach", f.head);
  await assert.rejects(runCleanValidation({ lease, actionId: "marker" }), /branch|identity|managed|lease/i);
  assert.equal(existsSync(marker), false);
});

test("validation enforces byte limits and proves its whole process group terminal", async (t) => {
  const f = fixture(t);
  const plan = {
    schema: "dispatch-ir.v1.validation-plan", limits: { timeoutMs: 1000, maxOutputBytes: 5, terminationGraceMs: 50, maxConcurrentWorkspaces: 1 },
    actions: [{ id: "descendant", kind: "validation", executable: process.execPath, args: ["-e", "process.stdout.write('ééé'); process.stderr.write('界'); const {spawn}=require('child_process'); spawn(process.execPath,['-e','process.on(\\\"SIGTERM\\\",()=>{});setInterval(()=>{},1000)'],{detached:false,stdio:'ignore'}); setTimeout(()=>process.exit(0),10)"] }],
  };
  const lease = createValidationWorkspace({ originRoot: f.origin, stateRoot: f.state, goalId: "g", taskId: "group", attempt: 1, integratedHead: f.head, validationPlan: plan });
  const result = await runCleanValidation({ lease, actionId: "descendant" });
  assert.equal(result.terminal, true);
  assert.match(result.processGroupTerminalProof, /.+/);
  assert.equal(result.outputBytes <= 5, true);
  assert.equal(Buffer.byteLength(result.output, "utf8") <= 5, true);
  assert.equal(result.truncated, true);
});

test("release records cleanup debt when the managed owner identity drifts", async (t) => {
  const f = fixture(t);
  const lease = createValidationWorkspace({ originRoot: f.origin, stateRoot: f.state, goalId: "g", taskId: "release-owner-drift", attempt: 1, integratedHead: f.head, validationPlan: strictPlan() });
  const manifestFile = join(f.origin, ".state", "worktree-lifecycle", "leases", `${lease.id}.json`);
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")); const replacementOwner = `worktree-owner.v1:${"c".repeat(64)}`;
  writeFileSync(manifestFile, JSON.stringify({ ...manifest, ownerToken: replacementOwner }));

  await assert.rejects(async () => releaseValidationWorkspace(lease, { expectedHead: f.head }), /owner|identity|managed|lease/i);
  assert.equal(JSON.parse(readFileSync(leaseFile(lease), "utf8")).state, "cleanup-debt");
  const retained = JSON.parse(readFileSync(manifestFile, "utf8"));
  assert.equal(retained.ownerToken, replacementOwner);
  assert.equal(retained.path, lease.path); assert.equal(retained.branchRef, `refs/heads/${lease.branch}`);
  assert.equal(existsSync(lease.path), true);
  assert.equal(git(f.origin, "worktree", "list", "--porcelain").includes(`worktree ${lease.path}\nHEAD ${f.head}\nbranch refs/heads/${lease.branch}`), true);
  assert.doesNotThrow(() => git(f.origin, "show-ref", "--verify", "--quiet", `refs/heads/${lease.branch}`));
});

test("release records cleanup debt when the validation worktree path is missing", async (t) => {
  const f = fixture(t);
  const lease = createValidationWorkspace({ originRoot: f.origin, stateRoot: f.state, goalId: "g", taskId: "release-missing-path", attempt: 1, integratedHead: f.head, validationPlan: strictPlan() });
  const manifestFile = join(f.origin, ".state", "worktree-lifecycle", "leases", `${lease.id}.json`); const manifest = readFileSync(manifestFile, "utf8");
  rmSync(lease.path, { recursive: true, force: true });

  await assert.rejects(async () => releaseValidationWorkspace(lease, { expectedHead: f.head }), /path|identity|managed|Git|lease/i);
  assert.equal(JSON.parse(readFileSync(leaseFile(lease), "utf8")).state, "cleanup-debt");
  assert.equal(readFileSync(manifestFile, "utf8"), manifest);
  assert.equal(existsSync(lease.path), false);
  assert.equal(git(f.origin, "worktree", "list", "--porcelain").includes(`worktree ${lease.path}\nHEAD ${f.head}\nbranch refs/heads/${lease.branch}`), true);
  assert.doesNotThrow(() => git(f.origin, "show-ref", "--verify", "--quiet", `refs/heads/${lease.branch}`));
});

test("validation records an independent stable supervisor rather than its short-lived action", async (t) => {
  const f = fixture(t); const marker = join(f.state, "action.pid");
  const plan = { ...strictPlan(), actions: [{ id: "supervised", kind: "validation", executable: process.execPath, args: ["-e", `const fs=require('fs'); fs.writeFileSync(${JSON.stringify(marker)},String(process.pid)); setTimeout(()=>process.exit(0),200)`] }] };
  const lease = createValidationWorkspace({ originRoot: f.origin, stateRoot: f.state, goalId: "g", taskId: "stable-supervisor", attempt: 1, integratedHead: f.head, validationPlan: plan });
  const run = runCleanValidation({ lease, actionId: "supervised" }); void run.catch(() => {});
  let actionPid; let runtimePid; let runtimeBirth; let completed = false;
  try {
    for (let i = 0; i < 100 && !existsSync(marker); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(existsSync(marker), true, "action did not write its PID marker");
    actionPid = Number(readFileSync(marker, "utf8"));
    const durable = JSON.parse(readFileSync(leaseFile(lease), "utf8")); runtimePid = durable.runtime.pid; runtimeBirth = durable.runtime.pidBirthIdentity;
    assert.equal(Number.isSafeInteger(runtimePid) && runtimePid > 0, true);
    assert.notEqual(runtimePid, actionPid);
    assert.doesNotThrow(() => process.kill(runtimePid, 0)); assert.doesNotThrow(() => process.kill(actionPid, 0));
    const result = await run;
    assert.equal(result.pid, runtimePid); assert.equal(result.pidBirthIdentity, runtimeBirth);
    assert.match(result.processGroupTerminalProof, /^[a-f0-9]{64}$/);
    assert.throws(() => process.kill(runtimePid, 0), /ESRCH/); assert.throws(() => process.kill(actionPid, 0), /ESRCH/);
    completed = true;
  } finally {
    if (!completed) for (const pid of new Set([actionPid, runtimePid])) if (Number.isSafeInteger(pid) && pid > 0) try { process.kill(pid, "SIGKILL"); } catch {}
    await run.catch(() => {});
    releaseValidationWorkspace(lease, { expectedHead: lease.integratedHead });
  }
});
