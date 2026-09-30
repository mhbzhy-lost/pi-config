import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("shell integration makes bare pi use the repository configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-shell-"));
  try {
    const output = join(root, "invocation.json");
    const fakePi = join(root, "pi-real");
    await writeFile(
      fakePi,
      `#!/usr/bin/env bash\nnode -e 'require("fs").writeFileSync(process.env.OUTPUT, JSON.stringify({ config: process.env.PI_CODING_AGENT_DIR, sessions: process.env.PI_CODING_AGENT_SESSION_DIR, goals: process.env.PI_CODING_GOAL_DIR, workspaces: process.env.PI_CODING_WORKSPACE_DIR, args: process.argv.slice(1) }))' -- "$@"\n`,
    );
    await chmod(fakePi, 0o755);

    const result = spawnSync(
      "zsh",
      ["-f", "-c", `source ${join(repoRoot, "scripts", "pi-shell.zsh")}; pi --version`],
      {
        encoding: "utf8",
        env: { ...process.env, PI_REAL_BIN: fakePi, OUTPUT: output, PI_CODING_AGENT_SESSION_DIR: "", PI_CODING_AGENT_GOAL_DIR: "", PI_CODING_AGENT_WORKSPACE_DIR: "", PI_CODING_GOAL_DIR: "", PI_CODING_WORKSPACE_DIR: "" },
      },
    );

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), {
      config: join(repoRoot, "pi"),
      sessions: join(repoRoot, "var", "sessions"),
      goals: join(repoRoot, "var", "goals"),
      workspaces: join(repoRoot, "var", "workspaces"),
      args: ["--no-skills", "--version"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shell integration preserves an absolute custom workspace state directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-shell-workspaces-"));
  try {
    const output = join(root, "workspace-dir.txt");
    const fakePi = join(root, "pi-real");
    await writeFile(fakePi, "#!/usr/bin/env bash\nprintf '%s' \"$PI_CODING_WORKSPACE_DIR\" > \"$OUTPUT\"\n");
    await chmod(fakePi, 0o755);

    const result = spawnSync(
      "zsh",
      ["-f", "-c", `source ${join(repoRoot, "scripts", "pi-shell.zsh")}; pi --version`],
      { encoding: "utf8", env: { ...process.env, PI_REAL_BIN: fakePi, OUTPUT: output, PI_CODING_AGENT_GOAL_DIR: "", PI_CODING_AGENT_WORKSPACE_DIR: "", PI_CODING_WORKSPACE_DIR: "/tmp/custom-pi-workspaces" } },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(output, "utf8"), "/tmp/custom-pi-workspaces");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shell integration preserves a custom Goal state directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-shell-goals-"));
  try {
    const output = join(root, "goal-dir.txt");
    const fakePi = join(root, "pi-real");
    await writeFile(fakePi, "#!/usr/bin/env bash\nprintf '%s' \"$PI_CODING_GOAL_DIR\" > \"$OUTPUT\"\n");
    await chmod(fakePi, 0o755);

    const result = spawnSync(
      "zsh",
      ["-f", "-c", `source ${join(repoRoot, "scripts", "pi-shell.zsh")}; pi --version`],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PI_REAL_BIN: fakePi,
          OUTPUT: output,
          PI_CODING_AGENT_GOAL_DIR: "",
          PI_CODING_GOAL_DIR: "/tmp/custom-pi-goals",
        },
      },
    );

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(output, "utf8"), "/tmp/custom-pi-goals");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shell integration lets pi-new agent-prefixed state roots win over stale inherited non-agent values", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-shell-agent-vars-"));
  try {
    const output = join(root, "state-roots.json");
    const fakePi = join(root, "pi-real");
    await writeFile(
      fakePi,
      "#!/usr/bin/env bash\nnode -e 'require(\"fs\").writeFileSync(process.env.OUTPUT, JSON.stringify({ goals: process.env.PI_CODING_GOAL_DIR, workspaces: process.env.PI_CODING_WORKSPACE_DIR }))' -- \"$@\"\n",
    );
    await chmod(fakePi, 0o755);

    // 模拟 pi-new 的权威通道（AGENT_ 前缀显式设置）与用户 shell 中残留的旧仓导出值（非 AGENT 变体）共存。
    const result = spawnSync(
      "zsh",
      ["-f", "-c", `source ${join(repoRoot, "scripts", "pi-shell.zsh")}; pi --version`],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PI_REAL_BIN: fakePi,
          OUTPUT: output,
          PI_CODING_AGENT_GOAL_DIR: join(repoRoot, "var", "goals"),
          PI_CODING_AGENT_WORKSPACE_DIR: join(repoRoot, "var", "workspaces"),
          PI_CODING_GOAL_DIR: "/Users/leshi.zhy/pi-config/var/goals",
          PI_CODING_WORKSPACE_DIR: "/Users/leshi.zhy/pi-config/var/workspaces",
        },
      },
    );

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), {
      goals: join(repoRoot, "var", "goals"),
      workspaces: join(repoRoot, "var", "workspaces"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bare pi forwards without shell ANSI output", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-alt-default-"));
  try {
    const output = join(root, "args.txt");
    const fakePi = join(root, "pi-real");
    await writeFile(fakePi, "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" > \"$OUTPUT\"\n");
    await chmod(fakePi, 0o755);

    const result = spawnSync(
      "zsh",
      ["-f", "-c", `source ${join(repoRoot, "scripts", "pi-shell.zsh")}; pi`],
      {
        encoding: "utf8",
        env: { ...process.env, PI_REAL_BIN: fakePi, PI_ALT_SCREEN: "always", OUTPUT: output },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(await readFile(output, "utf8"), "--no-skills\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pi-inline requests official regular TUI mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-inline-"));
  try {
    const output = join(root, "args.txt");
    const fakePi = join(root, "pi-real");
    await writeFile(fakePi, "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" > \"$OUTPUT\"\n");
    await chmod(fakePi, 0o755);

    const result = spawnSync(
      "zsh",
      ["-f", "-c", `source ${join(repoRoot, "scripts", "pi-shell.zsh")}; pi-inline --version`],
      {
        encoding: "utf8",
        env: { ...process.env, PI_REAL_BIN: fakePi, PI_ALT_SCREEN: "always", OUTPUT: output },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(await readFile(output, "utf8"), "--no-skills\n--tui-mode\nregular\n--version\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pi-full requests official fullscreen TUI mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-full-"));
  try {
    const output = join(root, "args.txt");
    const fakePi = join(root, "pi-real");
    await writeFile(fakePi, "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" > \"$OUTPUT\"\n");
    await chmod(fakePi, 0o755);

    const result = spawnSync(
      "zsh",
      ["-f", "-c", `source ${join(repoRoot, "scripts", "pi-shell.zsh")}; pi-full --version`],
      {
        encoding: "utf8",
        env: { ...process.env, PI_REAL_BIN: fakePi, OUTPUT: output },
      },
    );

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(await readFile(output, "utf8"), "--no-skills\n--tui-mode\nfullscreen\n--version\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pi-lite launches the lean read-only exploration mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-shell-explore-"));
  try {
    const output = join(root, "args.txt");
    const fakePi = join(root, "pi-real");
    await writeFile(fakePi, "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" > \"$OUTPUT\"\n");
    await chmod(fakePi, 0o755);

    const result = spawnSync(
      "zsh",
      ["-f", "-c", `source ${join(repoRoot, "scripts", "pi-shell.zsh")}; pi-lite --version`],
      {
        encoding: "utf8",
        env: { ...process.env, PI_REAL_BIN: fakePi, OUTPUT: output },
      },
    );

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(
      await readFile(output, "utf8"),
      [
        "--no-skills",
        "-nc",
        "-na",
        "--no-extensions",
        "--no-prompt-templates",
        "--skill",
        join(repoRoot, "skill-overrides", "exa-search", "SKILL.md"),
        "--skill",
        join(repoRoot, "skill-overrides", "playwright", "SKILL.md"),
        "--tools",
        "read,bash",
        "--version",
        "",
      ].join("\n"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shell delegates TUI ownership to Pi official settings", async () => {
  const shell = await readFile(join(repoRoot, "scripts", "pi-shell.zsh"), "utf8");
  assert.doesNotMatch(shell, /1049|PI_ALT_SCREEN|_pi_config_alt_screen/);
});
