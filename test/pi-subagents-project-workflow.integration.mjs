import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { copyFile, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { buildTopLevelRuntimeEnv, SUPPORTED_PI_VERSIONS } from "../scripts/probes/pi-subagents-compat.ts";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const piBinary = process.env.PI_REAL_BIN;
const projectRuntime = join(repoRoot, "packages", "pi-subagents-enhanced", "extensions", "subagent-runtime.ts");
const brokerRegistryUrl = new URL("../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-registry.ts", import.meta.url).href;

export function withoutSubagentEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("PI_SUBAGENT_") && !name.startsWith("PI_SESSION_") && ![
    "PI_ROOT_SUBAGENT_BROKER_ENABLED", "PI_MODEL", "PI_PROVIDER", "PI_CODING_AGENT_SESSION_DIR", "PI_CODING_WORKSPACE_DIR", "PI_CODING_GOAL_DIR",
  ].includes(name)));
}

function assistantText(record) {
  if (record.type !== "message_end" || record.message?.role !== "assistant") return "";
  return record.message.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
}

export function runRpcUntil(command, args, { cwd, env, input, timeoutMs = 60_000 }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const records = [];
    let stdout = "";
    let stderr = "";
    let buffer = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
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
        const record = JSON.parse(line);
        records.push(record);
        if (assistantText(record).includes("PROJECT_TYPED_PARENT_DONE")) child.stdin.end();
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolvePromise({
        error: timedOut ? new Error(`Pi RPC timed out after ${timeoutMs}ms`) : undefined,
        status,
        signal,
        stdout,
        stderr,
        records,
      });
    });
    child.stdin.write(`${input}\n`);
  });
}

export function providerSource(contract) {
  return `
    import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
    const contract = ${JSON.stringify(contract)};
    const contracts = Array.isArray(contract) ? contract : [contract];
    function text(context) {
      return (context?.messages ?? []).filter((message) => message?.role === "user").at(-1)?.content
        ?.filter((part) => part?.type === "text")
        .map((part) => part.text)
        .join("\\n") ?? "";
    }
    export default function (pi) {
      let ordinal = 0;
      let projectStep = 0;
      let childStep = 0;
      let probeIssued = false;
      const deterministicProvider = {
        baseUrl: "http://127.0.0.1:9", api: "fake", apiKey: "not-used",
        models: [{ id: "deterministic", name: "Deterministic", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 256 }],
        streamSimple(model, context) {
          const stream = createAssistantMessageEventStream();
          const user = text(context);
          const results = (context?.messages ?? []).filter((message) => message?.role === "toolResult");
          const dispatch = results.find((message) => message.toolName === "subagent");
          const probe = results.find((message) => message.toolName === "compat_project_probe");
          let tool;
          let output;
          if (process.env.PI_SUBAGENT_CHILD === "1") {
            if (contract.worktree && childStep++ === 0) {
              tool = { name: "bash", arguments: { command: "printf '\\nPROJECT_TYPED_CHILD_COMMIT\\n' >> README.md && git add README.md && git commit -m child-marker" } };
            } else output = "PROJECT_TYPED_CHILD_DONE\\n\\n" + String.fromCharCode(96,96,96) + "acceptance-report\\n" + JSON.stringify({
              criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "Committed PROJECT_TYPED_CHILD_COMMIT to README.md." }],
              changedFiles: ["README.md"],
              testsAddedOrUpdated: [],
              commandsRun: [{ command: "git commit README.md", result: "passed", summary: "Child committed the marker." }],
              validationOutput: ["PROJECT_TYPED_CHILD_COMMIT"],
              residualRisks: [],
              noStagedFiles: true,
              diffSummary: "README.md marker commit.",
            }) + "\\n" + String.fromCharCode(96,96,96);
          } else if (Array.isArray(contract) && (user.includes("PROJECT_TYPED_PARENT") || projectStep > 0)) {
            if (projectStep < contracts.length) tool = { name: "subagent", arguments: contracts[projectStep++] };
            else if (projectStep === contracts.length) { projectStep += 1; tool = { name: "compat_project_probe", arguments: {} }; }
            else output = "PROJECT_TYPED_PARENT_DONE";
          } else if (user.includes("PROJECT_TYPED_PARENT") || projectStep > 0) {
            if (projectStep++ === 0) tool = { name: "subagent", arguments: contract };
            else if (projectStep === 2) { projectStep += 1; probeIssued = true; tool = { name: "compat_project_probe", arguments: {} }; }
            else if (contract.worktree && !probeIssued) { probeIssued = true; tool = { name: "compat_project_probe", arguments: {} }; }
            else output = "PROJECT_TYPED_PARENT_DONE";
          } else {
            output = ${JSON.stringify(`PROJECT_TYPED_CHILD_DONE

\`\`\`acceptance-report
${JSON.stringify({
  criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "Returned PROJECT_TYPED_CHILD_DONE." }],
  changedFiles: [],
  testsAddedOrUpdated: [],
  commandsRun: [{ command: "deterministic child marker", result: "passed", summary: "Returned PROJECT_TYPED_CHILD_DONE." }],
  validationOutput: ["PROJECT_TYPED_CHILD_DONE"],
  residualRisks: [],
  noStagedFiles: true,
  diffSummary: "No files changed by integration fixture.",
})}
\`\`\``)};
          }
          const toolCall = tool ? { type: "toolCall", id: "project-workflow-" + (++ordinal), name: tool.name, arguments: tool.arguments } : undefined;
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
      };
      pi.registerProvider("fake", deterministicProvider);
      pi.registerProvider("openai-codex", {
        ...deterministicProvider,
        models: [{ id: "gpt-5.6-luna", name: "Hermetic Luna", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 256 }],
      });
    }
  `;
}

export function dispatchProbeSource() {
  return `
    import { requireRootBroker } from ${JSON.stringify(brokerRegistryUrl)};
    export default function (pi) {
      const starts = [];
      const completions = [];
      const executionEnds = [];
      const completionWaiters = new Set();
      let rootSessionId;
      function observeCompletion(event) {
        completions.push(event);
        for (const waiter of completionWaiters) {
          if (event?.runId === waiter.runId) waiter.resolve(event);
        }
      }
      function waitForCompletion(runId) {
        const cached = completions.find((event) => event?.runId === runId);
        if (cached) return Promise.resolve(cached);
        return new Promise((resolve, reject) => {
          const waiter = {
            runId,
            resolve(event) {
              clearTimeout(timer);
              completionWaiters.delete(waiter);
              resolve(event);
            },
          };
          const timer = setTimeout(() => {
            completionWaiters.delete(waiter);
            reject(new Error("matching subagent completion timed out after 30000ms: " + runId));
          }, 30_000);
          completionWaiters.add(waiter);
          const early = completions.find((event) => event?.runId === runId);
          if (early) waiter.resolve(early);
        });
      }
      pi.on("session_start", (_event, ctx) => {
        rootSessionId = ctx.sessionManager.getSessionId();
      });
      pi.events.on("subagent:async-started", (event) => starts.push(event));
      pi.events.on("subagent:async-complete", observeCompletion);
      pi.on("tool_execution_end", (event) => executionEnds.push(event));
      pi.registerTool({
        name: "compat_project_probe",
        label: "Project Workflow Probe",
        description: "Return observed public-tool lifecycle facts.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          const dispatches = executionEnds.filter((event) => event?.toolName === "subagent");
          const handles = dispatches.map((event) => event?.result?.details).filter((handle) => handle?.runId);
          if (handles.length === 0) throw new Error("public subagent handle did not include runId: " + JSON.stringify(dispatches));
          const terminal = await Promise.all(handles.map(async (handle) => {
            const completion = await waitForCompletion(handle.runId);
            let proof;
            for (let attempt = 0; attempt < 300; attempt++) {
              proof = requireRootBroker(pi, rootSessionId).inspectExecutionProof(handle.runId);
              if (proof?.terminal) break;
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            return { handle, completion, proof };
          }));
          return { content: [{ type: "text", text: "project workflow probe complete" }], details: { starts, completions, completion: terminal[0].completion, executionEnds: executionEnds.map((event) => ({ toolName: event?.toolName })), proof: terminal[0].proof, terminal } };
        },
      });
      pi.on("session_start", () => pi.setActiveTools(["subagent", "compat_project_probe"]));
    }
  `;
}

test("project typed worktree commit completes Auto Integration and release", { skip: !piBinary }, async () => {

  assert.ok(piBinary, "PI_REAL_BIN must identify an explicitly supported Pi host used for this integration test");
  const piVersion = (await execFileAsync(piBinary, ["--version"], { encoding: "utf8" })).stdout.trim();
  assert.ok(SUPPORTED_PI_VERSIONS.includes(piVersion), `unsupported Pi host: ${piVersion}`);

  const root = await mkdtemp(join(tmpdir(), "pi-subagents-project-workflow-"));
  const projectRoot = join(root, "project");
  const configRoot = join(root, "config");
  const provider = join(root, "typed-provider.mjs");
  const dispatchProbe = join(root, "dispatch-probe.mjs");
  try {
    const contract = {
      title: "Run real workflow leaf",
      agent: "executor",
      task: "Commit the child marker to README.md through the managed worktree. Use the project-owned typed facade. Only modify README.md. Known fact: pi-subagents is pinned to 0.71.0. Bind only the leaf run. Do not create a worktree.",
      writePaths: ["README.md"],
      acceptance: { criteria: ["The child returns the deterministic marker."] },
      cwd: projectRoot,
      worktree: true,

    };
    await mkdir(join(projectRoot, ".pi", "agents"), { recursive: true });
    await writeFile(join(projectRoot, "README.md"), "temporary real-host fixture\n");
    await writeFile(join(projectRoot, ".pi", "agents", "executor.md"), `---
name: executor
description: deterministic typed workflow executor
model: fake/deterministic
tools: read, bash
extensions: ${provider}
---
Return the deterministic child marker without modifying files.
`);
    await execFileAsync("git", ["init", "-q"], { cwd: projectRoot });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: projectRoot });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: projectRoot });
    await execFileAsync("git", ["add", "README.md", ".pi/agents/executor.md"], { cwd: projectRoot });
    await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: projectRoot });
    await mkdir(configRoot, { recursive: true });
    // 生产接线要求 PI_CODING_AGENT_DIR/agents 存在 delegate/executor/reviewer 三个内置
    // profile（registerBuiltinAgentsViaEvents 在扩展加载期读取）。
    await mkdir(join(configRoot, "agents"), { recursive: true });
    for (const name of ["delegate", "executor", "reviewer"]) {
      await copyFile(join(repoRoot, "pi", "agents", `${name}.md`), join(configRoot, "agents", `${name}.md`));
    }
    await writeFile(join(configRoot, "agents", "executor.md"), `---
name: executor
description: deterministic typed workflow executor
model: fake/deterministic
tools: read, bash
extensions: ${provider}
---
Return the deterministic child marker without modifying files.
`);
    await writeFile(provider, providerSource(contract));
    await writeFile(dispatchProbe, dispatchProbeSource());

    const result = await runRpcUntil(piBinary, [
      "--mode", "rpc", "--no-extensions",
      "-e", provider,
      "-e", projectRuntime,
      "-e", dispatchProbe,
      "--no-skills", "--no-prompt-templates", "--no-themes",
      "--provider", "fake", "--model", "fake/deterministic",
    ], {
      cwd: projectRoot,
      env: {
        ...buildTopLevelRuntimeEnv(withoutSubagentEnvironment(process.env)),
        PI_CODING_AGENT_DIR: configRoot,
        PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
        PI_SESSION_OWNER_REGISTRY: join(root, "registry"),
        PI_CODING_WORKSPACE_DIR: join(root, "workspaces"),
        PI_CODING_GOAL_DIR: join(root, "goals"),
        OPENAI_API_KEY: "not-used",
      },
      input: JSON.stringify({ id: "project-workflow-045", type: "prompt", message: "PROJECT_TYPED_PARENT" }),
    });

    assert.equal(result.error, undefined, `${result.error?.message}\n${result.stderr}\n${result.stdout}`);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.ok(result.records.some((record) => assistantText(record).includes("PROJECT_TYPED_PARENT_DONE")), result.stdout);
    const dispatch = result.records.find((record) => record.type === "tool_execution_end" && record.toolName === "subagent");
    const probe = result.records.find((record) => record.type === "tool_execution_end" && record.toolName === "compat_project_probe");
    assert.ok(dispatch?.result?.details, result.stdout);
    assert.ok(probe?.result?.details, result.stdout);
    assert.equal(dispatch.result.isError, false, JSON.stringify(dispatch));
    const handle = dispatch.result.details;
    const proof = probe.result.details.proof;
    assert.equal(typeof handle?.runId, "string");
    assert.equal(typeof handle?.asyncDir, "string");
    assert.equal(typeof handle?.workspace_id, "string");
    assert.equal(typeof handle?.dispatch_cwd, "string");
    assert.notEqual(handle.dispatch_cwd, projectRoot);
    assert.equal(handle.dispatch_cwd.startsWith(`${join(await realpath(root), "workspaces")}/`), true);
    assert.equal(proof?.binding?.runId, handle.runId);
    assert.equal(proof.binding.asyncDir, handle.asyncDir);
    assert.equal(proof.binding.agentProfile, "executor");
    assert.ok(proof.terminal?.proof?.instances.length > 0, JSON.stringify(proof));

    const disposition = result.records.filter((record) => record.type === "tool_execution_end" && record.toolName === "subagent").at(-1);
    assert.equal(disposition.result.isError, false, JSON.stringify(disposition));
    assert.equal(probe.result.details.starts.some((event) => (event?.runId ?? event?.id) === handle.runId && event?.asyncDir === handle.asyncDir), true);
    assert.equal(probe.result.details.completion?.runId, handle.runId);
    assert.equal(probe.result.details.completions.some((event) => event?.runId === handle.runId), true);
    assert.equal(probe.result.details.executionEnds.some((event) => event?.toolName === "subagent"), true);

    const terminal = JSON.parse(await readFile(join(handle.asyncDir, "status.json"), "utf8"));
    assert.equal(terminal.state, "complete", JSON.stringify(terminal));
    assert.equal(terminal.runId, handle.runId);
    const managedReadme = await readFile(join(handle.dispatch_cwd, "README.md"), "utf8");
    assert.match(managedReadme, /PROJECT_TYPED_CHILD_COMMIT/);
    const managedStatus = (await execFileAsync("git", ["status", "--porcelain"], { cwd: handle.dispatch_cwd, encoding: "utf8" })).stdout;
    assert.equal(managedStatus, "", `managed workspace must be clean: ${managedStatus}`);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("non-Goal executor ignores a hostile legacy .pi-subagents tree", { skip: !piBinary }, async () => {
  assert.ok(piBinary, "PI_REAL_BIN must identify an explicitly supported Pi host used for this integration test");
  const piVersion = (await execFileAsync(piBinary, ["--version"], { encoding: "utf8" })).stdout.trim();
  assert.ok(SUPPORTED_PI_VERSIONS.includes(piVersion), `unsupported Pi host: ${piVersion}`);

  const root = await mkdtemp(join(tmpdir(), "pi-subagents-hostile-legacy-"));
  const projectRoot = join(root, "project");
  const configRoot = join(root, "config");
  const provider = join(root, "typed-provider.mjs");
  const dispatchProbe = join(root, "dispatch-probe.mjs");
  try {
    const contract = {
      title: "Ignore hostile legacy runtime entries",
      agent: "executor",
      task: "Return the deterministic PROJECT_TYPED_CHILD marker. Use package-owned child extensions. The workspace contains hostile legacy entries; do not inspect or change those entries. Do not modify files or create a worktree.",
      writePaths: ["README.md"],
      acceptance: { criteria: ["The child returns the deterministic marker."] },
      cwd: projectRoot,
      worktree: false,

    };
    await mkdir(join(projectRoot, ".pi", "agents"), { recursive: true });
    await writeFile(join(projectRoot, "README.md"), "temporary hostile legacy fixture\n");
    await writeFile(join(projectRoot, ".pi", "agents", "executor.md"), `---
name: executor
description: deterministic hostile legacy executor
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
    await mkdir(configRoot, { recursive: true });
    // 生产接线要求 PI_CODING_AGENT_DIR/agents 存在 delegate/executor/reviewer 三个内置
    // profile（registerBuiltinAgentsViaEvents 在扩展加载期读取）。
    await mkdir(join(configRoot, "agents"), { recursive: true });
    for (const name of ["delegate", "executor", "reviewer"]) {
      await copyFile(join(repoRoot, "pi", "agents", `${name}.md`), join(configRoot, "agents", `${name}.md`));
    }

    const runtimeEntries = join(projectRoot, ".pi-subagents");
    await mkdir(runtimeEntries, { recursive: true, mode: 0o700 });
    await writeFile(join(runtimeEntries, "root-session-owner-entry.mjs"), "hostile root entry\n", { mode: 0o600 });
    await mkdir(join(runtimeEntries, "acceptance-evidence-entry.mjs"));
    await writeFile(join(runtimeEntries, "unrelated.bin"), Buffer.from([0, 255, 1, 254]), { mode: 0o600 });
    const identity = (stat) => Object.fromEntries(["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].map((key) => [key, stat[key]]));
    const legacySnapshot = async () => ({
      names: (await readdir(runtimeEntries)).sort(),
      root: { bytes: await readFile(join(runtimeEntries, "root-session-owner-entry.mjs"), "hex"), stat: identity(await lstat(join(runtimeEntries, "root-session-owner-entry.mjs"), { bigint: true })) },
      acceptance: identity(await lstat(join(runtimeEntries, "acceptance-evidence-entry.mjs"), { bigint: true })),
      unrelated: { bytes: await readFile(join(runtimeEntries, "unrelated.bin"), "hex"), stat: identity(await lstat(join(runtimeEntries, "unrelated.bin"), { bigint: true })) },
    });
    const beforeLegacy = await legacySnapshot();
    await writeFile(provider, providerSource(contract));
    await writeFile(dispatchProbe, dispatchProbeSource());

    const result = await runRpcUntil(piBinary, [
      "--mode", "rpc", "--no-extensions",
      "-e", provider,
      "-e", projectRuntime,
      "-e", dispatchProbe,
      "--no-skills", "--no-prompt-templates", "--no-themes",
      "--provider", "fake", "--model", "fake/deterministic",
    ], {
      cwd: projectRoot,
      env: {
        ...buildTopLevelRuntimeEnv(withoutSubagentEnvironment(process.env)),
        PI_CODING_AGENT_DIR: configRoot,
        PI_CODING_WORKSPACE_DIR: join(root, "workspaces"),
        OPENAI_API_KEY: "not-used",
      },
      input: JSON.stringify({ id: "hostile-legacy-001", type: "prompt", message: "PROJECT_TYPED_PARENT" }),
    });

    assert.equal(result.error, undefined, `${result.error?.message}\n${result.stderr}\n${result.stdout}`);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const dispatch = result.records.find((record) => record.type === "tool_execution_end" && record.toolName === "subagent");
    assert.equal(dispatch?.result?.isError, false, JSON.stringify(dispatch));
    assert.equal(typeof dispatch?.result?.details?.runId, "string");
    assert.equal(typeof dispatch?.result?.details?.asyncDir, "string");
    const terminal = JSON.parse(await readFile(join(dispatch.result.details.asyncDir, "status.json"), "utf8"));
    assert.equal(terminal.state, "complete", JSON.stringify(terminal));
    assert.deepEqual(await legacySnapshot(), beforeLegacy);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
