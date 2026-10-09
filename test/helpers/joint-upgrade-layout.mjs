import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * 在候选archive与合回后的真实仓库中统一解析联合升级测试布局。
 * 测试不得通过工作目录或全局Pi推断Host，也不得把candidate.json复制进生产仓库。
 */
export function resolveJointUpgradeLayout() {
  const repoRoot = resolve(import.meta.dirname, "../..");
  const explicitCandidateRoot = process.env.PI_JOINT_CANDIDATE_ROOT?.trim();
  const candidateRoot = explicitCandidateRoot
    ? resolve(explicitCandidateRoot)
    : existsSync(join(repoRoot, "candidate.json"))
      ? repoRoot
      : existsSync(join(repoRoot, "..", "candidate.json"))
        ? resolve(repoRoot, "..")
        : repoRoot;
  const manifestPath = join(candidateRoot, "candidate.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : undefined;
  const hostRoot = manifest?.hostRoot
    ?? process.env.PI_TEST_CODING_AGENT_ROOT?.trim()
    ?? join(repoRoot, "node_modules/@earendil-works/pi-coding-agent");
  return { repoRoot, candidateRoot, hostRoot, manifest };
}
