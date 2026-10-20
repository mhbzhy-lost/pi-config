import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";

import { buildTopLevelRuntimeEnv, SUPPORTED_PI_VERSIONS } from "../scripts/probes/pi-subagents-compat.ts";

// 主动 steer 文本插入守卫（用户报告：旧仓 runtime 下主动 steer 无法向 subagent 插入文本）。
//
// 场景：父 Host 经 typed subagent 派发一个 async child；child 第一回合执行 `sleep`
// 保持存活，父在 child 运行中主动 subagent_run_steer({ runId, message })。
// 断言 steer 文本真正插入 child 会话（child 会话 jsonl 出现该文本），且 child
// 消费后在后续回合回显——即完整走生产 steer 路径：
//   extension.executeControl → supervisor 控制面 → rpc.steer → child steering inbox
//   → child 在 turn 边界经 sendUserMessage({deliverAs:"steer"}) 注入上下文。
//
// 若 steer 文本未插入（旧仓缺陷形态），child 会话不含标记、最终输出为 CHILD_FALLBACK。

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const piBinary = process.env.PI_REAL_BIN;
const projectRuntime = join(repoRoot, "packages", "pi-subagents-enhanced", "extensions", "subagent-runtime.ts");

const PARENT_PROMPT = "STEER_INSERT_PARENT";
const CHILD_OBJECTIVE_MARKER = "STEER_INSERT_CHILD";
const STEER_MARKER = "STEER_INSERT_INJECTED_TEXT";
const CHILD_RECEIVED = "STEER_RECEIVED";
const CHILD_FALLBACK = "STEER_CHILD_FALLBACK";

function withoutSubagentEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("PI_SUBAGENT_") && !name.startsWith("PI_SESSION_") && ![
    "PI_ROOT_SUBAGENT_BROKER_ENABLED", "PI_MODEL", "PI_PROVIDER", "PI_CODING_AGENT_SESSION_DIR", "PI_CODING_WORKSPACE_DIR", "PI_CODING_GOAL_DIR",
  ].includes(name)));
}

function childAcceptanceReport() {
  const fence = String.fromCharCode(96, 96, 96);
  return `\n\n${fence}acceptance-report\n${JSON.stringify({
    criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "Reported steer arrival." }],
    changedFiles: [], testsAddedOrUpdated: [],
    commandsRun: [{ command: "steer insertion fixture", result: "passed", summary: "Reported steer arrival." }],
    validationOutput: ["steer insertion fixture"], residualRisks: [], noStagedFiles: true,
    diffSummary: "No files changed.",
  })}\n${fence}`;
}

function providerSource(contract) {
  return `
    import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
    const contract = ${JSON.stringify(contract)};
    const childReport = ${JSON.stringify(childAcceptanceReport())};
    function text(message) {
      return typeof message?.content === "string" ? message.content
        : message?.content?.filter((part) => part?.type === "text").map((part) => part.text).join("\\n") ?? "";
    }
    export default function (pi) {
      let ordinal = 0;
      pi.registerProvider("fake", {
        baseUrl: "http://127.0.0.1:9", api: "fake", apiKey: "not-used",
        models: [{ id: "deterministic", name: "Deterministic", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 256 }],
        streamSimple(model, context) {
          const stream = createAssistantMessageEventStream();
          const messages = context?.messages ?? [];
          const allText = messages.map(text).join("\\n");
          const users = messages.filter((m) => m?.role === "user").map(text);
          const lastUser = users.at(-1) ?? "";
          const toolResults = messages.filter((m) => m?.role === "toolResult");
          const subagentResults = toolResults.filter((m) => m.toolName === "subagent_start");
          let tool; let output;
          if (allText.includes(${JSON.stringify(STEER_MARKER)})) {
            // child：上下文中已出现 steer 注入文本 → 回显收到。
            output = ${JSON.stringify(CHILD_RECEIVED)} + childReport;
          } else if (lastUser.includes(${JSON.stringify(CHILD_OBJECTIVE_MARKER)}) && toolResults.length === 0) {
            // child 第一回合：sleep 保持存活，给父侧 steer 留出运行中窗口。
            tool = { name: "bash", arguments: { command: "sleep 5" } };
          } else if (lastUser.includes(${JSON.stringify(CHILD_OBJECTIVE_MARKER)})) {
            // child 后续回合但未见 steer 文本 → 缺陷形态。
            output = ${JSON.stringify(CHILD_FALLBACK)} + childReport;
          } else if (subagentResults.length === 1 && subagentResults[0]?.details?.runId) {
            // 父第二回合：已派发一个 child 且运行中 → 主动 steer 注入标记文本。
            tool = { name: "subagent_run_steer", arguments: { runId: subagentResults[0].details.runId, message: ${JSON.stringify(STEER_MARKER)} } };
          } else if (lastUser.includes(${JSON.stringify(PARENT_PROMPT)}) && subagentResults.length === 0) {
            tool = { name: "subagent_start", arguments: contract };
          } else {
            output = "STEER_PARENT_DONE";
          }
          const toolCall = tool ? { type: "toolCall", id: "steer-insert-" + (++ordinal), name: tool.name, arguments: tool.arguments } : undefined;
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

function assistantText(record) {
  if (record.type !== "message_end" || record.message?.role !== "assistant") return "";
  return record.message.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
}

function spawnRpcHost(command, args, { cwd, env, input, timeoutMs = 300_000 }) {
  const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const records = [];
  let stdout = ""; let stderr = ""; let buffer = ""; let timedOut = false; let spawnError;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM");
    setTimeout(()=>child.kill("SIGKILL"),3000).unref(); }, timeoutMs);
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk; buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try { records.push(JSON.parse(line)); } catch {}
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", (error) => { spawnError = error; });
  const closed = new Promise((resolveClosed) => {
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolveClosed({ error: timedOut ? new Error(`Pi RPC host timed out after ${timeoutMs}ms`) : spawnError, status, signal });
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

// 递归收集 root 下所有 .jsonl 文件中包含 marker 的文件（child 会话/transcript）。
async function findJsonlContaining(root, marker) {
  const hits = [];
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.name.endsWith(".jsonl")) continue;
      try {
        const content = await readFile(full, "utf8");
        if (content.includes(marker)) hits.push(full);
      } catch {}
    }
  }
  await walk(root);
  return hits;
}

test("主动 steer 将文本插入运行中 subagent 的会话并被其消费", { skip: !piBinary, timeout: 240_000 }, async (t) => {
  assert.ok(piBinary, "PI_REAL_BIN must identify an explicitly supported Pi host used for this integration test");
  const piVersion = (await execFileAsync(piBinary, ["--version"], { encoding: "utf8" })).stdout.trim();
  assert.ok(SUPPORTED_PI_VERSIONS.includes(piVersion), `unsupported Pi host: ${piVersion}`);

  const root = await mkdtemp(join(tmpdir(), "subagent-steer-insert-"));
  const runtimeTmp = await mkdtemp(join(tmpdir(), "subagent-steer-runtime-"));
  const projectRoot = join(root, "project");
  const configRoot = join(root, "config");
  const sessionsRoot = join(root, "sessions");
  const workspacesRoot = join(root, "workspaces");
  const provider = join(root, "steer-provider.mjs");

  t.after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(runtimeTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const contract = {
    title: "Steer insertion deterministic child",
    agent: "executor",
    task: `Keep alive for the ${CHILD_OBJECTIVE_MARKER} fixture. Wait, then report whether the injected steer text arrived.`,
    writePaths: ["README.md"],
    acceptance: { criteria: ["The child reports whether the steer text arrived."] },
    cwd: projectRoot,
    worktree: false,
  };

  await mkdir(join(projectRoot, ".pi", "agents"), { recursive: true });
  await writeFile(join(projectRoot, "README.md"), "steer insertion fixture\n");
  await writeFile(join(projectRoot, ".pi", "agents", "executor.md"), `---
name: executor
description: deterministic steer insertion executor
model: fake/deterministic
tools: read, bash
extensions: ${provider}
---
Wait, then report whether the injected steer text arrived.
`);
  await execFileAsync("git", ["init", "-q"], { cwd: projectRoot });
  await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: projectRoot });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: projectRoot });
  await execFileAsync("git", ["add", "README.md", ".pi/agents/executor.md"], { cwd: projectRoot });
  await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: projectRoot });
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
  await writeFile(provider, providerSource(contract));

  const host = spawnRpcHost(piBinary, [
    "--mode", "rpc", "--no-extensions",
    "-e", provider, "-e", projectRuntime,
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
    input: JSON.stringify({ id: "steer-insert-001", type: "prompt", message: PARENT_PROMPT }),
  });

  try {
    // 等待 child 派发回执。
    let handle;
    const dispatchDeadline = Date.now() + 60_000;
    while (!handle && Date.now() < dispatchDeadline) {
      const dispatch = host.records.find((record) => record.type === "tool_execution_end" && record.toolName === "subagent_start" && record.result?.details?.runId);
      if (dispatch) handle = dispatch.result.details;
      else await delay(50);
    }
    assert.ok(handle?.runId, `typed subagent dispatch receipt is missing\n${host.diagnostics()}`);

    // 等待 steer 控制调用出现（父第二回合发起 subagent_run_steer）。
    let steerCall;
    const steerDeadline = Date.now() + 60_000;
    while (!steerCall && Date.now() < steerDeadline) {
      steerCall = host.records.find((record) => record.type === "tool_execution_start" && record.toolName === "subagent_run_steer")
        ?? host.records.find((record) => record.type === "tool_execution_end" && record.toolName === "subagent_run_steer");
      if (!steerCall) await delay(50);
    }

    // child 终态。
    const terminal = await waitForStatus(handle.asyncDir, (status) => status.state !== "running" && status.state !== "queued")
      .catch((error) => { throw new Error(`${error.message}\n${host.diagnostics()}`); });
    // 诊断：抓取 parent 侧所有 subagent 工具调用（spawn + steer）的起止与结果。
    const subagentToolRecords = host.records.filter((record) => ["subagent_start", "subagent_run_steer"].includes(record.toolName) && (record.type === "tool_execution_start" || record.type === "tool_execution_end"));
    const steerEnd = subagentToolRecords.find((record) => record.type === "tool_execution_end" && record.toolName === "subagent_run_steer");
    const steerSummary = JSON.stringify({
      childSteering: terminal.steering,
      steerIssued: Boolean(steerEnd),
      steerResult: steerEnd?.result,
      subagentCalls: subagentToolRecords.map((record) => ({ type: record.type, tool: record.toolName, isError: record.result?.isError, text: record.result?.content?.[0]?.text?.slice(0, 200), details: record.result?.details })),
    }, null, 2);
    assert.equal(terminal.state, "complete", `child terminal state\n${steerSummary}\n${host.diagnostics()}`);

    // 核心断言 1：steer 标记文本出现在 child 的会话/transcript jsonl（真正插入）。
    const hits = await findJsonlContaining(root, STEER_MARKER);
    assert.ok(hits.length > 0, `steer marker ${STEER_MARKER} was not inserted into any child session jsonl\n${steerSummary}\n${host.diagnostics()}`);

    // 核心断言 2：child 消费了注入文本并回显 RECEIVED（而非 FALLBACK）。
    const receivedHits = await findJsonlContaining(root, CHILD_RECEIVED);
    const fallbackHits = await findJsonlContaining(root, CHILD_FALLBACK);
    assert.ok(receivedHits.length > 0, `child did not consume the injected steer text (no ${CHILD_RECEIVED})\n${steerSummary}\n${host.diagnostics()}`);
    assert.equal(fallbackHits.length, 0, `child hit the no-steer fallback path (${CHILD_FALLBACK}) — steer text was not inserted\n${steerSummary}\n${host.diagnostics()}`);

    host.endInput();
    const result = await host.closed;
    assert.equal(result.error, undefined, `${result.error?.message}\n${host.diagnostics()}`);
    assert.equal(result.status, 0, host.diagnostics());
  } finally {
    host.kill();
  }
});
