import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createRegistryStore, listLiveRecords } from "../src/session-owner/registry.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const systemPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
const childEnvironmentNames = [
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

function environment(state, extra = {}) {
  const env = {
    PATH: `${state.bin}:${systemPath}`,
    HOME: state.home,
    ZDOTDIR: state.zsh,
    TMPDIR: state.root,
    TERM: "dumb",
    REAL_NODE: process.execPath,
    COMMAND_LOG: state.commandLog,
    FAKE_PI_MARKER: state.marker,
    PI_REAL_BIN: state.fakePi,
    PI_CODING_AGENT_DIR: join(state.root, "isolated-agent-dir"),
    PI_CODING_AGENT_SESSION_DIR: join(state.root, "isolated-sessions"),
    PI_SESSION_OWNER_REGISTRY: state.registry,
    ...extra,
  };
  for (const name of childEnvironmentNames) delete env[name];
  return env;
}

function assertCompleted(result, label) {
  assert.equal(result.error, undefined, `${label} failed: ${result.error?.message ?? result.stderr}`);
  assert.notEqual(result.signal, "SIGTERM", `${label} timed out: ${result.stderr}`);
}

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-session-owner-install-"));
  const repo = join(root, "installed-pi-config");
  const home = join(root, "home");
  const zsh = join(root, "zsh");
  const bin = join(root, "bin");
  const marker = join(root, "fake-pi.json");
  const commandLog = join(root, "commands.log");
  const registry = join(root, "registry");
  await Promise.all([mkdir(repo, { recursive: true }), mkdir(home, { recursive: true }), mkdir(zsh, { recursive: true }), mkdir(bin, { recursive: true })]);
  await Promise.all([
    cp(join(repoRoot, "init-pi.sh"), join(repo, "init-pi.sh")),
    cp(join(repoRoot, "scripts"), join(repo, "scripts"), { recursive: true }),
    cp(join(repoRoot, "src"), join(repo, "src"), { recursive: true }),
    cp(join(repoRoot, "pi", "extensions"), join(repo, "pi", "extensions"), { recursive: true }),
  ]);
  await chmod(join(repo, "init-pi.sh"), 0o755);
  await chmod(join(repo, "scripts", "pi-launcher.zsh"), 0o644);
  await writeFile(join(zsh, ".zshrc"), "export PRESERVED_FROM_FRESH_INSTALL=1\n");

  for (const name of ["git", "npm", "uv"]) {
    const command = join(bin, name);
    await writeFile(command, `#!/usr/bin/env bash\nprintf '${name} %s\\n' "$*" >> "$COMMAND_LOG"\n`);
    await chmod(command, 0o755);
  }
  const fakeZsh = `#!/usr/bin/env bash
printf 'zsh %s\\n' "$*" >> "$COMMAND_LOG"
exec /bin/zsh "$@"
`;
  assert.match(fakeZsh, /exec \/bin\/zsh "\$@"/);
  await writeFile(join(bin, "zsh"), fakeZsh);
  await chmod(join(bin, "zsh"), 0o755);
  for (const [name, command] of [["chmod", "/bin/chmod"], ["mkdir", "/bin/mkdir"], ["dirname", "/usr/bin/dirname"]]) {
    const fake = join(bin, name);
    await writeFile(fake, `#!/usr/bin/env bash\nprintf '${name} %s\\n' "$*" >> "$COMMAND_LOG"\nexec ${command} "$@"\n`);
    await chmod(fake, 0o755);
  }
  await writeFile(join(bin, "node"), `#!/usr/bin/env bash
printf 'node %s\\n' "$*" >> "$COMMAND_LOG"
if [[ "$1" == */scripts/setup-subagent-runtime-deps.ts || "$1" == */scripts/sync-skills.ts ]]; then exit 0; fi
exec "$REAL_NODE" "$@"
`);
  await chmod(join(bin, "node"), 0o755);

  const packageRoot = join(root, "fake-pi-package");
  const fakePi = join(packageRoot, "bin", "pi-real");
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module" }));
  await writeFile(join(packageRoot, "dist", "index.js"), "export const SessionManager = { async list() { return []; } };\n");
  await writeFile(fakePi, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) { process.stdout.write("0.84.4\\n"); process.exit(0); }
writeFileSync(process.env.FAKE_PI_MARKER, JSON.stringify({ argv: process.argv.slice(2), ownerId: process.env.PI_SESSION_OWNER_ID, registry: process.env.PI_SESSION_OWNER_REGISTRY, agentDir: process.env.PI_CODING_AGENT_DIR, sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR }));
`);
  await chmod(fakePi, 0o755);
  await symlink(fakePi, join(bin, "pi"));
  return { root, repo, home, zsh, bin, marker, commandLog, registry, fakePi };
}

function runInit(state) {
  return spawnSync("bash", [join(state.repo, "init-pi.sh")], {
    cwd: state.repo,
    encoding: "utf8",
    env: environment(state),
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  });
}

function runFreshZsh(state) {
  const program = `set timeout 10
spawn -noecho /bin/zsh -f -c {source "$ZDOTDIR/.zshrc"; type pi > "$TYPE_MARKER"; pi --no-extensions -- fresh-install}
expect eof
set status [lindex [wait] 3]
exit $status
`;
  return spawnSync("/usr/bin/expect", ["-c", program], {
    cwd: state.repo,
    encoding: "utf8",
    env: environment(state, { TYPE_MARKER: join(state.root, "type-pi.txt") }),
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  });
}

function runOfficialFreshZsh(state) {
  const program = `set timeout 20
spawn -noecho /bin/zsh -f -c {source "$ZDOTDIR/.zshrc"; export PI_CODING_AGENT_DIR="$ISOLATED_AGENT_DIR" PI_CODING_AGENT_SESSION_DIR="$ISOLATED_SESSION_DIR" PI_SESSION_OWNER_REGISTRY="$ISOLATED_REGISTRY"; pi --version}
expect {
  -re {0\\.84\\.4} {}
  eof { exit 1 }
  timeout { exit 1 }
}
expect eof
set status [lindex [wait] 3]
exit $status
`;
  return spawnSync("/usr/bin/expect", ["-c", program], {
    cwd: state.repo,
    encoding: "utf8",
    env: environment(state, {
      PI_REAL_BIN: "/opt/homebrew/bin/pi",
      ISOLATED_AGENT_DIR: join(state.root, "official-agent-dir"),
      ISOLATED_SESSION_DIR: join(state.root, "official-sessions"),
      ISOLATED_REGISTRY: state.registry,
    }),
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
}

async function verifyInstalled(state) {
  const zshrc = await readFile(join(state.zsh, ".zshrc"), "utf8");
  assert.match(zshrc, /PRESERVED_FROM_FRESH_INSTALL=1/);
  assert.equal((zshrc.match(/# >>> pi-config >>>/g) ?? []).length, 1);
  assert.equal((zshrc.match(/# <<< pi-config <<</g) ?? []).length, 1);
  assert.match(zshrc, new RegExp(join(state.repo, "scripts", "pi-shell.zsh").replaceAll("/", "\\/")));
  assert.equal((await stat(join(state.repo, "scripts", "pi-launcher.zsh"))).mode & 0o111, 0o111);
  await stat(join(state.repo, "scripts", "pi-session-owner.ts"));
  await stat(join(state.repo, "pi", "extensions", "session-owner.ts"));
  const result = runFreshZsh(state);
  assertCompleted(result, "fresh zsh");
  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(join(await realpath(state.root), "type-pi.txt"), "utf8"), /pi is a shell function/);
  const invocation = JSON.parse(await readFile(state.marker, "utf8"));
  assert.equal(invocation.agentDir, await realpath(join(state.repo, "pi")));
  assert.equal(invocation.sessionDir, join(state.root, "isolated-sessions"));
  assert.ok(typeof invocation.ownerId === "string" && invocation.ownerId.length >= 8);
  assert.equal(invocation.registry, state.registry);
  assert.deepEqual(invocation.argv, ["-e", join(await realpath(state.repo), "pi", "extensions", "session-owner.ts"), "--no-skills", "--no-extensions", "--", "fresh-install"]);
}

test("fresh init installs an idempotent owner-wrapper shell entrypoint", async () => {
  const state = await makeFixture();
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = runInit(state);
      assertCompleted(result, "init-pi.sh");
      assert.equal(result.status, 0, result.stderr);
    }
    await verifyInstalled(state);
    assert.match(await readFile(state.commandLog, "utf8"), /npm (?:--no-audit --no-fund )?--prefix .* run setup:subagents-enhanced/);
    assert.doesNotMatch(await readFile(join(state.repo, "init-pi.sh"), "utf8"), /var\/upstream\/pi/);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("fresh zsh wrapper invokes official Pi version in an isolated environment and cleans its ESRCH record", async () => {
  const state = await makeFixture();
  try {
    const init = runInit(state);
    assertCompleted(init, "init-pi.sh");
    assert.equal(init.status, 0, init.stderr);
    await Promise.all([
      mkdir(join(state.root, "official-agent-dir"), { recursive: true, mode: 0o700 }),
      mkdir(join(state.root, "official-sessions"), { recursive: true, mode: 0o700 }),
      mkdir(state.registry, { recursive: true, mode: 0o700 }),
    ]);
    const result = runOfficialFreshZsh(state);
    assertCompleted(result, "official fresh zsh");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /0\.84\.4/);
    assert.deepEqual(await listLiveRecords(createRegistryStore(state.registry)), []);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("fresh-install verifier rejects broken shell, launcher permission, and extension wiring fixtures", async () => {
  const mutations = [
    {
      mutate: async (state) => writeFile(join(state.repo, "scripts", "pi-shell.zsh"), "pi() { command pi \"$@\"; }\n"),
      verifyRejection: async (state) => {
        const invocation = JSON.parse(await readFile(state.marker, "utf8"));
        assert.equal(invocation.ownerId, undefined);
        assert.doesNotMatch(invocation.argv.join(" "), /(^| )-e( |$)/);
        assert.deepEqual(invocation.argv, ["--no-extensions", "--", "fresh-install"]);
      },
    },
    { mutate: async (state) => chmod(join(state.repo, "scripts", "pi-launcher.zsh"), 0o644) },
    { mutate: async (state) => rm(join(state.repo, "pi", "extensions", "session-owner.ts")) },
  ];
  for (const { mutate, verifyRejection } of mutations) {
    const state = await makeFixture();
    try {
      const result = runInit(state);
      assertCompleted(result, "init-pi.sh");
      assert.equal(result.status, 0, result.stderr);
      await mutate(state);
      await assert.rejects(() => verifyInstalled(state));
      await verifyRejection?.(state);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  }
});
