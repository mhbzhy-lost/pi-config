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
      `#!/usr/bin/env bash\nnode -e 'require("fs").writeFileSync(process.env.OUTPUT, JSON.stringify({ config: process.env.PI_CODING_AGENT_DIR, sessions: process.env.PI_CODING_AGENT_SESSION_DIR, goals: process.env.PI_CODING_GOAL_DIR, args: process.argv.slice(1) }))' -- "$@"\n`,
    );
    await chmod(fakePi, 0o755);

    const result = spawnSync(
      "zsh",
      ["-f", "-c", `source ${join(repoRoot, "scripts", "pi-shell.zsh")}; pi --version`],
      {
        encoding: "utf8",
        env: { ...process.env, PI_REAL_BIN: fakePi, OUTPUT: output, PI_CODING_AGENT_SESSION_DIR: "", PI_CODING_GOAL_DIR: "" },
      },
    );

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), {
      config: join(repoRoot, "pi"),
      sessions: join(repoRoot, "var", "sessions"),
      goals: join(repoRoot, "var", "goals"),
      args: ["--no-skills", "--version"],
    });
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

test("bare pi uses the alternate screen for an interactive launch", async () => {
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
    assert.equal(result.stdout, "\u001b[?1049h\u001b[2J\u001b[H\u001b[?1049l");
    assert.equal(await readFile(output, "utf8"), "--no-skills\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pi-inline bypasses alternate screen explicitly", async () => {
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
    assert.equal(await readFile(output, "utf8"), "--no-skills\n--version\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pi-full runs pi in the alternate screen and restores the primary screen", async () => {
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
    assert.equal(result.stdout, "\u001b[?1049h\u001b[2J\u001b[H\u001b[?1049l");
    assert.equal(await readFile(output, "utf8"), "--no-skills\n--version\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
