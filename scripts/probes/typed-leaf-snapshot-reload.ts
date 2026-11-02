#!/usr/bin/env node
// typed-leaf-snapshot-reload.ts —— 扩展 reload 变体（只读诊断，不改 production）。
//
// 前置事实：fresh Host（typed-leaf-snapshot-gap.ts）与 new_session 会话切换
// （typed-leaf-snapshot-session-switch.ts）装载链均正常登记 leaf（asyncSnapshot 含 leaf、
// steer 放行），缺口不复现。生产 Host（pid 25058）为长生命周期交互式 TUI 进程，事故
// dispatch 前的可疑中间事件是扩展 reload（agent-session.reload()：旧代
// session_shutdown(reason=reload) → 全量重装载 → session_start(reason=reload)）。
// enhanced 层 installHeadlessTypedSubagentRuntime 在 hiddenOwnership（旧代 shutdown debt
// 未清偿）分支把上游全部事件订阅（含 asyncStartedHandler）延迟到 beforeSessionStart
// 激活（extension.ts:2785-2801）；本实验验证 reload 后该激活是否仍然成立。
//
// 形态：嵌套 script 提供真实 PTY，跑交互式 TUI；确定性 provider 驱动
// subagent_start/status/steer 工具序列（steer 回执编码进最终文本）；bus 观察扩展
// （跨 reload 代共享 events 文件）记录 async-started payload、session_start reason，
// 并经 subagents:rpc:v1 直接查询上游 in-memory asyncSnapshot。
// 阶段A（基线派发）→ /reload → 阶段B（reload 后派发，复刻事故 dispatch）。
//
// 运行：node scripts/probes/typed-leaf-snapshot-reload.ts
import { spawn } from "node:child_process";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repoRoot = resolve(import.meta.dirname, "../..");
const projectRuntime = join(repoRoot, "packages", "pi-subagents-enhanced", "extensions", "subagent-runtime.ts");

const CHILD_DELAY_MS = Number(process.env.PROBE_CHILD_DELAY_MS ?? 25_000);
const HOST_TIMEOUT_MS = 420_000;
const PARENT_A = "SNAPSHOT_RELOAD_PARENT_A";
const PARENT_B = "SNAPSHOT_RELOAD_PARENT_B";
const CHILD_OBJECTIVE_MARKER = "SNAPSHOT_RELOAD_CHILD_OBJECTIVE";
const CHILD_DONE_MARKER = "SNAPSHOT_RELOAD_CHILD_DONE";
const STEER_OK = "SNAPSHOT_RELOAD_STEER_OK";
const STEER_REJECTED = "SNAPSHOT_RELOAD_STEER_REJECTED";

function resolvePiBinary() {
  const candidate = process.env.PI_REAL_BIN ?? join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  if (!existsSync(candidate)) throw new Error(`pi binary 不可用：${candidate}（设置 PI_REAL_BIN）`);
  return candidate;
}

function withoutSubagentEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("PI_SUBAGENT_") && !name.startsWith("PI_SESSION_") && ![
    "PI_ROOT_SUBAGENT_BROKER_ENABLED", "PI_MODEL", "PI_PROVIDER", "PI_CODING_AGENT_SESSION_DIR", "PI_CODING_WORKSPACE_DIR", "PI_CODING_GOAL_DIR",
  ].includes(name)));
}

function text(message) {
  return typeof message?.content === "string" ? message.content
    : message?.content?.filter((part) => part?.type === "text").map((part) => part.text).join("\n") ?? "";
}

function providerSource(contractBase) {
  // 阶段A 子代理立即返回；阶段B（reload 后）任务带 HOLD 标记延迟保持 running。
  // steer 回执（放行/拒绝）编码进父会话最终文本，供 PTY 输出抓取。
  return `
    import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
    const contractBase = ${JSON.stringify(contractBase)};
    const childDelayMs = ${JSON.stringify(CHILD_DELAY_MS)};
    const PARENT_A = ${JSON.stringify(PARENT_A)};
    const PARENT_B = ${JSON.stringify(PARENT_B)};
    const STEER_OK = ${JSON.stringify(STEER_OK)};
    const STEER_REJECTED = ${JSON.stringify(STEER_REJECTED)};
    const CHILD_OBJECTIVE_MARKER = ${JSON.stringify(CHILD_OBJECTIVE_MARKER)};
    const CHILD_DONE_MARKER = ${JSON.stringify(CHILD_DONE_MARKER)};
    const fence = String.fromCharCode(96, 96, 96);
    const childReport = (marker) => marker + "\\n\\n" + fence + "acceptance-report\\n" + JSON.stringify({
      criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "Returned " + marker + "." }],
      changedFiles: [], testsAddedOrUpdated: [], commandsRun: [{ command: "deterministic child marker", result: "passed", summary: marker }],
      validationOutput: [marker], residualRisks: [], noStagedFiles: true, diffSummary: "No files changed by the snapshot reload fixture.",
    }) + "\\n" + fence;
    function text(message) {
      return typeof message?.content === "string" ? message.content
        : message?.content?.filter((part) => part?.type === "text").map((part) => part.text).join("\\n") ?? "";
    }
    export default function (pi) {
      let ordinal = 0;
      let phaseADispatched = false;
      let phaseBDispatched = false;
      pi.registerProvider("fake", {
        baseUrl: "http://127.0.0.1:9", api: "fake", apiKey: "not-used",
        models: [{
          id: "deterministic", name: "Deterministic", input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 4096, maxTokens: 1024,
        }],
        async streamSimple(model, context) {
          const stream = createAssistantMessageEventStream();
          const messages = context?.messages ?? [];
          const users = messages.filter((message) => message?.role === "user").map(text);
          const toolResults = messages.filter((message) => message?.role === "toolResult");
          const lastUser = users.at(-1) ?? "";
          const startResult = toolResults.filter((message) => message.toolName === "subagent_start" && /Started /.test(text(message))).at(-1);
          const leafRunId = startResult ? /Started [^:]+: [^(]*\\(([^()]+)\\)/.exec(text(startResult))?.[1] : undefined;
          const statusDone = toolResults.some((message) => message.toolName === "subagent_run_status");
          const steerResult = toolResults.find((message) => message.toolName === "subagent_run_steer");
          let tool;
          let output;
          if (lastUser.includes(CHILD_OBJECTIVE_MARKER)) {
            if (lastUser.includes("HOLD_FOR_STATUS")) await new Promise((done) => setTimeout(done, childDelayMs));
            output = childReport(CHILD_DONE_MARKER);
          } else if (lastUser.includes(PARENT_A)) {
            if (!phaseADispatched) { phaseADispatched = true; tool = { name: "subagent_start", arguments: { ...contractBase, task: "Return the " + CHILD_DONE_MARKER + " marker for the " + CHILD_OBJECTIVE_MARKER + (childDelayMs > 0 ? " HOLD_FOR_STATUS" : "") + " fixture." } }; }
            else if (!statusDone) tool = { name: "subagent_run_status", arguments: {} };
            else output = "SNAPSHOT_RELOAD_DONE_A";
          } else if (lastUser.includes(PARENT_B)) {
            if (!phaseBDispatched) { phaseBDispatched = true; tool = { name: "subagent_start", arguments: { ...contractBase, task: "Return the " + CHILD_DONE_MARKER + " marker for the " + CHILD_OBJECTIVE_MARKER + " HOLD_FOR_STATUS fixture." } }; }
            else if (!statusDone) tool = { name: "subagent_run_status", arguments: {} };
            else if (!steerResult && leafRunId) tool = { name: "subagent_run_steer", arguments: { id: leafRunId, index: 0, message: "SNAPSHOT_RELOAD_STEER_MESSAGE" } };
            else if (steerResult) output = /SUPERVISOR_STEER_NOT_ALLOWED|SUPERVISOR_OWNER_UNAVAILABLE|SUPERVISOR_STALE_OWNER/.test(text(steerResult)) ? STEER_REJECTED : STEER_OK;
            else output = "SNAPSHOT_RELOAD_DONE_B";
          } else {
            output = "SNAPSHOT_RELOAD_PROVIDER_FALLBACK";
          }
          const toolCall = tool ? { type: "toolCall", id: "snapshot-reload-" + (++ordinal), name: tool.name, arguments: tool.arguments } : undefined;
          const message = {
            role: "assistant", content: toolCall ? [toolCall] : [{ type: "text", text: output ?? "" }],
            api: model.api, provider: model.provider, model: model.id,
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
            stream.push({ type: "text_delta", contentIndex: 0, delta: (output ?? "").slice(0, 400), partial: message });
            stream.push({ type: "text_end", contentIndex: 0, content: output ?? "", partial: message });
            stream.push({ type: "done", reason: "stop", message });
          }
          stream.end();
          return stream;
        },
      });
    }
  `;
}

// bus 观察扩展：记录 async-started payload / session_start reason；在 leaf started 后经
// subagents:rpc:v1 请求直接读取上游 in-memory asyncSnapshot（跨 reload 代共享文件）。
function probeExtensionSource() {
  return `
    import fs from "node:fs";
    import { randomUUID } from "node:crypto";
    export default function (pi) {
      const out = process.env.PROBE_EVENTS_FILE;
      const monoUs = () => Number(process.hrtime.bigint() / 1000n);
      const append = (entry) => { try { fs.appendFileSync(out, JSON.stringify({ ...entry, monoUs }) + "\\n"); } catch {} };
      append({ marker: "probe-load", pid: process.pid });
      let identity = null;
      const rpcStatus = (tag) => {
        try {
          const requestId = randomUUID();
          const replyChannel = "subagents:rpc:v1:reply:" + requestId;
          const timer = setTimeout(() => { try { unsubscribe(); } catch {} append({ marker: "rpc-status", tag, error: "timeout" }); }, 15000);
          const unsubscribe = pi.events.on(replyChannel, (reply) => {
            clearTimeout(timer); try { unsubscribe(); } catch {}
            const snapshot = reply?.data?.asyncSnapshot;
            append({
              marker: "rpc-status", tag, success: reply?.success === true,
              runs: Array.isArray(snapshot?.runs) ? snapshot?.runs.map((run) => ({ id: run?.id, sessionId: run?.sessionId, state: run?.state ?? run?.status, mode: run?.mode, parentWorkflowRunId: run?.parentWorkflowRunId })) : null,
              text: typeof reply?.data?.text === "string" ? reply.data.text.slice(0, 200) : null,
            });
          });
          pi.events.emit("subagents:rpc:v1:request", { version: 1, requestId, method: "status", params: {} });
        } catch (error) {
          // reload 后旧实例 ctx 失效：静默终止本实例的采样，绝不让探针异常杀死 Host。
          append({ marker: "rpc-status", tag, error: "stale-ctx" });
        }
      };
      pi.on("session_start", (event, ctx) => {
        identity = {
          reason: event?.reason ?? null,
          previousSessionFile: event?.previousSessionFile ?? null,
          sessionFile: ctx?.sessionManager?.getSessionFile?.() ?? null,
          sessionId: ctx?.sessionManager?.getSessionId?.() ?? null,
          cwd: ctx?.cwd ?? null,
        };
        append({ marker: "probe-session-start", identity, pid: process.pid });
        if (event?.reason === "reload") { for (const delayMs of [1500, 3000, 5000, 8000]) setTimeout(() => rpcStatus("after-reload+" + delayMs), delayMs); }
      });
      pi.events.on("subagent:async-started", (payload) => {
        append({
          marker: "async-started",
          id: payload?.id, sessionId: payload?.sessionId, agent: payload?.agent,
          mode: payload?.mode, pid: payload?.pid, workflowKey: payload?.workflowKey,
          parentWorkflowRunId: payload?.parentWorkflowRunId, asyncDir: payload?.asyncDir,
          knownSessionFile: identity?.sessionFile ?? null,
          knownSessionId: identity?.sessionId ?? null,
        });
        if (payload?.agent && payload?.agent !== "workflow") {
          for (const delayMs of [500, 1500, 3000, 6000, 10000]) {
            setTimeout(() => rpcStatus("leaf-" + String(payload?.id).slice(0, 8) + "+" + delayMs), delayMs);
          }
        }
      });
    }
  `;
}

function ptyRelaySource() {
  // Python pty 中继（探针 fixture，非 production）：给 TUI 提供真实 PTY，并把驱动侧
  // stdin/stdout 与 PTY 主端双向转发，使驱动可以模拟键盘输入并抓取 TUI 原始输出。
  return [
    "import os, pty, sys, select, subprocess",
    "argv = sys.argv[1:]",
    "master, slave = pty.openpty()",
    "p = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=slave, close_fds=True)",
    "os.close(slave)",
    "while True:",
    "    r, _, _ = select.select([master, sys.stdin.buffer], [], [], 1.0)",
    "    if master in r:",
    "        try:",
    "            data = os.read(master, 65536)",
    "        except OSError:",
    "            break",
    "        if not data:",
    "            break",
    "        sys.stdout.buffer.write(data)",
    "        sys.stdout.buffer.flush()",
    "    if sys.stdin.buffer in r:",
    "        data = sys.stdin.buffer.read1(65536)",
    "        if data:",
    "            os.write(master, data)",
    "    if p.poll() is not None:",
    "        try:",
    "            while True:",
    "                r, _, _ = select.select([master], [], [], 0.2)",
    "                if master not in r:",
    "                    break",
    "                data = os.read(master, 65536)",
    "                if not data:",
    "                    break",
    "                sys.stdout.buffer.write(data)",
    "        except OSError:",
    "            pass",
    "        break",
    "sys.exit(p.returncode or 0)",
  ].join("\n");
}

function spawnTuiHost(piBinary, args, { cwd, env, timeoutMs, relayScript }) {
  const child = spawn("/usr/bin/python3", [relayScript, piBinary, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 3000).unref(); }, timeoutMs);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.on("error", () => {});
  const closed = new Promise((resolveClosed) => child.once("close", (status, signal) => {
    clearTimeout(timer);
    resolveClosed({ timedOut, status, signal });
  }));
  return {
    type(value) { child.stdin.write(value); },
    kill() { child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 3000).unref(); },
    closed,
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}

// 去 ANSI/OSC 转义，供 TUI 原始流上的标记抓取。
function stripAnsi(raw) {
  return raw
    .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "")
    .replace(/\u001b[()][0-9A-B]/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001a\u001c-\u001f]/g, "");
}

async function waitFor(predicate, { timeoutMs, what }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await delay(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function readJsonl(file) {
  if (!existsSync(file)) return [];
  const content = await (await import("node:fs/promises")).readFile(file, "utf8");
  return content.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

async function main() {
  const piBinary = resolvePiBinary();
  const root = await mkdtemp(join(tmpdir(), "typed-leaf-snapshot-reload-"));
  const runtimeTmp = await mkdtemp(join(tmpdir(), "typed-leaf-snapshot-reload-rt-"));
  const projectRoot = join(root, "project");
  const configRoot = join(root, "config");
  const sessionsRoot = join(root, "sessions");
  const workspacesRoot = join(root, "workspaces");
  const provider = join(root, "snapshot-reload-provider.mjs");
  const probe = join(root, "snapshot-reload-probe.mjs");
  const eventsFile = join(root, "probe-events.jsonl");
  const relayScript = join(root, "pty-relay.py");
  const contractBase = {
    title: "Typed leaf snapshot reload child",
    agent: "executor",
    writePaths: ["README.md"],
    acceptance: { criteria: ["The child returns the deterministic marker."] },
    cwd: projectRoot,
    worktree: false,
  };

  await mkdir(join(projectRoot, ".pi", "agents"), { recursive: true });
  await writeFile(join(projectRoot, "README.md"), "typed leaf snapshot reload fixture\n");
  await writeFile(join(projectRoot, ".pi", "agents", "executor.md"), `---
name: executor
description: deterministic reload executor
model: fake/deterministic
tools: read
extensions: ${provider}
---
Return the deterministic child marker without modifying files.
`);
  await mkdir(join(configRoot, "agents"), { recursive: true });
  for (const name of ["delegate", "executor", "reviewer"]) {
    await writeFile(join(configRoot, "agents", `${name}.md`), `---
name: ${name}
description: fixture
model: fake/deterministic
tools: read,bash,contact_supervisor
extensions: ${provider}
---
执行隔离fixture。
`);
  }
  await mkdir(join(configRoot, "extensions"), { recursive: true });
  await symlink(join(repoRoot, "pi", "extensions", "agents-shared.ts"), join(configRoot, "extensions", "agents-shared.ts"));
  // TUI 首次进入未信任 cwd 会弹信任对话框：预写 agentDir/trust.json（canonical 路径）。
  await writeFile(join(configRoot, "trust.json"), JSON.stringify({ [realpathSync(projectRoot)]: true }, null, 2));
  await writeFile(provider, providerSource(contractBase));
  await writeFile(probe, probeExtensionSource());
  await writeFile(relayScript, ptyRelaySource());

  const host = spawnTuiHost(piBinary, [
    "--no-extensions",
    "-e", provider,
    "-e", projectRuntime,
    "-e", probe,
    "--no-skills", "--no-prompt-templates", "--no-themes",
    "--provider", "fake", "--model", "fake/deterministic",
  ], {
    cwd: projectRoot,
    env: {
      ...withoutSubagentEnvironment(process.env),
      TMPDIR: runtimeTmp,
      TERM: "xterm-256color",
      PI_CODING_AGENT_DIR: configRoot,
      PI_CODING_AGENT_SESSION_DIR: sessionsRoot,
      PI_CODING_WORKSPACE_DIR: workspacesRoot,
      PROBE_EVENTS_FILE: eventsFile,
      OPENAI_API_KEY: "not-used",
    },
    timeoutMs: HOST_TIMEOUT_MS,
    relayScript,
  });

  const verdict = { experiment: "typed-leaf-snapshot-reload", phases: {}, evidence: {} };
  const leafPids = [];
  const events = () => readJsonl(eventsFile);
  try {
    await waitFor(async () => (await events()).some((entry) => entry.marker === "probe-session-start" && entry.identity?.reason === "startup") ? 1 : null,
      { timeoutMs: 90_000, what: "TUI startup session_start" });

    // ---- 阶段A：基线派发 ----
    host.type(`${PARENT_A}\r`);
    const leafA = await waitFor(async () => (await events()).filter((entry) => entry.marker === "async-started" && entry.agent === "executor").at(-1)?.id ?? null,
      { timeoutMs: 150_000, what: "phase A leaf started" });
    const leafAEvent = (await events()).filter((entry) => entry.marker === "async-started" && entry.id === leafA)[0];
    const statusA = await waitFor(async () => (await events()).filter((entry) => entry.marker === "rpc-status" && String(entry.tag ?? "").startsWith("leaf-" + leafA.slice(0, 8) + "+")).at(-1) ?? null,
      { timeoutMs: 30_000, what: "phase A rpc status" });
    verdict.phases.A = {
      leafRunId: leafA,
      snapshotRuns: statusA.runs?.map((run) => run.id) ?? null,
      leafInSnapshot: Boolean(statusA.runs?.some((run) => run.id === leafA)),
    };
    const reloadWhileRunning = process.env.PROBE_RELOAD_AFTER_LEAF_COMPLETE !== "1";
    if (!reloadWhileRunning) {
      await waitFor(async () => {
        try { return JSON.parse(readFileSync(join(leafAEvent.asyncDir, "status.json"), "utf8")).state !== "running" ? 1 : null; } catch { return null; }
      }, { timeoutMs: 120_000, what: "phase A leaf completion" });
    } else {
      await waitFor(async () => {
        try { return JSON.parse(readFileSync(join(leafAEvent.asyncDir, "status.json"), "utf8")).state === "running" ? 1 : null; } catch { return null; }
      }, { timeoutMs: 30_000, what: "phase A leaf running" });
    }
    try { leafPids.push(JSON.parse(readFileSync(join(leafAEvent.asyncDir, "status.json"), "utf8")).pid); } catch {}
    verdict.phases.A.reloadWhileRunning = reloadWhileRunning;
    await delay(6000);

    // ---- 阶段B：/reload 触发真实扩展重装载 ----
    host.type("/reload\r");
    await waitFor(async () => (await events()).some((entry) => entry.marker === "probe-session-start" && entry.identity?.reason === "reload") ? 1 : null,
      { timeoutMs: 120_000, what: "session_start reason=reload" });
    verdict.evidence.reloadObserved = true;
    await delay(8000);

    // ---- 阶段C：reload 后派发（复刻事故 dispatch）----
    host.type(`${PARENT_B}\r`);
    const leafB = await waitFor(async () => (await events()).filter((entry) => entry.marker === "async-started" && entry.agent === "executor" && entry.id !== leafA).at(-1)?.id ?? null,
      { timeoutMs: 150_000, what: "phase B leaf started" });
    const leafBEvent = (await events()).filter((entry) => entry.marker === "async-started" && entry.id === leafB)[0];
    const statusB = await waitFor(async () => (await events()).filter((entry) => entry.marker === "rpc-status" && String(entry.tag ?? "").startsWith("leaf-" + leafB.slice(0, 8) + "+")).at(-1) ?? null,
      { timeoutMs: 30_000, what: "phase B rpc status" });
    await delay(11_000);
    const statusBSamples = (await events()).filter((entry) => entry.marker === "rpc-status" && String(entry.tag ?? "").startsWith("leaf-" + leafB.slice(0, 8) + "+"));
    // 快照时刻同步读 leaf 磁盘状态（证明观测窗口内 leaf 仍 running）。
    const leafBDiskAtStatus = (() => {
      try {
        const status = JSON.parse(readFileSync(join(leafBEvent.asyncDir, "status.json"), "utf8"));
        return { state: status.state, startedAt: status.startedAt, pid: status.pid };
      } catch (error) { return { readError: String(error) }; }
    })();
    const leafBRunning = leafBDiskAtStatus.state === "running";
    try { leafPids.push(JSON.parse(readFileSync(join(leafBEvent.asyncDir, "status.json"), "utf8")).pid); } catch {}
    // steer 回执等父会话最终文本（PTY 原始流去转义后抓取）。
    const steerOutcome = await waitFor(() => {
      const plain = stripAnsi(host.stdoutText());
      const rejected = plain.includes(STEER_REJECTED);
      const ok = plain.includes(STEER_OK);
      return rejected ? STEER_REJECTED : ok ? STEER_OK : null;
    }, { timeoutMs: 90_000, what: "phase B steer receipt" }).catch(() => "steer-receipt-timeout");
    verdict.phases.B = {
      leafRunId: leafB,
      snapshotRuns: statusB.runs?.map((run) => run.id) ?? null,
      leafInSnapshot: Boolean(statusB.runs?.some((run) => run.id === leafB)),
      snapshotSamples: statusBSamples.map((entry) => ({ tag: entry.tag, runs: entry.runs?.map((run) => ({ id: run.id, state: run.state ?? run.status })) ?? null, text: entry.text })),
      leafDiskAtStatus: leafBDiskAtStatus,
      leafStillRunningAtStatus: leafBDiskAtStatus.state === "running",
      statusText: statusB.text,
      steerOutcome,
      steerReceiptWindow: (() => {
        const plain = stripAnsi(host.stdoutText());
        const index = plain.lastIndexOf("subagent_run_steer");
        return index >= 0 ? plain.slice(Math.max(0, index - 100), index + 700) : null;
      })(),
      steerRejectedNotRunning: steerOutcome === STEER_REJECTED || /SUPERVISOR_STEER_NOT_ALLOWED/.test(verdict?.phases?.B?.steerReceiptWindow ?? ""),
    };
    try {
      const finalB = JSON.parse(readFileSync(join(leafBEvent.asyncDir, "status.json"), "utf8"));
      verdict.phases.B.leafFinalState = { state: finalB.state, error: finalB.error ?? null, lastUpdate: finalB.lastUpdate };
    } catch { verdict.phases.B.leafFinalState = null; }
    // 子会话记录前两条（只读）：验证子代理实际收到的 prompt 形态。
    try {
      const sessionsDir = sessionsRoot;
      const { readdirSync } = await import("node:fs");
      const sessionFiles = [];
      const walk = (dir) => { for (const name of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, name.name); if (name.isDirectory()) walk(p); else if (name.name.endsWith(".jsonl")) sessionFiles.push(p); } };
      walk(sessionsDir);
      verdict.evidence.leafBChildSessionHead = sessionFiles
        .filter((file) => file.includes(leafB))
        .flatMap((file) => readFileSync(file, "utf8").split("\n").filter(Boolean).slice(0, 2))
        .map((line) => line.slice(0, 600));
    } catch (error) { verdict.evidence.leafBChildSessionHead = [`read-error: ${String(error)}`]; }
    verdict.reproduced = Boolean(leafBRunning && !verdict.phases.B.leafInSnapshot);

    verdict.evidence.sessionStarts = (await events()).filter((entry) => entry.marker === "probe-session-start").map((entry) => entry.identity);
    verdict.evidence.startedEvents = (await events()).filter((entry) => entry.marker === "async-started")
      .map((entry) => ({ id: entry.id, sessionId: entry.sessionId, agent: entry.agent, knownSessionFile: entry.knownSessionFile, monoUs: entry.monoUs }));
    verdict.evidence.rpcStatuses = (await events()).filter((entry) => entry.marker === "rpc-status");
  } catch (error) {
    verdict.error = error instanceof Error ? error.message : String(error);
    try { verdict.evidence.probeEventsDump = (await events()).slice(-30); } catch { verdict.evidence.probeEventsDump = null; }
    verdict.evidence.tuiTail = stripAnsi(host.stdoutText()).slice(-3000);
    verdict.evidence.stderrTail = host.stderrText().slice(-2000);
  } finally {
    host.kill();
    await host.closed;
    for (const pid of leafPids) { try { process.kill(pid, "SIGTERM"); } catch {} }
    await delay(1500);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
    await rm(runtimeTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
  console.log(JSON.stringify(verdict, null, 2));
  process.exitCode = verdict.error ? 1 : 0;
}

main().catch((error) => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; });
