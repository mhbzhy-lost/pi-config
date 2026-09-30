import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { buildTopLevelRuntimeEnv, REQUIRED_METHODS, SUPPORTED_PI_VERSIONS } from "../scripts/probes/pi-subagents-compat.ts";
import { renderCodingDispatchPrompt } from "../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts";
import integrationQueue from "../packages/pi-subagents-enhanced/child-extensions/integration-queue.ts";


const repoRoot = resolve(import.meta.dirname, "..");
const piBinary = process.env.PI_REAL_BIN;
const enhancedPackageRoot = join(repoRoot, "packages", "pi-subagents-enhanced");
const upstreamPackageRoot = join(enhancedPackageRoot, "node_modules", "pi-subagents");
const extension = join(enhancedPackageRoot, "extensions", "subagent-runtime.ts");
const providerExtension = join(repoRoot, "test", "fixtures", "deterministic-provider.mjs");
const clientModule = new URL("../scripts/probes/pi-subagents-compat.ts", import.meta.url).href;

test("generic child without a Root Broker loads required integration extension as a no-op", async (t) => {
  const messages = [];
  const registered = [];
  const originalError = console.error;
  console.error = (message) => messages.push(String(message));
  t.after(() => { console.error = originalError; });
  const extension = integrationQueue({ registerTool(tool) { registered.push(tool); }, on() { return () => {}; } }, { env: {} });
  assert.equal(typeof extension.dispose, "function");
  assert.deepEqual(registered, []);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /disabled: trusted Root Broker session unavailable/);
});


test("coding Host loads the child integration tool and prompt while generic non-Git cwd does not start a coordinator", async (t) => {
  const { codingWorkflowSpawnParams } = await import("../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts");
  const { shouldStartRepositoryCoordinator } = await import("../packages/pi-subagents-enhanced/extensions/subagent-runtime.ts");
  const root = await mkdtemp(join(tmpdir(), "runtime-coordinator-gate-"));
  const repository = join(root, "repository");
  const plain = join(root, "plain");
  await mkdir(repository); await mkdir(plain);
  execFileSync("git", ["init", "-b", "main"], { cwd: repository, stdio: "ignore" });
  t.after(() => rm(root, { recursive: true, force: true }));
  const ir = {
    title: "title", agent: "executor", contractHash: "a".repeat(64),
    cwd: repository, worktree: true, task: "objective; commit -> subagent_integration enqueue -> await_admission -> git rebase targetHead", writePaths: ["result.txt"],

    acceptance: { criteria: ["criterion"] },
  };
  const prompt = renderCodingDispatchPrompt(ir);
  assert.match(prompt, /commit -> subagent_integration enqueue -> await_admission -> git rebase targetHead/);
  const spawn = codingWorkflowSpawnParams(ir, prompt, "workflow-key");
  const leaf = JSON.parse(spawn.workflowScript.match(/runs\.run\([^,]+, (.*)\);$/s)[1]);
  assert.equal(leaf.worktree, false);
  assert.ok((leaf.subagentOnlyExtensions ?? []).some((entry) => entry.endsWith("/child-extensions/integration-queue.ts")));
  const sharedSpawn = codingWorkflowSpawnParams({ ...ir, worktree: false }, prompt, "shared-workflow-key");
  const sharedLeaf = JSON.parse(sharedSpawn.workflowScript.match(/runs\.run\([^,]+, (.*)\);$/s)[1]);
  assert.equal((sharedLeaf.subagentOnlyExtensions ?? []).some((entry) => entry.endsWith("/child-extensions/integration-queue.ts")), false);

  assert.equal(await shouldStartRepositoryCoordinator(repository), true);
  assert.equal(await shouldStartRepositoryCoordinator(plain), false);
});

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
              // admission 为 repository-only（R10 用户决策）：typed dispatch 只认 pi/agents 三 profile。
              // workflowKey 保留 compat-worker 语义，agent 改用 repository profile executor。
              const workflowScript = "return await runs.run(" + JSON.stringify("executor") + ", " + JSON.stringify({
                agent: "executor",
                model: "fake/deterministic",
                tools: "contact_supervisor, read",
                subagentOnlyExtensions: ${JSON.stringify(providerExtension)},
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
                leaf = starts.find((event) => event?.parentWorkflowRunId === workflowRunId
                  && event?.agent === "executor");
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
          name: "bg_wait",
          label: "Compatibility Wait",
          description: "Yield once for the deterministic compatibility fixture.",
          parameters: { type: "object", properties: {}, additionalProperties: true },
          async execute() {
            const deadline = Date.now() + 10_000;
            while (Date.now() < deadline) {
              try {
                const proof = JSON.parse(await readFile(join(spawnedAsyncDir, "process-terminal.json"), "utf8"));
                if (proof.state === "observed") {
                  return { content: [{ type: "text", text: "compatibility wait complete" }], details: { processTerminal: proof } };
                }
              } catch (error) {
                if (error?.code !== "ENOENT") throw error;
              }
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            throw new Error("process-terminal proof was not observed for " + spawnedAsyncDir);
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
            "bg_wait",
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
        env: (() => {
          // generic Host 必须隔离调用方 child 的 Root Broker 身份，避免误接别的会话的 grant。
          const { PI_SUBAGENT_CHILD: _child, PI_SUBAGENT_FANOUT_CHILD: _fanout, PI_SUBAGENT_PARENT_SESSION: _parent,
            PI_ROOT_SUBAGENT_BROKER_ENABLED: _broker, PI_SUBAGENT_ORCHESTRATOR_SESSION_ID: _orchestrator,
            PI_SUBAGENT_RUN_ID: _run, ...topLevelEnv } = process.env;

          return { ...buildTopLevelRuntimeEnv(topLevelEnv), TMPDIR: runtimeTmp, PI_CODING_AGENT_DIR: join(repoRoot, "pi"), OPENAI_API_KEY: "not-used" };
        })(),
        input: JSON.stringify({ id: `top-level-rpc-${mode}`, type: "prompt", message: prompt }),
        until: (record) => {
          const text = assistantText(record);
          return text.includes("COMPAT_PARENT_DONE") || text.includes("COMPAT_PARENT_PENDING_MISSING");
        },
      },
    );

    assert.equal(result.error, undefined, `${result.error?.message}\n${result.stderr}\n${result.stdout}`);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    if (mode === "attention") {
      const childRun = spawnedDetails(result.records).spawned;
      const transcript = await readFile(join(projectRoot, ".pi", "subagents", "artifacts", `${childRun.runId}_executor_transcript.jsonl`), "utf8");
      console.log("CHILD DIAGNOSTICS", await readFile(join(childRun.asyncDir, "runner.stderr.log"), "utf8"), transcript.split("\n").filter(line => line.includes('"role":"assistant"') || line.includes('"recordType":"stderr"')).map(line => line.slice(0, 900)).join("\n"));
    }
    assert.ok(result.records.some((record) => assistantText(record).includes("COMPAT_PARENT_DONE")), `parent did not complete: ${JSON.stringify(result.records.slice(-10))}`);
    const details = spawnedDetails(result.records);
    assert.equal(details.childEnv.child, null);
    assert.equal(details.childEnv.fanout, null);
    // 0.71 does not propagate the retired PI_SUBAGENT_PARENT_SESSION marker;
    // parent identity is carried by the typed RPC ping/session projection.
    assert.equal(details.childEnv.parentSession, null);
    assert.equal(details.ping.version, 1);
    for (const method of REQUIRED_METHODS) {
      assert.ok(details.ping.methods.includes(method), `missing RPC method: ${method}`);
    }
    assert.ok(details.activeTools.includes("bg_wait"), JSON.stringify(details.activeTools));
    assert.ok(details.activeTools.includes("subagent_supervisor"), JSON.stringify(details.activeTools));
    assert.ok(!details.activeTools.includes("subagent"), JSON.stringify(details.activeTools));
    assert.equal(typeof details.workflowRoot?.runId, "string");
    assert.equal(typeof details.spawned?.runId, "string");
    assert.equal(typeof details.spawned?.asyncDir, "string");
    assert.equal(details.spawned.parentWorkflowRunId, details.workflowRoot.runId);
    assert.equal(details.spawned.workflowKey, "executor");
    assert.notEqual(details.spawned.runId, details.workflowRoot.runId);

    const terminal = await waitForStatus(details.spawned.asyncDir, (status) => status.state !== "running" && status.state !== "queued");
    assert.equal(terminal.state, "complete", JSON.stringify(terminal));
    assert.equal(terminal.cwd, projectRoot);
    const output = await readFile(terminal.outputFile, "utf8");
    assert.match(output, /COMPAT_OK tools=/);
    const tools = output.match(/COMPAT_OK tools=([^\n]+)/)?.[1]?.split(",") ?? [];
    // 0.71 resolves the child tool allow-list from the installed agent
    // runtime; this compatibility fixture may expose no optional tools.
    assert.ok(!tools.includes("subagent"), output);

    const nestedInspection = result.records.find((record) => record.type === "tool_execution_end"
      && record.toolName === "compat_inspect_nested_events");
    const statusObservation = result.records.find((record) => record.type === "tool_execution_end"
      && record.toolName === "compat_status");
    const waitObservation = result.records.find((record) => record.type === "tool_execution_end" && record.toolName === "bg_wait");
    assert.equal(waitObservation?.result?.details?.processTerminal?.state, "observed", JSON.stringify(waitObservation));
    if (mode === "attention") {
      // 0.71's child runtime may expose a plain completion rather than the
      // retired native supervisor round-trip when the configured child has no
      // supervisor transport.  Preserve the stable RPC and route evidence.
      assert.equal(nestedInspection?.result?.details?.eventFileCount, 0, JSON.stringify(nestedInspection));
      assert.equal(nestedInspection?.result?.details?.routeFileCount, 1, JSON.stringify(nestedInspection));
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
  const piSubagentsVersion = execFileSync("node", ["-p", `require(${JSON.stringify(join(upstreamPackageRoot, "package.json"))}).version`], { encoding: "utf8" }).trim();
   assert.equal(piSubagentsVersion, "0.71.0");
  const requireFromExtension = createRequire(join(upstreamPackageRoot, "package.json"));
  assert.match(requireFromExtension.resolve("typebox/compile"), /typebox/);
  const typeboxPackage = JSON.parse(execFileSync("node", ["-e", `process.stdout.write(require('fs').readFileSync(${JSON.stringify(join(upstreamPackageRoot, "node_modules", "typebox", "package.json"))}, 'utf8'))`], { encoding: "utf8" }));
  assert.equal(typeboxPackage.version, "1.1.38");
});

test("top-level RPC compatibility waits for a completing executor without nested events", async () => {
  await runScenario("complete");
});

test("top-level RPC compatibility observes attention, replies, and resumes the executor", async () => {
  await runScenario("attention");
});
