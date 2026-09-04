import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertSafeSubagentRuntimeUpgrade, installSubagentRuntimeDependencies } from "../scripts/setup-subagent-runtime-deps.ts";

async function enhancedFixture(t, version) {
  const root = await mkdtemp(join(tmpdir(), "subagent-enhanced-setup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (version) {
    const upstream = join(root, "node_modules", "pi-subagents");
    await mkdir(upstream, { recursive: true });
    await writeFile(join(upstream, "package.json"), JSON.stringify({ name: "pi-subagents", version }));
  }
  return root;
}

test("runtime dependency setup rejects a package-local cross-version upgrade from inside an active Pi session before mutation", async (t) => {
  const enhancedPackageRoot = await enhancedFixture(t, "0.45.2");
  const piNpmDir = await mkdtemp(join(tmpdir(), "subagent-scheduler-"));
  t.after(() => rm(piNpmDir, { recursive: true, force: true }));
  const calls = [];

  await assert.rejects(
    () => installSubagentRuntimeDependencies({
      enhancedPackageRoot,
      piNpmDir,
      env: { PI_ROOT_SUBAGENT_BROKER_ENABLED: "1" },
      async run(...args) { calls.push(args); },
      patchSubagentRuntime: async () => {},
    }),
    (error) => error?.code === "SUBAGENT_RUNTIME_LIVE_UPGRADE"
      && /0\.45\.2/.test(error.message)
      && /0\.62\.0/.test(error.message)
      && /fresh Host/.test(error.message),
  );
  assert.deepEqual(calls, []);
});

test("runtime upgrade preflight allows an external terminal and an active same-version enhanced package", async (t) => {
  const enhancedPackageRoot = await enhancedFixture(t, "0.45.2");
  const packageJsonPath = join(enhancedPackageRoot, "node_modules", "pi-subagents", "package.json");
  await assert.doesNotReject(() => assertSafeSubagentRuntimeUpgrade({ enhancedPackageRoot, env: {} }));

  await writeFile(packageJsonPath, JSON.stringify({ name: "pi-subagents", version: "0.62.0" }));
  await assert.doesNotReject(() => assertSafeSubagentRuntimeUpgrade({
    enhancedPackageRoot,
    env: { PI_ROOT_SUBAGENT_BROKER_ENABLED: "1" },
  }));
});

test("runtime dependency setup coordinates the enhanced package and scheduler without installing standalone upstream", async (t) => {
  const enhancedPackageRoot = await enhancedFixture(t, "0.62.0");
  const piNpmDir = await mkdtemp(join(tmpdir(), "subagent-scheduler-"));
  t.after(() => rm(piNpmDir, { recursive: true, force: true }));
  const calls = [];

  const result = await installSubagentRuntimeDependencies({
    enhancedPackageRoot,
    piNpmDir,
    env: {},
    async run(command, args) { calls.push([command, ...args]); },
    patchSubagentRuntime: async () => {},
  });

  assert.deepEqual(result, { piNpmDir, enhancedPackageRoot });
  assert.deepEqual(calls, [
    ["npm", "uninstall", "--prefix", piNpmDir, "@juicesharp/rpiv-todo", "pi-subagents", "typebox"],
    ["npm", "install", "--prefix", enhancedPackageRoot, "--ignore-scripts", "--omit=peer"],
    ["npm", "--prefix", enhancedPackageRoot, "run", "setup:runtime"],
    ["npm", "--prefix", enhancedPackageRoot, "run", "verify:package"],
    ["npm", "install", "--prefix", piNpmDir, "--omit=peer", "--save-exact", "@amaster.ai/pi-task-scheduler@0.1.9", "@amaster.ai/pi-shared@0.1.9", "croner@10.0.1"],
  ]);
  assert.equal(calls.some((call) => call.some((arg) => /^pi-subagents@/.test(arg))), false);
});
