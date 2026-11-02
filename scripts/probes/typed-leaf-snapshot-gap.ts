#!/usr/bin/env node
// typed-leaf-snapshot-gap.ts —— 受控复现实验（只读诊断，不改 production）。
//
// 目标：在真实 pi Host（RPC 模式）+ 真实 pi-subagents-enhanced typed runtime 装载链上，
// 派发一个 typed workflow spawn（subagent_start → workflow facade → leaf），在 leaf 处于
// running 期间观察上游 async job tracker 是否把 leaf 登记进 asyncSnapshot：
//   1) subagent_run_status（无 target）→ 上游 in-memory 投影 "In-memory subagent status: N active children."
//   2) subagent_run_status（target=leaf）→ "Active async capacity" 投影（生产 2026-11-01 事故观测口）
//   3) subagent_run_steer（id=leaf, index=0）→ 是否复现 SUPERVISOR_STEER_NOT_ALLOWED
//   4) bus 观察扩展记录 subagent:async-started 实际 payload（含 sessionId 实值）与 Host 会话身份
//   5) 捕获 Host stderr 中的 "Event handler error (...)"（pi EventBus safeHandler 吞错观察口）
//
// 运行：node scripts/probes/typed-leaf-snapshot-gap.ts
// 依赖：PI_REAL_BIN（或仓库 node_modules 的 pi-coding-agent@1.4.0）。
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildTopLevelRuntimeEnv } from "./pi-subagents-compat.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
const projectRuntime = join(repoRoot, "packages", "pi-subagents-enhanced", "extensions", "subagent-runtime.ts");

const CHILD_DELAY_MS = Number(process.env.PROBE_CHILD_DELAY_MS ?? 25_000);
const HOST_TIMEOUT_MS = 240_000;
const PARENT_PROMPT = "SNAPSHOT_GAP_PARENT";
const CHILD_OBJECTIVE_MARKER = "SNAPSHOT_GAP_CHILD_OBJECTIVE";
const CHILD_DONE_MARKER = "SNAPSHOT_GAP_CHILD_DONE";

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

function providerSource(contract) {
  // 确定性 provider：父会话按 toolResult 状态机依次派发 status/steer；子代理回合延迟后返回标记。
  // 文案合同沿用 test/subagent-completion-notification.integration.mjs 已验证的回执形态：
  //   subagent_start 回执 "Started <agent>: <title> (<runId>)."
  return `
    import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
    const contract = ${JSON.stringify(contract)};
    const childDelayMs = ${JSON.stringify(CHILD_DELAY_MS)};
    const PARENT_PROMPT = ${JSON.stringify(PARENT_PROMPT)};
    const CHILD_OBJECTIVE_MARKER = ${JSON.stringify(CHILD_OBJECTIVE_MARKER)};
    const CHILD_DONE_MARKER = ${JSON.stringify(CHILD_DONE_MARKER)};
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
        async streamSimple(model, context) {
          const stream = createAssistantMessageEventStream();
          const messages = context?.messages ?? [];
          const users = messages.filter((message) => message?.role === "user").map(text);
          const toolResults = messages.filter((message) => message?.role === "toolResult");
          const lastUser = users.at(-1) ?? "";
          const startResult = toolResults.find((message) => message.toolName === "subagent_start" && /Started /.test(text(message)));
          const leafRunId = startResult ? /Started [^:]+: [^(]*\\(([^()]+)\\)/.exec(text(startResult))?.[1] : undefined;
          const statusDone = toolResults.some((message) => message.toolName === "subagent_run_status");
          const steerDone = toolResults.some((message) => message.toolName === "subagent_run_steer");
          let tool;
          let output;
          if (lastUser.includes(CHILD_OBJECTIVE_MARKER)) {
            // 子代理回合：延迟保持 leaf 处于 running，供父会话观测窗口使用。
            await new Promise((done) => setTimeout(done, childDelayMs));
            output = CHILD_DONE_MARKER;
          } else if (lastUser.includes(PARENT_PROMPT)) {
            if (!startResult) tool = { name: "subagent_start", arguments: contract };
            else if (!statusDone) tool = { name: "subagent_run_status", arguments: {} };
            else if (!steerDone && leafRunId) tool = { name: "subagent_run_steer", arguments: { id: leafRunId, index: 0, message: "SNAPSHOT_GAP_STEER_MESSAGE" } };
            else output = "SNAPSHOT_GAP_PARENT_DONE";
          } else {
            output = "SNAPSHOT_GAP_PROVIDER_FALLBACK";
          }
          const toolCall = tool ? { type: "toolCall", id: "snapshot-gap-" + (++ordinal), name: tool.name, arguments: tool.arguments } : undefined;
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
            stream.push({ type: "text_delta", contentIndex: 0, delta: output ?? "", partial: message });
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

// bus 观察扩展：记录 subagent:async-started 实际 payload 与 Host 会话身份（只读旁路，不参与判定）。
function probeExtensionSource() {
  return `
    import fs from "node:fs";
    export default function (pi) {
      const out = process.env.PROBE_EVENTS_FILE;
      const monoUs = () => Number(process.hrtime.bigint() / 1000n);
      const append = (entry) => { try { fs.appendFileSync(out, JSON.stringify({ ...entry, monoUs }) + "\\n"); } catch {} };
      append({ marker: "probe-load", pid: process.pid });
      let identity = null;
      pi.on("session_start", (_event, ctx) => {
        identity = {
          sessionFile: ctx?.sessionManager?.getSessionFile?.() ?? null,
          sessionId: ctx?.sessionManager?.getSessionId?.() ?? null,
          cwd: ctx?.cwd ?? null,
        };
        append({ marker: "probe-session-start", identity, pid: process.pid });
      });
      pi.events.on("subagent:async-started", (payload) => {
        append({
          marker: "async-started",
          id: payload?.id, sessionId: payload?.sessionId, agent: payload?.agent,
          mode: payload?.mode, pid: payload?.pid, workflowKey: payload?.workflowKey,
          parentWorkflowRunId: payload?.parentWorkflowRunId, asyncDir: payload?.asyncDir,
          cwd: payload?.cwd, completionOwnerId: payload?.completionOwnerId,
          knownSessionFile: identity?.sessionFile ?? null,
          knownSessionId: identity?.sessionId ?? null,
        });
      });
      pi.events.on("subagent:async-complete", (payload) => {
        append({ marker: "async-complete", id: payload?.id, sessionId: payload?.sessionId, state: payload?.state });
      });
    }
  `;
}

function spawnRpcHost(piBinary, args, { cwd, env, input, timeoutMs }) {
  const child = spawn(piBinary, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const records = [];
  let stdout = "";
  let stderr = "";
  let buffer = "";
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 3000).unref(); }, timeoutMs);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk; buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try { records.push(JSON.parse(line)); } catch { /* 跳过不可解析行 */ }
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.on("error", () => {});
  const closed = new Promise((resolveClosed) => child.once("close", (status, signal) => {
    clearTimeout(timer);
    resolveClosed({ timedOut, status, signal });
  }));
  child.stdin.write(`${input}\n`);
  return {
    records,
    endInput() { child.stdin.end(); },
    kill() { child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 3000).unref(); },
    closed,
    stderrText: () => stderr,
    stdoutText: () => stdout,
  };
}

async function waitFor(predicate, { timeoutMs, what }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = predicate();
    if (last) return last;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function readJsonl(file) {
  if (!existsSync(file)) return [];
  const content = await readFile(file, "utf8");
  return content.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

async function main() {
  const piBinary = resolvePiBinary();
  const root = await mkdtemp(join(tmpdir(), "typed-leaf-snapshot-gap-"));
  const runtimeTmp = await mkdtemp(join(tmpdir(), "typed-leaf-snapshot-runtime-"));
  const projectRoot = join(root, "project");
  const configRoot = join(root, "config");
  const sessionsRoot = join(root, "sessions");
  const workspacesRoot = join(root, "workspaces");
  const provider = join(root, "snapshot-gap-provider.mjs");
  const probe = join(root, "snapshot-gap-probe.mjs");
  const eventsFile = join(root, "probe-events.jsonl");
  const contract = {
    title: "Typed leaf snapshot gap deterministic child",
    agent: "executor",
    task: `Return exactly the ${CHILD_DONE_MARKER} marker for the ${CHILD_OBJECTIVE_MARKER} fixture.`,
    writePaths: ["README.md"],
    acceptance: { criteria: ["The child returns the deterministic marker."] },
    cwd: projectRoot,
    worktree: false,
  };

  await mkdir(join(projectRoot, ".pi", "agents"), { recursive: true });
  await writeFile(join(projectRoot, "README.md"), "typed leaf snapshot gap fixture\n");
  await writeFile(join(projectRoot, ".pi", "agents", "executor.md"), `---
name: executor
description: deterministic typed leaf snapshot gap executor
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
  await writeFile(provider, providerSource(contract));
  await writeFile(probe, probeExtensionSource());

  const host = spawnRpcHost(piBinary, [
    "--mode", "rpc", "--no-extensions",
    "-e", provider,
    "-e", projectRuntime,
    "-e", probe,
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
      PROBE_EVENTS_FILE: eventsFile,
      OPENAI_API_KEY: "not-used",
    },
    input: JSON.stringify({ id: "snapshot-gap-001", type: "prompt", message: PARENT_PROMPT }),
    timeoutMs: HOST_TIMEOUT_MS,
  });

  const toolEnd = (name) => host.records.filter((record) => record.type === "tool_execution_end" && record.toolName === name).at(-1);

  const verdict = { experiment: "typed-leaf-snapshot-gap", reproduced: null, observations: {}, evidence: {} };
  try {
    // 1) 派发回执（leaf runId / asyncDir）。
    const dispatch = await waitFor(() => toolEnd("subagent_start")?.result?.details?.runId ? toolEnd("subagent_start") : null,
      { timeoutMs: 120_000, what: "typed subagent dispatch receipt" });
    const leafRunId = dispatch.result.details.runId;
    const leafAsyncDir = dispatch.result.details.asyncDir;
    verdict.evidence.dispatch = { leafRunId, leafAsyncDir, receiptText: text(dispatch.result).slice(0, 400) };

    // 2) leaf 处于 running（磁盘事实）。
    await waitFor(() => {
      try {
        const status = JSON.parse(require_read(join(leafAsyncDir, "status.json")));
        return status.state === "running" ? status : null;
      } catch { return null; }
    }, { timeoutMs: 30_000, what: "leaf status.json state=running" });

    // 3) 无 target 的 in-memory status（asyncSnapshot 同源投影）。
    const statusAll = await waitFor(() => toolEnd("subagent_run_status") ?? null, { timeoutMs: 60_000, what: "subagent_run_status (untargeted)" });
    const inMemoryLine = /In-memory subagent status: (\d+) active/.exec(text(statusAll.result))?.[0] ?? null;
    const activeChildren = Number(/In-memory subagent status: (\d+) active/.exec(text(statusAll.result))?.[1] ?? NaN);
    verdict.observations.untargetedStatus = { text: text(statusAll.result).slice(0, 600), inMemoryLine, activeChildren, isError: statusAll.result?.isError === true };

    // 4) steer 复现口。
    const steer = await waitFor(() => toolEnd("subagent_run_steer") ?? null, { timeoutMs: 60_000, what: "subagent_run_steer" });
    verdict.observations.steer = { text: text(steer.result).slice(0, 600), isError: steer.result?.isError === true };

    // 5) bus 观察与 stderr 吞错观察。
    await delay(500);
    const probeEvents = await readJsonl(eventsFile);
    const startedEvents = probeEvents.filter((entry) => entry.marker === "async-started");
    const leafEvent = startedEvents.find((entry) => entry.id === leafRunId);
    const facadeEvent = startedEvents.find((entry) => entry.id !== leafRunId);
    verdict.evidence.busEvents = startedEvents.map((entry) => ({ ...entry }));
    verdict.evidence.probeSessionStart = probeEvents.filter((entry) => entry.marker === "probe-session-start").at(-1) ?? null;
    verdict.evidence.leafEventSessionIdMatchesHostSession = leafEvent
      ? leafEvent.sessionId === verdict.evidence.probeSessionStart?.identity?.sessionFile
      : null;
    verdict.evidence.facadeEvent = facadeEvent ?? null;

    const stderr = host.stderrText();
    verdict.evidence.eventHandlerErrors = stderr.split("\n").filter((line) => line.includes("Event handler error")).slice(0, 20);
    verdict.evidence.stderrTail = stderr.slice(-3000);

    // 判定：leaf running 期间 in-memory 投影为 0 ⇒ 未登记进 asyncSnapshot（asyncSnapshot 同源）。
    const leafStillRunning = (() => {
      try { return JSON.parse(require_read(join(leafAsyncDir, "status.json"))).state === "running"; } catch { return false; }
    })();
    verdict.observations.leafStillRunningAtStatus = leafStillRunning;
    verdict.reproduced = leafStillRunning && activeChildren === 0;
    verdict.observations.steerRejectedNotRunning = /SUPERVISOR_STEER_NOT_ALLOWED/.test(verdict.observations.steer.text ?? "");

    // 6) 定向 status（生产同款观测口），补在 steer 之后调用一轮会破坏 provider 状态机，
    //    因此用 leaf 磁盘 status + 上面的 untargeted 投影作主证据；这里只读磁盘补充记录。
    try {
      const leafStatus = JSON.parse(require_read(join(leafAsyncDir, "status.json")));
      verdict.evidence.leafDiskStatus = { state: leafStatus.state, sessionId: leafStatus.sessionId, pid: leafStatus.pid, mode: leafStatus.mode, parentWorkflowRunId: leafStatus.parentWorkflowRunId, workflowKey: leafStatus.workflowKey };
    } catch { verdict.evidence.leafDiskStatus = null; }
  } catch (error) {
    verdict.error = error instanceof Error ? error.message : String(error);
    verdict.evidence.stderrTail = host.stderrText().slice(-4000);
  } finally {
    host.kill();
    await host.closed;
    // 清理 leaf runner（本实验自建进程，允许终止），避免孤儿进程写已删除目录。
    try {
      const leafStatus = JSON.parse(require_read(join(verdict.evidence?.dispatch?.leafAsyncDir ?? "/nonexistent", "status.json")));
      if (typeof leafStatus.pid === "number" && leafStatus.pid > 0) {
        try { process.kill(leafStatus.pid, "SIGTERM"); } catch {}
      }
    } catch {}
    await delay(1500);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
    await rm(runtimeTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
  console.log(JSON.stringify(verdict, null, 2));
  process.exitCode = verdict.error ? 1 : 0;
}

// 同步小读（waitFor 轮询用）。
import { readFileSync } from "node:fs";
function require_read(file) { return readFileSync(file, "utf8"); }

void statSync;
main().catch((error) => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; });
