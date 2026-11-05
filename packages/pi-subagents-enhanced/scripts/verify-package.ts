import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const scriptPath = fileURLToPath(import.meta.url);
const defaultPackageRoot = resolve(import.meta.dirname, "..");
const defaultNpmCache = resolve(defaultPackageRoot, "../..", "var/tmp/npm-cache");
const UPSTREAM_VERSION = "0.84.0";
// 本仓唯一消费的上游公开 specifier：root runtime、agents 注册、required child 扩展与 capability ceiling。
// 0.81 起 root/subpath 改为 bundle 发布，因此门禁必须同时核对 types 与 runtime target，
// 并完整走完 runtime 的相对 import 闭包（bundle → chunk），不能只看 manifest 里还有 subpath。
const upstreamPublicSpecifiers = [
  "pi-subagents",
  "pi-subagents/agents",
  "pi-subagents/required-child-extensions",
  "pi-subagents/capability-ceiling",
];
// 只匹配模块说明符；new URL(...) 是运行时资源路径计算，不属于模块打包闭包。
const relativeModulePattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+(?:type\s+)?|\brequire\s*\(\s*)["']([^"']+)["']/g;
const expectedExtensions = ["./extensions/subagent-runtime.ts", "./extensions/custom-footer.ts"];
const expectedFiles = ["AGENTS.md", "README.md", "extensions", "child-extensions", "scripts", "src"];
const expectedExports = {
  "./dispatch-ir": "./src/contracts/dispatch-ir.ts",
  "./execution": "./src/execution/index.ts",
  "./host-runtime": "./src/host-runtime/index.ts",
  "./tui/background-activity": "./src/tui/index.ts",
  "./workspace": "./src/workspace/service.ts",
  "./workspace/admin": "./src/workspace/administration.ts",
};
const implementationRoots = ["extensions", "src", "child-extensions", "scripts"];
const requiredTarballPaths = [
  "extensions/subagent-runtime.ts", "extensions/custom-footer.ts", "child-extensions/root-session-owner.ts",
  "child-extensions/acceptance-evidence.ts", "scripts/setup-runtime-deps.ts", "scripts/verify-package.ts",
  "src/compat/pi-subagents-0.75.ts", "src/execution/index.ts", "src/subagent-dispatch/extension.ts", "src/subagent-dispatch/root-broker-server.ts",
  "src/tui/native-conversation.ts", "src/tui/session-browser.ts",
  "src/tui/index.ts", "src/tui/background-activity.ts",
  "src/tui/subagent-activity.ts", "src/tui/footer-runtime.ts",
  "src/contracts/dispatch-ir.ts",
  "src/workspace/contract.ts", "src/workspace/ledger.ts",
  "src/workspace/git-worktree.ts", "src/workspace/service.ts", "src/workspace/registry.ts",
  "src/workspace/tool.ts", "src/workspace/completion-reminder.ts", "src/workspace/administration.ts",
  "node_modules/pi-subagents/package.json",
];
const retiredTarballPaths = [
  "src/compat/pi-subagents-0.71.ts",
  "src/subagent-dispatch/workspace.ts", "src/subagent-dispatch/workspace-controller.ts",
  "src/subagent-dispatch/workspace-ledger.ts", "src/worktree-lifecycle/inventory.ts",
  "src/worktree-lifecycle/managed-worktree.ts", "src/worktree-lifecycle/registry.ts",
];

async function json(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

function assertPackagePath(packageRoot: string, value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty package path.`);
  const target = resolve(packageRoot, value);
  const rel = relative(packageRoot, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || (rel === "" && value.includes(".."))) {
    throw new Error(`${label} escapes the package root: ${value}`);
  }
  return target;
}

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (/\.(?:mjs|js|ts)$/.test(entry.name)) files.push(path);
  }
  return files;
}

async function verifyImportClosure(packageRoot: string) {
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
        const target = fileURLToPath(new URL(specifier, `file://${file}`));
        assertPackagePath(packageRoot, target, `relative import ${relative(packageRoot, file)} -> ${specifier}`);
        const physical = relative(canonicalRoot, await realpath(target));
        if (physical === ".." || physical.startsWith(`..${sep}`) || isAbsolute(physical)) {
          throw new Error(`Relative import escapes the physical package root: ${relative(packageRoot, file)} -> ${specifier}`);
        }
        edgeCount += 1;
      }
    }
  }
  return edgeCount;
}

function controlledRelative(path: string) {
  return path.split(sep).join("/").replace(/^\.\//, "");
}

async function fileMap(root: string) {
  const result = new Map<string, string>();
  async function visit(current: string) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if ([".package-lock.json", ".npmrc"].includes(entry.name)) continue;
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.set(controlledRelative(relative(root, path)), createHash("sha256").update(await readFile(path)).digest("hex"));
    }
  }
  await visit(root);
  return result;
}

export async function npmPackUpstream(version: string) {
  const temp = await mkdtemp(resolve(tmpdir(), "pi-subagents-registry-"));
  try {
    const env = { ...process.env, NPM_CONFIG_REGISTRY: "https://registry.npmjs.org", npm_config_cache: process.env.npm_config_cache ?? defaultNpmCache };
    const { stdout } = await execFile("npm", ["pack", `pi-subagents@${version}`, "--json", "--ignore-scripts"], { cwd: temp, env, maxBuffer: 16 * 1024 * 1024 });
    const report = JSON.parse(stdout);
    const archive = resolve(temp, report[0]?.filename);
    const unpack = resolve(temp, "unpack");
    await execFile("mkdir", ["-p", unpack]);
    await execFile("tar", ["-xzf", archive, "-C", unpack]);
    return { root: resolve(unpack, "package"), cleanup: () => rm(temp, { recursive: true, force: true }) };
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}

async function verifyControlledUpstream(packageRoot: string) {
  const localRoot = resolve(packageRoot, "node_modules/pi-subagents");
  const registry = await npmPackUpstream(UPSTREAM_VERSION);
  try {
    // npm's bundleDependencies materializes declared bundled dependencies in
    // the package-local node_modules. Compare the upstream payload itself and
    // exclude that generated nested closure from the controlled source set.
    const [local, expected] = await Promise.all([fileMap(localRoot), fileMap(registry.root)]);
    for (const key of [...local.keys()]) if (key.startsWith("node_modules/")) local.delete(key);
    for (const key of [...expected.keys()]) if (key.startsWith("node_modules/")) expected.delete(key);
    const keys = [...new Set([...local.keys(), ...expected.keys()])].sort();
    const differences = keys.filter((key) => local.get(key) !== expected.get(key));
    if (differences.length) throw new Error(`pi-subagents controlled files differ from registry ${UPSTREAM_VERSION}: ${differences.slice(0, 10).join(", ")}`);
    return { comparedFiles: keys.length, excludedMetadata: [".package-lock.json", ".npmrc"], bundleRule: "bundleDependencies=pi-subagents; npm pack controls bundled closure" };
  } finally {
    await registry.cleanup();
  }
}

async function upstreamShippedFile(upstreamRoot: string, value: unknown, label: string) {
  const target = assertPackagePath(upstreamRoot, value, label);
  try {
    const info = await lstat(target);
    if (!info.isFile()) throw new Error(`${label} 不是文件: ${String(value)}`);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} is missing from the installed upstream payload: ${String(value)}`);
    throw error;
  }
  return target;
}

/** 走完 runtime target 的相对 import 闭包（bundle + chunk），任何未随包发布的文件都必须 fail closed。 */
async function verifyUpstreamRuntimeClosure(upstreamRoot: string, entries: string[]) {
  const visited = new Set<string>();
  let edgeCount = 0;
  async function visit(file: string) {
    if (visited.has(file)) return;
    visited.add(file);
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(relativeModulePattern)) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) continue;
      const target = fileURLToPath(new URL(specifier, `file://${file}`));
      const label = `upstream relative import ${relative(upstreamRoot, file)} -> ${specifier}`;
      assertPackagePath(upstreamRoot, target, label);
      try {
        await lstat(target);
      } catch {
        throw new Error(`${label} is not shipped in the bundled payload.`);
      }
      edgeCount += 1;
      await visit(target);
    }
  }
  for (const entry of entries) await visit(entry);
  return { files: visited.size, edges: edgeCount };
}

/** 按已安装 upstream manifest 核对四个公开 specifier 的 types/runtime target 与 bundle/chunk/child 闭包。 */
export async function verifyUpstreamPublicExports(packageRoot: string) {
  const upstreamRoot = resolve(packageRoot, "node_modules/pi-subagents");
  const manifest = await json(resolve(upstreamRoot, "package.json"));
  const exportMap = manifest.exports;
  if (!exportMap || typeof exportMap !== "object" || Array.isArray(exportMap)) throw new Error(`pi-subagents ${UPSTREAM_VERSION} must declare an exports map.`);
  const entries: { specifier: string; runtime: string; types: string }[] = [];
  const runtimeTargets: string[] = [];
  for (const specifier of upstreamPublicSpecifiers) {
    const subpath = specifier === "pi-subagents" ? "." : `.${specifier.slice("pi-subagents".length)}`;
    const entry = exportMap[subpath];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`pi-subagents ${UPSTREAM_VERSION} is missing the public export ${specifier}.`);
    const runtime = entry.default ?? entry.import;
    const runtimeTarget = await upstreamShippedFile(upstreamRoot, runtime, `pi-subagents export ${specifier} runtime target`);
    const typesTarget = await upstreamShippedFile(upstreamRoot, entry.types, `pi-subagents export ${specifier} types target`);
    runtimeTargets.push(runtimeTarget);
    entries.push({
      specifier,
      runtime: controlledRelative(relative(upstreamRoot, runtimeTarget)),
      types: controlledRelative(relative(upstreamRoot, typesTarget)),
    });
  }
  const childExtensions = manifest.pi?.extensions;
  if (!Array.isArray(childExtensions) || childExtensions.length === 0) throw new Error(`pi-subagents ${UPSTREAM_VERSION} must declare the child extension entries.`);
  const childExtensionEntries: string[] = [];
  for (const [index, value] of childExtensions.entries()) {
    const target = await upstreamShippedFile(upstreamRoot, value, `pi-subagents pi.extensions[${index}]`);
    childExtensionEntries.push(controlledRelative(relative(upstreamRoot, target)));
    runtimeTargets.push(target);
  }
  return { specifiers: entries, childExtensionEntries, closure: await verifyUpstreamRuntimeClosure(upstreamRoot, runtimeTargets) };
}

function verifyTarball(pack: any) {
  if (!pack || !Array.isArray(pack.files)) throw new Error("npm pack dry-run did not return a file list.");
  const paths = pack.files.map((file: any) => file.path);
  for (const required of requiredTarballPaths) if (!paths.includes(required)) throw new Error(`Tarball runtime closure is missing: ${required}`);
  for (const retired of retiredTarballPaths) if (paths.includes(retired)) throw new Error(`Tarball contains retired workspace implementation: ${retired}`);
  for (const path of paths) {
    if (typeof path !== "string" || !path || isAbsolute(path) || path.split("/").includes("..")) throw new Error(`Tarball contains an unsafe path: ${path}`);
    if (/^(?:pi\/|test\/|tests\/|var\/|\.state\/)/.test(path)) throw new Error(`Tarball contains a repository-private path: ${path}`);
    if (/(?:^|\/)(?:settings|models|auth)\.json$|(?:^|\/)sessions(?:\/|$)|(?:^|\/)logs?(?:\/|$)|\.log$/i.test(path)) throw new Error(`Tarball contains runtime or private data: ${path}`);
    if (/(?:^|\/)node_modules\/@earendil-works\/(?:pi-agent-core|pi-ai|pi-coding-agent|pi-tui)(?:\/|$)/.test(path)) throw new Error(`Tarball contains a Pi core peer: ${path}`);
  }
  if (!Array.isArray(pack.bundled) || !pack.bundled.includes("pi-subagents")) throw new Error("Tarball does not include the bundleDependencies pi-subagents entry.");
  return { fileCount: paths.length, unpackedSize: pack.unpackedSize };
}

export async function npmPackDryRun(packageRoot: string) {
  const env = { ...process.env, NPM_CONFIG_REGISTRY: "https://registry.npmjs.org", npm_config_cache: process.env.npm_config_cache ?? defaultNpmCache };
  const { stdout } = await execFile("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: packageRoot, env, maxBuffer: 16 * 1024 * 1024 });
  const result = JSON.parse(stdout);
  if (!Array.isArray(result) || result.length !== 1) throw new Error("npm pack dry-run returned an unexpected report.");
  return result[0];
}

export async function verifyEnhancedPackage({ packageRoot = defaultPackageRoot, runPack = npmPackDryRun } = {}) {
  const manifest = await json(resolve(packageRoot, "package.json"));
  if (manifest.name !== "pi-subagents-enhanced" || manifest.version !== "0.1.0") throw new Error("Enhanced package identity must be pi-subagents-enhanced@0.1.0.");
  if (manifest.dependencies?.["pi-subagents"] !== UPSTREAM_VERSION || manifest.dependencies?.typescript !== "5.9.3" || JSON.stringify(manifest.bundleDependencies) !== JSON.stringify(["pi-subagents"]) || Object.hasOwn(manifest, "bundledDependencies")) throw new Error(`Enhanced package must declare pi-subagents@${UPSTREAM_VERSION} and canonical bundleDependencies.`);
  if (JSON.stringify(manifest.pi?.extensions) !== JSON.stringify(expectedExtensions)) throw new Error("Enhanced package must declare exactly the runtime and footer extensions.");
  if (JSON.stringify(manifest.exports) !== JSON.stringify(expectedExports)) throw new Error("Enhanced package exports must expose only canonical dispatch, execution, Host, TUI, and workspace APIs.");
  if (JSON.stringify(manifest.files) !== JSON.stringify(expectedFiles)) throw new Error("Enhanced package files allowlist is incomplete or unexpected.");
  for (const [index, entry] of manifest.pi.extensions.entries()) assertPackagePath(packageRoot, entry, `pi.extensions[${index}]`);
  for (const [index, entry] of manifest.files.entries()) assertPackagePath(packageRoot, entry, `files[${index}]`);
  for (const [entry, target] of Object.entries(manifest.exports)) assertPackagePath(packageRoot, target, `exports[${entry}]`);
  const upstreamRoot = resolve(packageRoot, "node_modules/pi-subagents");
  const upstream = await json(resolve(upstreamRoot, "package.json"));
  if (upstream.version !== UPSTREAM_VERSION) throw new Error(`Expected pi-subagents ${UPSTREAM_VERSION}, found ${upstream.version ?? "unknown"}.`);
  const controlled = await verifyControlledUpstream(packageRoot);
  const upstreamExports = await verifyUpstreamPublicExports(packageRoot);
  for (const entry of manifest.pi.extensions) await lstat(resolve(packageRoot, entry));
  const importEdges = await verifyImportClosure(packageRoot);
  const tarball = verifyTarball(await runPack(packageRoot));
  return { name: manifest.name, version: manifest.version, upstreamVersion: upstream.version, controlled, upstreamExports, importEdges, tarball };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) process.stdout.write(`${JSON.stringify(await verifyEnhancedPackage())}\n`);
