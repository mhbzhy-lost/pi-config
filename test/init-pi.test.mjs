import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
    await mkdir(join(fixtureRepo, "skill-overrides", "external-llm-review", "tests"), { recursive: true });
    await mkdir(join(home, ".local", "share", "opencode"), { recursive: true });
    await mkdir(fakeBin, { recursive: true });
    await copyFile(join(repoRoot, "init-pi.sh"), join(fixtureRepo, "init-pi.sh"));
    await copyFile(join(repoRoot, "scripts", "pi-shell.zsh"), join(fixtureRepo, "scripts", "pi-shell.zsh"));
    await copyFile(join(repoRoot, "skill-overrides", "external-llm-review", "reviewer.py"), join(fixtureRepo, "skill-overrides", "external-llm-review", "reviewer.py"));
    await copyFile(join(repoRoot, "skill-overrides", "external-llm-review", "_config.py"), join(fixtureRepo, "skill-overrides", "external-llm-review", "_config.py"));
    await copyFile(join(repoRoot, "skill-overrides", "external-llm-review", "_provider.py"), join(fixtureRepo, "skill-overrides", "external-llm-review", "_provider.py"));
    await copyFile(join(repoRoot, "skill-overrides", "external-llm-review", "tests", "test_reviewer.py"), join(fixtureRepo, "skill-overrides", "external-llm-review", "tests", "test_reviewer.py"));
    await chmod(join(fixtureRepo, "init-pi.sh"), 0o755);

    for (const command of ["git", "uv"]) {
      const commandPath = join(fakeBin, command);
      await writeFile(commandPath, `#!/usr/bin/env bash\nprintf '${command} %s markers=%s,%s,%s,%s\\n' "$*" "\${PI_SUBAGENT_CHILD:-}" "\${PI_SUBAGENT_FANOUT_CHILD:-}" "\${PI_SUBAGENT_PARENT_SESSION:-}" "\${PI_ROOT_SUBAGENT_BROKER_ENABLED:-}" >> "$COMMAND_LOG"\n`);
      await chmod(commandPath, 0o755);
    }
    const fakeNpm = join(fakeBin, "npm");
    await writeFile(
      fakeNpm,
      "#!/usr/bin/env bash\nprintf 'npm registry=%s %s markers=%s,%s,%s,%s\\n' \"${NPM_CONFIG_REGISTRY:-}\" \"$*\" \"${PI_SUBAGENT_CHILD:-}\" \"${PI_SUBAGENT_FANOUT_CHILD:-}\" \"${PI_SUBAGENT_PARENT_SESSION:-}\" \"${PI_ROOT_SUBAGENT_BROKER_ENABLED:-}\" >> \"$COMMAND_LOG\"\nif [[ \"$1\" == \"--prefix\" && \"$3\" == \"run\" && \"$4\" == \"setup:subagent-runtime\" ]]; then mkdir -p \"$2/pi/npm/node_modules/typebox\"; printf '{\\\"version\\\":\\\"1.1.38\\\"}' > \"$2/pi/npm/node_modules/typebox/package.json\"; fi\n",
    );
    await chmod(fakeNpm, 0o755);
    await writeFile(
      fakePi,
      "#!/usr/bin/env bash\nprintf 'pi-real registry=%s %s\\n' \"${NPM_CONFIG_REGISTRY:-}\" \"$*\" >> \"$COMMAND_LOG\"\nif [[ \"$1\" == \"install\" && \"$2\" == \"npm:pi-subagents@0.37.2\" ]]; then mkdir -p \"$PI_CODING_AGENT_DIR/npm/node_modules/pi-subagents\"; printf '{\\\"version\\\":\\\"0.37.2\\\"}' > \"$PI_CODING_AGENT_DIR/npm/node_modules/pi-subagents/package.json\"; printf 'export default {};\\n' > \"$PI_CODING_AGENT_DIR/npm/node_modules/pi-subagents/index.js\"; fi\n",
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

    const env = {
      ...process.env,
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH}`,
      COMMAND_LOG: commandLog,
      PI_REAL_BIN: fakePi,
      PI_SUBAGENT_CHILD: "1",
      PI_SUBAGENT_FANOUT_CHILD: "1",
      PI_SUBAGENT_PARENT_SESSION: "parent-session",
      PI_ROOT_SUBAGENT_BROKER_ENABLED: "1",
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = spawnSync("bash", [join(fixtureRepo, "init-pi.sh")], {
        cwd: fixtureRepo,
        encoding: "utf8",
        env,
      });
      assert.equal(result.error, undefined, result.error?.message);
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
    assert.match(commands, /git -C .* submodule update --init --recursive markers=1,1,parent-session,1/);
    assert.match(commands, /npm registry=https:\/\/registry\.npmjs\.org install -g --ignore-scripts @earendil-works\/pi-coding-agent@0\.83\.0/);
    assert.match(commands, /pi-real registry=https:\/\/registry\.npmjs\.org install npm:pi-subagents@0\.37\.2/);
    assert.doesNotMatch(commands, /rpiv-todo/);
    assert.match(commands, /npm registry=https:\/\/registry\.npmjs\.org --prefix .* run setup:subagent-runtime markers=1,1,parent-session,1/);
    const typeboxPackage = JSON.parse(await readFile(join(fixtureRepo, "pi", "npm", "node_modules", "typebox", "package.json"), "utf8"));
    assert.equal(typeboxPackage.version, "1.1.38");
    assert.match(commands, /npm registry= test markers=,,,/);
    assert.match(commands, /npm registry= run doctor markers=,,,/);
    assert.match(commands, /npm registry= run test:integration markers=,,,/);
    assert.match(commands, /uv run --no-project --with httpx --with python-dotenv --with pyyaml python -m unittest discover -s skill-overrides\/external-llm-review\/tests markers=,,,/);
    assert.match(commands, /uv tool install --force basic-memory==0\.22\.1 markers=1,1,parent-session,1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
