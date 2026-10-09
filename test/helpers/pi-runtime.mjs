import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

/**
 * 默认解析本仓物理 SDK：测试必须消费仓库自带的 node_modules 里的
 * @earendil-works/pi-coding-agent（当前 1.0.4），绝不静默回退到 npm 全局安装
 * （机器上的全局 Pi 是过期旧版本，其 theme/API 面与本仓断言不符）。
 * 物理根缺失时直接报错，不回退 global。
 */
const defaultPhysicalRoot = () => {
  const candidate = join(import.meta.dirname, "..", "..", "node_modules", "@earendil-works", "pi-coding-agent");
  if (!existsSync(join(candidate, "package.json"))) {
    throw new Error(`repository physical Pi SDK is missing at ${candidate}; run the repo install instead of falling back to the global npm root`);
  }
  return candidate;
};

/**
 * 解析测试用 Pi SDK root，优先级：
 * 1. 显式 PI_TEST_CODING_AGENT_ROOT（仍可作为候选 pin，含首尾空白容忍）；
 * 2. 调用方显式注入 readGlobalNodeModules（同 env pin 一样是显式选择全局 root
 *    发现方式的语义，供隔离 fixture 测试全局解析行为）；
 * 3. 缺省：本仓物理 SDK（见 defaultPhysicalRoot），无 global npmroot 兜底。
 */
export function resolvePiCodingAgentRoot({
  env = process.env,
  readGlobalNodeModules,
} = {}) {
  const explicit = env.PI_TEST_CODING_AGENT_ROOT?.trim();
  if (explicit) return explicit;
  if (readGlobalNodeModules) return join(readGlobalNodeModules(), "@earendil-works", "pi-coding-agent");
  return defaultPhysicalRoot();
}

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
