#!/usr/bin/env node
// typed-leaf-snapshot-resume.ts —— resume（switch_session 到既有会话）变体（只读诊断，不改 production）。
//
// 前置事实（scripts/probes/typed-leaf-snapshot-gap.ts）：fresh Host + 单一 session_start
// 装载链上 leaf 会被正常登记（In-memory status ≥1、steer 放行），缺口不复现。
// 生产 Host（pid 25058）为长生命周期进程：2026-10-31 17:36 启动会话，11-01 ~18:12 切换到
// 10-12-25 会话后继续派发（磁盘 status.json 证据），事故 dispatch（18:34）发生在切换之后。
// 本探针在受控 Host 内复刻该形态：
//   阶段A（基线）：会话A 派发 typed run#1 → 观测 status/steer → 等 run#1 完全落地；
//   阶段B（复刻）：new_session 切到会话B（session_start reason=new, previousSessionFile）
//                 → 派发 typed run#2 → 观测 leaf#2 是否进 asyncSnapshot、steer 是否被拒。
//
// 运行：node scripts/probes/typed-leaf-snapshot-session-switch.ts
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildTopLevelRuntimeEnv } from "./pi-subagents-compat.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
const projectRuntime = join(repoRoot, "packages", "pi-subagents-enhanced", "extensions", "subagent-runtime.ts");

const CHILD_DELAY_MS = Number(process.env.PROBE_CHILD_DELAY_MS ?? 20_000);
const HOST_TIMEOUT_MS = 300_000;
const PARENT_A = "SNAPSHOT_SWITCH_PARENT_A";
const PARENT_B = "SNAPSHOT_SWITCH_PARENT_B";
const PARENT_C = "SNAPSHOT_SWITCH_PARENT_C";
const CHILD_OBJECTIVE_MARKER = "SNAPSHOT_SWITCH_CHILD_OBJECTIVE";
const CHILD_DONE_MARKER = "SNAPSHOT_SWITCH_CHILD_DONE";

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
  // 阶段A（基线）：子代理立即返回合法 acceptance 报告；阶段B（复刻）：任务带 HOLD 标记，
  // 子代理延迟保持 running，供 status/steer 观测窗口使用。任务文本进入派发 prompt，子代理可识别。
  return `
    import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
    const contractBase = ${JSON.stringify(contractBase)};
    const childDelayMs = ${JSON.stringify(CHILD_DELAY_MS)};
    const PARENT_A = ${JSON.stringify(PARENT_A)};
    const PARENT_B = ${JSON.stringify(PARENT_B)};
    const PARENT_C = ${JSON.stringify(PARENT_C)};
    const CHILD_OBJECTIVE_MARKER = ${JSON.stringify(CHILD_OBJECTIVE_MARKER)};
    const CHILD_DONE_MARKER = ${JSON.stringify(CHILD_DONE_MARKER)};
    const fence = String.fromCharCode(96, 96, 96);
    const childReport = (marker) => marker + "\\n\\n" + fence + "acceptance-report\\n" + JSON.stringify({
      criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "Returned " + marker + "." }],
      changedFiles: [], testsAddedOrUpdated: [], commandsRun: [{ command: "deterministic child marker", result: "passed", summary: marker }],
      validationOutput: [marker], residualRisks: [], noStagedFiles: true, diffSummary: "No files changed by the snapshot switch fixture.",
    }) + "\\n" + fence;
    function text(message) {
      return typeof message?.content === "string" ? message.content
        : message?.content?.filter((part) => part?.type === "text").map((part) => part.text).join("\\n") ?? "";
    }
    export default function (pi) {
      let ordinal = 0;
      let phaseADispatched = false;
      let phaseBDispatched = false;
      let phaseCDispatched = false;
      pi.registerProvider("fake", {
        baseUrl: "http://127.0.0.1:9", api: "fake", apiKey: "not-used",
        models: [{
          id: "deterministic", name: "Deterministic", input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 4096, maxTokens: 1024,
        }],
        async streamSimple(model, context) {
          const stream = createAssistantMessageEventStream();
          try {
          const messages = context?.messages ?? [];
          const users = messages.filter((message) => message?.role === "user").map(text);
          const toolResults = messages.filter((message) => message?.role === "toolResult");
          const lastUser = users.at(-1) ?? "";
          const startResult = toolResults.find((message) => message.toolName === "subagent_start" && /Started /.test(text(message)));
          const leafRunId = startResult ? /Started [^:]+: [^(]*\\(([^()]+)\\)/.exec(text(startResult))?.[1] : undefined;
          const statusDone = toolResults.some((message) => message.toolName === "subagent_run_status");
          const steerDone = toolResults.some((message) => message.toolName === "subagent_run_steer");
          const inSessionB = messages.some((message) => message?.role === "user" && text(message).includes(PARENT_B));
          let tool;
          let output;
          const anyUser = (marker) => messages.some((message) => message?.role === "user" && text(message).includes(marker));
          if (anyUser(CHILD_OBJECTIVE_MARKER) && !anyUser(PARENT_A) && !anyUser(PARENT_B) && !anyUser(PARENT_C)) {
            if (lastUser.includes("HOLD_FOR_STATUS")) await new Promise((done) => setTimeout(done, childDelayMs));
            output = childReport(CHILD_DONE_MARKER);
          } else if (lastUser.includes(PARENT_A) || (anyUser(PARENT_A) && !anyUser(PARENT_B) && !anyUser(PARENT_C))) {
            if (!phaseADispatched) { phaseADispatched = true; tool = { name: "subagent_start", arguments: { ...contractBase, task: "Return the " + CHILD_DONE_MARKER + " marker for the " + CHILD_OBJECTIVE_MARKER + " fixture." } }; }
            else if (!statusDone) tool = { name: "subagent_run_status", arguments: {} };
            else output = "SNAPSHOT_SWITCH_DONE_A";
          } else if (lastUser.includes(PARENT_B) || (anyUser(PARENT_B) && !anyUser(PARENT_C))) {
            if (!phaseBDispatched) { phaseBDispatched = true; tool = { name: "subagent_start", arguments: { ...contractBase, task: "Return the " + CHILD_DONE_MARKER + " marker for the " + CHILD_OBJECTIVE_MARKER + " fixture." } }; }
            else if (!statusDone) tool = { name: "subagent_run_status", arguments: {} };
            else output = "SNAPSHOT_SWITCH_DONE_B";
          } else if (lastUser.includes(PARENT_C) || anyUser(PARENT_C)) {
            const leafText = leafRunId ? String(leafRunId) : "";
            const statusDoneC = toolResults.some((message) => message.toolName === "subagent_run_status" && leafText && text(message).includes(leafText));
            const steerDoneC = toolResults.some((message) => message.toolName === "subagent_run_steer" && leafText && text(message).includes(leafText));
            if (!phaseCDispatched) { phaseCDispatched = true; tool = { name: "subagent_start", arguments: { ...contractBase, task: "Return the " + CHILD_DONE_MARKER + " marker for the " + CHILD_OBJECTIVE_MARKER + " HOLD_FOR_STATUS fixture." } }; }
            else if (!statusDoneC && leafText) tool = { name: "subagent_run_status", arguments: { id: leafRunId } };
            else if (!steerDoneC && leafText) tool = { name: "subagent_run_steer", arguments: { id: leafRunId, index: 0, message: "SNAPSHOT_SWITCH_STEER_MESSAGE" } };
            else output = "SNAPSHOT_SWITCH_DONE_C";
          } else {
            output = "SNAPSHOT_SWITCH_PROVIDER_FALLBACK";
          }
          const toolCall = tool ? { type: "toolCall", id: "snapshot-switch-" + (++ordinal), name: tool.name, arguments: tool.arguments } : undefined;
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
          } catch (providerError) {
            const message = { role: "assistant", content: [{ type: "text", text: "PROVIDER_ERROR: " + String(providerError && providerError.stack || providerError) }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
            stream.push({ type: "start", partial: message });
            stream.push({ type: "text_start", contentIndex: 0, partial: message });
            stream.push({ type: "text_delta", contentIndex: 0, delta: "PROVIDER_ERROR", partial: message });
            stream.push({ type: "text_end", contentIndex: 0, content: "PROVIDER_ERROR", partial: message });
            stream.push({ type: "done", reason: "stop", message });
            stream.end();
          }
          return stream;
        },
      });
    }
  `;
}

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
      const rpcStatus = (tag, params = {}) => {
        try {
          const requestId = randomUUID();
          const replyChannel = "subagents:rpc:v1:reply:" + requestId;
          const timer = setTimeout(() => { try { unsubscribe(); } catch {} append({ marker: "rpc-status", tag, error: "timeout" }); }, 15000);
          const unsubscribe = pi.events.on(replyChannel, (reply) => {
            clearTimeout(timer); try { unsubscribe(); } catch {}
            const snapshot = reply?.data?.asyncSnapshot;
            append({
              marker: "rpc-status", tag, targeted: Boolean(params?.id), success: reply?.success === true,
              runs: Array.isArray(snapshot?.runs) ? snapshot?.runs.map((run) => ({ id: run?.id, sessionId: run?.sessionId, state: run?.state ?? run?.status, mode: run?.mode, parentWorkflowRunId: run?.parentWorkflowRunId })) : null,
              text: typeof reply?.data?.text === "string" ? reply.data.text.slice(0, 120) : null,
              error: reply?.success === true ? undefined : (reply?.error?.message ?? undefined),
            });
          });
          pi.events.emit("subagents:rpc:v1:request", { version: 1, requestId, method: "status", params });
        } catch (error) {
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
        setTimeout(() => rpcStatus("session-" + (event?.reason ?? "?")), 2500);
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
          for (const delayMs of [3000, 8000]) {
            setTimeout(() => rpcStatus("targeted-" + String(payload?.id).slice(0, 8) + "+" + delayMs, { id: payload?.id }), delayMs);
            setTimeout(() => rpcStatus("untargeted+" + String(payload?.id).slice(0, 8) + "+" + delayMs), delayMs);
          }
        }
      });
    }
  `;
}

function spawnRpcHost(piBinary, args, { cwd, env, timeoutMs }) {
  const child = spawn(piBinary, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const records = [];
  let stderr = "";
  let buffer = "";
  let stdout = "";
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
  return {
    records,
    send(command) { child.stdin.write(`${JSON.stringify(command)}\n`); },
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
    last = await predicate();
    if (last) return last;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function require_read_jsonl_sync(file) {
  try {
    const content = readFileSync(file, "utf8");
    return content.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

async function readJsonl(file) {
  if (!existsSync(file)) return [];
  const content = await (await import("node:fs/promises")).readFile(file, "utf8");
  return content.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

async function main() {
  const piBinary = resolvePiBinary();
  const root = await mkdtemp(join(tmpdir(), "typed-leaf-snapshot-switch-"));
  const runtimeTmp = await mkdtemp(join(tmpdir(), "typed-leaf-snapshot-switch-rt-"));
  const projectRoot = join(root, "project");
  const configRoot = join(root, "config");
  const sessionsRoot = join(root, "sessions");
  const workspacesRoot = join(root, "workspaces");
  const provider = join(root, "snapshot-switch-provider.mjs");
  const probe = join(root, "snapshot-switch-probe.mjs");
  const eventsFile = join(root, "probe-events.jsonl");
  const contractBase = {
    title: "Typed leaf snapshot session switch child",
    agent: "executor",
    writePaths: ["README.md"],
    acceptance: { criteria: ["The child returns the deterministic marker."] },
    cwd: projectRoot,
    worktree: false,
  };

  await mkdir(join(projectRoot, ".pi", "agents"), { recursive: true });
  await writeFile(join(projectRoot, "README.md"), "typed leaf snapshot session switch fixture\n");
  await writeFile(join(projectRoot, ".pi", "agents", "executor.md"), `---
name: executor
description: deterministic session switch executor
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
  await writeFile(provider, providerSource(contractBase));
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
    timeoutMs: HOST_TIMEOUT_MS,
  });

  const toolEnds = (name) => host.records.filter((record) => record.type === "tool_execution_end" && record.toolName === name);
  const verdict = { experiment: "typed-leaf-snapshot-resume", phases: {}, evidence: {} };
  const leafPids = [];
  try {
    // ---- 阶段A：初始会话基线派发 ----
    host.send({ id: "phase-a", type: "prompt", message: PARENT_A });
    const dispatchA = await waitFor(() => toolEnds("subagent_start")[0]?.result?.details?.runId ? toolEnds("subagent_start")[0] : null,
      { timeoutMs: 120_000, what: "phase A dispatch receipt" });
    const leafA = dispatchA.result.details.runId;
    const asyncDirA = dispatchA.result.details.asyncDir;
    const statusA = await waitFor(() => toolEnds("subagent_run_status")[0] ?? null, { timeoutMs: 60_000, what: "phase A status" });
    verdict.phases.A = {
      leafRunId: leafA,
      activeChildren: Number(/In-memory subagent status: (\d+) active/.exec(text(statusA.result))?.[1] ?? NaN),
    };
    await waitFor(() => {
      try { return JSON.parse(readFileSync(join(asyncDirA, "status.json"), "utf8")).state !== "running" ? 1 : null; } catch { return null; }
    }, { timeoutMs: 90_000, what: "phase A leaf completion" });
    try { leafPids.push(JSON.parse(readFileSync(join(asyncDirA, "status.json"), "utf8")).pid); } catch {}
    await waitFor(() => host.records.some((record) => record.type === "message_end" && text(record.message).includes("SNAPSHOT_SWITCH_DONE_A")) ? 1 : null,
      { timeoutMs: 30_000, what: "phase A parent done" });
    await delay(4000);

    // ---- 阶段B：new_session（reason=new）后派发基线 ----
    host.send({ id: "new-session", type: "new_session" });
    await waitFor(() => host.records.find((record) => record.id === "new-session" && record.success) ?? null, { timeoutMs: 120_000, what: "new_session success" });
    await waitFor(() => {
      const lastStart = host.records.map((record) => record.type === "agent_start").lastIndexOf(true);
      const lastSettled = host.records.map((record) => record.type === "agent_settled").lastIndexOf(true);
      return lastSettled >= lastStart && lastSettled >= 0 ? 1 : null;
    }, { timeoutMs: 90_000, what: "post-new_session settle" });
    host.send({ id: "phase-b", type: "prompt", message: PARENT_B });
    const dispatchB = await waitFor(() => toolEnds("subagent_start")[1]?.result?.details?.runId ? toolEnds("subagent_start")[1] : null,
      { timeoutMs: 120_000, what: "phase B dispatch receipt" });
    const asyncDirB = dispatchB.result.details.asyncDir;
    const statusB = await waitFor(() => toolEnds("subagent_run_status")[1] ?? null, { timeoutMs: 60_000, what: "phase B status" });
    verdict.phases.B = {
      leafRunId: dispatchB.result.details.runId,
      activeChildren: Number(/In-memory subagent status: (\d+) active/.exec(text(statusB.result))?.[1] ?? NaN),
    };
    await waitFor(() => {
      try { return JSON.parse(readFileSync(join(asyncDirB, "status.json"), "utf8")).state !== "running" ? 1 : null; } catch { return null; }
    }, { timeoutMs: 90_000, what: "phase B leaf completion" });
    try { leafPids.push(JSON.parse(readFileSync(join(asyncDirB, "status.json"), "utf8")).pid); } catch {}
    await waitFor(() => host.records.some((record) => record.type === "message_end" && text(record.message).includes("SNAPSHOT_SWITCH_DONE_B")) ? 1 : null,
      { timeoutMs: 30_000, what: "phase B parent done" });
    await delay(4000);

    // ---- 阶段C：switch_session 回初始会话（reason=resume，生产 18:12 形态）后派发观测 ----
    const sessionAFile = verdict.evidence.sessionAFile ?? (() => {
      const probeEvents = require_read_jsonl_sync(eventsFile);
      const first = probeEvents.find((entry) => entry.marker === "probe-session-start");
      return first?.identity?.sessionFile;
    })();
    if (!sessionAFile) throw new Error("无法定位初始会话文件（probe-session-start 缺失）");
    host.send({ id: "resume-session", type: "switch_session", sessionPath: sessionAFile });
    await waitFor(() => host.records.find((record) => record.id === "resume-session" && record.success) ?? null, { timeoutMs: 120_000, what: "switch_session success" });
    await waitFor(() => {
      const lastStart = host.records.map((record) => record.type === "agent_start").lastIndexOf(true);
      const lastSettled = host.records.map((record) => record.type === "agent_settled").lastIndexOf(true);
      return lastSettled >= lastStart && lastSettled >= 0 ? 1 : null;
    }, { timeoutMs: 90_000, what: "post-resume settle" });
    await delay(2000);
    host.send({ id: "phase-c", type: "prompt", message: PARENT_C });
    const dispatchC = await waitFor(() => toolEnds("subagent_start")[2]?.result?.details?.runId ? toolEnds("subagent_start")[2] : null,
      { timeoutMs: 120_000, what: "phase C dispatch receipt" });
    const leafC = dispatchC.result.details.runId;
    const asyncDirC = dispatchC.result.details.asyncDir;
    await waitFor(() => {
      try { return JSON.parse(readFileSync(join(asyncDirC, "status.json"), "utf8")).state === "running" ? 1 : null; } catch { return null; }
    }, { timeoutMs: 30_000, what: "phase C leaf running" });
    const statusC = await waitFor(() => toolEnds("subagent_run_status")[2] ?? null, { timeoutMs: 60_000, what: "phase C status" });
    const steerC = await waitFor(() => toolEnds("subagent_run_steer").at(-1) ?? null, { timeoutMs: 60_000, what: "phase C steer" });
    const leafCRunning = (() => {
      try { return JSON.parse(readFileSync(join(asyncDirC, "status.json"), "utf8")).state === "running"; } catch { return false; }
    })();
    try { leafPids.push(JSON.parse(readFileSync(join(asyncDirC, "status.json"), "utf8")).pid); } catch {}
    verdict.phases.C = {
      leafRunId: leafC,
      activeChildren: Number(/In-memory subagent status: (\d+) active/.exec(text(statusC.result))?.[1] ?? NaN),
      statusText: text(statusC.result).slice(0, 600),
      steerText: text(steerC.result).slice(0, 600),
      steerRejectedNotRunning: /SUPERVISOR_STEER_NOT_ALLOWED/.test(text(steerC.result)),
      leafStillRunningAtStatus: leafCRunning,
    };
    verdict.reproduced = Boolean(leafCRunning && verdict.phases.C.activeChildren === 0);

    // ---- bus 证据 ----
    await delay(500);
    const probeEvents = await readJsonl(eventsFile);
    verdict.evidence.sessionStarts = probeEvents.filter((entry) => entry.marker === "probe-session-start").map((entry) => entry.identity);
    verdict.evidence.rpcStatuses = probeEvents.filter((entry) => entry.marker === "rpc-status");
    verdict.evidence.startedEvents = probeEvents.filter((entry) => entry.marker === "async-started")
      .map((entry) => ({ id: entry.id, sessionId: entry.sessionId, agent: entry.agent, knownSessionFile: entry.knownSessionFile }));
    const stderr = host.stderrText();
    verdict.evidence.eventHandlerErrors = stderr.split("\n").filter((line) => line.includes("Event handler error")).slice(0, 20);
    verdict.evidence.stderrTail = stderr.slice(-3000);
  } catch (error) {
    verdict.error = error instanceof Error ? error.message : String(error);
    verdict.evidence.stderrTail = host.stderrText().slice(-4000);
    verdict.evidence.commandResponses = host.records.filter((record) => record.type === "response").map((record) => JSON.stringify(record).slice(0, 300));
    verdict.evidence.toolStarts = host.records.filter((record) => record.type === "tool_execution_start").map((record) => record.toolName);
    verdict.evidence.errorRecords = host.records.filter((record) => record.type === "error" || record.type === "extension_error" || record.error).map((record) => JSON.stringify(record).slice(0, 400)).slice(-10);
    verdict.evidence.recordsTail = host.records.slice(-12).map((record) => JSON.stringify(record).slice(0, 260));
    verdict.evidence.toolEndsSeen = host.records.filter((record) => record.type === "tool_execution_end").map((record) => record.toolName);
    verdict.evidence.errorRecords = host.records.filter((record) => record.type === "error" || record.type === "extension_error" || record.error).map((record) => JSON.stringify(record).slice(0, 500)).slice(-10);
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
