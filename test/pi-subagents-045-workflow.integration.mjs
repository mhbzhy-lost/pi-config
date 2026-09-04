import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { buildTopLevelRuntimeEnv, SUPPORTED_PI_VERSIONS } from "../scripts/probes/pi-subagents-compat.ts";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const piBinary = process.env.PI_REAL_BIN;
const clientModule = new URL("../scripts/probes/pi-subagents-compat.ts", import.meta.url).href;

function assistantText(record) {
  if (record.type !== "message_end" || record.message?.role !== "assistant") return "";
  return record.message.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
}

function runRpcUntil(command, args, { cwd, env, input, timeoutMs = 60_000 }) {
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
        if (assistantText(record).includes("WORKFLOW_PARENT_DONE")) child.stdin.end();
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

function providerExtensionSource() {
  return `
    import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

    function userText(context) {
      return (context?.messages ?? []).filter((message) => message?.role === "user").at(-1)?.content
        ?.filter((part) => part?.type === "text")
        .map((part) => part.text)
        .join("\\n") ?? "";
    }

    export default function (pi) {
      let nextId = 0;
      pi.registerProvider("fake", {
        baseUrl: "http://127.0.0.1:9",
        api: "fake",
        apiKey: "not-used",
        models: [{
          id: "deterministic",
          name: "Deterministic",
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 4096,
          maxTokens: 256,
        }],
        streamSimple(model, context) {
          const stream = createAssistantMessageEventStream();
          const text = userText(context);
          const toolResults = (context?.messages ?? []).filter((message) => message?.role === "toolResult");
          const shouldCall = text.includes("WORKFLOW_PARENT_PROBE")
            && !toolResults.some((message) => message.toolName === "workflow_probe");
          const toolCall = shouldCall
            ? { type: "toolCall", id: "workflow-probe-" + (++nextId), name: "workflow_probe", arguments: {} }
            : undefined;
          const content = toolCall
            ? [toolCall]
            : [{ type: "text", text: text.includes("WORKFLOW_PARENT_PROBE") ? "WORKFLOW_PARENT_DONE" : "WORKFLOW_CHILD_DONE" }];
          const message = {
            role: "assistant",
            content,
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: toolCall ? "toolUse" : "stop",
            timestamp: Date.now(),
          };
          stream.push({ type: "start", partial: message });
          if (toolCall) {
            stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
            stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(toolCall.arguments), partial: message });
            stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
            stream.push({ type: "done", reason: "toolUse", message });
          } else {
            stream.push({ type: "text_start", contentIndex: 0, partial: message });
            stream.push({ type: "text_delta", contentIndex: 0, delta: content[0].text, partial: message });
            stream.push({ type: "text_end", contentIndex: 0, content: content[0].text, partial: message });
            stream.push({ type: "done", reason: "stop", message });
          }
          stream.end();
          return stream;
        },
      });
    }
  `;
}

function probeExtensionSource({ projectRoot }) {
  return `
    import { createSubagentsRpcClient } from ${JSON.stringify(clientModule)};

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    export default function (pi) {
      const client = createSubagentsRpcClient(pi.events, { timeoutMs: 10_000 });
      pi.registerTool({
        name: "workflow_probe",
        label: "Workflow Probe",
        description: "Probe one public workflow root and its child lifecycle event.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          const starts = [];
          const unsubscribe = pi.events.on("subagent:async-started", (event) => starts.push(event));
          try {
            const clarifyError = await client.call("spawn", {
              workflowScript: "return await runs.run('clarify-probe', { agent: 'compat-worker', task: 'WORKFLOW_CHILD_PROBE', async: true, worktree: false });",
              async: true,
              clarify: false,
            }).then(() => null, (error) => error.message);
            const root = await client.call("spawn", {
              workflowScript: "return await runs.run('typed-probe', { agent: 'compat-worker', task: 'WORKFLOW_CHILD_PROBE', async: true, worktree: false, output: false, acceptance: { level: 'checked', criteria: ['Child returns its deterministic marker.'], evidence: ['commands-run'] } });",
              cwd: ${JSON.stringify(projectRoot)},
              context: "fresh",
              async: true,
              timeoutMs: 30_000,
              artifacts: true,
              worktree: false,
              mission: false,
              chatProgress: "off",
            });
            const rootRunId = root.details?.runId ?? root.details?.asyncId;
            const deadline = Date.now() + 10_000;
            let leaf;
            while (!leaf && Date.now() < deadline) {
              leaf = starts.find((event) => event?.workflowKey === "typed-probe"
                && event?.parentWorkflowRunId === rootRunId
                && event?.agent === "compat-worker");
              if (!leaf) await wait(25);
            }
            if (!leaf) throw new Error("workflow leaf start event did not arrive for " + rootRunId);
            return {
              content: [{ type: "text", text: "workflow probe complete" }],
              details: { clarifyError, root: root.details, leaf },
            };
          } finally {
            unsubscribe?.();
          }
        },
      });
      pi.on("session_start", () => pi.setActiveTools(["workflow_probe"]));
    }
  `;
}

test("pi-subagents 0.62.0 rejects clarify and correlates a public workflow leaf", async () => {
  assert.ok(piBinary, "PI_REAL_BIN must identify an explicitly supported Pi host used for this integration test");
  const piVersion = (await execFileAsync(piBinary, ["--version"], { encoding: "utf8" })).stdout.trim();
  assert.ok(SUPPORTED_PI_VERSIONS.includes(piVersion), `unsupported Pi host: ${piVersion}`);

  const root = await mkdtemp(join(tmpdir(), "pi-subagents-045-workflow-"));
  const npmRoot = join(root, "npm");
  const projectRoot = join(root, "project");
  const configRoot = join(root, "config");
  const provider = join(root, "workflow-provider.mjs");
  const probe = join(root, "workflow-probe.mjs");
  try {
    await execFileAsync("npm", [
      "install", "--prefix", npmRoot, "--ignore-scripts", "--no-audit", "--no-fund",
      "pi-subagents@0.62.0", "typebox@1.1.38",
    ], { env: { ...process.env, NPM_CONFIG_REGISTRY: "https://registry.npmjs.org" } });
    const extension = join(npmRoot, "node_modules", "pi-subagents");
    const installed = JSON.parse(await (await import("node:fs/promises")).readFile(join(extension, "package.json"), "utf8"));
    assert.equal(installed.version, "0.62.0");

    await mkdir(join(projectRoot, ".pi", "agents"), { recursive: true });
    await mkdir(configRoot, { recursive: true });
    await writeFile(provider, providerExtensionSource());
    await writeFile(probe, probeExtensionSource({ projectRoot }));
    await writeFile(join(projectRoot, ".pi", "agents", "compat-worker.md"), `---
name: compat-worker
description: deterministic workflow compatibility worker
model: fake/deterministic
tools: read
subagentOnlyExtensions: ${JSON.stringify(provider)}
---
Return the deterministic workflow child marker.
`);

    const result = await runRpcUntil(piBinary, [
      "--mode", "rpc", "--no-session", "--no-extensions",
      "-e", provider,
      "-e", extension,
      "-e", probe,
      "--no-skills", "--no-prompt-templates", "--no-themes",
      "--provider", "fake", "--model", "fake/deterministic",
    ], {
      cwd: projectRoot,
      env: {
        ...buildTopLevelRuntimeEnv(process.env),
        PI_CODING_AGENT_DIR: configRoot,
        OPENAI_API_KEY: "not-used",
      },
      input: JSON.stringify({ id: "workflow-045-probe", type: "prompt", message: "WORKFLOW_PARENT_PROBE" }),
    });

    assert.equal(result.error, undefined, `${result.error?.message}\n${result.stderr}\n${result.stdout}`);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.ok(result.records.some((record) => assistantText(record).includes("WORKFLOW_PARENT_DONE")), result.stdout);
    const tool = result.records.find((record) => record.type === "tool_execution_end" && record.toolName === "workflow_probe");
    assert.ok(tool?.result?.details, result.stdout);
    const { clarifyError, root: workflowRoot, leaf } = tool.result.details;
    assert.match(clarifyError, /does not support clarify UI/);
    assert.equal(typeof workflowRoot.runId, "string");
    assert.equal(leaf.parentWorkflowRunId, workflowRoot.runId);
    assert.equal(leaf.workflowKey, "typed-probe");
    assert.equal(leaf.agent, "compat-worker");
    assert.equal(typeof (leaf.runId ?? leaf.id), "string");
    assert.equal(typeof leaf.asyncDir, "string");
    assert.notEqual(leaf.runId ?? leaf.id, workflowRoot.runId);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
