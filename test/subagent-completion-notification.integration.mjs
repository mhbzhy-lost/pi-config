import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";

import { buildTopLevelRuntimeEnv, SUPPORTED_PI_VERSIONS } from "../scripts/probes/pi-subagents-compat.ts";
import { installHeadlessTypedSubagentRuntime } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts";

// 通知到达性守卫（docs/bugs/2026-09-29-async-completion-notification-silent-swallow.md）。
//
// 2026-09-29 缺陷：生产 async subagent 完成后，主 agent 会话日志零条
// subagent-notify custom_message。根因是旧接线向 installHeadlessTypedSubagentRuntime
// 传入 completionNotifierFactory，extension.ts 据此置
// suppressCompletionNotifications=true，runtime-membrane.ts 对 customType===
// "subagent-notify" 的 sendMessage 静默丢弃（不抛错），上游原生 notify
// (notify.js sendCompletion) 以"不抛错"为成功判据继续收尾——通知被吞且无任何失败信号。
//
// P1 修复（var/upgrade/p1-notifier-removal.md）删除了 compat notifier 接线，
// 生产不再传 factory，suppression=false，上游原生投递直达主会话。
// 本文件为该行为建立永久集成回归守卫：
//   1) 主用例：fresh Host（真实 pi 二进制 + fake/deterministic provider）经 typed
//      subagent 派发一个 async run，断言完成后主会话 session jsonl 出现
//      subagent-notify custom_message，且内容与派发 runId 关联。
//   2) 对照用例：以最小 harness 复现旧接线（completionNotifierFactory 注入），
//      证明同一断言在旧接线下失败（suppression 重新激活即缺陷复发）。

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const piBinary = process.env.PI_REAL_BIN;
const projectRuntime = join(repoRoot, "packages", "pi-subagents-enhanced", "extensions", "subagent-runtime.ts");

const PARENT_PROMPT = "NOTIFY_ARRIVAL_PARENT";
const CHILD_OBJECTIVE_MARKER = "NOTIFY_ARRIVAL_CHILD";
const CHILD_DONE_MARKER = "NOTIFY_CHILD_DONE";

function withoutSubagentEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("PI_SUBAGENT_") && !name.startsWith("PI_SESSION_") && ![
    "PI_ROOT_SUBAGENT_BROKER_ENABLED", "PI_MODEL", "PI_PROVIDER", "PI_CODING_AGENT_SESSION_DIR", "PI_CODING_WORKSPACE_DIR", "PI_CODING_GOAL_DIR",
  ].includes(name)));
}

function childAcceptanceReport() {
  return `${CHILD_DONE_MARKER}

\`\`\`acceptance-report
${JSON.stringify({
  criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: `Returned ${CHILD_DONE_MARKER}.` }],
  changedFiles: [],
  testsAddedOrUpdated: [],
  commandsRun: [{ command: "deterministic child marker", result: "passed", summary: `Returned ${CHILD_DONE_MARKER}.` }],
  validationOutput: [CHILD_DONE_MARKER],
  residualRisks: [],
  noStagedFiles: true,
  diffSummary: "No files changed by the notification arrival fixture.",
})}
\`\`\``;
}

function notifyProviderSource(contract) {
  return `
    import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
    const contract = ${JSON.stringify(contract)};
    const childReport = ${JSON.stringify(childAcceptanceReport())};
    const childDoneMarker = ${JSON.stringify(CHILD_DONE_MARKER)};
    // 目标版本（pi-subagents@0.79.2）已发布文案，固定在本 fixture 内作为既有目标合同：
    //  - 完成通知头：src/runs/background/notify.js formatSingleCompletion；
    //  - 父唤醒文案：src/shared/parent-wake.js PARENT_WAKE_TEXT —— createParentWake 在父空闲时
    //    先 sendMessage(通知, { triggerTurn: false })，再 sendUserMessage(PARENT_WAKE_TEXT, { deliverAs: "steer" })。
    // 仅作为测试侧识别合同，不引入任何上游 deep import，也不向 production 扩散。
    const NOTICE_HEADER = "Background task completed: ";
    const PARENT_WAKE_PREFIX = "Inspect subagent updates above.";
    function text(message) {
      return typeof message?.content === "string" ? message.content
        : message?.content?.filter((part) => part?.type === "text").map((part) => part.text).join("\\n") ?? "";
    }
    export default function (pi) {
      let ordinal = 0;
      pi.registerProvider("fake", {
        baseUrl: "http://127.0.0.1:9", api: "fake", apiKey: "not-used",
        models: [{
          id: "deterministic", name: "Deterministic", input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 4096, maxTokens: 256,
        }],
        streamSimple(model, context) {
          const stream = createAssistantMessageEventStream();
          const messages = context?.messages ?? [];
          const users = messages.filter((message) => message?.role === "user").map(text);
          const toolResults = messages.filter((message) => message?.role === "toolResult");
          const lastUser = users.at(-1) ?? "";
          const dispatched = toolResults.find((message) => message.toolName === "subagent_start" && /Started /.test(text(message)));
          // 派发回执文案为 'Started <agent>: <title> (<runId>).'，从本次回执取回 runId。
          const dispatchedRunId = dispatched ? /Started [^:]+: [^(]*\\(([^()]+)\\)/.exec(text(dispatched))?.[1] : undefined;
          // 本次 run 的完成通知是否已进入父会话上下文：通知体同时携带该 run 的 retention 目录
          // （async-subagent-runs/<runId>）与该子代理的完成产物预览，二者同时命中才算同一次完成。
          const runNoticeIndex = dispatchedRunId
            ? users.findIndex((message) => message.startsWith(NOTICE_HEADER)
              && message.includes("async-subagent-runs/" + dispatchedRunId)
              && message.includes(childDoneMarker))
            : -1;
          let tool;
          let output;
          if (lastUser.includes(${JSON.stringify(CHILD_OBJECTIVE_MARKER)})) {
            // 子代理回合：typed dispatch prompt 内嵌 objective 标记，直接返回确定性完成产物。
            output = childReport;
          } else if (dispatched) {
            // 派发后的父会话回合有两种，必须区分：
            //  1) 初次 dispatch 回合：工具结果入上下文后模型续跑，lastUser 仍是父 prompt，尚未发生唤醒。
            //  2) 真实后续父回合：上游 notify 先以 triggerTurn=false 追加通知（convertToLlm 转成 user
            //     消息），随后 createParentWake 以 PARENT_WAKE_TEXT 起新回合；父不空闲时则由通知本身
            //     （triggerTurn=true）起回合。两种入口都必须已有本次 run 的通知，否则不算父被唤醒。
            const parentWoken = (lastUser.startsWith(PARENT_WAKE_PREFIX) && runNoticeIndex !== -1 && runNoticeIndex < users.length - 1)
              || (lastUser.startsWith(NOTICE_HEADER) && runNoticeIndex === users.length - 1);
            if (parentWoken) output = "NOTIFY_PARENT_NOTIFIED";
            else if (lastUser.startsWith(PARENT_WAKE_PREFIX) || lastUser.startsWith(NOTICE_HEADER)) output = "NOTIFY_PARENT_WAKE_UNLINKED";
            else output = "NOTIFY_PARENT_DISPATCHED";
          } else if (lastUser.includes(${JSON.stringify(PARENT_PROMPT)})) {
            tool = { name: "subagent_start", arguments: contract };
          } else {
            output = "NOTIFY_PROVIDER_FALLBACK";
          }
          const toolCall = tool ? { type: "toolCall", id: "notify-arrival-" + (++ordinal), name: tool.name, arguments: tool.arguments } : undefined;
          const content = toolCall ? [toolCall] : [{ type: "text", text: output }];
          const message = {
            role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: toolCall ? "toolUse" : "stop", timestamp: Date.now(),
          };
          stream.push({ type: "start", partial: message });
          if (toolCall) {
            stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
            stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(tool.arguments), partial: message });
            stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
            stream.push({ type: "done", reason: "toolUse", message });
          } else {
            stream.push({ type: "text_start", contentIndex: 0, partial: message });
            stream.push({ type: "text_delta", contentIndex: 0, delta: output, partial: message });
            stream.push({ type: "text_end", contentIndex: 0, content: output, partial: message });
            stream.push({ type: "done", reason: "stop", message });
          }
          stream.end();
          return stream;
        },
      });
    }
  `;
}

function parentProbeSource() {
  return `
    export default function (pi) {
      pi.on("session_start", () => {
        pi.setActiveTools([...new Set([...pi.getActiveTools(), "subagent_start"])]);
      });
    }
  `;
}

function assistantText(record) {
  if (record.type !== "message_end" || record.message?.role !== "assistant") return "";
  return record.message.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
}

// RPC host 驱动：stdin 保持打开（等待后台通知投递期间 Host 必须存活），由调用方决定何时 endInput。
function spawnRpcHost(command, args, { cwd, env, input, timeoutMs = 300_000 }) {
  const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const records = [];
  let stdout = "";
  let stderr = "";
  let buffer = "";
  let timedOut = false;
  let spawnError;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(()=>child.kill("SIGKILL"),3000).unref();
  }, timeoutMs);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // 诊断输出行不可解析时跳过，不影响记录流。
      }
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  // stdin 只用于 EOF teardown：spawn 失败或子进程已退出后 end() 可能报流错误，
  // 不得变成未捕获异常而掩盖真正的断言失败。
  child.stdin.on("error", () => {});
  child.once("error", (error) => { spawnError = error; });
  const closed = new Promise((resolveClosed) => {
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolveClosed({
        error: timedOut ? new Error(`Pi RPC host timed out after ${timeoutMs}ms`) : spawnError,
        status,
        signal,
      });
    });
  });
  child.stdin.write(`${input}\n`);
  return {
    records,
    endInput() { child.stdin.end(); },
    kill() { child.kill("SIGTERM");
    setTimeout(()=>child.kill("SIGKILL"),3000).unref(); },
    closed,
    diagnostics() {
      const recordTail = records.slice(-12).map((record) => JSON.stringify(record).slice(0, 400)).join("\n");
      return `stderr tail:\n${stderr.slice(-4000)}\nstdout tail:\n${stdout.slice(-2000)}\nrecords tail:\n${recordTail}`;
    },
  };
}

async function waitForStatus(asyncDir, predicate, { timeoutMs = 90_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus;
  while (Date.now() < deadline) {
    try {
      lastStatus = JSON.parse(await readFile(join(asyncDir, "status.json"), "utf8"));
      if (predicate(lastStatus)) return lastStatus;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await delay(50);
  }
  throw new Error(`timed out waiting for status in ${asyncDir}; last=${JSON.stringify(lastStatus)}`);
}

// 在主会话（含 PARENT_PROMPT 的顶层 jsonl）中查找与 runId 关联的 subagent-notify custom_message。
async function findSessionNotify(sessionsRoot, runId) {
  let names;
  try {
    names = (await readdir(sessionsRoot)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return undefined;
  }
  for (const name of names) {
    const file = join(sessionsRoot, name);
    let content;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    if (!content.includes(PARENT_PROMPT)) continue;
    for (const line of content.split("\n")) {
      if (!line.includes("subagent-notify")) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record.type === "custom_message"
        && record.customType === "subagent-notify"
        && typeof record.content === "string"
        && record.content.includes(`async-subagent-runs/${runId}`)
        && record.content.includes(CHILD_DONE_MARKER)) {
        return { file, record };
      }
    }
  }
  return undefined;
}

async function waitForSessionNotify(sessionsRoot, runId, { timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await findSessionNotify(sessionsRoot, runId);
    if (last) return last;
    await delay(100);
  }
  throw new Error(`timed out waiting for the subagent-notify custom_message (runId=${runId}) in ${sessionsRoot}`);
}

test("async typed dispatch delivers the upstream subagent-notify custom message into the main session log", { skip: !piBinary }, async (t) => {
  assert.ok(piBinary, "PI_REAL_BIN must identify an explicitly supported Pi host used for this integration test");
  const piVersion = (await execFileAsync(piBinary, ["--version"], { encoding: "utf8" })).stdout.trim();
  assert.ok(SUPPORTED_PI_VERSIONS.includes(piVersion), `unsupported Pi host: ${piVersion}`);

  const root = await mkdtemp(join(tmpdir(), "subagent-notify-arrival-"));
  const runtimeTmp = await mkdtemp(join(tmpdir(), "subagent-notify-runtime-"));
  const projectRoot = join(root, "project");
  const configRoot = join(root, "config");
  const sessionsRoot = join(root, "sessions");
  const workspacesRoot = join(root, "workspaces");
  const provider = join(root, "notify-provider.mjs");
  const parentProbe = join(root, "notify-parent-probe.mjs");

  // 本用例创建的 Host 由本用例负责释放：无论断言成功还是失败，都对本 Host 执行既有 EOF
  // （endInput）并等待既有 closed，避免失败路径一直挂到 300s 总 timer；Host 完全关闭后才删
  // session/根目录，避免自己删 session 时 Host 仍在写。不新增 kill 路径、不改 deadline。
  let host;
  t.after(async () => {
    if (host) {
      host.endInput();
      await host.closed;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(runtimeTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const contract = {
    title: "Notify arrival deterministic child",
    agent: "executor",
    task: `Return exactly the ${CHILD_DONE_MARKER} marker for the ${CHILD_OBJECTIVE_MARKER} fixture.`,
    writePaths: ["README.md"],
    acceptance: { criteria: ["The child returns the deterministic marker."] },
    cwd: projectRoot,
    worktree: false,
  };

  await mkdir(join(projectRoot, ".pi", "agents"), { recursive: true });
  await writeFile(join(projectRoot, "README.md"), "notification arrival guard fixture\n");
  await writeFile(join(projectRoot, ".pi", "agents", "executor.md"), `---
name: executor
description: deterministic notification arrival executor
model: fake/deterministic
tools: read
extensions: ${provider}
---
Return the deterministic child marker without modifying files.
`);
  await execFileAsync("git", ["init", "-q"], { cwd: projectRoot });
  await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: projectRoot });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: projectRoot });
  await execFileAsync("git", ["add", "README.md", ".pi/agents/executor.md"], { cwd: projectRoot });
  await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: projectRoot });
  // 生产接线要求 PI_CODING_AGENT_DIR/agents 存在 delegate/executor/reviewer 三个内置
  // profile（registerBuiltinAgentsViaEvents 在扩展加载期读取）。
  await mkdir(join(configRoot, "agents"), { recursive: true });
  for (const name of ["delegate", "executor", "reviewer"]) {
    await writeFile(join(configRoot,"agents",`${name}.md`),`---
name: ${name}
description: fixture
model: fake/deterministic
tools: read,bash,contact_supervisor
extensions: ${provider}
---
执行隔离fixture。
`);
  }
  // 与 contact-supervisor/runtime lane 对齐：configRoot 缺 agents-shared 扩展会让 typed
  // extension 的 session_start 链在 required-child 校验处失败（fixture 环境缺件），
  // 因此以 symlink 指向仓内同一权威来源提供该扩展，不复制内容、不新建实现。
  await mkdir(join(configRoot, "extensions"), { recursive: true });
  await symlink(join(repoRoot, "pi", "extensions", "agents-shared.ts"), join(configRoot, "extensions", "agents-shared.ts"));
  await writeFile(provider, notifyProviderSource(contract));
  await writeFile(parentProbe, parentProbeSource());

  host = spawnRpcHost(piBinary, [
    "--mode", "rpc", "--no-extensions",
    "-e", provider,
    "-e", projectRuntime,
    "-e", parentProbe,
    "--no-skills", "--no-prompt-templates", "--no-themes",
    "--provider", "fake", "--model", "fake/deterministic",
  ], {
    cwd: projectRoot,
    env: {
      ...buildTopLevelRuntimeEnv(withoutSubagentEnvironment(process.env)),
      TMPDIR: runtimeTmp,
      PI_CODING_AGENT_DIR: configRoot,
      PI_CODING_AGENT_SESSION_DIR: sessionsRoot,
      PI_CODING_WORKSPACE_DIR: workspacesRoot,
      OPENAI_API_KEY: "not-used",
    },
    input: JSON.stringify({ id: "notify-arrival-001", type: "prompt", message: PARENT_PROMPT }),
  });

  let handle;
  const dispatchDeadline = Date.now() + 60_000;
  while (!handle && Date.now() < dispatchDeadline) {
    const dispatch = host.records.find((record) => record.type === "tool_execution_end" && record.toolName === "subagent_start");
    if (dispatch?.result?.details?.runId) handle = dispatch.result.details;
    else await delay(50);
  }
  assert.ok(handle?.runId, `typed subagent dispatch receipt is missing\n${host.diagnostics()}`);
  assert.equal(typeof handle.asyncDir, "string", JSON.stringify(handle));

  // 后台 run 终态：typed workflow root 完成（fake provider 子代理立即返回确定性产物）。
  const terminal = await waitForStatus(handle.asyncDir, (status) => status.state !== "running" && status.state !== "queued")
    .catch((error) => { throw new Error(`${error.message}\n${host.diagnostics()}`); });
  assert.equal(terminal.state, "complete", JSON.stringify(terminal));

  // 核心断言：主会话 session jsonl 出现 subagent-notify custom_message，且与派发 runId 关联。
  const notify = await waitForSessionNotify(sessionsRoot, handle.runId)
    .catch((error) => { throw new Error(`${error.message}\n${host.diagnostics()}`); });
  assert.equal(notify.record.customType, "subagent-notify");
  // runId 关联：通知体携带该 run 的 retention 目录（async-subagent-runs/<runId>）。
  assert.ok(notify.record.content.includes(`async-subagent-runs/${handle.runId}`), notify.record.content);
  assert.ok(notify.file.startsWith(sessionsRoot), notify.file);

  // 通知必须来自本次子代理完成：内容携带该子代理的确定性完成产物预览。
  assert.ok(notify.record.content.includes(CHILD_DONE_MARKER), notify.record.content);

  // 通知到达应唤醒主 agent（缺陷现场：主 agent 未被任何完成事件唤醒）。
  const wakeDeadline = Date.now() + 60_000;
  let notified = false;
  while (!notified && Date.now() < wakeDeadline) {
    notified = host.records.some((record) => assistantText(record).includes("NOTIFY_PARENT_NOTIFIED"));
    if (!notified) await delay(50);
  }
  assert.ok(notified, `the subagent-notify message did not wake the parent agent\n${host.diagnostics()}`);

  host.endInput();
  const result = await host.closed;
  assert.equal(result.error, undefined, `${result.error?.message}\n${host.diagnostics()}`);
  assert.equal(result.status, 0, host.diagnostics());
});

// ---------------------------------------------------------------------------
// 对照用例：旧接线检测力证明。
// 旧接线（P1 删除前）向 installHeadlessTypedSubagentRuntime 传入
// completionNotifierFactory（extension.ts:1678 由此置
// suppressCompletionNotifications=true），上游原生 notify 经 bootstrap 收到的
// membrane api 发送 subagent-notify 时被 runtime-membrane.ts:209 静默丢弃（不抛错）。
// 若有人重新注入 factory，本对照断言立即失败——这正是主用例所守卫缺陷的复发形态。
// ---------------------------------------------------------------------------

function createHarnessPi() {
  const tools = [];
  const commands = [];
  const shortcuts = [];
  const providers = [];
  const messageRenderers = [];
  const entryRenderers = [];
  const handlers = new Map();
  const eventListeners = [];
  const messages = [];
  const events = {
    on(name, handler) {
      eventListeners.push({ name, handler });
      return () => {
        const index = eventListeners.findIndex((entry) => entry.name === name && entry.handler === handler);
        if (index >= 0) eventListeners.splice(index, 1);
      };
    },
    emit(name, payload) {
      for (const entry of [...eventListeners]) {
        if (entry.name === name) entry.handler(payload);
      }
    },
  };
  // sendMessage 返回哨兵值，用于断言 membrane 对返回值的透传（真实 Host 返回 promise）。
  const sendMessageResult = "send-accepted";
  return {
    tools,
    commands,
    shortcuts,
    providers,
    messageRenderers,
    entryRenderers,
    handlers,
    eventListeners,
    messages,
    events,
    sendMessage(message) { messages.push(message); return sendMessageResult; },
    sendMessageResult,
    registerTool(tool) { tools.push(tool); },
    registerCommand(name, definition) { commands.push({ name, definition }); },
    registerShortcut(name, definition) { shortcuts.push({ name, definition }); },
    registerProvider(name, definition) { providers.push({ name, definition }); },
    registerMessageRenderer(name, renderer) { messageRenderers.push({ name, renderer }); },
    registerEntryRenderer(name, renderer) { entryRenderers.push({ name, renderer }); },
    on(name, handler) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
    getAllTools() { return [...tools]; },
  };
}

test("the retired completionNotifierFactory wiring swallows the upstream native notify send; production wiring delivers it", () => {
  const notifyMessage = {
    customType: "subagent-notify",
    content: `Background task completed: **executor**\n\nWorkflow run: run-guard-contrast\n\n${CHILD_DONE_MARKER}`,
    display: false,
  };

  // 旧接线：completionNotifierFactory 注入 → suppression 激活。
  const retiredPi = createHarnessPi();
  let retiredUpstreamApi;
  installHeadlessTypedSubagentRuntime(retiredPi, {
    discoverAgents() { return { agents: [{ name: "executor" }] }; },
    bootstrap(api) { retiredUpstreamApi = api; },
    completionNotifierFactory() { return { dispose() {} }; },
    resolveSessionId() { return "session-contrast"; },
  });
  assert.ok(retiredUpstreamApi, "the upstream bootstrap must receive the membrane api");
  // 上游原生 notify sendCompletion 形态（notify.js:421-436）：sendMessage 不抛错即视为投递成功。
  const swallowed = retiredUpstreamApi.sendMessage({ ...notifyMessage }, { triggerTurn: true });
  assert.equal(swallowed, undefined, "the suppressed send must be silently dropped without a value");
  assert.equal(retiredPi.messages.filter((message) => message?.customType === "subagent-notify").length, 0,
    "the retired factory wiring must swallow the subagent-notify send (the 2026-09-29 silent-loss defect)");

  // 当前生产接线：无 factory → suppression=false → 原生投递直达 Host sendMessage。
  const productionPi = createHarnessPi();
  let productionUpstreamApi;
  installHeadlessTypedSubagentRuntime(productionPi, {
    discoverAgents() { return { agents: [{ name: "executor" }] }; },
    bootstrap(api) { productionUpstreamApi = api; },
  });
  assert.ok(productionUpstreamApi, "the upstream bootstrap must receive the membrane api");
  const delivered = productionUpstreamApi.sendMessage({ ...notifyMessage }, { triggerTurn: true });
  const deliveredNotifies = productionPi.messages.filter((message) => message?.customType === "subagent-notify");
  assert.equal(deliveredNotifies.length, 1, "the production wiring must deliver the upstream native notify exactly once");
  assert.equal(delivered, productionPi.sendMessageResult, "the membrane must pass the sendMessage result through");
  assert.equal(deliveredNotifies[0].content, notifyMessage.content);
  assert.equal(deliveredNotifies[0].display, false);
});
