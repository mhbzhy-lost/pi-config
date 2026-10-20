import { mkdir, readFile, writeFile, rename, cp, appendFile } from "node:fs/promises";
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const ACCEPTANCE_TASKS = Object.freeze([
  { name: "parse", writePath: "src/pipeline.ts", behaviorAssertion: "parse stage is present" },
  { name: "validate", writePath: "src/pipeline.ts", behaviorAssertion: "validate stage is present" },
  { name: "transform", writePath: "src/pipeline.ts", behaviorAssertion: "transform stage is present" },
  { name: "serialize", writePath: "src/pipeline.ts", behaviorAssertion: "serialize stage is present" },
  { name: "audit", writePath: "src/pipeline.ts", behaviorAssertion: "audit stage is present" },
]);

/** Public evidence contracts consumed by this probe (never internal ledger/events). */
export function validateAcceptanceReadyReceipt(receipt, { runId, baseCommit } = {}) {
  if (!receipt || receipt.schemaVersion !== "repository-merge-queue-ready.v1") throw new Error("invalid acceptance barrier ready schema");
  if (runId && receipt.runId !== runId) throw new Error("acceptance ready receipt run mismatch");
  if (typeof receipt.runId !== "string" || !receipt.runId || typeof receipt.worktree !== "string" || !receipt.worktree
    || typeof receipt.baseCommit !== "string" || !/^[0-9a-f]{40}$/i.test(receipt.baseCommit)
    || !Number.isInteger(receipt.pid) || receipt.pid <= 0) throw new Error("acceptance ready receipt requires trusted run/cwd/HEAD/PID");
  if (baseCommit && receipt.baseCommit !== baseCommit) throw new Error("acceptance ready receipt base commit mismatch");
  return true;
}

export function validateAcceptanceConflictEvidence(evidence) {
  if (!evidence || typeof evidence !== "object" || !Number.isInteger(evidence.rebaseExitCode) || evidence.rebaseExitCode === 0
    || !Array.isArray(evidence.unmergedEntries) || evidence.unmergedEntries.length === 0
    || !evidence.sequencer || typeof evidence.sequencer !== "object"
    || typeof evidence.conflictDigest !== "string" || !/^[0-9a-f]{64}$/i.test(evidence.conflictDigest)) {
    throw new Error("invalid acceptance conflict evidence: rebase, unmerged entries, sequencer, and Git conflict digest are required");
  }
  if (evidence.digestSource !== "git") throw new Error("acceptance conflict digest must be sourced from Git facts");
  return true;
}

export function collectAcceptanceLifecycleCounts(records = []) {
  const counts = { agent_end: 0, follow_up: 0, next_agent_start: 0 };
  let ended = false;
  for (const record of records) {
    const type = record?.type;
    if (type === "agent_end") { counts.agent_end += 1; ended = true; }
    else if (type === "follow-up" || type === "follow_up") counts.follow_up += 1;
    else if (type === "agent_start" && ended) counts.next_agent_start += 1;
  }
  return Object.freeze(counts);
}

export function parseAcceptanceOptions(argv = []) {
  const values = { roots: 2, subagents: 5, requireConflicts: 4, model: "codex-pool/gpt-5.6-sol" };
  const names = new Map([["--roots", "roots"], ["--subagents", "subagents"], ["--require-conflicts", "requireConflicts"], ["--model", "model"]]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const name = names.get(argv[index]);
    if (!name || seen.has(name) || index + 1 >= argv.length) throw new Error(`unknown or incomplete acceptance option: ${argv[index]}`);
    const value = argv[++index];
    if (name === "model") {
      if (!/^[^\/\s]+\/\S+$/.test(value) || /fake|deterministic/i.test(value)) throw new Error("--model must be a qualified provider/model-id of a real executor model");
      values[name] = value;
    } else {
      if (!/^\d+$/.test(value)) throw new Error(`${argv[index - 1]} must be an integer`);
      values[name] = Number(value);
    }
    seen.add(name);
  }
  if (values.roots < 1 || values.roots > 2) throw new Error("roots must be 1 or 2");
  if (values.subagents < 1 || values.subagents > 5 || values.subagents < values.roots) throw new Error("subagents must be between 1 and 5 and cover every root");
  if (values.requireConflicts > values.subagents - 1) throw new Error("require-conflicts cannot exceed subagents - 1");
  return Object.freeze(values);
}

export function createAcceptanceDispatchPlan({ model = "codex-pool/gpt-5.6-sol", roots = 2, subagents = 5 } = {}) {
  if (!model || /fake|deterministic/i.test(model)) throw new Error("acceptance coding children require a real executor model");
  if (!Number.isInteger(roots) || roots < 1 || roots > 2) throw new Error("roots must be 1 or 2");
  if (!Number.isInteger(subagents) || subagents < roots || subagents > ACCEPTANCE_TASKS.length) throw new Error("subagents must be between 1 and 5 and cover every root");
  const tasksPerRoot = Math.ceil(subagents / roots);
  return Object.freeze({
    roots: Object.freeze(Array.from({ length: roots }, (_, index) => Object.freeze({
      rootSessionId: `root-${String.fromCharCode(97 + index)}`,
      tasks: Object.freeze(ACCEPTANCE_TASKS.slice(index * tasksPerRoot, Math.min(subagents, (index + 1) * tasksPerRoot)).map((task) => task.name)),
    }))),
    children: Object.freeze(ACCEPTANCE_TASKS.slice(0, subagents).map((task) => Object.freeze({
      taskId: `acceptance-${task.name}`,
      title: `Acceptance pipeline ${task.name} stage`,
      agent: "executor", model, risk: "high",
      task: `Modify the shared PIPELINE declaration line to add only the ${task.name} stage.`,
      workflow: { mode: "tdd" },
      requirements: [`Modify the same line in ${task.writePath}.`, "Add test/pipeline.test.mjs, run the focused test, and create a commit.", "The commit message must use Conventional Commit format with a Chinese subject, for example 'feat: 添加 ${task.name} 阶段'; English-only or non-conventional subjects are rejected by the repository gate.", "Only perform business-file changes and, when given a conflict continuation, resolve unmerged files and git add them; Auto Integration queues, rebases, resolves lifecycle, and publishes the candidate."],
      context: { knownFacts: ["Five tasks intentionally edit the same pipeline line."], decisions: ["Auto Integration owns queue admission, rebase, conflict continuation, and publication."], relevantFiles: [task.writePath, "test/pipeline.test.mjs"] },
      writePaths: [task.writePath, "test/pipeline.test.mjs"],

      acceptance: { criteria: [task.behaviorAssertion, `The ${task.writePath} change is covered by test/pipeline.test.mjs and committed with the required conventional message.`] },
      worktree: true,
    }))),
  });
}

export function createAcceptancePrompt(plan, root) {
  const children = plan.children.filter((child) => root.tasks.includes(child.taskId.replace(/^acceptance-/, "")));
  return JSON.stringify({ agent: "executor", model: plan.children[0].model, worktree: true, roots: [{ rootSessionId: root.rootSessionId, children }] });

}

/** A deliberately small JSON-lines RPC client. It remains open until settlement. */
export class AcceptanceRpcHost {
  constructor(command, args, { cwd, env, prompt, timeoutMs, startupTimeoutMs = 10_000, firstToolTimeoutMs = 30_000, settlementTimeoutMs = 15 * 60 * 1000, diagnosticsDir, rootLabel = "unknown-root", tempPath } = {}) {
    this.child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.records = [];
    this.errors = [];
    this.buffer = "";
    this.stderr = "";
    this.stdoutTail = [];
    this.exitError = undefined;
    this.fatalError = undefined;
    this.settled = false;
    this.diagnosticsDir = diagnosticsDir;
    this.rootLabel = rootLabel;
    this.tempPath = tempPath ?? diagnosticsDir;
    this.diagnosticWrites = diagnosticsDir
      ? mkdir(diagnosticsDir, { recursive: true }).then(() => Promise.all([
        writeFile(join(diagnosticsDir, "root-records.jsonl"), "", { flag: "a" }),
        writeFile(join(diagnosticsDir, "root-stderr.log"), "", { flag: "a" }),
      ]))
      : Promise.resolve();
    this.firstToolTimeoutMs = firstToolTimeoutMs;
    this.phase = "startup";
    this.failure = new Promise((resolvePromise) => { this.resolveFailure = resolvePromise; });
    this.startupTimeout = setTimeout(() => this.fail(acceptanceError("STARTUP_TIMEOUT", "acceptance RPC host startup timed out")), startupTimeoutMs);
    this.firstToolTimeout = undefined;
    this.settlementTimeoutMs = timeoutMs ?? settlementTimeoutMs;
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.#consume(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-65_536);
    });
    this.child.on("error", (error) => this.fail(error));
    this.closed = new Promise((resolvePromise) => { this.resolveClosed = resolvePromise; });
    this.child.on("close", (code, signal) => {
      clearTimeout(this.startupTimeout); clearTimeout(this.firstToolTimeout); clearTimeout(this.settlementTimeout);
      if (!this.settled) {
        this.exitError = acceptanceError("ROOT_EXIT", `Pi Host exited before acceptance settlement (${code ?? signal ?? "unknown"})`);
        this.fail(this.exitError);
      }
      this.resolveClosed({ code, signal, records: this.records });
    });
    this.prompt = prompt;
  }
  #consume(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim(); this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        this.records.push(record);
        if (record.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(record.method)) {
          const response = record.method === "confirm"
            ? { type: "extension_ui_response", id: record.id, confirmed: false }
            : { type: "extension_ui_response", id: record.id, cancelled: true };
          if (!this.child.stdin.destroyed) this.child.stdin.write(`${JSON.stringify(response)}\n`);
        }
        clearTimeout(this.startupTimeout);
        if (this.phase === "startup") {
          this.phase = "first-tool";
          this.firstToolTimeout = setTimeout(() => this.fail(acceptanceError("FIRST_TOOL_TIMEOUT", "acceptance RPC host first-tool timed out")), this.firstToolTimeoutMs);
        }
        if (record.type === "tool_execution_start" && record.toolName === "subagent_start") {
          this.phase = "settlement";
          clearTimeout(this.firstToolTimeout);
        }
        const isError = record.type === "extension_error" || record.type === "error" || record.isError === true || record.result?.isError === true;
        const event = { type: record.type, toolName: record.toolName ?? record.tool ?? null, isError };
        if (typeof record.method === "string") event.method = record.method;
        if (isError && record.type === "tool_execution_end") {
          const details = record.result?.details;
          const detail = record.error ?? record.result?.error;
          const safeDetail = sanitizeErrorRecord(details?.detail);
          const code = details?.code ?? detail?.code;
          const errorCode = detail?.code;
          const safeMessage = sanitizeErrorRecord({ causeMessage: typeof detail === "string" ? detail : detail?.message ?? record.message }).causeMessage;
          const errorText = safeDetail.causeMessage ?? safeMessage;
          if (typeof code === "string") event.detailsCode = code;
          if (typeof errorCode === "string") event.errorCode = errorCode;
          if (typeof errorText === "string") event.errorText = errorText.slice(0, 500);
          Object.assign(event, safeDetail);
        }
        this.stdoutTail.push(event);
        if (this.stdoutTail.length > 100) this.stdoutTail.shift();
        if (this.diagnosticsDir) this.diagnosticWrites = this.diagnosticWrites.then(() => appendFile(join(this.diagnosticsDir, "root-records.jsonl"), `${JSON.stringify(this.stdoutTail.at(-1))}\n`)).catch(() => {});
        if (isError) {
          this.errors.push(record);
          const detail = record.error ?? record.result?.error ?? record.result;
          const detailMessage = typeof detail === "string" ? detail : detail?.message;
          const message = detailMessage ?? record.message ?? `${record.type}${record.toolName ? ` ${record.toolName}` : ""} reported an error`;
          const code = detail?.code ?? String(message).match(/\bE[A-Z0-9]+\b/)?.[0]
            ?? (record.type === "extension_error" ? "EXTENSION_ERROR" : "TOOL_EXECUTION_ERROR");
          this.fail(acceptanceError(code, `${record.type}${record.toolName ? ` ${record.toolName}` : ""}: ${message}`));
        }
      }
      catch (error) { this.fail(acceptanceError("INVALID_JSON", `invalid Pi RPC JSON: ${error.message}`)); }
    }
  }
  start() { this.child.stdin.write(`${JSON.stringify({ id: `acceptance-${process.pid}`, type: "prompt", message: this.prompt })}\n`); return this; }
  fail(error) {
    if (this.fatalError) return;
    this.fatalError = error instanceof Error ? error : new Error(String(error));
    clearTimeout(this.startupTimeout); clearTimeout(this.firstToolTimeout); clearTimeout(this.settlementTimeout);
    this.failureWork = this.writeDiagnostic()
      .catch((diagnosticError) => { this.fatalError.diagnosticError = diagnosticError; })
      .finally(() => {
        if (this.child.exitCode === null) this.child.kill("SIGTERM");
        this.resolveFailure(this.fatalError);
      });
  }
  async settle({ terminal = () => false, timeoutMs = this.settlementTimeoutMs } = {}) {
    this.settlementTimeout = setTimeout(() => this.fail(acceptanceError("SETTLEMENT_TIMEOUT", "acceptance RPC settlement timed out")), timeoutMs);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.assertHealthyAsync();
      if (terminal(this.records)) { this.settled = true; return this.records; }
      await Promise.race([
        new Promise((resolvePromise) => setTimeout(resolvePromise, 50)),
        this.failure.then((error) => Promise.reject(error)),
      ]);
    }
    this.fail(acceptanceError("SETTLEMENT_TIMEOUT", "acceptance RPC settlement timed out"));
    throw await this.failure;
  }
  assertHealthy() {
    if (this.fatalError) throw this.fatalError;
    if (this.errors.length) throw new Error(`Pi RPC error: ${this.errors.at(-1)?.error?.message ?? this.errors.at(-1)?.message ?? "unknown"}`);
    if (this.exitError) throw this.exitError;
  }
  async assertHealthyAsync() {
    if (this.fatalError) throw await this.failure;
    this.assertHealthy();
  }
  async close() { this.settled = true; clearTimeout(this.startupTimeout); clearTimeout(this.firstToolTimeout); clearTimeout(this.settlementTimeout); if (!this.child.stdin.destroyed) this.child.stdin.end(); await this.failureWork; await this.diagnosticWrites; return this.closed; }
  async writeDiagnostic() {
    if (!this.diagnosticsDir) return;
    await this.diagnosticWrites;
    await mkdir(this.diagnosticsDir, { recursive: true });
    await writeJsonAtomic(join(this.diagnosticsDir, "diagnostic.json"), {
      schemaVersion: "repository-merge-queue-diagnostic.v1",
      rootLabel: this.rootLabel,
      tempPath: this.tempPath,
      phase: this.phase,
      error: { name: this.fatalError?.name, code: this.fatalError?.code, message: safeDiagnosticText(this.fatalError?.message) },
      recentEvents: this.stdoutTail.slice(-100),
      stderrTail: safeStderrTail(this.stderr),
    });
  }
}

function acceptanceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, path);
}

function sanitizeDiagnostic(value) {
  if (Array.isArray(value)) return value.map(sanitizeDiagnostic);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/prompt|session|message|content|credential|authorization|api[_-]?key|arguments?|params?|input/i.test(key)).map(([key, item]) => [key, sanitizeDiagnostic(item)]));
}

// T9 retains only correlation and safe failure classification fields.
export function sanitizeErrorRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return {};
  const allowed = new Set(["taskId", "toolCallId", "stage", "rpcOperation", "causeCode", "causeMessage"]);
  return Object.fromEntries(Object.entries(record)
    .filter(([key]) => allowed.has(key))
    .map(([key, value]) => [key, key === "causeMessage"
      ? String(value).replace(/[\r\n\t]+/g, " ")
        .replace(/(prompt|session|token|credential|authorization|capability|password|secret|api[_-]?key)\s*[:=][^,; ]*/gi, "$1=[redacted]")
        .replace(/(?:^|\s)(?:\/|[A-Za-z]:\\)[^\s,;]*/g, " [path-redacted]").slice(0, 500)
      : value]));
}

/** Deterministic test-only coordinator: production Host owns the typed tool and all child execution. */
export async function dispatchAcceptanceRoots({ plan = createAcceptanceDispatchPlan(), roots = plan.roots, subagentTools, cwd }) {
  if (!Array.isArray(subagentTools) || subagentTools.length !== roots.length) throw new Error(`acceptance requires ${roots.length} root subagent tools`);
  return Promise.all(roots.map(async (root, index) => {
    const tool = subagentTools[index];
    if (!tool || typeof tool.execute !== "function") throw new Error("root subagent tool is unavailable");
    const children = plan.children.filter((child) => root.tasks.includes(child.taskId.replace(/^acceptance-/, "")));
    const results = await Promise.all(children.map((child) => tool.execute(child.taskId, child)));
    return { rootSessionId: root.rootSessionId, tasks: root.tasks, results };
  }));
}

export function createAcceptanceBarrier({ expected = ACCEPTANCE_TASKS, baseCommit }) {
  const names = new Set(expected.map((task) => task.name));
  const readyChildren = new Map();
  let release;
  let reject;
  const releasedPromise = new Promise((resolve, rejectPromise) => { release = resolve; reject = rejectPromise; });
  const barrier = {
    released: false,
    ready(value) {
      if (barrier.released) throw new Error("acceptance barrier is already released");
      if (!value || !names.has(value.task)) throw new Error("unexpected child cannot enter acceptance barrier");
      if (value.baseCommit !== baseCommit) throw new Error("acceptance barrier base commit mismatch");
      if (!value.childId || !value.worktree) throw new Error("acceptance barrier child identity is incomplete");
      if (readyChildren.has(value.task) || [...readyChildren.values()].some((entry) => entry.childId === value.childId)) throw new Error("duplicate child or task in acceptance barrier");
      readyChildren.set(value.task, Object.freeze({ task: value.task, childId: value.childId, worktree: value.worktree, baseCommit: value.baseCommit }));
      if (readyChildren.size === names.size) {
        barrier.released = true;
        release(Object.freeze({ released: true, children: [...readyChildren.values()] }));
      }
    },
    waitForRelease() { return releasedPromise; },
    fail(error) { reject(error instanceof Error ? error : new Error(String(error))); },
  };
  return barrier;
}

export function createAcceptanceReceipt({ allocations = [], options = { roots: 2, subagents: ACCEPTANCE_TASKS.length, requireConflicts: ACCEPTANCE_TASKS.length - 1 }, actualRoots, lifecycle, audit } = {}) {
  const actual = { roots: actualRoots ?? (new Set(allocations.map((entry) => entry.rootSessionId)).size || (allocations.length ? 1 : 0)), subagents: allocations.length, conflicts: Math.max(0, allocations.length - 1) };
  const evidence = collectAcceptanceRecoveryEvidence(audit);
  return Object.freeze({ schemaVersion: "repository-merge-queue-acceptance.v1", requested: { roots: options.roots, subagents: options.subagents, conflicts: options.requireConflicts }, actual, allocations: allocations.map(({ task, childId, worktree, baseCommit }) => ({ task, childId, worktree, baseCommit })),
    lifecycle: Object.freeze({ agent_end: 0, follow_up: 0, next_agent_start: 0, ...evidence.counts, ...(lifecycle ?? {}) }),
    recoveries: evidence.recoveries });
}

/** Recovery 公共证据：仅消费公共 coordinator audit（磁盘真相），不以模型文本计数。
 * resumed_child_start = 已记录 resumedRun 的 intent 数；resume_activation =
 * activated/completed 的 intent 数。*/
export function collectAcceptanceRecoveryEvidence(audit) {
  const intents = Array.isArray(audit?.queue?.resumeIntents) ? audit.queue.resumeIntents : [];
  const recoveries = Object.freeze(intents.map((intent) => Object.freeze({
    resumeIntentId: intent?.resumeIntentId, sourceRunId: intent?.sourceRunId,
    resumedRunId: intent?.resumedRun?.runId ?? null, workspaceId: intent?.workspaceId,
    queueItemId: intent?.queueItemId, attempt: intent?.attempt, generation: intent?.generation, state: intent?.state,
  })));
  const counts = Object.freeze({
    resumed_child_start: intents.filter((intent) => intent?.resumedRun?.runId).length,
    // 只统计被证明完成 recovery.activate-resume 的 intent：failed 状态意味着
    // activation 链路（授权/rebind/supersession）某环节失败，计入会高估。
    resume_activation: intents.filter((intent) => intent?.state === "activated" || intent?.state === "completed").length,
  });
  return Object.freeze({ recoveries, counts });
}

export function buildAcceptanceEnvironment(parent = process.env, stateRoot, configRoot) {
  if (!configRoot) throw new Error("acceptance config root is required");
  const environment = {
    ...parent,
    GIT_CONFIG_GLOBAL: join(stateRoot, "empty-global.gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_RERERE_ENABLED: "0",
    PI_CODING_WORKSPACE_DIR: join(stateRoot, "workspaces"),
    PI_CODING_AGENT_SESSION_DIR: join(stateRoot, "sessions"),
    PI_CODING_AGENT_DIR: configRoot,
  };
  for (const marker of Object.keys(environment)) {
    if (marker.startsWith("PI_SUBAGENT_")) delete environment[marker];
  }
  delete environment.PI_ROOT_SUBAGENT_BROKER_ENABLED;
  return environment;
}

export function createAcceptanceRootRpcArgs({ provider, runtime }) {
  return [
    "--mode", "rpc", "--no-session", "--no-extensions", "--approve",
    "-e", provider, "-e", runtime,
    "--provider", "fake", "--model", "fake/deterministic",
  ];
}

export async function writeAcceptanceRelease(barrierDir, children, { expected = ACCEPTANCE_TASKS } = {}) {
  if (children.length !== expected.length || new Set(children.map((child) => child.baseCommit)).size !== 1 || new Set(children.map((child) => child.childId)).size !== children.length) {
    throw new Error(`acceptance barrier requires ${expected.length} distinct children on one base`);
  }
  const temporary = join(barrierDir, `release.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify({ schemaVersion: "repository-merge-queue-release.v1", children })}\n`, { flag: "wx" });
  await rename(temporary, join(barrierDir, "release.json"));
}

function acceptanceTaskName(taskId) {
  const matches = ACCEPTANCE_TASKS.filter((task) => taskId === `acceptance-${task.name}`);
  if (matches.length !== 1) throw new Error(`dispatch receipt has an invalid acceptance taskId: ${taskId}`);
  return matches[0].name;
}

const DERIVED_DISPATCH_TASK_ID = /^dispatch-[0-9a-f]{8}$/;

function isDerivedDispatchTaskId(value) {
  return typeof value === "string" && DERIVED_DISPATCH_TASK_ID.test(value);
}

function isAcceptanceTaskId(value) {
  return typeof value === "string" && ACCEPTANCE_TASKS.some((task) => value === `acceptance-${task.name}`);
}

/**
 * 任务身份只认 probe 自己控制的 `toolCallId`：production 的 `details.taskId` 是由
 * contractHash 派生的 dispatch 身份（`dispatch-<8hex>`，`contracts/dispatch-ir.ts`），
 * 不是调用方任务名。旧回执形态（taskId 直接是 `acceptance-<task>`）仍可识别，
 * 但派生形态丢了 toolCallId 时无法归属任务，必须 fail closed，不猜。
 */
function acceptanceTaskIdentity(record, details) {
  const toolCallId = record?.toolCallId;
  if (isAcceptanceTaskId(toolCallId)) return acceptanceTaskName(toolCallId);
  if (isDerivedDispatchTaskId(details?.taskId)) {
    throw new Error(`host dispatch record lost its acceptance toolCallId (derived taskId: ${details.taskId})`);
  }
  return acceptanceTaskName(details?.taskId);
}

export function collectPublicDispatchBindings(hosts, audit) {
  const bindings = new Map();
  const merge = (binding, source) => {
    const previous = bindings.get(binding.task);
    if (previous && (previous.runId !== binding.runId || previous.workspaceId !== binding.workspaceId || previous.leaseId !== binding.leaseId)) {
      throw new Error(`${source} dispatch binding mismatch for ${binding.task}`);
    }
    bindings.set(binding.task, binding);
  };
  for (const host of hosts) {
    for (const record of host.records) {
      if (record.type !== "tool_execution_end" || record.toolName !== "subagent_start" || record.result?.isError === true) continue;
      const details = record.result?.details;
      if (!details?.taskId) continue;
      if (!isDerivedDispatchTaskId(details.taskId) && !isAcceptanceTaskId(details.taskId)) {
        throw new Error(`host dispatch receipt has an unrecognized taskId shape: ${details.taskId}`);
      }
      if (typeof details.runId !== "string" || !details.runId) throw new Error("host dispatch binding is missing public runId");
      if (typeof details.workspace_id !== "string" || !details.workspace_id || typeof details.lease_id !== "string" || !details.lease_id) {
        throw new Error("host dispatch binding is missing public workspace_id or lease_id");
      }
      merge({ task: acceptanceTaskIdentity(record, details), runId: details.runId, workspaceId: details.workspace_id, leaseId: details.lease_id }, "duplicate");
    }
  }
  for (const entry of audit?.inventory?.workspaces ?? []) {
    const taskId = entry?.receipt?.owner?.toolCallId;
    if (!taskId) continue;
    const task = acceptanceTaskName(taskId);
    const workspaceId = entry.receipt.workspaceId;
    const leaseId = entry.receipt.leaseId;
    if (typeof workspaceId !== "string" || !workspaceId || typeof leaseId !== "string" || !leaseId) {
      throw new Error("audit dispatch binding is missing workspaceId or leaseId");
    }
    if (entry.receipt.run === null) {
      const previous = bindings.get(task);
      if (previous && (previous.workspaceId !== workspaceId || previous.leaseId !== leaseId)) {
        throw new Error(`public dispatch binding mismatch for ${task}`);
      }
      bindings.delete(task);
      continue;
    }
    const runId = entry.receipt.run?.runId;
    if (typeof runId !== "string" || !runId) throw new Error("audit dispatch binding is missing runId");
    merge({ task, runId, workspaceId, leaseId }, "public");
  }
  return bindings;
}

function acceptanceInterruption(hosts, signal) {
  return new Promise((_, reject) => {
    for (const host of hosts) host.failure?.then(reject);
    if (!signal) return;
    const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "acceptance probe aborted")));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

async function assertAcceptanceHostsHealthy(hosts) {
  for (const host of hosts) {
    if (host.records?.some((record) => /integration/i.test(record.toolName ?? record.tool) && !/auto/i.test(record.toolName ?? record.tool))) {
      throw new Error("manual integration mutation tool trace is a race error");
    }
    if (typeof host.assertHealthyAsync === "function") await host.assertHealthyAsync();
    else host.assertHealthy();
  }
}

export async function collectAcceptanceReady(barrierDir, { hosts = [], readAudit = async () => undefined, timeoutMs = 2 * 60 * 1000, expected = ACCEPTANCE_TASKS, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  const interrupted = acceptanceInterruption(hosts, signal);
  let missingBindings = expected.map((task) => task.name);
  while (Date.now() < deadline) {
    await assertAcceptanceHostsHealthy(hosts);
    const audit = await Promise.race([Promise.resolve().then(readAudit), interrupted]);
    const bindings = collectPublicDispatchBindings(hosts, audit);
    missingBindings = expected.filter((task) => !bindings.has(task.name)).map((task) => task.name);
    if (bindings.size === expected.length) {
      const children = [];
      for (const task of expected) {
        const binding = bindings.get(task.name);
        if (!binding) break;
        try {
          const ready = JSON.parse(await readFile(join(barrierDir, `${binding.runId}.ready.json`), "utf8"));
          validateAcceptanceReadyReceipt(ready, { runId: binding.runId });
          children.push({ ...ready, task: task.name, childId: ready.runId, workspaceId: binding.workspaceId });
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          break;
        }
      }
      if (children.length === expected.length) {
        if (new Set(children.map((child) => child.runId)).size !== children.length || new Set(children.map((child) => child.worktree)).size !== children.length) throw new Error("acceptance barrier child identity or worktree is duplicated");
        if (new Set(children.map((child) => child.baseCommit)).size !== 1) throw new Error("acceptance barrier base commit mismatch");
        await assertAcceptanceHostsHealthy(hosts);
        return children;
      }
    }
    await Promise.race([new Promise((resolvePromise) => setTimeout(resolvePromise, 100)), interrupted]);
  }
  if (missingBindings.length) throw new Error(`acceptance barrier timed out; dispatch binding missing for ${missingBindings.join(", ")}; evidence retained`);
  throw new Error("acceptance barrier timed out; evidence retained");
}

export function isAcceptanceAuditSettled(audit, expectedCount = ACCEPTANCE_TASKS.length) {
  // daemon 正常 idle-exit 后 metadata 保留为 stale：曾治理过即满足 durable 审计前提，
  // settlement 的证据主体是 queue/workspace/proof 的磁盘真相而非活 daemon（R12g）。
  // idle-exit 必然伴随 coordinator-singleton dead debt：只接受这一种伴生 debt，其余仍然拒绝（R12h）。
  if (audit?.schemaVersion !== "managed-workspace-administration.v1" || !["observed", "stale"].includes(audit.coordinator?.status) || audit.debts?.length === undefined) return false;
  const toleratedDebts = audit.coordinator?.status === "stale" && audit.debts.length === 1
    && audit.debts[0]?.kind === "coordinator-singleton" && audit.debts[0]?.status === "dead";
  if (audit.debts.length !== 0 && !toleratedDebts) return false;
  if ((audit.inventory?.orphanRegistrations?.length ?? 0) !== 0 || (audit.inventory?.legacy?.length ?? 0) !== 0) return false;
  const queue = audit.queue?.items;
  const workspaces = audit.inventory?.workspaces;
  if (!Array.isArray(queue) || !Array.isArray(workspaces) || queue.length !== expectedCount || workspaces.length !== expectedCount) return false;
  // Durable resume 恢复证据：每个 queue item 的最新 resume intent 必须收敛为
  // completed；preserved/failed 或仍在等待/激活中的最新 intent 判定 settlement
  // 失败并保留现场（15min 超时只是兑底报告，不是通过条件）。
  const resumeIntents = Array.isArray(audit.queue?.resumeIntents) ? audit.queue.resumeIntents : [];
  const latestResumeByItem = new Map();
  for (const intent of resumeIntents) {
    if (typeof intent?.queueItemId !== "string" || !Number.isInteger(intent.attempt)) continue;
    const current = latestResumeByItem.get(intent.queueItemId);
    if (!current || intent.attempt > current.attempt) latestResumeByItem.set(intent.queueItemId, intent);
  }
  const recoveriesCompleted = [...latestResumeByItem.values()].every((intent) => intent?.state === "completed");
  const sequences = queue.map((item) => item.sequence);
  if (!sequences.every(Number.isInteger) || new Set(sequences).size !== expectedCount || sequences.some((value, index) => index > 0 && value <= sequences[index - 1])) return false;
  const completed = queue.every((item, index) => item?.version === "workspace-integration-queue-item.v1" && item.state === "completed"
    && item.candidateHead && item.integrationIntentId && item.workspaceDispositionReceiptId && item.completedAt
    && item.admittedTargetHead && (index === 0 || item.admittedTargetHead === queue[index - 1].candidateHead));
  const proof = workspaces.every((entry) => entry?.receipt?.terminalProof?.state === "observed" && entry.receipt.terminalProof.conflict === false);
  const released = workspaces.every((entry) => entry?.receipt?.state === "released" && entry.identity === null && (entry.issues?.length ?? 0) === 0);
  const queuedWorkspaceIds = new Set(queue.map((item) => item.workspaceId));
  return completed && proof && released && recoveriesCompleted && queuedWorkspaceIds.size === expectedCount && workspaces.every((entry) => queuedWorkspaceIds.has(entry.receipt.workspaceId));
}

export async function waitForAcceptanceAudit({ hosts, readAudit, expectedCount = ACCEPTANCE_TASKS.length, timeoutMs = 15 * 60 * 1000, intervalMs = 250, signal }) {
  const deadline = Date.now() + timeoutMs;
  const interrupted = acceptanceInterruption(hosts, signal);
  let lastAudit;
  while (Date.now() < deadline) {
    await assertAcceptanceHostsHealthy(hosts);
    lastAudit = await Promise.race([Promise.resolve().then(readAudit), interrupted]);
    if (isAcceptanceAuditSettled(lastAudit, expectedCount)) {
      await assertAcceptanceHostsHealthy(hosts);
      return lastAudit;
    }
    await Promise.race([new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs)), interrupted]);
  }
  const error = new Error("public worktree lifecycle audit settlement timed out");
  error.lastAudit = lastAudit;
  throw error;
}

export async function settleAcceptanceHosts(options) {
  const audit = await waitForAcceptanceAudit(options);
  await Promise.all(options.hosts.map((host) => host.close()));
  return audit;
}

async function readPublicAudit(repository, environment) {
  const { stdout } = await execFileAsync(process.execPath, [resolve("scripts/worktree-lifecycle.ts"), "audit", "--json"], {
    cwd: repository, env: environment, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function safeStderrTail(value) {
  return String(value ?? "").split("\n").filter((line) => !/prompt|session|message|content|api[_-]?key|authorization/i.test(line)).slice(-100).join("\n").slice(-16_384);
}

function safeDiagnosticText(value) {
  const text = String(value ?? "unknown");
  return /prompt|session|credential|authorization|api[_-]?key/i.test(text) ? "redacted diagnostic message" : text.slice(-4_096);
}

function configuredTimeout(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive timeout in milliseconds`);
  return value;
}

export async function runAcceptance(options = parseAcceptanceOptions()) {
  const piBinary = process.env.PI_REAL_BIN;
  if (!piBinary) throw new Error("PI_REAL_BIN must identify a real supported Pi binary (see scripts/probes/pi-subagents-compat.ts SUPPORTED_PI_VERSIONS); acceptance probe never substitutes a fake model");

  const root = await mkdtemp(join(tmpdir(), "repository-merge-queue-acceptance-"));
  const repository = join(root, "repository");
  await cp(resolve("test/fixtures/repository-merge-queue-acceptance"), repository, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=acceptance@example.test", "-c", "user.name=Acceptance", "commit", "-m", "acceptance base"], { cwd: repository, stdio: "ignore" });
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
  const stateRoot = join(root, "state");
  const barrierDir = join(root, "barrier");
  await mkdir(join(stateRoot, "workspaces"), { recursive: true });
  await mkdir(barrierDir, { recursive: true });
  await writeFile(join(stateRoot, "empty-global.gitconfig"), "", { flag: "wx" });
  const receiptPath = process.env.ACCEPTANCE_RECEIPT ?? join(root, "acceptance-receipt.json");
  const environment = buildAcceptanceEnvironment(process.env, stateRoot, resolve("pi"));
  const plan = createAcceptanceDispatchPlan(options);
  const roots = plan.roots.map(({ rootSessionId, tasks }) => ({ rootSessionId, allocation: tasks.length, tasks }));
  const provider = resolve("test/fixtures/repository-merge-queue-acceptance/root-provider.mjs");
  const runtime = resolve("packages/pi-subagents-enhanced/extensions/subagent-runtime.ts");
  const hosts = [];
  const firstToolTimeoutMs = configuredTimeout("ACCEPTANCE_FIRST_TOOL_TIMEOUT_MS", 30_000);
  const barrierTimeoutMs = configuredTimeout("ACCEPTANCE_BARRIER_TIMEOUT_MS", 2 * 60 * 1000);
  const overallTimeoutMs = configuredTimeout("ACCEPTANCE_OVERALL_TIMEOUT_MS", 15 * 60 * 1000);
  const overall = new AbortController();
  const overallStartedAt = Date.now();
  const overallTimer = setTimeout(() => overall.abort(acceptanceError("OVERALL_TIMEOUT", "acceptance probe overall timed out")), overallTimeoutMs);
  let publicAudit;
  try {
    hosts.push(...roots.map((rootSpec) => new AcceptanceRpcHost(piBinary, createAcceptanceRootRpcArgs({ provider, runtime }), {
      cwd: repository,
      env: { ...environment, PI_ACCEPTANCE_BARRIER_DIR: barrierDir, PI_ACCEPTANCE_ROOT_SESSION: rootSpec.rootSessionId, PI_ACCEPTANCE_TASKS: rootSpec.tasks.join(","), PI_ACCEPTANCE_MODEL: plan.children[0].model, PI_ACCEPTANCE_BASE_COMMIT: baseCommit, PI_ACCEPTANCE_REPOSITORY: repository },
      prompt: createAcceptancePrompt(plan, rootSpec),
      startupTimeoutMs: 5_000,
      firstToolTimeoutMs,
      diagnosticsDir: join(root, "diagnostics", rootSpec.rootSessionId),
      rootLabel: rootSpec.rootSessionId,
      tempPath: root,
      settlementTimeoutMs: overallTimeoutMs,
    }).start()));
    const audit = () => readPublicAudit(repository, environment);
    const expectedTasks = ACCEPTANCE_TASKS.slice(0, options.subagents);
    const remainingOverallMs = () => Math.max(1, overallTimeoutMs - (Date.now() - (overallStartedAt)));
    const children = await collectAcceptanceReady(barrierDir, { hosts, expected: expectedTasks, readAudit: audit, timeoutMs: Math.min(barrierTimeoutMs, remainingOverallMs()), signal: overall.signal });
    await writeAcceptanceRelease(barrierDir, children, { expected: expectedTasks });
    publicAudit = await settleAcceptanceHosts({ hosts, expectedCount: children.length, readAudit: audit, timeoutMs: remainingOverallMs(), signal: overall.signal });
    const lifecycle = Object.freeze(hosts.reduce((total, host) => {
      const counts = collectAcceptanceLifecycleCounts(host.records);
      return { agent_end: total.agent_end + counts.agent_end, follow_up: total.follow_up + counts.follow_up, next_agent_start: total.next_agent_start + counts.next_agent_start };
    }, { agent_end: 0, follow_up: 0, next_agent_start: 0 }));
    const receipt = createAcceptanceReceipt({ allocations: children, options, actualRoots: roots.length, lifecycle, audit: publicAudit });
    const status = receipt.actual.roots === options.roots && receipt.actual.subagents === options.subagents && receipt.actual.conflicts >= options.requireConflicts ? "accepted" : "rejected";
    await writeFile(receiptPath, `${JSON.stringify({ ...receipt, roots, dispatch: plan.children, publicAudit, status }, null, 2)}\n`);
    return receiptPath;
  } catch (error) {
    publicAudit = error?.lastAudit ?? publicAudit;
    const diagnosticPath = join(root, "acceptance-diagnostic.json");
    await writeJsonAtomic(diagnosticPath, {
      schemaVersion: "repository-merge-queue-diagnostic.v1", root, repository, barrierDir,
      error: { name: error?.name ?? "Error", code: error?.code, message: safeDiagnosticText(error?.message ?? error) },
      firstDeviation: { phase: hosts.some((host) => host.phase === "settlement") ? "public-audit-settlement" : "barrier" },
      publicAudit: sanitizeDiagnostic(publicAudit),
      hosts: hosts.map((host) => ({ stdoutTail: host.stdoutTail, stderrTail: safeStderrTail(host.stderr), exitError: host.exitError?.message })),
    });
    for (const host of hosts) if (host.child.exitCode === null) host.child.kill("SIGTERM");
    throw new Error(`${error?.message ?? error}; diagnostic=${diagnosticPath}`);
  } finally {
    clearTimeout(overallTimer);
  }
}

if (import.meta.main) runAcceptance(parseAcceptanceOptions(process.argv.slice(2))).then((path) => console.log(path)).catch((error) => { console.error(error.message); process.exitCode = 1; });
