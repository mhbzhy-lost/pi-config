import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRegistryStore, prepareLaunch } from "../src/session-owner/registry.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(repoRoot, "scripts", "pi-launcher.zsh");
const decisionCli = join(repoRoot, "scripts", "pi-session-owner.ts");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-session-owner-wrapper-"));
  const output = join(root, "fake-pi.json");
  const bin = join(root, "bin");
  const dist = join(root, "dist");
  await (await import("node:fs/promises")).mkdir(bin);
  await (await import("node:fs/promises")).mkdir(dist);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module" }));
  await writeFile(join(dist, "index.js"), "throw new Error('continue must not load Pi package');\n");
  const fakePi = join(bin, "pi-real");
  await writeFile(fakePi, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.env.OUTPUT, JSON.stringify({ pid: process.pid, ownerId: process.env.PI_SESSION_OWNER_ID, registry: process.env.PI_SESSION_OWNER_REGISTRY, argv: process.argv.slice(2) }));\n`);
  await chmod(fakePi, 0o755);
  return { root, output, fakePi };
}

function runLauncher(args, env) {
  const childSafeEnv = { ...process.env, PI_SUBAGENT_CHILD: undefined, PI_SUBAGENT_FANOUT_CHILD: undefined, ...env };
  return spawnSync("zsh", ["-f", launcher, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: childSafeEnv,
  });
}

function runInteractiveLauncher(args, env) {
  const childSafeEnv = { ...process.env, PI_SUBAGENT_CHILD: undefined, PI_SUBAGENT_FANOUT_CHILD: undefined, ...env };
  const tclWord = (value) => `{${value.replaceAll("}", "\\}")}}`;
  const command = [launcher, ...args].map(tclWord).join(" ");
  return spawnSync("expect", ["-c", `spawn -noecho zsh -c {exec zsh -f "$@" 2>"$PI_TEST_LAUNCHER_STDERR"} zsh ${command}\nexpect eof\nexit [lindex [wait] 3]`], {
    cwd: repoRoot,
    encoding: "utf8",
    env: childSafeEnv,
  });
}

async function runPrepare(args, env) {
  const decisionDir = await mkdtemp(join(tmpdir(), "pi-session-owner-decision-"));
  await chmod(decisionDir, 0o700);
  const piBinary = join(spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout.trim(), "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
  const result = spawnSync("node", [decisionCli, "prepare", "--pid", String(process.pid), "--cwd", repoRoot, "--stdin-tty", "1", "--stdout-tty", "1", "--decision-dir", decisionDir, "--pi-binary", piBinary, "--", ...args], {
    cwd: repoRoot, encoding: "utf8", env: { ...process.env, PI_SUBAGENT_CHILD: undefined, PI_SUBAGENT_FANOUT_CHILD: undefined, ...env },
  });
  return { result, decisionDir };
}

test("prepare requires an explicit verified Pi binary", async () => {
  const decisionDir = await mkdtemp(join(tmpdir(), "pi-session-owner-decision-"));
  await chmod(decisionDir, 0o700);
  try {
    const result = spawnSync("node", [decisionCli, "prepare", "--pid", String(process.pid), "--cwd", repoRoot, "--stdin-tty", "1", "--stdout-tty", "1", "--decision-dir", decisionDir, "--", "-c"], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, PI_SUBAGENT_CHILD: undefined, PI_SUBAGENT_FANOUT_CHILD: undefined } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(join(decisionDir, "action"), "utf8"), "blocked\n");
  } finally { await rm(decisionDir, { recursive: true, force: true }); }
});

test("continue does not require Pi package discovery and retains the PI_REAL_BIN binary bridge", async () => {
  const state = await fixture();
  const first = await mkdtemp(join(tmpdir(), "pi-session-owner-decision-"));
  const second = await mkdtemp(join(tmpdir(), "pi-session-owner-decision-"));
  const sessions = await mkdtemp(join(tmpdir(), "pi-session-owner-empty-sessions-"));
  await chmod(first, 0o700); await chmod(second, 0o700);
  const base = [decisionCli, "prepare", "--pid", String(process.pid), "--cwd", repoRoot, "--stdin-tty", "1", "--stdout-tty", "1"];
  try {
    const cliWins = spawnSync("node", [...base, "--decision-dir", first, "--pi-binary", "/missing/pi", "--", "-c"], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, PI_SUBAGENT_CHILD: undefined, PI_SUBAGENT_FANOUT_CHILD: undefined, PI_REAL_BIN: state.fakePi, PI_SESSION_OWNER_REGISTRY: join(state.root, "registry-cli"), PI_CODING_AGENT_SESSION_DIR: sessions } });
    assert.equal(cliWins.status, 0, cliWins.stderr);
    assert.equal(await readFile(join(first, "action"), "utf8"), "pass\n");
    const envFallback = spawnSync("node", [...base, "--decision-dir", second, "--", "-c"], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, PI_SUBAGENT_CHILD: undefined, PI_SUBAGENT_FANOUT_CHILD: undefined, PI_REAL_BIN: state.fakePi, PI_SESSION_OWNER_REGISTRY: join(state.root, "registry"), PI_CODING_AGENT_SESSION_DIR: sessions } });
    assert.equal(envFallback.status, 0, envFallback.stderr);
    assert.equal(await readFile(join(second, "action"), "utf8"), "pass\n");
  } finally { await rm(first, { recursive: true, force: true }); await rm(second, { recursive: true, force: true }); await rm(sessions, { recursive: true, force: true }); await rm(state.root, { recursive: true, force: true }); }
});

test("continue pins the recent header without loading the Pi package", async () => {
  const state = await fixture();
  const sessions = join(state.root, "sessions");
  await (await import("node:fs/promises")).mkdir(sessions);
  const session = join(sessions, "recent.jsonl");
  const canonicalCwd = await realpath(repoRoot);
  await writeFile(session, `${JSON.stringify({ type: "session", id: "recent", cwd: canonicalCwd })}\n${"large-body".repeat(20_000)}\n`);
  try {
    const { result, decisionDir } = await runPrepare(["-c"], { PI_REAL_BIN: state.fakePi, PI_CODING_AGENT_SESSION_DIR: sessions, PI_SESSION_OWNER_REGISTRY: join(state.root, "registry") });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(join(decisionDir, "action"), "utf8"), "pin-session\n");
    assert.equal((await readFile(join(decisionDir, "session-path"))).subarray(-1)[0], 0);
    await rm(decisionDir, { recursive: true, force: true });
  } finally { await rm(state.root, { recursive: true, force: true }); }
});

test("non-TTY launcher bypasses ownership and preserves user extension settings", async () => {
  const state = await fixture();
  try {
    const result = runLauncher(["-c", "--no-extensions", "--", "prompt -c\nvalue"], {
      OUTPUT: state.output,
      PI_REAL_BIN: state.fakePi,
      PI_SESSION_OWNER_REGISTRY: join(state.root, "registry"),
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    const invocation = JSON.parse(await readFile(state.output, "utf8"));
    assert.equal(invocation.ownerId, undefined);
    assert.equal(invocation.pid, result.pid, "launcher must exec fake Pi without changing PID");
    assert.deepEqual(invocation.argv, ["-c", "--no-extensions", "--", "prompt -c\nvalue"]);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("child launches bypass ownership without registry state or extension injection", async () => {
  const state = await fixture();
  try {
    const registry = join(state.root, "registry");
    const result = runLauncher(["--no-extensions"], {
      OUTPUT: state.output,
      PI_REAL_BIN: state.fakePi,
      PI_SESSION_OWNER_REGISTRY: registry,
      PI_SUBAGENT_CHILD: "1",
    });
    assert.equal(result.status, 0, result.stderr);
    const invocation = JSON.parse(await readFile(state.output, "utf8"));
    assert.equal(invocation.ownerId, undefined);
    assert.equal(invocation.registry, undefined);
    assert.deepEqual(invocation.argv, ["--no-extensions"]);
    await assert.rejects((await import("node:fs/promises")).readdir(registry), { code: "ENOENT" });
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("resume selection is blocked by an existing owner without invoking fake Pi", async () => {
  const state = await fixture();
  try {
    const registry = join(state.root, "registry");
    await prepareLaunch({
      store: createRegistryStore(registry), pid: process.pid, ownerId: "existing-selector-12345678",
      startedAt: new Date().toISOString(), reservation: { kind: "new" },
    });
    const { result, decisionDir } = await runPrepare(["-r"], { PI_SESSION_OWNER_REGISTRY: registry });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(join(decisionDir, "action"), "utf8"), "blocked\n");
    await assert.rejects(readFile(state.output, "utf8"));
    await rm(decisionDir, { recursive: true, force: true });
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("blocked launcher explains the safe ways to continue", async () => {
  const state = await fixture();
  try {
    const registry = join(state.root, "registry");
    const stderr = join(state.root, "launcher.stderr");
    await prepareLaunch({
      store: createRegistryStore(registry), pid: process.pid, ownerId: "existing-owner-12345678",
      startedAt: new Date().toISOString(), reservation: { kind: "session", cwd: repoRoot, sessionFile: join(state.root, "owned.jsonl"), sessionId: null },
    });
    const result = runInteractiveLauncher(["--session", join(state.root, "owned.jsonl")], {
      OUTPUT: state.output,
      PI_REAL_BIN: state.fakePi,
      PI_SESSION_OWNER_REGISTRY: registry,
      PI_TEST_LAUNCHER_STDERR: stderr,
    });
    assert.equal(result.status, 1, result.stderr);
    const message = await readFile(stderr, "utf8");
    assert.match(message, /目标正被其他 Pi 使用/);
    assert.match(message, /回到原窗口/);
    assert.match(message, /普通 `pi` 新建 session/);
    assert.match(message, /关闭占用窗口后重试 `pi -c`/);
    await assert.rejects(readFile(state.output, "utf8"));
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("non-interactive reuse bypasses ownership while resume requires a TTY", async () => {
  const state = await fixture();
  const decisionDir = await mkdtemp(join(tmpdir(), "pi-session-owner-decision-"));
  await chmod(decisionDir, 0o700);
  try {
    const bypass = await runPrepare(["--mode", "rpc", "--session", join(state.root, "missing.jsonl")], { PI_SESSION_OWNER_REGISTRY: join(state.root, "registry") });
    assert.equal(bypass.result.status, 0, bypass.result.stderr);
    assert.equal(await readFile(join(bypass.decisionDir, "action"), "utf8"), "bypass\n");
    await rm(bypass.decisionDir, { recursive: true, force: true });
    const blocked = spawnSync("node", [decisionCli, "prepare", "--pid", String(process.pid), "--cwd", repoRoot, "--stdin-tty", "0", "--stdout-tty", "0", "--decision-dir", decisionDir, "--pi-binary", state.fakePi, "--", "-r"], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, PI_SUBAGENT_CHILD: undefined, PI_SUBAGENT_FANOUT_CHILD: undefined, PI_SESSION_OWNER_REGISTRY: join(state.root, "registry") } });
    assert.equal(blocked.status, 0, blocked.stderr);
    assert.equal(await readFile(join(decisionDir, "action"), "utf8"), "blocked\n");
  } finally { await rm(decisionDir, { recursive: true, force: true }); await rm(state.root, { recursive: true, force: true }); }
});

test("blocked explicit session never invokes fake Pi or leaves a preliminary record", async () => {
  const state = await fixture();
  try {
    const session = join(state.root, "owned.jsonl");
    const registry = join(state.root, "registry");
    await prepareLaunch({
      store: createRegistryStore(registry), pid: process.pid, ownerId: "existing-owner-12345678",
      startedAt: new Date().toISOString(), reservation: { kind: "session", cwd: repoRoot, sessionFile: session, sessionId: null },
    });
    const { result, decisionDir } = await runPrepare(["--session", session], { PI_SESSION_OWNER_REGISTRY: registry });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(join(decisionDir, "action"), "utf8"), "blocked\n");
    await rm(decisionDir, { recursive: true, force: true });
    const names = await (await import("node:fs/promises")).readdir(registry);
    assert.equal(names.filter((name) => name.endsWith(".json")).length, 1);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});
