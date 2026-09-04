import { execFile as execFileCallback } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { verifyOrderedModelsRuntimePatch } from "../src/subagent-dispatch/ordered-models-runtime-patch.ts";

const execFile = promisify(execFileCallback);
const scriptPath = fileURLToPath(import.meta.url);
const defaultPackageRoot = resolve(import.meta.dirname, "..");
const expectedExtensions = ["./extensions/subagent-runtime.ts", "./extensions/custom-footer.ts"];
const expectedFiles = ["AGENTS.md", "README.md", "extensions", "child-extensions", "scripts", "src"];
const expectedExports = {
  "./dispatch-ir": "./src/contracts/dispatch-ir.ts",
  "./workspace": "./src/workspace/service.ts",
  "./workspace/admin": "./src/workspace/administration.ts",
};
const implementationRoots = ["extensions", "src", "child-extensions", "scripts"];
const forbiddenLocalPeers = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];
const requiredTarballPaths = [
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
const retiredTarballPaths = [
  "src/subagent-dispatch/workspace.ts",
  "src/subagent-dispatch/workspace-controller.ts",
  "src/subagent-dispatch/workspace-ledger.ts",
  "src/goal-support/workspace.ts",
  "src/worktree-lifecycle/inventory.ts",
  "src/worktree-lifecycle/managed-worktree.ts",
  "src/worktree-lifecycle/registry.ts",
];

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function assertPackagePath(packageRoot, value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty package path.`);
  const target = resolve(packageRoot, value);
  const rel = relative(packageRoot, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel === "" && value.includes("..")) throw new Error(`${label} escapes the package root: ${value}`);
  return target;
}

async function assertNoLocalPeerCopies(packageRoot) {
  for (const peer of forbiddenLocalPeers) {
    try {
      await lstat(resolve(packageRoot, "node_modules", peer));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    throw new Error(`Package-local peer duplicate breaks Host module identity: ${peer}`);
  }
}

async function sourceFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (/\.(?:mjs|js|ts)$/.test(entry.name)) files.push(path);
  }
  return files;
}

async function verifyImportClosure(packageRoot) {
  const canonicalRoot = await realpath(packageRoot);
  const specifierPattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+(?:type\s+)?|\bnew URL\s*\(\s*)["']([^"']+)["']/g;
  let edgeCount = 0;
  for (const implementationRoot of implementationRoots) {
    const root = assertPackagePath(packageRoot, implementationRoot, `implementation root ${implementationRoot}`);
    for (const file of await sourceFiles(root)) {
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(specifierPattern)) {
        const specifier = match[1];
        if (!specifier.startsWith(".")) continue;
        const targetUrl = new URL(specifier, pathToFileURL(file));
        targetUrl.search = "";
        targetUrl.hash = "";
        const target = fileURLToPath(targetUrl);
        assertPackagePath(packageRoot, target, `relative import ${relative(packageRoot, file)} -> ${specifier}`);
        const canonicalTarget = await realpath(target);
        const physical = relative(canonicalRoot, canonicalTarget);
        if (physical === ".." || physical.startsWith(`..${sep}`) || isAbsolute(physical)) {
          throw new Error(`Relative import escapes the physical package root: ${relative(packageRoot, file)} -> ${specifier}`);
        }
        edgeCount += 1;
      }
    }
  }
  return edgeCount;
}

function verifyTarball(pack) {
  if (!pack || !Array.isArray(pack.files)) throw new Error("npm pack dry-run did not return a file list.");
  const paths = pack.files.map((file) => file.path);
  for (const required of requiredTarballPaths) {
    if (!paths.includes(required)) throw new Error(`Tarball runtime closure is missing: ${required}`);
  }
  for (const retired of retiredTarballPaths) {
    if (paths.includes(retired)) throw new Error(`Tarball contains retired workspace implementation: ${retired}`);
  }
  for (const path of paths) {
    if (typeof path !== "string" || !path || isAbsolute(path) || path.split("/").includes("..")) throw new Error(`Tarball contains an unsafe path: ${path}`);
    if (/^(?:pi\/|test\/|tests\/|var\/|\.state\/)/.test(path)) throw new Error(`Tarball contains a repository-private path: ${path}`);
    if (/(?:^|\/)(?:settings|models|auth)\.json$|(?:^|\/)sessions(?:\/|$)|(?:^|\/)logs?(?:\/|$)|\.log$/i.test(path)) throw new Error(`Tarball contains runtime or private data: ${path}`);
    if (/(?:^|\/)node_modules\/@earendil-works\/(?:pi-agent-core|pi-ai|pi-coding-agent|pi-tui)(?:\/|$)/.test(path)) throw new Error(`Tarball contains a Pi core peer: ${path}`);
  }
  if (!Array.isArray(pack.bundled) || !pack.bundled.includes("pi-subagents")) throw new Error("Tarball does not include the bundleDependencies pi-subagents entry.");
  return { fileCount: paths.length, unpackedSize: pack.unpackedSize };
}

async function npmPackDryRun(packageRoot) {
  const env = { ...process.env };
  for (const key of ["npm_config_prefix", "npm_config_global_prefix", "npm_config_globalconfig", "NPM_CONFIG_PREFIX", "NPM_CONFIG_GLOBAL_PREFIX", "NPM_CONFIG_GLOBALCONFIG"]) delete env[key];
  const { stdout } = await execFile("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: packageRoot, env, maxBuffer: 16 * 1024 * 1024 });
  const result = JSON.parse(stdout);
  if (!Array.isArray(result) || result.length !== 1) throw new Error("npm pack dry-run returned an unexpected report.");
  return result[0];
}

export async function verifyEnhancedPackage({ packageRoot = defaultPackageRoot, verifyPatch = verifyOrderedModelsRuntimePatch, runPack = npmPackDryRun } = {}) {
  const manifest = await json(resolve(packageRoot, "package.json"));
  if (manifest.name !== "pi-subagents-enhanced" || manifest.version !== "0.1.0") throw new Error("Enhanced package identity must be pi-subagents-enhanced@0.1.0.");
  if (manifest.dependencies?.["pi-subagents"] !== "0.62.0"
    || JSON.stringify(manifest.bundleDependencies) !== JSON.stringify(["pi-subagents"])
    || Object.hasOwn(manifest, "bundledDependencies")) {
    throw new Error("Enhanced package must declare only canonical bundleDependencies for pi-subagents 0.62.0.");
  }
  if (JSON.stringify(manifest.pi?.extensions) !== JSON.stringify(expectedExtensions)) throw new Error("Enhanced package must declare exactly the runtime and footer extensions.");
  if (JSON.stringify(manifest.exports) !== JSON.stringify(expectedExports)) throw new Error("Enhanced package exports must expose only canonical dispatch and workspace APIs.");
  if (JSON.stringify(manifest.files) !== JSON.stringify(expectedFiles)) throw new Error("Enhanced package files allowlist is incomplete or unexpected.");
  for (const [index, entry] of manifest.pi.extensions.entries()) assertPackagePath(packageRoot, entry, `pi.extensions[${index}]`);
  for (const [index, entry] of manifest.files.entries()) assertPackagePath(packageRoot, entry, `files[${index}]`);
  for (const [entry, target] of Object.entries(manifest.exports)) assertPackagePath(packageRoot, target, `exports[${entry}]`);
  await assertNoLocalPeerCopies(packageRoot);
  const upstreamRoot = resolve(packageRoot, "node_modules/pi-subagents");
  const upstream = await json(resolve(upstreamRoot, "package.json"));
  if (upstream.version !== "0.62.0") throw new Error(`Expected pi-subagents 0.62.0, found ${upstream.version ?? "unknown"}.`);
  await verifyPatch(upstreamRoot);
  for (const entry of manifest.pi.extensions) await lstat(resolve(packageRoot, entry));
  const importEdges = await verifyImportClosure(packageRoot);
  const tarball = verifyTarball(await runPack(packageRoot));
  return { name: manifest.name, version: manifest.version, upstreamVersion: upstream.version, patched: true, importEdges, tarball };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  process.stdout.write(`${JSON.stringify(await verifyEnhancedPackage())}\n`);
}
