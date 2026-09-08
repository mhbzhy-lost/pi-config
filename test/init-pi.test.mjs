import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const systemPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
const blockedEnvironmentNames = [
  "PI_SUBAGENT_CHILD",
  "PI_SUBAGENT_FANOUT_CHILD",
  "PI_SUBAGENT_PARENT_SESSION",
  "PI_ROOT_SUBAGENT_BROKER_ENABLED",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "PI_AUTH",
  "PI_PROVIDER",
];

function initEnvironment({ home, fakeBin, commandLog, fixtureRepo, fakePi, root }) {
  const env = {
    PATH: `${fakeBin}:${systemPath}`,
    HOME: home,
    ZDOTDIR: home,
    TMPDIR: root,
    TERM: "dumb",
    COMMAND_LOG: commandLog,
    FIXTURE_REPO: fixtureRepo,
    REAL_NODE: process.execPath,
    PI_REAL_BIN: fakePi,
    FAKE_PI_MARKER: join(root, "fake-pi-marker"),
    PI_CODING_AGENT_DIR: join(root, "agent-dir"),
    PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
    PI_SESSION_OWNER_REGISTRY: join(root, "registry"),
  };
  for (const name of blockedEnvironmentNames) delete env[name];
  return env;
}

function assertCompleted(result) {
  assert.equal(result.error, undefined, `init-pi.sh failed: ${result.error?.message ?? result.stderr}`);
  assert.notEqual(result.signal, "SIGTERM", `init-pi.sh timed out: ${result.stderr}`);
}

test("init-pi.sh reproducibly installs Pi without reading OpenCode credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "init-pi-"));
  try {
    const fixtureRepo = join(root, "pi-config");
    const home = join(root, "home");
    const fakeBin = join(root, "bin");
    const commandLog = join(root, "commands.log");
    const fakePi = join(fakeBin, "pi-real");

    await mkdir(join(fixtureRepo, "scripts"), { recursive: true });
    await mkdir(join(fixtureRepo, "pi"), { recursive: true });
    await mkdir(join(fixtureRepo, "packages", "pi-subagents-enhanced"), { recursive: true });
    await mkdir(join(fixtureRepo, "skill-overrides", "external-llm-review", "tests"), { recursive: true });
    await mkdir(join(home, ".local", "share", "opencode"), { recursive: true });
    await mkdir(fakeBin, { recursive: true });
    await copyFile(join(repoRoot, "init-pi.sh"), join(fixtureRepo, "init-pi.sh"));
    await copyFile(join(repoRoot, "scripts", "pi-shell.zsh"), join(fixtureRepo, "scripts", "pi-shell.zsh"));
    await copyFile(join(repoRoot, "scripts", "pi-launcher.zsh"), join(fixtureRepo, "scripts", "pi-launcher.zsh"));
    await copyFile(join(repoRoot, "skill-overrides", "external-llm-review", "reviewer.py"), join(fixtureRepo, "skill-overrides", "external-llm-review", "reviewer.py"));
    await copyFile(join(repoRoot, "skill-overrides", "external-llm-review", "_config.py"), join(fixtureRepo, "skill-overrides", "external-llm-review", "_config.py"));
    await copyFile(join(repoRoot, "skill-overrides", "external-llm-review", "_provider.py"), join(fixtureRepo, "skill-overrides", "external-llm-review", "_provider.py"));
    await copyFile(join(repoRoot, "skill-overrides", "external-llm-review", "tests", "test_reviewer.py"), join(fixtureRepo, "skill-overrides", "external-llm-review", "tests", "test_reviewer.py"));
    await chmod(join(fixtureRepo, "init-pi.sh"), 0o755);

    for (const command of ["git", "uv", "zsh"]) {
      const commandPath = join(fakeBin, command);
      await writeFile(commandPath, `#!/usr/bin/env bash\nprintf '${command} %s markers=%s,%s,%s,%s\\n' "$*" "\${PI_SUBAGENT_CHILD:-}" "\${PI_SUBAGENT_FANOUT_CHILD:-}" "\${PI_SUBAGENT_PARENT_SESSION:-}" "\${PI_ROOT_SUBAGENT_BROKER_ENABLED:-}" >> "$COMMAND_LOG"\n`);
      await chmod(commandPath, 0o755);
    }
    const fakeNpm = join(fakeBin, "npm");
    await writeFile(
      fakeNpm,
      "#!/usr/bin/env bash\nprintf 'npm registry=%s %s markers=%s,%s,%s,%s\\n' \"${NPM_CONFIG_REGISTRY:-}\" \"$*\" \"${PI_SUBAGENT_CHILD:-}\" \"${PI_SUBAGENT_FANOUT_CHILD:-}\" \"${PI_SUBAGENT_PARENT_SESSION:-}\" \"${PI_ROOT_SUBAGENT_BROKER_ENABLED:-}\" >> \"$COMMAND_LOG\"\n",
    );
    await chmod(fakeNpm, 0o755);
    for (const [command, executable] of [["chmod", "/bin/chmod"], ["mkdir", "/bin/mkdir"], ["dirname", "/usr/bin/dirname"]]) {
      const commandPath = join(fakeBin, command);
      await writeFile(commandPath, `#!/usr/bin/env bash\nprintf '${command} %s\\n' "$*" >> "$COMMAND_LOG"\nexec ${executable} "$@"\n`);
      await chmod(commandPath, 0o755);
    }
    const fakeNode = join(fakeBin, "node");
    await writeFile(
      fakeNode,
      "#!/usr/bin/env bash\nif [[ \"$1\" == */scripts/setup-subagent-runtime-deps.ts && \"$2\" == \"--check-upgrade\" ]]; then printf 'node check-subagent-upgrade\\n' >> \"$COMMAND_LOG\"; exit 0; fi\nif [[ \"$1\" == */scripts/sync-skills.ts ]]; then printf 'node sync-skills markers=%s,%s,%s,%s\\n' \"${PI_SUBAGENT_CHILD:-}\" \"${PI_SUBAGENT_FANOUT_CHILD:-}\" \"${PI_SUBAGENT_PARENT_SESSION:-}\" \"${PI_ROOT_SUBAGENT_BROKER_ENABLED:-}\" >> \"$COMMAND_LOG\"; exit 0; fi\nprintf 'node %s\\n' \"$*\" >> \"$COMMAND_LOG\"\nexec \"$REAL_NODE\" \"$@\"\n",
    );
    await chmod(fakeNode, 0o755);
    await writeFile(
      fakePi,
      "#!/usr/bin/env bash\nprintf 'pi-real registry=%s %s\\n' \"${NPM_CONFIG_REGISTRY:-}\" \"$*\" >> \"$COMMAND_LOG\"\n",
    );
    await chmod(fakePi, 0o755);

    await writeFile(join(home, ".zshrc"), "export PRESERVED_SETTING=1\n");
    await writeFile(
      join(home, ".local", "share", "opencode", "auth.json"),
      `${JSON.stringify({ "openai-idealab": { type: "api", key: "fixture-secret" } })}\n`,
    );
    await writeFile(
      join(fixtureRepo, "pi", "auth.json"),
      `${JSON.stringify({ existing: { type: "api_key", key: "keep-me" } })}\n`,
      { mode: 0o600 },
    );

    const env = initEnvironment({ home, fakeBin, commandLog, fixtureRepo, fakePi, root });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = spawnSync("bash", [join(fixtureRepo, "init-pi.sh")], {
        cwd: fixtureRepo,
        encoding: "utf8",
        env,
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
      });
      assertCompleted(result);
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /fixture-secret/);
      assert.doesNotMatch(result.stdout, /OpenCode|openai-idealab credential/);
    }

    const zshrc = await readFile(join(home, ".zshrc"), "utf8");
    assert.match(zshrc, /export PRESERVED_SETTING=1/);
    assert.equal((zshrc.match(/# >>> pi-config >>>/g) ?? []).length, 1);
    assert.equal((zshrc.match(/# <<< pi-config <<</g) ?? []).length, 1);
    assert.match(zshrc, new RegExp(join(fixtureRepo, "scripts", "pi-shell\\.zsh").replaceAll("/", "\\/")));

    const piAuth = JSON.parse(await readFile(join(fixtureRepo, "pi", "auth.json"), "utf8"));
    assert.deepEqual(piAuth, {
      existing: { type: "api_key", key: "keep-me" },
    });
    assert.equal((await stat(join(fixtureRepo, "pi", "auth.json"))).mode & 0o777, 0o600);

    const commands = await readFile(commandLog, "utf8");
    assert.doesNotMatch(commands, /submodule/);
    assert.match(commands, /npm registry=https:\/\/registry\.npmjs\.org install -g --ignore-scripts @earendil-works\/pi-coding-agent@0\.84\.4/);
    assert.doesNotMatch(commands, /pi-real registry=.*install npm:pi-subagents/);
    assert.match(commands, /node check-subagent-upgrade/);
    assert.match(commands, /npm registry=https:\/\/registry\.npmjs\.org --prefix .* run setup:subagents-enhanced markers=,,,/);
    assert.ok(commands.indexOf("node check-subagent-upgrade") < commands.indexOf("run setup:subagents-enhanced"), "live-upgrade preflight must run before package setup mutates the package");
    assert.doesNotMatch(commands, /rpiv-todo/);
    assert.match(commands, /node sync-skills markers=,,,/);
    assert.match(commands, /npm registry= test markers=,,,/);
    assert.match(commands, /npm registry= run doctor markers=,,,/);
    assert.match(commands, /npm registry= run test:integration markers=,,,/);
    assert.match(commands, /uv run --no-project --with httpx --with python-dotenv --with pyyaml python -m unittest discover -s skill-overrides\/external-llm-review\/tests markers=,,,/);
    assert.match(commands, /uv tool install --force basic-memory==0\.22\.1 markers=,,,/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
