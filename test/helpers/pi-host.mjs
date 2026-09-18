import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePiCodingAgentRoot } from "./pi-runtime.mjs";

/**
 * Public Pi package specifiers consumed by both the Host and the tests.
 *
 * The keys stay published specifiers, so the `@earendil-works/pi-ai/compat`
 * public subpath contract is preserved. The values are the resolved entry of
 * the candidate package, which forces every jiti consumer onto the same
 * module instance the Host loads. Without that, a package that ships its own
 * `node_modules` copy (for example `packages/pi-subagents-enhanced`) resolves
 * a second instance and `instanceof` checks against Host classes fail.
 */
const PI_HOST_PACKAGE_SPECIFIERS = [
  "@earendil-works/pi-ai/compat",
  "@earendil-works/pi-tui",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
];

const ESM_ENTRY_CONDITIONS = ["node", "import", "default"];

function readPackageManifest(directory) {
  try {
    return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
}

function pickExportTarget(target) {
  if (typeof target === "string") return target;
  if (Array.isArray(target)) {
    for (const item of target) {
      const picked = pickExportTarget(item);
      if (picked) return picked;
    }
    return undefined;
  }
  if (target && typeof target === "object") {
    for (const [condition, value] of Object.entries(target)) {
      if (!ESM_ENTRY_CONDITIONS.includes(condition)) continue;
      const picked = pickExportTarget(value);
      if (picked) return picked;
    }
  }
  return undefined;
}

function packageNameOf(specifier) {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

function packageSubpathOf(specifier) {
  const packageName = packageNameOf(specifier);
  const rest = specifier.slice(packageName.length);
  return rest ? `.${rest}` : ".";
}

/** Mirrors the Node `node_modules` lookup: nested first, then hoisted parents. */
function findPackageRoot(piHostRoot, packageName) {
  if (readPackageManifest(piHostRoot)?.name === packageName) return resolve(piHostRoot);
  let directory = resolve(piHostRoot);
  for (;;) {
    const candidate = join(directory, "node_modules", packageName);
    if (readPackageManifest(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Pi candidate root ${piHostRoot} cannot resolve package ${packageName}`);
}

function resolvePackageEntry(packageRoot, packageName, subpath) {
  const manifest = readPackageManifest(packageRoot);
  if (manifest.exports !== undefined) {
    const exportsMap = typeof manifest.exports === "string" ? { ".": manifest.exports } : manifest.exports;
    const target = pickExportTarget(exportsMap[subpath]);
    if (!target) throw new Error(`Pi package ${packageName} does not export public subpath ${subpath}`);
    return join(packageRoot, target);
  }
  if (subpath !== ".") throw new Error(`Pi package ${packageName} declares no exports map for subpath ${subpath}`);
  const target = manifest.module ?? manifest.main;
  if (!target) throw new Error(`Pi package ${packageName} declares no public entry`);
  return join(packageRoot, target);
}

/**
 * Resolves a public Pi specifier to the real path of its entry under the
 * candidate root. The entry always comes from the package's own
 * `exports`/`main` declaration, never from a hard-coded dist layout, and it is
 * realpathed so jiti and the Node ESM loader share one module instance.
 */
export function resolvePiHostPackageEntry(piHostRoot, specifier) {
  if (!PI_HOST_PACKAGE_SPECIFIERS.includes(specifier)) {
    throw new Error(`Unknown Pi host package specifier ${specifier}`);
  }
  const packageName = packageNameOf(specifier);
  const packageRoot = findPackageRoot(piHostRoot, packageName);
  const entry = resolvePackageEntry(packageRoot, packageName, packageSubpathOf(specifier));
  if (!existsSync(entry)) throw new Error(`Pi package ${packageName} entry ${entry} is missing under ${piHostRoot}`);
  return realpathSync(entry);
}

export function resolvePiHostPaths(options = {}) {
  const piHostRoot = resolvePiCodingAgentRoot(options);
  const piHostAliases = Object.freeze(Object.fromEntries(
    PI_HOST_PACKAGE_SPECIFIERS.map((specifier) => [specifier, resolvePiHostPackageEntry(piHostRoot, specifier)]),
  ));
  return {
    piHostRoot,
    piHostJitiUrl: pathToFileURL(join(piHostRoot, "node_modules/jiti/lib/jiti.mjs")).href,
    piHostModuleUrl: pathToFileURL(piHostAliases["@earendil-works/pi-coding-agent"]).href,
    piHostAliases,
  };
}

const defaultPiHostPaths = resolvePiHostPaths();
export const { piHostRoot, piHostJitiUrl, piHostModuleUrl, piHostAliases } = defaultPiHostPaths;
