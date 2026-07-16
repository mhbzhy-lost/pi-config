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

    for (const command of ["git", "npm"]) {
      const commandPath = join(fakeBin, command);
      await writeFile(commandPath, `#!/usr/bin/env bash\nprintf '%s\\n' '${command} '"$*" >> "$COMMAND_LOG"\n`);
      await chmod(commandPath, 0o755);
    }
    await writeFile(
      fakePi,
      "#!/usr/bin/env bash\nprintf 'pi-real %s\\n' \"$*\" >> \"$COMMAND_LOG\"\nif [[ \"$1\" == \"install\" ]]; then mkdir -p \"$PI_CODING_AGENT_DIR/npm/node_modules/pi-subagents\"; printf '{\\\"version\\\":\\\"0.34.0\\\"}' > \"$PI_CODING_AGENT_DIR/npm/node_modules/pi-subagents/package.json\"; printf 'export default {};\\n' > \"$PI_CODING_AGENT_DIR/npm/node_modules/pi-subagents/index.js\"; fi\n",
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
    assert.match(commands, /git -C .* submodule update --init --recursive/);
    assert.match(commands, /npm install -g --ignore-scripts @earendil-works\/pi-coding-agent@0\.80\.6/);
    assert.match(commands, /pi-real install npm:pi-subagents@0\.34\.0/);
    assert.match(commands, /npm test/);
    assert.match(commands, /npm run doctor/);
    assert.match(commands, /npm run test:integration/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
