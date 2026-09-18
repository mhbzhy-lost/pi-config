import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const defaultGlobalRoot = () => execFileSync("npm", ["root", "-g"], {
  encoding: "utf8",
}).trim();

/**
 * A test-owned Git repository with its own common-dir.
 *
 * The workspace coordinator partitions durable state by
 * `git rev-parse --git-common-dir`, so a Host started in the repository under
 * test inherits that repository's live coordinator metadata. Combined with a
 * temporary `PI_CODING_WORKSPACE_DIR`, that is an unrecoverable state-root
 * split brain and the coordinator must fail closed. Starting the Host in this
 * isolated repository keeps the temporary state root scoped to the fixture
 * instead of colliding with the live owner.
 *
 * The repository is intentionally left without commits: repository identity
 * only needs a toplevel, a common-dir and a worktree listing.
 */
export async function createIsolatedHostRepository(prefix) {
  if (typeof prefix !== "string" || !prefix) throw new TypeError("isolated host repository prefix is required");
  const root = await mkdtemp(join(tmpdir(), prefix));
  const repository = join(root, "repository");
  await mkdir(repository);
  execFileSync("git", ["init", "-b", "main"], { cwd: repository, stdio: "ignore" });
  return { root, repository };
}

export function resolvePiCodingAgentRoot({
  env = process.env,
  readGlobalNodeModules = defaultGlobalRoot,
} = {}) {
  const explicit = env.PI_TEST_CODING_AGENT_ROOT?.trim();
  if (explicit) return explicit;
  return join(readGlobalNodeModules(), "@earendil-works", "pi-coding-agent");
}

export async function loadPiTestRuntime(importMetaUrl, options = {}) {
  const { resolvePiHostPaths } = await import("./pi-host.mjs");
  const { piHostRoot: root, piHostJitiUrl, piHostModuleUrl, piHostAliases } = resolvePiHostPaths(options);
  const paths = {
    codingAgent: piHostModuleUrl,
    piTui: piHostAliases["@earendil-works/pi-tui"],
    piAi: piHostAliases["@earendil-works/pi-ai"],
    piAiCompat: piHostAliases["@earendil-works/pi-ai/compat"],
    piAgentCore: piHostAliases["@earendil-works/pi-agent-core"],
    jiti: piHostJitiUrl,
  };
  const { createJiti } = await import(paths.jiti);
  const jiti = createJiti(importMetaUrl, {
    moduleCache: false,
    alias: piHostAliases,
  });
  return {
    root,
    paths,
    jiti,
    codingAgent: await import(paths.codingAgent),
    piTui: await jiti.import(paths.piTui),
  };
}
