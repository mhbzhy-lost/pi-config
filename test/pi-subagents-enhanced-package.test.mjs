import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { cp, lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after } from "node:test";
import test from "node:test";
import { resolvePiHostPaths } from "./helpers/pi-host.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const packageRoot = join(repoRoot, "packages/pi-subagents-enhanced");
// 公开 SDK alias 取自本仓物理 Host（物理根 = <repo>/node_modules/@earendil-works/pi-coding-agent），
// 不再经 `npm root -g` 解析全局旧 Host：全局 Pi 的 theme/API 面与本仓断言不符，且越出隔离边界。
const { piHostAliases } = resolvePiHostPaths();
const forbiddenLocalPeers = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];

let fixtureRoot;
let fixturePromise;
async function preparedPackageFixture() {
  if (!fixturePromise) fixturePromise = (async () => {
    fixtureRoot = join(await mkdtemp(join(tmpdir(), "enhanced-runtime-fixture-")), "package");
    await cp(packageRoot, fixtureRoot, {
      recursive: true,
      filter: (source) => !source.endsWith("/node_modules") && !source.endsWith("/package-lock.json") && !source.endsWith(".tgz"),
    });
    const manifest = await metadata(fixtureRoot);
    delete manifest.bundleDependencies;
    await writeFile(join(fixtureRoot, "package.json"), JSON.stringify(manifest));
    const setup = await import("../packages/pi-subagents-enhanced/scripts/setup-runtime-deps.ts");
    await setup.setupRuntimeDependencies({ root: fixtureRoot });
    // 独立fixture显式提供Host TypeBox peer；不把本仓生产依赖扩大为runtime authority。
    // npm 入口走 PATH 上的标准 CLI（不钉死具体 prefix/安装布局），仍只用官方源与仓库自己的 cache，
    // 安装目标始终是该 mkdtemp fixture，不触碰任何全局或正式 node_modules。
    execFileSync("npm", ["install", "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", "typebox@1.3.27"], {
      cwd: fixtureRoot,
      env: { ...process.env, NPM_CONFIG_REGISTRY: "https://registry.npmjs.org", npm_config_cache: process.env.npm_config_cache ?? join(repoRoot, "var/tmp/npm-cache") },
    });
    manifest.bundleDependencies = ["pi-subagents"];
    await writeFile(join(fixtureRoot, "package.json"), JSON.stringify(manifest));
    return fixtureRoot;
  })();
  return fixturePromise;
}
after(async () => {
  if (fixtureRoot) await rm(dirname(fixtureRoot), { recursive: true, force: true });
});

async function metadata(root = packageRoot) {
  return JSON.parse(await readFile(join(root, "package.json"), "utf8"));
}

test("both npm verification entry points default cache under the repository root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "enhanced-cache-entrypoints-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fakeNpm = join(root, "npm");
  const capture = join(root, "cache-path");
  await writeFile(fakeNpm, `#!/bin/sh
printf '%s' "$npm_config_cache" > "$CAPTURE"
case " $* " in
  *" --dry-run "*) printf '[{"files":[],"bundled":[]}]\\n' ;;
  *) mkdir -p "$PWD/payload/package"; printf '{"name":"pi-subagents","version":"0.79.2"}\\n' > "$PWD/payload/package/package.json"; tar -czf "$PWD/pi-subagents-0.79.2.tgz" -C "$PWD/payload" package; printf '[{"filename":"pi-subagents-0.79.2.tgz"}]\\n' ;;
esac
`);
  await execFileSync("chmod", ["+x", fakeNpm]);
  const verify = await import("../packages/pi-subagents-enhanced/scripts/verify-package.ts");
  const originalPath = process.env.PATH;
  const originalHome = process.env.HOME;
  const originalCache = process.env.npm_config_cache;
  process.env.PATH = `${root}:${originalPath}`;
  process.env.HOME = join(root, "home");
  delete process.env.npm_config_cache;
  process.env.CAPTURE = capture;
  try {
    const upstream = await verify.npmPackUpstream("0.79.2");
    await upstream.cleanup();
    assert.equal(await readFile(capture, "utf8"), join(repoRoot, "var/tmp/npm-cache"));
    await verify.npmPackDryRun(root);
    assert.equal(await readFile(capture, "utf8"), join(repoRoot, "var/tmp/npm-cache"));
    process.env.npm_config_cache = join(root, "explicit-cache");
    const overridden = await verify.npmPackUpstream("0.79.2");
    await overridden.cleanup();
    assert.equal(await readFile(capture, "utf8"), join(root, "explicit-cache"));
    await verify.npmPackDryRun(root);
    assert.equal(await readFile(capture, "utf8"), join(root, "explicit-cache"));
  } finally {
    process.env.PATH = originalPath;
    process.env.HOME = originalHome;
    if (originalCache === undefined) delete process.env.npm_config_cache;
    else process.env.npm_config_cache = originalCache;
    delete process.env.CAPTURE;
  }
});

test("pi-subagents-enhanced exposes a publishable pinned package contract", async () => {
  const rootManifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  const manifest = await metadata();
  assert.equal(rootManifest.private, true);
  // Pi 1.3.0 起四个核心包只声明精确版本（当前 pi-coding-agent -> pi-codemode@1.4.0），
  // 不再存在 ^1.0.4 漂移源，因此旧的 1.0.4 codemode override 已删除；
  // 这里改为断言 override 不再存在，且干净闭包解析出的就是 1.4.0。
  assert.equal(Object.hasOwn(rootManifest, "overrides"), false);
  assert.equal(Object.hasOwn(manifest, "overrides"), false);
  const rootLock = JSON.parse(await readFile(join(repoRoot, "package-lock.json"), "utf8"));
  const lockedCodemode = Object.entries(rootLock.packages).filter(([path]) => path.endsWith("node_modules/@earendil-works/pi-codemode"));
  assert.ok(lockedCodemode.length > 0, "根 lock 必须记录 codemode 闭包");
  for (const [, entry] of lockedCodemode) {
    assert.equal(entry.version, "1.4.0");
    assert.equal(entry.resolved, "https://registry.npmjs.org/@earendil-works/pi-codemode/-/pi-codemode-1.4.0.tgz");
    assert.match(entry.integrity, /^sha512-/);
  }
  assert.deepEqual({
    test: rootManifest.scripts["test:subagents-enhanced"],
    workspace: rootManifest.scripts["test:subagent-workspace"],
    setup: rootManifest.scripts["setup:subagents-enhanced"],
    verify: rootManifest.scripts["verify:subagents-enhanced"],
  }, {
    test: "npm --prefix packages/pi-subagents-enhanced test",
    workspace: "node --test test/managed-workspace-contract.test.mjs test/managed-workspace-ledger.integration.mjs test/managed-workspace-service.integration.mjs test/subagent-managed-worktree.integration.mjs",
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
    "./execution": "./src/execution/index.ts",
    "./host-runtime": "./src/host-runtime/index.ts",
    // F1 新增的合法公开出口：统一后台活动协议/registry 与 package provider，
    // 根与独立消费者均经该 bare specifier 消费，不深引 package src。
    "./tui/background-activity": "./src/tui/index.ts",
    "./workspace": "./src/workspace/service.ts",
    "./workspace/admin": "./src/workspace/administration.ts",
  });
  assert.deepEqual(manifest.dependencies, { "pi-subagents": "0.80.0", typescript: "5.9.3" });
  assert.deepEqual(manifest.devDependencies, {
    "@earendil-works/pi-agent-core": "1.4.0",
    "@earendil-works/pi-ai": "1.4.0",
    "@earendil-works/pi-coding-agent": "1.4.0",
    "@earendil-works/pi-tui": "1.4.0",
  });
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

test("package setup and verify exercise the package-local upstream without patching", async () => {
  const setup = await import("../packages/pi-subagents-enhanced/scripts/setup-runtime-deps.ts");
  const verify = await import("../packages/pi-subagents-enhanced/scripts/verify-package.ts");
  assert.equal(typeof setup.setupRuntimeDependencies, "function");
  assert.equal(typeof verify.verifyEnhancedPackage, "function");
  const calls = [];
  await setup.setupRuntimeDependencies({
    root: packageRoot,
    run: async (...args) => { calls.push(args); },
  });
  assert.deepEqual(calls[0]?.[1], [
    "--no-audit", "--no-fund", "install", "--prefix", packageRoot, "--ignore-scripts", "--omit=peer", "--save-exact", "pi-subagents@0.80.0",
  ]);
  const root = await preparedPackageFixture();
  const report = await verify.verifyEnhancedPackage({ packageRoot: root });
  assert.deepEqual({ name: report.name, version: report.version, upstreamVersion: report.upstreamVersion }, {
    name: "pi-subagents-enhanced",
    version: "0.1.0",
    upstreamVersion: "0.80.0",
  });
  assert.ok(report.tarball.fileCount > 0);
  assert.ok(report.tarball.unpackedSize > 0);
});

test("npm dry-run tarball contains the complete runtime closure and no repository-private files", async () => {
  const root = await preparedPackageFixture();
  const tarballs = async () => (await readdir(root)).filter((name) => name.endsWith(".tgz")).sort();
  const before = await tarballs();
  const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" }))[0];
  const paths = packed.files.map((file) => file.path);
  const required = [
    "extensions/subagent-runtime.ts",
    "extensions/custom-footer.ts",
    "child-extensions/root-session-owner.ts",
    "child-extensions/acceptance-evidence.ts",
    "scripts/setup-runtime-deps.ts",
    "scripts/verify-package.ts",
    "src/compat/pi-subagents-0.75.ts",
    "src/subagent-dispatch/extension.ts",
    "src/subagent-dispatch/root-broker-server.ts",
    "src/tui/native-conversation.ts",
    "src/tui/session-browser.ts",
    // F1/F2b/F6：公开 TUI 出口与统一后台活动实现必须随包发布（独立部署无根依赖）。
    "src/tui/index.ts",
    "src/tui/background-activity.ts",
    "src/tui/subagent-activity.ts",
    "src/tui/footer-runtime.ts",
    "src/contracts/dispatch-ir.ts",
    "src/workspace/contract.ts",
    "src/workspace/ledger.ts",
    "src/workspace/git-worktree.ts",
    "src/workspace/service.ts",
    "src/workspace/registry.ts",
    "src/workspace/tool.ts",
    "src/workspace/completion-reminder.ts",
    "src/workspace/administration.ts",
    "node_modules/pi-subagents/package.json",
  ];
  for (const path of required) assert.ok(paths.includes(path), `missing tarball path: ${path}`);
  const retired = [
    "src/subagent-dispatch/workspace.ts",
    "src/subagent-dispatch/workspace-controller.ts",
    "src/subagent-dispatch/workspace-ledger.ts",
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

test("package setup installs Pi core typings as development dependencies", async () => {
  for (const peer of forbiddenLocalPeers) {
    assert.equal((await metadata(join(await preparedPackageFixture(), "node_modules", peer))).version, "1.4.0", peer);

  }
  const root = await preparedPackageFixture();
  const require = createRequire(join(root, "node_modules/pi-subagents/package.json"));
  assert.ok(require.resolve("typebox/compile"));
});

test("the new compat facade loads from the prepared package", async () => {
  const root = await preparedPackageFixture();
  const { createJiti } = await import(pathToFileURL(join(root, "node_modules/jiti/lib/jiti.mjs")).href);
  const jiti = createJiti(import.meta.url, { moduleCache: false, alias: piHostAliases });
  const facade = await jiti.import(join(root, "src/compat/pi-subagents-0.75.ts"));
  assert.equal(typeof facade.upstreamSubagentRuntime, "function");
  assert.equal(typeof facade.readFleetTranscript, "function");
});

test("published upstream uses package exports and loads in plain Node", async () => {
  const root = await preparedPackageFixture();
  const command = 'import("pi-subagents").then(() => process.stdout.write("loaded"))';
  assert.equal(execFileSync("node", ["--input-type=module", "-e", command], { cwd: root, encoding: "utf8" }), "loaded");
  const upstream = JSON.parse(await readFile(join(root, "node_modules/pi-subagents", "package.json"), "utf8"));
  assert.equal(upstream.version, "0.80.0");
  assert.ok(upstream.exports["."]);
});

test("package verification rejects upstream drift, missing patch, and escaping extension entries", async (t) => {
  const { verifyEnhancedPackage } = await import("../packages/pi-subagents-enhanced/scripts/verify-package.ts");
  const preparedRoot = await preparedPackageFixture();
  const fixture = async (name) => {
    const root = await mkdtemp(join(tmpdir(), `enhanced-${name}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "node_modules"), { recursive: true });
    await cp(join(preparedRoot, "package.json"), join(root, "package.json"));
    return root;
  };

  const drift = await fixture("drift");
  await mkdir(join(drift, "node_modules/pi-subagents"), { recursive: true });
  await writeFile(join(drift, "node_modules/pi-subagents/package.json"), JSON.stringify({ name: "pi-subagents", version: "0.63.0" }));
  await assert.rejects(() => verifyEnhancedPackage({ packageRoot: drift }), /0\.80\.0|version/i);

  const escaping = await fixture("escape");
  const escapingManifest = await metadata(escaping);
  escapingManifest.pi.extensions[0] = "../outside.ts";
  await writeFile(join(escaping, "package.json"), JSON.stringify(escapingManifest));
  await assert.rejects(() => verifyEnhancedPackage({ packageRoot: escaping }), /outside|escape|package/i);

  const unpatched = await fixture("unpatched");
  await cp(join(packageRoot, "node_modules/pi-subagents"), join(unpatched, "node_modules/pi-subagents"), { recursive: true });
  await writeFile(join(unpatched, "node_modules/pi-subagents/CHANGELOG.md"), "drifted upstream\n");
  await assert.rejects(() => verifyEnhancedPackage({ packageRoot: unpatched }), /controlled files differ|registry|drift/i);


  const missingWorkspaceTool = await mkdtemp(join(tmpdir(), "enhanced-missing-workspace-tool-"));
  t.after(() => rm(missingWorkspaceTool, { recursive: true, force: true }));
  await cp(preparedRoot, missingWorkspaceTool, { recursive: true });
  await rm(join(missingWorkspaceTool, "src/workspace/tool.ts"));
  await assert.rejects(
    () => verifyEnhancedPackage({ packageRoot: missingWorkspaceTool }),
    /tool\.ts|runtime closure/i,
  );

  const escapingImport = await fixture("escaping-import");
  await mkdir(join(escapingImport, "extensions"), { recursive: true });
  await mkdir(join(escapingImport, "src"), { recursive: true });
  await mkdir(join(escapingImport, "node_modules/pi-subagents"), { recursive: true });
  await writeFile(join(escapingImport, "extensions/subagent-runtime.ts"), 'export * from "../../../outside.ts";\n');
  await writeFile(join(escapingImport, "extensions/custom-footer.ts"), "export default function footer() {}\n");
  await writeFile(join(escapingImport, "node_modules/pi-subagents/package.json"), JSON.stringify({ name: "pi-subagents", version: "0.80.0" }));
  await assert.rejects(
    () => verifyEnhancedPackage({ packageRoot: escapingImport, runPack: async () => ({ files: [], bundled: ["pi-subagents"] }) }),
    /import|escape|outside|package root|controlled files differ/i,
  );
});
