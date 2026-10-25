// 只读观测驱动：在两个 Host 形态下串行运行（node --test 单文件默认串行，
// 不设置 concurrency），各启动一个 Host 并收集 subagent-rpc-bridge-observation
// fixture 的原始观测记录。既有测试与生产代码零改动。
//
// 运行：cd /Users/leshi.zhy/pi-config && \
//   PI_REAL_BIN="$PWD/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" \
//   node --test test/subagent-rpc-bridge-observation.integration.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { buildTopLevelRuntimeEnv } from "../scripts/probes/pi-subagents-compat.ts";

const repo = resolve(import.meta.dirname, "..");
const hostRoot = process.env.PI_TEST_CODING_AGENT_ROOT?.trim()
  || join(repo, "node_modules", "@earendil-works", "pi-coding-agent");
const piBinary = process.env.PI_REAL_BIN ?? join(hostRoot, "dist", "cli.js");
const runtimeExtension = join(repo, "packages", "pi-subagents-enhanced", "extensions", "subagent-runtime.ts");
const observationProbe = join(repo, "test", "fixtures", "subagent-rpc-bridge-observation.mjs");

async function waitForSessionStartPing(observationPath, { timeoutMs = 45_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const observation = JSON.parse(await readFile(observationPath, "utf8"));
      if (observation.pings?.some((entry) => entry.label === "session-start")) return observation;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(`observation session-start ping not observed within ${timeoutMs}ms: ${lastError?.message ?? "(no file)"}`);
}

async function reap(child, { timeoutMs = 10_000 } = {}) {
  if (child.exitCode === null && child.signalCode === null) {
    child.stdin?.end();
    child.kill("SIGTERM");
  }
  const closed = new Promise((resolveClose) => child.once("close", resolveClose));
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs).unref();
  try { await closed; } finally { clearTimeout(timer); }
}

function dumpEvidence(tag, { observation, stderr, stdout }) {
  // 原始记录直接进测试输出，供验收取证。
  console.log(`\n===== ${tag} OBSERVATION =====\n${JSON.stringify(observation, null, 2)}`);
  console.log(`\n===== ${tag} STDERR (tail) =====\n${stderr.slice(-6000)}`);
  console.log(`\n===== ${tag} STDOUT (first 2000) =====\n${stdout.slice(0, 2000)}`);
}

test("形态一：top-level compat lane Host 观测（--mode rpc --no-session，非 Git cwd）", { timeout: 120_000 }, async t => {
  const providerExtension = join(repo, "test", "fixtures", "deterministic-provider.mjs");
  const packageRoot = await mkdtemp(join(tmpdir(), "rpc-obs-form1-package-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "rpc-obs-form1-project-"));
  const runtimeTmp = await mkdtemp(join(tmpdir(), "rpc-obs-form1-runtime-"));
  const configRoot = join(packageRoot, "config");
  const observationPath = join(packageRoot, "rpc-bridge-observation.json");
  try {
    await mkdir(join(configRoot, "agents"), { recursive: true });
    // 与 test/pi-subagents-runtime.integration.mjs runScenario 一致：三个 profile 都要存在，
    // 否则 runtime admission 会在启动时以 Invalid agent profile 失败。
    for (const [name, tools] of [["executor", "contact_supervisor, read"], ["delegate", "read"], ["reviewer", "read"]]) {
      await writeFile(join(configRoot, "agents", `${name}.md`), `---
name: ${name}
description: deterministic top-level RPC compatibility worker
model: fake/deterministic
tools: ${tools}
${name === "executor" ? `extensions: ${providerExtension}
` : ""}---
Use the deterministic compatibility marker from the assigned task.
`);
    }
    const env = (() => {
      // 与 test/pi-subagents-runtime.integration.mjs runScenario 的隔离一致。
      const {
        PI_SUBAGENT_CHILD: _child, PI_SUBAGENT_FANOUT_CHILD: _fanout, PI_SUBAGENT_PARENT_SESSION: _parent,
        PI_ROOT_SUBAGENT_BROKER_ENABLED: _broker, PI_SUBAGENT_ORCHESTRATOR_SESSION_ID: _orchestrator,
        PI_SUBAGENT_RUN_ID: _run, ...topLevelEnv
      } = process.env;
      return {
        ...buildTopLevelRuntimeEnv(topLevelEnv),
        TMPDIR: runtimeTmp,
        PI_CODING_AGENT_DIR: configRoot,
        PI_CODING_WORKSPACE_DIR: join(packageRoot, "state"),
        OPENAI_API_KEY: "not-used",
        PI_RPC_BRIDGE_OBSERVATION_OUTPUT: observationPath,
      };
    })();
    const child = spawn(piBinary, [
      "--mode", "rpc", "--no-session", "--no-extensions",
      "-e", providerExtension,
      "-e", runtimeExtension,
      "-e", observationProbe,
      "--no-skills", "--no-prompt-templates", "--no-themes",
      "--provider", "fake", "--model", "fake/deterministic",
    ], { cwd: projectRoot, env, stdio: ["pipe", "pipe", "pipe"] });
    t.after(async () => { await reap(child); });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      // Host 启动失败时测试可能长时间等待，stderr 实时透出便于现场取证。
      console.error(`[form1-host-stderr] ${chunk}`);
    });
    const hostClosed = new Promise((resolveClose) => child.once("close", (code, signal) => resolveClose({ code, signal })));
    child.stdin.write(`${JSON.stringify({ id: "rpc-obs-form1", type: "prompt", message: "PI_SUBAGENTS_COMPAT_PARENT_COMPLETE" })}\n`);
    const observation = await Promise.race([
      waitForSessionStartPing(observationPath),
      hostClosed.then(({ code, signal }) => { throw new Error(`Host exited early code=${code} signal=${signal}`); }),
    ]);
    dumpEvidence("FORM1", { observation, stderr, stdout });
    // 仅对 fixture 机制做最小断言；判定本身由原始记录承载。
    // ping 超时本身也是有效观测结果，不作为断言失败。
    assert.equal(observation.fixture, "subagent-rpc-bridge-observation");
    assert.ok(observation.pings.some((entry) => entry.label === "session-start"), JSON.stringify(observation.pings));
  } finally {
    await rm(packageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
    await rm(runtimeTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

test("形态二：joint-upgrade contact-supervisor 成功场景 Host 观测（ask）", { timeout: 120_000 }, async t => {
  const provider = fileURLToPath(new URL("./fixtures/joint-upgrade/contact-provider.mjs", import.meta.url));
  const root = await mkdtemp(join(tmpdir(), "rpc-obs-form2-"));
  const agent = join(root, "agent");
  const cwd = join(root, "cwd");
  const capture = join(root, "capture.jsonl");
  const observationPath = join(root, "rpc-bridge-observation.json");
  try {
    await mkdir(join(agent, "agents"), { recursive: true });
    await mkdir(join(agent, "extensions"), { recursive: true });
    await mkdir(cwd);
    await mkdir(join(root, "home"));
    await mkdir(join(root, "tmp"));
    await symlink(join(repo, "pi", "extensions", "agents-shared.ts"), join(agent, "extensions", "agents-shared.ts"));
    for (const name of ["delegate", "executor", "reviewer"]) {
      await writeFile(join(agent, `agents/${name}.md`), `---
name: ${name}
description: fixture
model: joint-contact/fixture
tools: read,contact_supervisor
extensions: ${provider}
---
执行隔离测试请求。
`);
    }
    await writeFile(join(root, "trace.jsonl"), "", { mode: 0o600 });
    const env = {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: join(root, "home"),
      TMPDIR: join(root, "tmp"),
      XDG_STATE_HOME: join(root, "state"),
      PI_CODING_AGENT_DIR: agent,
      PI_CODING_WORKSPACE_DIR: join(root, "workspace"),
      PI_PACKAGE_DIR: hostRoot,
      PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: hostRoot,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      PI_INTERCOM_ASK_TIMEOUT_MS: "20000",
      JOINT_CONTACT_CASE: "ask",
      JOINT_CONTACT_CAPTURE: capture,
      PI_SUBAGENT_DISPATCH_TRACE_FILE: join(root, "trace.jsonl"),
      PI_RPC_BRIDGE_OBSERVATION_OUTPUT: observationPath,
    };
    const child = spawn(process.execPath, [
      join(hostRoot, "dist/cli.js"),
      "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--no-context-files",
      "-e", provider,
      "-e", runtimeExtension,
      "-e", observationProbe,
      "--provider", "joint-contact", "--model", "joint-contact/fixture",
    ], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    t.after(async () => { await reap(child); });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      console.error(`[form2-host-stderr] ${chunk}`);
    });
    const hostClosed = new Promise((resolveClose) => child.once("close", (code, signal) => resolveClose({ code, signal })));
    child.stdin.write(`${JSON.stringify({ id: "rpc-obs-form2", type: "prompt", message: "JOINT_PARENT_ASK" })}\n`);
    const observation = await Promise.race([
      waitForSessionStartPing(observationPath),
      hostClosed.then(({ code, signal }) => { throw new Error(`Host exited early code=${code} signal=${signal}`); }),
    ]);
    dumpEvidence("FORM2", { observation, stderr, stdout });
    assert.equal(observation.fixture, "subagent-rpc-bridge-observation");
    assert.ok(observation.pings.some((entry) => entry.label === "session-start"), JSON.stringify(observation.pings));
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});
