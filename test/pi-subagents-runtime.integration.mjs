import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { buildTopLevelRuntimeEnv, REQUIRED_METHODS, SUPPORTED_PI_VERSIONS } from "../scripts/probes/pi-subagents-compat.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const piBinary = process.env.PI_REAL_BIN;
const extension = join(repoRoot, "pi", "npm", "node_modules", "pi-subagents");
const providerExtension = join(repoRoot, "test", "fixtures", "deterministic-provider.mjs");
const clientModule = new URL("../scripts/probes/pi-subagents-compat.mjs", import.meta.url).href;

function runRpcUntil(command, args, { input, until, timeoutMs = 60_000, ...options }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    const records = [];
    let stdout = "";
    let stderr = "";
    let buffer = "";
    let matched = false;
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
        if (!matched && until(record, records)) {
          matched = true;
          child.stdin.end();
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (status, signal) => {
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

async function waitForStatus(asyncDir, predicate, { timeoutMs = 30_000 } = {}) {
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

function assistantText(record) {
  if (record.type !== "message_end" || record.message?.role !== "assistant") return "";
  return record.message.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
}

function spawnedDetails(records) {
  const event = records.find((record) => record.type === "tool_execution_end" && record.toolName === "compat_spawn");
  assert.ok(event, "compat_spawn tool result is missing");
  assert.ok(event.result?.details, `compat_spawn details are missing: ${JSON.stringify(event)}`);
  assert.ok(event.result.details.childEnv, `compat_spawn failed: ${JSON.stringify(event)}`);
  return event.result.details;
}

async function runScenario(mode) {
  const packageRoot = await mkdtemp(join(tmpdir(), "pi-subagents-top-level-probe-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "pi-subagents-top-level-project-"));
  const runtimeTmp = await mkdtemp(join(tmpdir(), "pi-subagents-top-level-runtime-"));
  const probe = join(packageRoot, "top-level-rpc-probe.mjs");
  const outputPath = join(projectRoot, `${mode}-output.txt`);

  try {
    await mkdir(join(projectRoot, ".pi", "agents"), { recursive: true });
    await writeFile(join(projectRoot, ".pi", "agents", "compat-worker.md"), `---
name: compat-worker
description: deterministic top-level RPC compatibility worker
model: fake/deterministic
tools: contact_supervisor, read
extensions: ""
subagentOnlyExtensions: ${providerExtension}
---
Use the deterministic compatibility marker from the assigned task.
`);
    await writeFile(probe, `
      import { readFile, readdir } from "node:fs/promises";
      import { join } from "node:path";
      import { createSubagentsRpcClient } from ${JSON.stringify(clientModule)};
      const schema = {
        type: "object",
        properties: { mode: { type: "string", enum: ["complete", "attention"] } },
        required: ["mode"],
        additionalProperties: false,
      };
      export default function (pi) {
        const client = createSubagentsRpcClient(pi.events, { timeoutMs: 10000 });
        let spawnedAsyncDir;
        let spawnedRunId;
        pi.registerTool({
          name: "compat_spawn",
          label: "Compatibility Spawn",
          description: "Spawn one authorized compatibility executor through stable RPC.",
          parameters: schema,
          async execute(_id, params) {
            const ping = await client.call("ping");
            const starts = [];
            const unsubscribe = pi.events.on("subagent:async-started", (event) => starts.push(event));
            try {
              const task = params.mode === "attention"
                ? "PI_SUBAGENTS_COMPAT_CHILD_ATTENTION"
                : "PI_SUBAGENTS_COMPAT_CHILD_COMPLETE";
              const workflowScript = "return await runs.run(" + JSON.stringify("compat-worker") + ", " + JSON.stringify({
                agent: "compat-worker",
                task,
                async: true,
                worktree: false,
                acceptance: false,
              }) + ");";
              const spawned = await client.call("spawn", {
                workflowScript,
                cwd: ${JSON.stringify(projectRoot)},
                context: "fresh",
                worktree: false,
                async: true,
                artifacts: true,
                output: ${JSON.stringify(outputPath)},
                outputMode: "file-only",
                mission: false,
                chatProgress: "off",
              });
              const workflowRunId = spawned.details?.runId ?? spawned.details?.asyncId;
              const deadline = Date.now() + 10_000;
              let leaf;
              while (!leaf && Date.now() < deadline) {
                leaf = starts.find((event) => event?.workflowKey === "compat-worker"
                  && event?.parentWorkflowRunId === workflowRunId
                  && event?.agent === "compat-worker");
                if (!leaf) await new Promise((resolve) => setTimeout(resolve, 25));
              }
              if (!leaf) throw new Error("workflow leaf start event did not arrive for " + workflowRunId);
              spawnedAsyncDir = leaf.asyncDir;
              spawnedRunId = leaf.runId ?? leaf.id;
              return {
                content: [{ type: "text", text: "compat executor dispatched" }],
                details: {
                  ping,
                  workflowRoot: spawned.details,
                  spawned: { ...leaf, runId: spawnedRunId, asyncDir: spawnedAsyncDir },
                  childEnv: {
                    child: process.env.PI_SUBAGENT_CHILD ?? null,
                    fanout: process.env.PI_SUBAGENT_FANOUT_CHILD ?? null,
                    parentSession: process.env.PI_SUBAGENT_PARENT_SESSION ?? null,
                  },
                  activeTools: [...pi.getActiveTools()].sort(),
                },
              };
            } finally {
              unsubscribe?.();
            }
          },
        });
        pi.registerTool({
          name: "compat_status",
          label: "Compatibility Status",
          description: "Observe the active executor through stable RPC status.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          async execute() {
            const deadline = Date.now() + 3000;
            let lastError;
            let rpcStatusFound = false;
            while (Date.now() < deadline) {
              try {
                const status = await client.call("status", { runId: spawnedRunId });
                rpcStatusFound = status.text?.includes("Run: " + spawnedRunId)
                  && status.text?.includes("State: running");
              } catch (error) {
                lastError = error;
              }
              try {
                const status = JSON.parse(await readFile(join(spawnedAsyncDir, "status.json"), "utf8"));
                if (rpcStatusFound && (status.currentTool === "contact_supervisor" || status.steps?.some((step) => step.currentTool === "contact_supervisor"))) {
                  return {
                    content: [{ type: "text", text: "contact_supervisor observed" }],
                    details: { currentTool: "contact_supervisor", rpcStatusFound: true, source: "rpc+status-artifact", status },
                  };
                }
              } catch {}
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            throw new Error("attention executor did not enter contact_supervisor at " + spawnedAsyncDir + ": " + (lastError?.message ?? "status never matched"));
          },
        });
        pi.registerTool({
          name: "compat_pause",
          label: "Compatibility Pause",
          description: "Yield once for the native Supervisor channel poller.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          async execute() {
            await new Promise((resolve) => setTimeout(resolve, 600));
            return { content: [{ type: "text", text: "paused" }] };
          },
        });
        pi.registerTool({
          name: "compat_inspect_nested_events",
          label: "Inspect Nested Events",
          description: "Count nested route metadata and event files while the executor is active.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          async execute() {
            const root = ${JSON.stringify(join(runtimeTmp, `pi-subagents-uid-${process.getuid()}`, "nested-subagent-events"))};
            const files = [];
            const visit = async (dir) => {
              let entries;
              try { entries = await readdir(dir, { withFileTypes: true }); }
              catch (error) { if (error?.code === "ENOENT") return; throw error; }
              for (const entry of entries) {
                const child = join(dir, entry.name);
                if (entry.isDirectory()) await visit(child);
                else files.push(child);
              }
            };
            await visit(root);
            const separator = ${JSON.stringify("/")};
            return {
              content: [{ type: "text", text: "nested events inspected" }],
              details: {
                eventFileCount: files.filter((file) => file.includes(separator + "events" + separator)).length,
                routeFileCount: files.filter((file) => file.endsWith(separator + "route.json")).length,
              },
            };
          },
        });
        pi.on("session_start", () => {
          pi.setActiveTools([...new Set([
            ...pi.getActiveTools().filter((name) => name !== "subagent"),
            "compat_spawn",
            "compat_status",
            "compat_inspect_nested_events",
            "compat_pause",
            "subagent_wait",
            "subagent_supervisor",
          ])]);
        });
        pi.on("tool_call", (event) => event.toolName === "subagent"
          ? { block: true, reason: "top-level RPC compatibility probe cannot call subagent directly." }
          : undefined);
      }
    `);

    const prompt = mode === "attention"
      ? "PI_SUBAGENTS_COMPAT_PARENT_ATTENTION"
      : "PI_SUBAGENTS_COMPAT_PARENT_COMPLETE";
    const result = await runRpcUntil(
      piBinary,
      [
        "--mode", "rpc", "--no-session", "--no-extensions",
        "-e", providerExtension,
        "-e", extension,
        "-e", probe,
        "--no-skills", "--no-prompt-templates", "--no-themes",
        "--provider", "fake", "--model", "fake/deterministic",
      ],
      {
        cwd: projectRoot,
        env: {
          ...buildTopLevelRuntimeEnv(process.env),
          TMPDIR: runtimeTmp,
          PI_CODING_AGENT_DIR: join(repoRoot, "pi"),
          OPENAI_API_KEY: "not-used",
        },
        input: JSON.stringify({ id: `top-level-rpc-${mode}`, type: "prompt", message: prompt }),
        until: (record) => {
          const text = assistantText(record);
          return text.includes("COMPAT_PARENT_DONE") || text.includes("COMPAT_PARENT_PENDING_MISSING");
        },
      },
    );

    assert.equal(result.error, undefined, `${result.error?.message}\n${result.stderr}\n${result.stdout}`);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.ok(result.records.some((record) => assistantText(record).includes("COMPAT_PARENT_DONE")), `parent did not complete: ${JSON.stringify(result.records.slice(-10))}`);
    const details = spawnedDetails(result.records);
    assert.equal(details.childEnv.child, null);
    assert.equal(details.childEnv.fanout, null);
    assert.equal(details.childEnv.parentSession, details.ping.session.sessionId);
    assert.notEqual(details.childEnv.parentSession, process.env.PI_SUBAGENT_PARENT_SESSION);
    assert.equal(details.ping.version, 1);
    for (const method of REQUIRED_METHODS) {
      assert.ok(details.ping.methods.includes(method), `missing RPC method: ${method}`);
    }
    assert.ok(details.activeTools.includes("subagent_wait"), JSON.stringify(details.activeTools));
    assert.ok(details.activeTools.includes("subagent_supervisor"), JSON.stringify(details.activeTools));
    assert.ok(!details.activeTools.includes("subagent"), JSON.stringify(details.activeTools));
    assert.equal(typeof details.workflowRoot?.runId, "string");
    assert.equal(typeof details.spawned?.runId, "string");
    assert.equal(typeof details.spawned?.asyncDir, "string");
    assert.equal(details.spawned.parentWorkflowRunId, details.workflowRoot.runId);
    assert.equal(details.spawned.workflowKey, "compat-worker");
    assert.notEqual(details.spawned.runId, details.workflowRoot.runId);

    const terminal = await waitForStatus(details.spawned.asyncDir, (status) => status.state !== "running" && status.state !== "queued");
    assert.equal(terminal.state, "complete", JSON.stringify(terminal));
    assert.equal(terminal.cwd, projectRoot);
    const output = await readFile(terminal.outputFile, "utf8");
    assert.match(output, /COMPAT_OK tools=/);
    const tools = output.match(/COMPAT_OK tools=([^\n]+)/)?.[1]?.split(",") ?? [];
    assert.ok(tools.includes("contact_supervisor"), output);
    assert.ok(!tools.includes("subagent"), output);

    const nestedInspection = result.records.find((record) => record.type === "tool_execution_end"
      && record.toolName === "compat_inspect_nested_events");
    const statusObservation = result.records.find((record) => record.type === "tool_execution_end"
      && record.toolName === "compat_status");
    if (mode === "attention") {
      assert.equal(statusObservation?.result?.details?.currentTool, "contact_supervisor", JSON.stringify(statusObservation));
      assert.equal(statusObservation?.result?.details?.rpcStatusFound, true, JSON.stringify(statusObservation));
      assert.equal(statusObservation?.result?.details?.source, "rpc+status-artifact", JSON.stringify(statusObservation));
      assert.equal(nestedInspection?.result?.details?.eventFileCount, 0, JSON.stringify(nestedInspection));
      assert.equal(nestedInspection?.result?.details?.routeFileCount, 1, JSON.stringify(nestedInspection));
      assert.ok(result.records.some((record) => record.type === "tool_execution_end"
        && record.toolName === "subagent_supervisor"
        && record.result?.details?.replyTo), "supervisor reply evidence is missing");
      assert.ok(result.records.some((record) => record.type === "tool_execution_end" && record.toolName === "subagent_wait"));
    } else {
      assert.ok(result.records.some((record) => record.type === "tool_execution_end" && record.toolName === "subagent_wait"));
    }

    return { terminal, details };
  } finally {
    await rm(packageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(runtimeTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

test("installed runtime resolves a supported Pi and exact dependency versions", () => {
  assert.ok(piBinary, "PI_REAL_BIN must point to an explicitly supported Pi runtime");
  const piVersion = execFileSync(piBinary, ["--version"], { encoding: "utf8" }).trim();
  assert.ok(SUPPORTED_PI_VERSIONS.includes(piVersion), `unsupported Pi version: ${piVersion}`);
  const piSubagentsVersion = execFileSync("node", ["-p", `require(${JSON.stringify(join(extension, "package.json"))}).version`], { encoding: "utf8" }).trim();
  assert.equal(piSubagentsVersion, "0.45.2");
  const requireFromExtension = createRequire(join(extension, "package.json"));
  assert.match(requireFromExtension.resolve("typebox/compile"), /typebox/);
  const typeboxPackage = JSON.parse(execFileSync("node", ["-e", `process.stdout.write(require('fs').readFileSync(${JSON.stringify(join(repoRoot, "pi", "npm", "node_modules", "typebox", "package.json"))}, 'utf8'))`], { encoding: "utf8" }));
  assert.equal(typeboxPackage.version, "1.1.38");
});

test("top-level RPC compatibility waits for a completing executor without nested events", async () => {
  await runScenario("complete");
});

test("top-level RPC compatibility observes attention, replies, and resumes the executor", async () => {
  await runScenario("attention");
});
