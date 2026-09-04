import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { resolvePiHostPaths } from "./helpers/pi-host.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const packageRoot = join(repoRoot, "packages/pi-subagents-enhanced");
const hostResolutionEnv = { ...process.env };
for (const key of [
  "npm_config_prefix", "npm_config_global_prefix", "npm_config_globalconfig",
  "NPM_CONFIG_PREFIX", "NPM_CONFIG_GLOBAL_PREFIX", "NPM_CONFIG_GLOBALCONFIG",
]) delete hostResolutionEnv[key];
const { piHostAliases } = resolvePiHostPaths({
  env: hostResolutionEnv,
  readGlobalNodeModules: () => execFileSync("npm", ["root", "-g"], { encoding: "utf8", env: hostResolutionEnv }).trim(),
});
const forbiddenLocalPeers = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];

async function metadata(root = packageRoot) {
  return JSON.parse(await readFile(join(root, "package.json"), "utf8"));
}

test("pi-subagents-enhanced exposes a publishable pinned package contract", async () => {
  const rootManifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  const manifest = await metadata();
  assert.equal(rootManifest.private, true);
  assert.deepEqual({
    test: rootManifest.scripts["test:subagents-enhanced"],
    workspace: rootManifest.scripts["test:subagent-workspace"],
    goal: rootManifest.scripts["test:goal-engine"],
    setup: rootManifest.scripts["setup:subagents-enhanced"],
    verify: rootManifest.scripts["verify:subagents-enhanced"],
  }, {
    test: "npm --prefix packages/pi-subagents-enhanced test",
    workspace: "node --test test/managed-workspace-contract.test.mjs test/managed-workspace-ledger.integration.mjs test/managed-workspace-service.integration.mjs test/subagent-managed-worktree.integration.mjs",
    goal: "node --test \"test/goal-engine-*.integration.mjs\"",
    setup: "node scripts/setup-subagent-runtime-deps.ts",
    verify: "npm --prefix packages/pi-subagents-enhanced run verify:package",
  });
  assert.equal(manifest.name, "pi-subagents-enhanced");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.private, undefined);
  assert.deepEqual(manifest.engines, { node: ">=22.19.0" });
  assert.deepEqual(manifest.pi.extensions, ["./extensions/subagent-runtime.ts", "./extensions/custom-footer.ts"]);
  assert.deepEqual(manifest.exports, {
    "./dispatch-ir": "./src/contracts/dispatch-ir.ts",
    "./workspace": "./src/workspace/service.ts",
    "./workspace/admin": "./src/workspace/administration.ts",
  });
  assert.equal(manifest.dependencies["pi-subagents"], "0.62.0");
  assert.deepEqual(manifest.bundleDependencies, ["pi-subagents"]);
  assert.equal(Object.hasOwn(manifest, "bundledDependencies"), false);
  assert.deepEqual(manifest.peerDependencies, {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-agent-core": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    typebox: "*",
  });
});

test("package setup and verify exercise the package-local patched upstream", async () => {
  const setup = await import("../packages/pi-subagents-enhanced/scripts/setup-runtime-deps.ts");
  const verify = await import("../packages/pi-subagents-enhanced/scripts/verify-package.ts");
  assert.equal(typeof setup.setupRuntimeDependencies, "function");
  assert.equal(typeof verify.verifyEnhancedPackage, "function");
  const calls = [];
  await setup.setupRuntimeDependencies({
    root: packageRoot,
    run: async (...args) => { calls.push(args); },
    patch: async () => {},
  });
  assert.deepEqual(calls[0]?.[1], [
    "install", "--prefix", packageRoot, "--ignore-scripts", "--omit=peer", "--save-exact", "pi-subagents@0.62.0",
  ]);
  const report = await verify.verifyEnhancedPackage({ packageRoot });
  assert.deepEqual({ name: report.name, version: report.version, upstreamVersion: report.upstreamVersion, patched: report.patched }, {
    name: "pi-subagents-enhanced",
    version: "0.1.0",
    upstreamVersion: "0.62.0",
    patched: true,
  });
  assert.ok(report.tarball.fileCount > 0);
  assert.ok(report.tarball.unpackedSize > 0);
});

test("npm dry-run tarball contains the complete runtime closure and no repository-private files", async () => {
  const tarballs = async () => (await readdir(packageRoot)).filter((name) => name.endsWith(".tgz")).sort();
  const before = await tarballs();
  const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: packageRoot, encoding: "utf8" }))[0];
  const paths = packed.files.map((file) => file.path);
  const required = [
    "extensions/subagent-runtime.ts",
    "extensions/custom-footer.ts",
    "child-extensions/root-session-owner.ts",
    "child-extensions/acceptance-evidence.ts",
    "scripts/setup-runtime-deps.ts",
    "scripts/verify-package.ts",
    "src/compat/pi-subagents-0.62.ts",
    "src/subagent-dispatch/extension.ts",
    "src/subagent-dispatch/root-broker-server.ts",
    "src/tui/native-conversation.ts",
    "src/tui/session-browser.ts",
    "src/contracts/dispatch-ir.ts",
    "src/workspace/contract.ts",
    "src/workspace/ledger.ts",
    "src/workspace/git-worktree.ts",
    "src/workspace/service.ts",
    "src/workspace/registry.ts",
    "src/workspace/administration.ts",
    "node_modules/pi-subagents/package.json",
    "node_modules/pi-subagents/src/agents/agents.ts",
    "node_modules/acorn/package.json",
    "node_modules/jiti/package.json",
    "node_modules/pi-subagents/node_modules/typebox/package.json",
    "node_modules/pi-subagents/node_modules/yaml/package.json",
  ];
  for (const path of required) assert.ok(paths.includes(path), `missing tarball path: ${path}`);
  const retired = [
    "src/subagent-dispatch/workspace.ts",
    "src/subagent-dispatch/workspace-controller.ts",
    "src/subagent-dispatch/workspace-ledger.ts",
    "src/goal-support/workspace.ts",
    "src/worktree-lifecycle/inventory.ts",
    "src/worktree-lifecycle/managed-worktree.ts",
    "src/worktree-lifecycle/registry.ts",
  ];
  for (const path of retired) assert.equal(paths.includes(path), false, `retired tarball path: ${path}`);
  for (const path of paths) {
    assert.equal(isAbsolute(path), false, path);
    assert.equal(path.split("/").includes(".."), false, path);
    assert.doesNotMatch(path, /^(?:pi\/|test\/|tests\/|var\/|\.state\/)/, path);
    assert.doesNotMatch(path, /(?:^|\/)(?:settings|models|auth)\.json$|(?:^|\/)sessions(?:\/|$)|(?:^|\/)logs?(?:\/|$)|\.log$/i, path);
    assert.doesNotMatch(path, /(?:^|\/)node_modules\/@earendil-works\/(?:pi-agent-core|pi-ai|pi-coding-agent|pi-tui)(?:\/|$)/, path);
  }
  assert.deepEqual(packed.bundled.includes("pi-subagents"), true);
  assert.deepEqual(await tarballs(), before);
});

test("package setup leaves Pi core peers owned exclusively by the host", async () => {
  for (const peer of forbiddenLocalPeers) {
    await assert.rejects(lstat(join(packageRoot, "node_modules", peer)), { code: "ENOENT" }, peer);
  }
  assert.equal((await metadata(join(packageRoot, "node_modules/pi-subagents/node_modules/typebox"))).name, "typebox");
});

test("compat imports every required upstream API from package-local pi-subagents", async () => {
  const { createJiti } = await import(new URL("../packages/pi-subagents-enhanced/node_modules/jiti/lib/jiti.mjs", import.meta.url));
  const jiti = createJiti(import.meta.url, { moduleCache: false, alias: piHostAliases });
  const compat = await jiti.import("../packages/pi-subagents-enhanced/src/compat/pi-subagents-0.62.ts");
  for (const name of [
    "upstreamSubagentRuntime", "loadConfig", "registerSubagentNotify", "resolveCurrentSessionId",
    "currentCompletionOwnerId", "getArtifactsDir", "readFleetTranscript", "renderFleetTranscript",
  ]) assert.equal(typeof compat[name], "function", name);
});

test("package verification rejects upstream drift, missing patch, and escaping extension entries", async (t) => {
  const { verifyEnhancedPackage } = await import("../packages/pi-subagents-enhanced/scripts/verify-package.ts");
  const fixture = async (name) => {
    const root = await mkdtemp(join(tmpdir(), `enhanced-${name}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "node_modules"), { recursive: true });
    await cp(join(packageRoot, "package.json"), join(root, "package.json"));
    return root;
  };

  const drift = await fixture("drift");
  await mkdir(join(drift, "node_modules/pi-subagents"), { recursive: true });
  await writeFile(join(drift, "node_modules/pi-subagents/package.json"), JSON.stringify({ name: "pi-subagents", version: "0.63.0" }));
  await assert.rejects(() => verifyEnhancedPackage({ packageRoot: drift }), /0\.62\.0|version/i);

  const escaping = await fixture("escape");
  const escapingManifest = await metadata(escaping);
  escapingManifest.pi.extensions[0] = "../outside.ts";
  await writeFile(join(escaping, "package.json"), JSON.stringify(escapingManifest));
  await assert.rejects(() => verifyEnhancedPackage({ packageRoot: escaping }), /outside|escape|package/i);

  const unpatched = await fixture("unpatched");
  await cp(join(packageRoot, "node_modules/pi-subagents"), join(unpatched, "node_modules/pi-subagents"), { recursive: true });
  const agentsPath = join(unpatched, "node_modules/pi-subagents/src/agents/agents.ts");
  await writeFile(agentsPath, (await readFile(agentsPath, "utf8")).replace("// pi-config patch: ordered-models.v3", ""));
  await assert.rejects(() => verifyEnhancedPackage({ packageRoot: unpatched }), /patch/i);

  for (const [index, peer] of forbiddenLocalPeers.entries()) {
    const duplicatedPeer = await fixture(`peer-${index}`);
    await cp(join(packageRoot, "node_modules/pi-subagents"), join(duplicatedPeer, "node_modules/pi-subagents"), { recursive: true });
    await mkdir(join(duplicatedPeer, "node_modules", peer), { recursive: true });
    await writeFile(join(duplicatedPeer, "node_modules", peer, "package.json"), JSON.stringify({ name: peer, version: "0.84.4" }));
    await assert.rejects(() => verifyEnhancedPackage({ packageRoot: duplicatedPeer }), /peer|duplicate|module identity/i, peer);
  }

  const escapingImport = await fixture("escaping-import");
  await mkdir(join(escapingImport, "extensions"), { recursive: true });
  await mkdir(join(escapingImport, "src"), { recursive: true });
  await mkdir(join(escapingImport, "node_modules/pi-subagents"), { recursive: true });
  await writeFile(join(escapingImport, "extensions/subagent-runtime.ts"), 'export * from "../../../outside.ts";\n');
  await writeFile(join(escapingImport, "extensions/custom-footer.ts"), "export default function footer() {}\n");
  await writeFile(join(escapingImport, "node_modules/pi-subagents/package.json"), JSON.stringify({ name: "pi-subagents", version: "0.62.0" }));
  await assert.rejects(
    () => verifyEnhancedPackage({ packageRoot: escapingImport, verifyPatch: async () => {}, runPack: async () => ({ files: [] }) }),
    /import|escape|outside|package root/i,
  );
});
