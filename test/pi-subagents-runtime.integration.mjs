import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const piBinary = process.env.PI_REAL_BIN;
const reportPrefix = "PI_SUBAGENTS_COMPAT_REPORT=";

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", timeout: 30000, ...options });
}

function runRpcUntil(command, args, { input, until, timeoutMs = 30000, ...options }) {
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

function parseRecords(stdout) {
  return stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function findNotification(stdout, prefix) {
  return parseRecords(stdout)
    .find((record) =>
      record.type === "extension_ui_request"
      && record.method === "notify"
      && record.message?.startsWith(prefix));
}

async function waitForStatus(asyncDir, predicate, { timeoutMs = 90000 } = {}) {
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
  let runnerError = "";
  try {
    runnerError = await readFile(join(asyncDir, "runner.stderr.log"), "utf8");
  } catch {}
  throw new Error(`timed out waiting for subagent status in ${asyncDir}; last=${JSON.stringify(lastStatus)}; runner=${runnerError.slice(-2000)}`);
}

test("outer JSONL loads compat-probe and its command uses the in-process bridge for ping", async () => {
  assert.ok(piBinary, "PI_REAL_BIN must point to Pi 0.80.6");
  assert.equal(execFileSync(piBinary, ["--version"], { encoding: "utf8" }).trim(), "0.80.6");

  const packageRoot = await mkdtemp(join(tmpdir(), "pi-subagents-compat-"));
  const extension = join(packageRoot, "node_modules", "pi-subagents");
  const probe = join(packageRoot, "compat-probe.mjs");
  const clientModule = new URL("../scripts/probes/pi-subagents-compat.mjs", import.meta.url).href;

  try {
    const install = run("npm", ["install", "--prefix", packageRoot, "--ignore-scripts", "pi-subagents@0.34.0"]);
    assert.equal(install.status, 0, install.stderr);
    assert.equal(JSON.parse(await readFile(join(extension, "package.json"), "utf8")).version, "0.34.0");

    await writeFile(probe, `
      const prefix = ${JSON.stringify(reportPrefix)};
      import { createSubagentsRpcClient } from ${JSON.stringify(clientModule)};
      export default function (pi) {
        pi.registerCommand("compat-probe", {
          description: "Probe pi-subagents RPC v1",
          handler: async (_args, ctx) => {
            const data = await createSubagentsRpcClient(pi.events).call("ping");
            ctx.ui.notify(prefix + JSON.stringify({
              piVersion: "0.80.6",
              piSubagentsVersion: "0.34.0",
              ping: true,
              version: data.version,
              methods: data.methods,
              capabilities: data.capabilities,
            }), "info");
          },
        });
      }
    `);

    const commandList = run(
      piBinary,
      ["--mode", "rpc", "--no-session", "--no-extensions", "-e", extension, "-e", probe, "--no-skills", "--no-prompt-templates", "--no-themes"],
      { cwd: repoRoot, env: { ...process.env, PI_CODING_AGENT_DIR: join(repoRoot, "pi") }, input: `${JSON.stringify({ id: "commands", type: "get_commands" })}\n` },
    );
    assert.equal(commandList.status, 0, commandList.stderr);
    const commands = parseRecords(commandList.stdout).find((record) => record.type === "response" && record.command === "get_commands");
    assert.ok(commands?.success, `missing successful get_commands response: ${commandList.stdout}`);
    assert.ok(commands.data.commands.some((command) => command.name === "compat-probe"));

    const invocation = run(
      piBinary,
      ["--mode", "rpc", "--no-session", "--no-extensions", "-e", extension, "-e", probe, "--no-skills", "--no-prompt-templates", "--no-themes", "--provider", "openai", "--model", "openai/gpt-4o"],
      {
        cwd: repoRoot,
        env: { ...process.env, PI_CODING_AGENT_DIR: join(repoRoot, "pi") },
        input: `${JSON.stringify({ id: "probe", type: "prompt", message: "/compat-probe" })}\n`,
      },
    );
    const output = `${invocation.stdout}\n${invocation.stderr}`;
    assert.equal(invocation.error, undefined, invocation.error?.message);
    assert.equal(invocation.status, 0, output.includes("OpenAI") ? "OpenAI Pi login required; run /login openai" : output);
    const notification = parseRecords(invocation.stdout)
      .flatMap((record) => record.messages ?? [record])
      .find((record) => JSON.stringify(record).includes(reportPrefix));
    assert.ok(notification, `missing ${reportPrefix} notification: ${invocation.stdout}`);
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
});

test("top-level RPC spawn writes structured lifecycle details and a status artifact", async () => {
  assert.ok(piBinary, "PI_REAL_BIN must point to Pi 0.80.6");
  const packageRoot = await mkdtemp(join(tmpdir(), "pi-subagents-compat-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "pi-subagents-project-"));
  const extension = join(packageRoot, "node_modules", "pi-subagents");
  const probe = join(packageRoot, "lifecycle-probe.mjs");
  const reportPrefix = "PI_SUBAGENTS_LIFECYCLE_REPORT=";
  const clientModule = new URL("../scripts/probes/pi-subagents-compat.mjs", import.meta.url).href;

  try {
    const install = run("npm", ["install", "--prefix", packageRoot, "--ignore-scripts", "pi-subagents@0.34.0"]);
    assert.equal(install.status, 0, install.stderr);
    await mkdir(join(projectRoot, ".pi", "agents"), { recursive: true });
    await writeFile(join(projectRoot, ".pi", "agents", "compat-worker.md"), `---
name: compat-worker
description: compatibility worker
model: openai-idealab/Qwen3.7-Max-DogFooding
tools: read
extensions: ""
---
Reply exactly: compat worker complete.
`);
    await writeFile(probe, `
      const prefix = ${JSON.stringify(reportPrefix)};
      import { createSubagentsRpcClient } from ${JSON.stringify(clientModule)};
      export default function (pi) {
        pi.registerCommand("lifecycle-probe", {
          description: "Probe pi-subagents lifecycle",
          handler: async (_args, ctx) => {
            const client = createSubagentsRpcClient(pi.events);
            const spawned = await client.call("spawn", {
              agent: "compat-worker",
              task: "Reply exactly: compat worker complete.",
              cwd: ${JSON.stringify(projectRoot)},
              context: "fresh",
              async: true,
              clarify: false,
            });
            const details = spawned.details;
            ctx.ui.notify(prefix + JSON.stringify({ spawned, details }), "info");
          },
        });
      }
    `);

    const invocation = run(
      piBinary,
      ["--mode", "rpc", "--no-session", "--no-extensions", "-e", extension, "-e", probe, "--no-skills", "--no-prompt-templates", "--no-themes", "--provider", "openai-idealab", "--model", "openai-idealab/Qwen3.7-Max-DogFooding"],
      {
        cwd: repoRoot,
        env: { ...process.env, PI_CODING_AGENT_DIR: join(repoRoot, "pi") },
        input: `${JSON.stringify({ id: "probe", type: "prompt", message: "/lifecycle-probe" })}\n`,
      },
    );
    const output = `${invocation.stdout}\n${invocation.stderr}`;
    assert.equal(invocation.error, undefined, invocation.error?.message);
    assert.equal(invocation.status, 0, output.includes("login") ? "OpenAI Pi login required; run /login openai-idealab" : output);
    const notification = findNotification(invocation.stdout, reportPrefix);
    assert.ok(notification, `missing ${reportPrefix} notification: ${invocation.stdout}`);
    const report = JSON.parse(notification.message.slice(reportPrefix.length));
    assert.equal(typeof report.details?.runId, "string");
    assert.equal(typeof report.details?.asyncDir, "string");
    const running = await waitForStatus(report.details.asyncDir, (status) => status.runId === report.details.runId);
    assert.equal(running.runId, report.details.runId);
    const terminal = await waitForStatus(report.details.asyncDir, (status) => status.state !== "running");
    assert.equal(terminal.state, "complete", JSON.stringify(terminal));
    assert.equal(terminal.steps[0].exitCode, 0);
    assert.equal(typeof terminal.sessionFile, "string");
    assert.equal(typeof terminal.outputFile, "string");
    await readFile(terminal.sessionFile, "utf8");
    await readFile(terminal.outputFile, "utf8");
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("stable status RPC resolves a spawned run within the same outer Pi RPC process", async () => {
  assert.ok(piBinary, "PI_REAL_BIN must point to Pi 0.80.6");
  const packageRoot = await mkdtemp(join(tmpdir(), "pi-subagents-compat-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "pi-subagents-project-"));
  const extension = join(packageRoot, "node_modules", "pi-subagents");
  const probe = join(packageRoot, "status-probe.mjs");
  const reportPrefix = "PI_SUBAGENTS_STATUS_REPORT=";
  const clientModule = new URL("../scripts/probes/pi-subagents-compat.mjs", import.meta.url).href;

  try {
    const install = run("npm", ["install", "--prefix", packageRoot, "--ignore-scripts", "pi-subagents@0.34.0"]);
    assert.equal(install.status, 0, install.stderr);
    await mkdir(join(projectRoot, ".pi", "agents"), { recursive: true });
    await writeFile(join(projectRoot, ".pi", "agents", "compat-worker.md"), `---
name: compat-worker
description: compatibility worker
model: openai-idealab/Qwen3.7-Max-DogFooding
tools: read
extensions: ""
---
Reply exactly: compat worker complete.
`);
    await writeFile(probe, `
      const prefix = ${JSON.stringify(reportPrefix)};
      import { createSubagentsRpcClient } from ${JSON.stringify(clientModule)};
      export default function (pi) {
        pi.registerCommand("status-probe", {
          description: "Probe pi-subagents status RPC",
          handler: async (_args, ctx) => {
            const client = createSubagentsRpcClient(pi.events);
            const spawned = await client.call("spawn", {
              agent: "compat-worker",
              task: "Reply exactly: compat worker complete.",
              cwd: ${JSON.stringify(projectRoot)},
              context: "fresh",
              async: true,
              clarify: false,
            });
            const deadline = Date.now() + 5000;
            let status;
            while (Date.now() < deadline) {
              try {
                status = await client.call("status", { runId: spawned.details.runId });
                break;
              } catch (error) {
                if (!String(error).includes("Status file not found")) throw error;
                await new Promise((resolve) => setTimeout(resolve, 50));
              }
            }
            if (!status) throw new Error("status RPC did not resolve the spawned run before the command deadline");
            ctx.ui.notify(prefix + JSON.stringify({ spawned, status }), "info");
          },
        });
      }
    `);

    const invocation = await runRpcUntil(
      piBinary,
      ["--mode", "rpc", "--no-session", "--no-extensions", "-e", extension, "-e", probe, "--no-skills", "--no-prompt-templates", "--no-themes", "--provider", "openai-idealab", "--model", "openai-idealab/Qwen3.7-Max-DogFooding"],
      {
        cwd: repoRoot,
        env: { ...process.env, PI_CODING_AGENT_DIR: join(repoRoot, "pi") },
        input: JSON.stringify({ id: "probe", type: "prompt", message: "/status-probe" }),
        until: (record) => record.type === "extension_ui_request"
          && record.method === "notify"
          && record.message?.startsWith(reportPrefix),
      },
    );
    assert.equal(invocation.error, undefined, invocation.error?.message);
    assert.equal(invocation.status, 0, invocation.stderr);
    const notification = findNotification(invocation.stdout, reportPrefix);
    assert.ok(notification, `missing ${reportPrefix} notification: ${invocation.stdout}`);
    const report = JSON.parse(notification.message.slice(reportPrefix.length));
    assert.equal(report.status.isError, undefined, JSON.stringify(report));
    assert.equal(report.status.details.mode, "single", JSON.stringify(report));
    const status = await waitForStatus(
      report.spawned.details.asyncDir,
      (value) => value.runId === report.spawned.details.runId,
    );
    assert.equal(status.runId, report.spawned.details.runId);
    const terminal = await waitForStatus(report.spawned.details.asyncDir, (value) => value.state !== "running");
    assert.equal(terminal.state, "complete", JSON.stringify(terminal));
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("stable interrupt RPC pauses a compat-wait async child and preserves control evidence", async () => {
  assert.ok(piBinary, "PI_REAL_BIN must point to Pi 0.80.6");
  const packageRoot = await mkdtemp(join(tmpdir(), "pi-subagents-compat-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "pi-subagents-project-"));
  const extension = join(packageRoot, "node_modules", "pi-subagents");
  const waitExtension = join(projectRoot, ".pi", "extensions", "compat-wait.mjs");
  const probe = join(packageRoot, "interrupt-probe.mjs");
  const reportPrefix = "PI_SUBAGENTS_INTERRUPT_REPORT=";
  const clientModule = new URL("../scripts/probes/pi-subagents-compat.mjs", import.meta.url).href;

  try {
    const install = run("npm", ["install", "--prefix", packageRoot, "--ignore-scripts", "pi-subagents@0.34.0"]);
    assert.equal(install.status, 0, install.stderr);
    await mkdir(join(projectRoot, ".pi", "agents"), { recursive: true });
    await mkdir(join(projectRoot, ".pi", "extensions"), { recursive: true });
    await writeFile(join(projectRoot, ".pi", "agents", "compat-wait.md"), `---
name: compat-wait
description: compatibility wait worker
model: openai-idealab/Qwen3.7-Max-DogFooding
tools: compat_wait
extensions: ""
subagentOnlyExtensions: ${waitExtension}
---
Call compat_wait immediately and do not answer until it returns.
`);
    await writeFile(waitExtension, `
      export default function (pi) {
        pi.registerTool({
          name: "compat_wait",
          description: "Wait until aborted",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          execute: async (_toolCallId, _params, signal) => new Promise((resolve) => {
            const finish = () => resolve({ content: [{ type: "text", text: "compat wait aborted" }] });
            if (signal?.aborted) return finish();
            signal?.addEventListener("abort", finish, { once: true });
          }),
        });
      }
    `);
    await writeFile(probe, `
      const prefix = ${JSON.stringify(reportPrefix)};
      import { createSubagentsRpcClient } from ${JSON.stringify(clientModule)};
      export default function (pi) {
        pi.registerCommand("interrupt-probe", {
          description: "Probe interrupt RPC",
          handler: async (_args, ctx) => {
            const client = createSubagentsRpcClient(pi.events, { timeoutMs: 30000 });
            const spawned = await client.call("spawn", {
              agent: "compat-wait",
              task: "Call compat_wait immediately and do not answer until it returns.",
              cwd: ${JSON.stringify(projectRoot)},
              context: "fresh",
              async: true,
              clarify: false,
            });
            const deadline = Date.now() + 30000;
            let status;
            while (Date.now() < deadline) {
              try {
                status = await client.call("status", { runId: spawned.details.runId });
                break;
              } catch (error) {
                if (!String(error).includes("Status file not found")) throw error;
              }
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            if (!status) throw new Error("status RPC did not resolve the compat-wait run");
            const interrupted = await client.call("interrupt", { runId: spawned.details.runId });
            ctx.ui.notify(prefix + JSON.stringify({ spawned, status, interrupted }), "info");
          },
        });
      }
    `);

    const invocation = await runRpcUntil(
      piBinary,
      ["--mode", "rpc", "--no-session", "--no-extensions", "-e", extension, "-e", probe, "--no-skills", "--no-prompt-templates", "--no-themes", "--provider", "openai-idealab", "--model", "openai-idealab/Qwen3.7-Max-DogFooding"],
      {
        cwd: repoRoot,
        env: { ...process.env, PI_CODING_AGENT_DIR: join(repoRoot, "pi") },
        input: JSON.stringify({ id: "probe", type: "prompt", message: "/interrupt-probe" }),
        until: (record) => record.type === "extension_ui_request"
          && record.method === "notify"
          && record.message?.startsWith(reportPrefix),
        timeoutMs: 60000,
      },
    );
    assert.equal(invocation.error, undefined, invocation.error?.message);
    assert.equal(invocation.status, 0, invocation.stderr);
    const notification = findNotification(invocation.stdout, reportPrefix);
    assert.ok(notification, `missing ${reportPrefix} notification: ${invocation.stdout}`);
    const report = JSON.parse(notification.message.slice(reportPrefix.length));
    assert.equal(report.interrupted.isError, undefined, JSON.stringify(report));
    assert.equal(report.interrupted.details.mode, "management", JSON.stringify(report));
    const terminal = await waitForStatus(
      report.spawned.details.asyncDir,
      (value) => value.state === "paused",
    );
    assert.equal(terminal.state, "paused", JSON.stringify(terminal));
    assert.equal(terminal.runId, report.spawned.details.runId);
    const events = parseRecords(await readFile(join(report.spawned.details.asyncDir, "events.jsonl"), "utf8"));
    assert.ok(events.some((event) => event.type?.includes("paused")), JSON.stringify(events));
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("stable stop RPC reports stopping before the compat-wait child reaches its artifact terminal state", async () => {
  assert.ok(piBinary, "PI_REAL_BIN must point to Pi 0.80.6");
  const packageRoot = await mkdtemp(join(tmpdir(), "pi-subagents-compat-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "pi-subagents-project-"));
  const extension = join(packageRoot, "node_modules", "pi-subagents");
  const waitExtension = join(projectRoot, ".pi", "extensions", "compat-wait.mjs");
  const probe = join(packageRoot, "stop-probe.mjs");
  const reportPrefix = "PI_SUBAGENTS_STOP_REPORT=";
  const clientModule = new URL("../scripts/probes/pi-subagents-compat.mjs", import.meta.url).href;

  try {
    const install = run("npm", ["install", "--prefix", packageRoot, "--ignore-scripts", "pi-subagents@0.34.0"]);
    assert.equal(install.status, 0, install.stderr);
    await mkdir(join(projectRoot, ".pi", "agents"), { recursive: true });
    await mkdir(join(projectRoot, ".pi", "extensions"), { recursive: true });
    await writeFile(join(projectRoot, ".pi", "agents", "compat-wait.md"), `---
name: compat-wait
description: compatibility wait worker
model: openai-idealab/Qwen3.7-Max-DogFooding
tools: compat_wait
extensions: ""
subagentOnlyExtensions: ${waitExtension}
---
Call compat_wait immediately and do not answer until it returns.
`);
    await writeFile(waitExtension, `
      export default function (pi) {
        pi.registerTool({
          name: "compat_wait",
          description: "Wait until aborted",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          execute: async (_toolCallId, _params, signal) => new Promise((resolve) => {
            const finish = () => resolve({ content: [{ type: "text", text: "compat wait aborted" }] });
            if (signal?.aborted) return finish();
            signal?.addEventListener("abort", finish, { once: true });
          }),
        });
      }
    `);
    await writeFile(probe, `
      const prefix = ${JSON.stringify(reportPrefix)};
      import { createSubagentsRpcClient } from ${JSON.stringify(clientModule)};
      export default function (pi) {
        pi.registerCommand("stop-probe", {
          description: "Probe stop RPC",
          handler: async (_args, ctx) => {
            const client = createSubagentsRpcClient(pi.events, { timeoutMs: 30000 });
            const spawned = await client.call("spawn", {
              agent: "compat-wait",
              task: "Call compat_wait immediately and do not answer until it returns.",
              cwd: ${JSON.stringify(projectRoot)},
              context: "fresh",
              async: true,
              clarify: false,
            });
            const deadline = Date.now() + 30000;
            let status;
            while (Date.now() < deadline) {
              try {
                status = await client.call("status", { runId: spawned.details.runId });
                break;
              } catch (error) {
                if (!String(error).includes("Status file not found")) throw error;
              }
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            if (!status) throw new Error("status RPC did not resolve the compat-wait run");
            const stopped = await client.call("stop", { runId: spawned.details.runId });
            ctx.ui.notify(prefix + JSON.stringify({ spawned, status, stopped }), "info");
          },
        });
      }
    `);

    const invocation = await runRpcUntil(
      piBinary,
      ["--mode", "rpc", "--no-session", "--no-extensions", "-e", extension, "-e", probe, "--no-skills", "--no-prompt-templates", "--no-themes", "--provider", "openai-idealab", "--model", "openai-idealab/Qwen3.7-Max-DogFooding"],
      {
        cwd: repoRoot,
        env: { ...process.env, PI_CODING_AGENT_DIR: join(repoRoot, "pi") },
        input: JSON.stringify({ id: "probe", type: "prompt", message: "/stop-probe" }),
        until: (record) => record.type === "extension_ui_request"
          && record.method === "notify"
          && record.message?.startsWith(reportPrefix),
        timeoutMs: 60000,
      },
    );
    assert.equal(invocation.error, undefined, invocation.error?.message);
    assert.equal(invocation.status, 0, invocation.stderr);
    const notification = findNotification(invocation.stdout, reportPrefix);
    assert.ok(notification, `missing ${reportPrefix} notification: ${invocation.stdout}`);
    const report = JSON.parse(notification.message.slice(reportPrefix.length));
    assert.equal(report.stopped.state, "stopping", JSON.stringify(report));
    assert.equal(report.stopped.runId, report.spawned.details.runId, JSON.stringify(report));
    const terminal = await waitForStatus(
      report.spawned.details.asyncDir,
      (value) => value.state === "failed" || value.state === "paused" || value.state === "complete",
    );
    assert.ok(["failed", "paused", "complete"].includes(terminal.state), JSON.stringify(terminal));
    assert.equal(terminal.runId, report.spawned.details.runId);
    assert.equal(typeof terminal.timedOut, "boolean", JSON.stringify(terminal));
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("nested subagents preserve the explicit depth and tool-capability boundary", async () => {
  assert.ok(piBinary, "PI_REAL_BIN must point to Pi 0.80.6");
  const packageRoot = await mkdtemp(join(tmpdir(), "pi-subagents-compat-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "pi-subagents-project-"));
  const extension = join(packageRoot, "node_modules", "pi-subagents");
  const probe = join(packageRoot, "nested-probe.mjs");
  const ordinaryArtifact = join(projectRoot, "ordinary-tools.json");
  const planArtifact = join(projectRoot, "plan-tools.json");
  const nestedArtifact = join(projectRoot, "nested-tools.json");
  const ordinaryExtension = join(projectRoot, ".pi", "extensions", "ordinary-sentinel.mjs");
  const planExtension = join(projectRoot, ".pi", "extensions", "plan-sentinel.mjs");
  const nestedExtension = join(projectRoot, ".pi", "extensions", "nested-sentinel.mjs");
  const reportPrefix = "PI_SUBAGENTS_NESTED_REPORT=";
  const clientModule = new URL("../scripts/probes/pi-subagents-compat.mjs", import.meta.url).href;

  try {
    const install = run("npm", ["install", "--prefix", packageRoot, "--ignore-scripts", "pi-subagents@0.34.0"]);
    assert.equal(install.status, 0, install.stderr);
    await mkdir(join(projectRoot, ".pi", "agents"), { recursive: true });
    await mkdir(join(projectRoot, ".pi", "extensions"), { recursive: true });
    const sentinel = (artifact) => `
      import { writeFileSync } from "node:fs";
      import { writeFile } from "node:fs/promises";
      export default function (pi) {
        writeFileSync(${JSON.stringify(`${artifact}.loaded`)}, "loaded");
        pi.on("session_start", async () => {
          await writeFile(${JSON.stringify(artifact)}, JSON.stringify({ tools: [...pi.getActiveTools()].sort() }));
        });
      }
    `;
    await writeFile(ordinaryExtension, sentinel(ordinaryArtifact));
    await writeFile(planExtension, sentinel(planArtifact));
    await writeFile(nestedExtension, sentinel(nestedArtifact));
    await writeFile(join(projectRoot, ".pi", "agents", "compat-ordinary.md"), `---
name: compat-ordinary
description: ordinary compatibility worker
model: openai-idealab/Qwen3.7-Max-DogFooding
tools: read
extensions: ""
subagentOnlyExtensions: ${ordinaryExtension}
---
Reply exactly: compat worker complete.
`);
    await writeFile(join(projectRoot, ".pi", "agents", "compat-worker.md"), `---
name: compat-worker
description: nested compatibility worker
model: openai-idealab/Qwen3.7-Max-DogFooding
tools: read
extensions: ""
subagentOnlyExtensions: ${nestedExtension}
---
Reply exactly: compat worker complete.
`);
    await writeFile(join(projectRoot, ".pi", "agents", "compat-plan.md"), `---
name: compat-plan
description: compatibility planner
model: openai-idealab/Qwen3.7-Max-DogFooding
tools: subagent, read
extensions: ""
maxSubagentDepth: 2
subagentOnlyExtensions: ${planExtension}
---
Call subagent exactly once with agent "compat-worker", async false, and task "Reply exactly: compat worker complete." Then reply exactly: compat plan complete.
`);
    await writeFile(probe, `
      const prefix = ${JSON.stringify(reportPrefix)};
      import { access, readFile } from "node:fs/promises";
      import { join } from "node:path";
      import { createSubagentsRpcClient } from ${JSON.stringify(clientModule)};
      export default function (pi) {
        pi.registerCommand("nested-probe", {
          description: "Probe nested subagent capability boundaries",
          handler: async (_args, ctx) => {
            const client = createSubagentsRpcClient(pi.events, { timeoutMs: 30000 });
            const ordinary = await client.call("spawn", {
              agent: "compat-ordinary",
              task: "Reply exactly: compat worker complete.",
              cwd: ${JSON.stringify(projectRoot)},
              context: "fresh",
              async: true,
              clarify: false,
            });
            const plan = await client.call("spawn", {
              agent: "compat-plan",
              task: "Call subagent exactly once with agent compat-worker, async false, and task Reply exactly: compat worker complete. Then reply exactly: compat plan complete.",
              cwd: ${JSON.stringify(projectRoot)},
              context: "fresh",
              async: true,
              clarify: false,
            });
            const deadline = Date.now() + 45000;
            let nested;
            while (Date.now() < deadline) {
              try {
                const events = (await readFile(join(plan.details.asyncDir, "events.jsonl"), "utf8"))
                  .split("\\n")
                  .filter(Boolean)
                  .map((line) => JSON.parse(line));
                const event = events.find((entry) => entry.type === "tool_execution_end"
                  && entry.toolName === "subagent"
                  && entry.result?.details?.runId
                  && (entry.result?.details?.asyncDir || entry.result?.details?.results?.[0]?.sessionFile));
                if (event) {
                  const result = event.result.details.results?.[0];
                  nested = {
                    runId: event.result.details.runId,
                    mode: event.result.details.asyncDir ? "async" : "foreground",
                    asyncDir: event.result.details.asyncDir,
                    sessionFile: result?.sessionFile,
                    artifactPaths: result?.artifactPaths,
                  };
                  break;
                }
              } catch (error) {
                if (error?.code !== "ENOENT") throw error;
              }
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            if (!nested) throw new Error("nested run evidence did not appear before the probe deadline");
            const extensionLoads = {};
            for (const [name, artifact] of Object.entries({
              ordinary: ${JSON.stringify(`${ordinaryArtifact}.loaded`)},
              plan: ${JSON.stringify(`${planArtifact}.loaded`)},
              nested: ${JSON.stringify(`${nestedArtifact}.loaded`)},
            })) {
              try {
                await access(artifact);
                extensionLoads[name] = true;
              } catch (error) {
                if (error?.code !== "ENOENT") throw error;
                extensionLoads[name] = false;
              }
            }
            const stopped = nested.mode === "async"
              ? await client.call("stop", { runId: plan.details.runId })
              : undefined;
            ctx.ui.notify(prefix + JSON.stringify({ ordinary, plan, nested, stopped, extensionLoads }), "info");
          },
        });
      }
    `);

    const invocation = await runRpcUntil(
      piBinary,
      ["--mode", "rpc", "--no-session", "--no-extensions", "-e", extension, "-e", probe, "--no-skills", "--no-prompt-templates", "--no-themes", "--provider", "openai-idealab", "--model", "openai-idealab/Qwen3.7-Max-DogFooding"],
      {
        cwd: repoRoot,
        env: { ...process.env, PI_CODING_AGENT_DIR: join(repoRoot, "pi") },
        input: JSON.stringify({ id: "probe", type: "prompt", message: "/nested-probe" }),
        until: (record) => record.type === "extension_ui_request"
          && record.method === "notify"
          && record.message?.startsWith(reportPrefix),
        timeoutMs: 60000,
      },
    );
    assert.equal(
      invocation.error,
      undefined,
      `${invocation.error?.message}\nstdout=${invocation.stdout}\nstderr=${invocation.stderr}`,
    );
    assert.equal(invocation.status, 0, invocation.stderr);
    const notification = findNotification(invocation.stdout, reportPrefix);
    assert.ok(notification, `missing ${reportPrefix} notification: ${invocation.stdout}`);
    const report = JSON.parse(notification.message.slice(reportPrefix.length));
    assert.deepEqual(report.extensionLoads, { ordinary: true, plan: true, nested: true }, JSON.stringify(report));
    const ordinaryTerminal = await waitForStatus(report.ordinary.details.asyncDir, (status) => status.state !== "running");
    const planTerminal = await waitForStatus(report.plan.details.asyncDir, (status) => status.state !== "running", { timeoutMs: 180000 });
    assert.equal(ordinaryTerminal.state, "complete", JSON.stringify(ordinaryTerminal));
    assert.equal(planTerminal.runId, report.plan.details.runId);
    if (report.nested.mode === "async") {
      assert.equal(report.stopped.state, "stopping", JSON.stringify(report));
      const nestedTerminal = await waitForStatus(report.nested.asyncDir, (status) => status.state !== "running", { timeoutMs: 180000 });
      assert.equal(nestedTerminal.runId, report.nested.runId);
    } else {
      assert.equal(report.stopped, undefined, JSON.stringify(report));
      assert.equal(planTerminal.state, "complete", JSON.stringify(planTerminal));
      assert.equal(typeof report.nested.sessionFile, "string", JSON.stringify(report));
      assert.equal(typeof report.nested.artifactPaths?.metadataPath, "string", JSON.stringify(report));
      await readFile(report.nested.sessionFile, "utf8");
      await readFile(report.nested.artifactPaths.metadataPath, "utf8");
    }

    const ordinaryTools = JSON.parse(await readFile(ordinaryArtifact, "utf8"));
    const planTools = JSON.parse(await readFile(planArtifact, "utf8"));
    const nestedTools = JSON.parse(await readFile(nestedArtifact, "utf8"));
    assert.ok(Array.isArray(ordinaryTools.tools), JSON.stringify(ordinaryTools));
    assert.ok(Array.isArray(planTools.tools), JSON.stringify(planTools));
    assert.ok(Array.isArray(nestedTools.tools), JSON.stringify(nestedTools));
    assert.ok(!ordinaryTools.tools.includes("subagent"), JSON.stringify(ordinaryTools));
    assert.ok(planTools.tools.includes("subagent"), JSON.stringify(planTools));
    assert.ok(!nestedTools.tools.includes("subagent"), JSON.stringify(nestedTools));

    const planEvents = parseRecords(await readFile(join(report.plan.details.asyncDir, "events.jsonl"), "utf8"));
    const nestedEvent = planEvents.find((event) => event.type === "tool_execution_end"
      && event.toolName === "subagent"
      && event.result?.details?.runId === report.nested.runId);
    assert.ok(nestedEvent, JSON.stringify(planEvents));
    if (report.nested.mode === "async") {
      assert.equal(nestedEvent.result.details.asyncDir, report.nested.asyncDir);
      const nestedChild = planTerminal.steps[0].children?.find((child) => child.id === report.nested.runId);
      assert.ok(nestedChild, JSON.stringify(planTerminal));
      assert.equal(typeof nestedChild.sessionFile, "string");
      await readFile(nestedChild.sessionFile, "utf8");
    } else {
      assert.equal(nestedEvent.result.details.results[0].sessionFile, report.nested.sessionFile);
    }
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});
