import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const piBinary = process.env.PI_REAL_BIN;
const provider = path.join(repoRoot, "test", "fixtures", "deterministic-provider.mjs");
const runtime = path.join(repoRoot, "packages", "pi-subagents-enhanced", "extensions", "subagent-runtime.ts");
const probe = path.join(repoRoot, "test", "fixtures", "root-broker-registry-probe.ts");

function brokerSocketPath(sessionId) {
  const digest = createHash("sha256").update(sessionId, "utf8").digest("hex");
  const uid = typeof process.getuid === "function" ? process.getuid() : process.pid;
  return `/tmp/pi-root-subagent-${uid}/${digest}.sock`;
}

function withoutSubagentEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => ![
    "PI_SUBAGENT_CHILD", "PI_SUBAGENT_FANOUT_CHILD", "PI_SUBAGENT_PARENT_SESSION",
    "PI_SUBAGENT_RUN_ID", "PI_SUBAGENT_ORCHESTRATOR_SESSION_ID", "PI_ROOT_SUBAGENT_BROKER_ENABLED",
  ].includes(name)));
}

test("persisted root session shares its broker registry with an independent Jiti extension", { timeout: 30_000 }, async (t) => {
  assert.ok(piBinary, "PI_REAL_BIN must point to the real Pi binary");
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-root-broker-registry-"));
  const sessions = path.join(root, "sessions");
  const runtimeTmp = path.join(root, "tmp");
  const agentDir = path.join(root, "agent");
  const output = path.join(root, "probe.json");
  const sessionId = "root-broker-registry-probe";
  const socket = brokerSocketPath(sessionId);
  try {
    await mkdir(agentDir);
    const result = spawnSync(piBinary, [
      "--mode", "rpc", "--session-dir", sessions, "--session-id", sessionId,
      "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
      "--no-context-files", "--approve", "--offline",
      "-e", provider, "-e", runtime, "-e", probe,
      "--provider", "fake", "--model", "fake/deterministic",
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 20_000,
      input: `${JSON.stringify({ id: "root-broker-registry-commands", type: "get_commands" })}\n`,
      env: {
        ...withoutSubagentEnvironment(process.env),
        PI_CODING_AGENT_DIR: agentDir,
        PI_ROOT_BROKER_PROBE_OUTPUT: output,
        TMPDIR: runtimeTmp,
        OPENAI_API_KEY: "not-used",
      },
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const records = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(records.some((record) => record.type === "response" && record.command === "get_commands" && record.success === true), result.stdout);
    assert.ok(!records.some((record) => record.type === "extension_error"), result.stdout);
    assert.doesNotMatch(result.stderr, /rootSessionId.*safe non-path identity|extension (?:failed|error)|failed to load extension/i);
    await assert.rejects(access(socket), /ENOENT/);

    const facts = JSON.parse(await readFile(output, "utf8"));
    assert.notEqual(facts.eventReason, null, JSON.stringify(facts));
    assert.equal(facts.brokerMarker, "1", JSON.stringify(facts));
    assert.equal(facts.getSessionId, sessionId, JSON.stringify(facts));
    assert.notEqual(facts.getSessionId, facts.getSessionFile, JSON.stringify(facts));
    assert.ok(facts.allToolNames.includes("subagent"), JSON.stringify(facts));
    assert.ok(facts.activeToolNames.includes("subagent"), JSON.stringify(facts));
    assert.equal(facts.error, null, JSON.stringify(facts));
    assert.equal(facts.brokerRootSessionId, sessionId, JSON.stringify(facts));
    assert.equal(facts.brokerServerExists, true, JSON.stringify(facts));
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
