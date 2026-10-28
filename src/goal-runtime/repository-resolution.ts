import { isAbsolute, join, normalize } from "node:path";
import type { GoalTask, PlanBinding, PlanContract } from "./contract.ts";

/** repoId 仅为超级根下一层目录名；两个身份仍由 workspace 的权威算法生成。 */
export type BoundRepository = {
  repoId: string;
  root: string;
  repositoryId: string;
  storageRepositoryId: string;
};
export type MultiRepositoryBinding = PlanBinding & { repositories: BoundRepository[] };
export type RepositoryCandidate = BoundRepository & {
  realRoot: string;
  gitRoot: string;
  gitDir: string;
  commonDir: string;
  originRoot: string;
  migrationDebt: boolean;
};
export type TaskRepositoryProjection = {
  repoId: string;
  root: string;
  originalWritePaths: string[];
  writePaths: string[];
};

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
const compare = (a: BoundRepository, b: BoundRepository) => a.repoId < b.repoId ? -1 : a.repoId > b.repoId ? 1 : 0;
const canonicalPath = (path: string) => isAbsolute(path) && normalize(path) === path;
const directoryName = (name: string) => !!name.trim() && !/[\\/\u0000-\u001f\u007f*?[\]]/.test(name) && name !== "." && name !== "..";

/** 只校验观测事实，不执行 Git、IO 或目录发现；恢复也复用同一准入规则。 */
export function admitRepositoryCandidates(superRoot: string, candidates: readonly RepositoryCandidate[]): BoundRepository[] {
  const repositories = candidates.map(candidate => {
    if (candidate.migrationDebt) fail("GOAL_REPOSITORY_LINKED_WORKTREE", `${candidate.repoId} 是 linked worktree，存在 migration debt`);
    if (!directoryName(candidate.repoId) || !canonicalPath(superRoot)
      || candidate.root !== join(superRoot, candidate.repoId) || candidate.realRoot !== candidate.root
      || candidate.gitRoot !== candidate.root || candidate.originRoot !== candidate.root) {
      fail("GOAL_REPOSITORY_TOPOLOGY_INVALID", `${candidate.repoId} 不是超级根内 canonical 一层普通仓库根（可能为路径别名或嵌套根）`);
    }
    if (candidate.gitDir !== join(candidate.root, ".git") || candidate.commonDir !== candidate.gitDir) {
      fail("GOAL_REPOSITORY_TOPOLOGY_INVALID", `${candidate.repoId} 不是普通独立 .git 仓库`);
    }
    return { repoId: candidate.repoId, root: candidate.root, repositoryId: candidate.repositoryId, storageRepositoryId: candidate.storageRepositoryId };
  });
  validateBoundRepositories(superRoot, repositories);
  return repositories.sort(compare);
}

/** 固定记录只包含参与集合；不接受重复目录、common-dir 身份或存储身份。 */
export function validateBoundRepositories(superRoot: string, repositories: readonly BoundRepository[]): void {
  if (!canonicalPath(superRoot) || repositories.length === 0) fail("GOAL_REPOSITORY_TOPOLOGY_INVALID", "固定参与仓库集合不得为空，超级根必须为绝对规范路径");
  const ids = new Set<string>(); const identities = new Set<string>(); const storageIds = new Set<string>();
  for (const repository of repositories) {
    if (!directoryName(repository.repoId) || repository.root !== join(superRoot, repository.repoId)
      || !/^[0-9a-f]{64}$/.test(repository.repositoryId) || !/^[0-9a-f]{64}$/.test(repository.storageRepositoryId)) {
      fail("GOAL_REPOSITORY_TOPOLOGY_INVALID", `${repository.repoId} 的固定仓库记录非法`);
    }
    if (ids.has(repository.repoId) || identities.has(repository.repositoryId) || storageIds.has(repository.storageRepositoryId)) {
      fail("GOAL_REPOSITORY_DUPLICATE", `${repository.repoId} 与其他候选共享目录、common-dir 或 storage 身份`);
    }
    ids.add(repository.repoId); identities.add(repository.repositoryId); storageIds.add(repository.storageRepositoryId);
  }
}

function validWritePath(path: string): boolean {
  if (typeof path !== "string" || !path.trim() || /[\\\u0000-\u001f\u007f]/.test(path) || /^[A-Za-z]:\//.test(path)) return false;
  const base = path.endsWith("/**") ? path.slice(0, -3) : path;
  return !/[*?[\]]/.test(base) && base.split("/").every(segment => !!segment && segment !== "." && segment !== "..");
}

/** 超级工作区唯一文法入口：先核验完整路径，再且仅剥除一次首段。 */
export function resolveTaskRepository(task: Pick<GoalTask, "id" | "writePaths">, repositories: readonly BoundRepository[]): TaskRepositoryProjection {
  if (!task.writePaths.length) fail("GOAL_REPOSITORY_PREFIX_REQUIRED", `任务 ${task.id} 缺少带仓库前缀的 writePaths`);
  let selected: BoundRepository | undefined;
  const writePaths = task.writePaths.map(path => {
    if (!validWritePath(path)) fail("GOAL_REPOSITORY_PATH_INVALID", `任务 ${task.id} 含非法路径 ${path}`);
    const slash = path.indexOf("/");
    if (slash < 1) fail("GOAL_REPOSITORY_PREFIX_REQUIRED", `任务 ${task.id} 的路径 ${path} 缺少仓库前缀`);
    const repoId = path.slice(0, slash);
    const matches = repositories.filter(repository => repository.repoId === repoId);
    if (matches.length !== 1) fail("GOAL_REPOSITORY_NOT_FOUND", `任务 ${task.id} 的前缀 ${repoId} 未唯一对应准入仓库`);
    if (selected && selected.repoId !== repoId) fail("GOAL_REPOSITORY_CROSS_TASK", `任务 ${task.id} 的 writePaths 跨仓库`);
    selected = matches[0];
    const projected = path.slice(slash + 1);
    if (!validWritePath(projected)) fail("GOAL_REPOSITORY_PATH_INVALID", `任务 ${task.id} 剥除前缀后的路径非法：${projected}`);
    return projected;
  });
  return { repoId: selected!.repoId, root: selected!.root, originalWritePaths: [...task.writePaths], writePaths };
}

export function resolveParticipatingRepositories(contract: Pick<PlanContract, "tasks">, candidates: readonly BoundRepository[]): BoundRepository[] {
  const ids = new Set(contract.tasks.map(task => resolveTaskRepository(task, candidates).repoId));
  return candidates.filter(candidate => ids.has(candidate.repoId)).map(repository => ({ ...repository })).sort(compare);
}

export function isMultiRepositoryBinding(binding: PlanBinding): binding is MultiRepositoryBinding {
  return Object.hasOwn(binding, "repositories");
}

/** 供重入比较消费：只排序固定参与记录，不引入目录库存、任务映射或默认字段。 */
export function bindingSemanticInput(binding: PlanBinding): PlanBinding | MultiRepositoryBinding {
  const base = { planPath: binding.planPath, contractHash: binding.contractHash, repositoryRoot: binding.repositoryRoot,
    sessionId: binding.sessionId, sessionFile: binding.sessionFile };
  return isMultiRepositoryBinding(binding) ? { ...base, repositories: binding.repositories.map(repository => ({
    repoId: repository.repoId, root: repository.root, repositoryId: repository.repositoryId, storageRepositoryId: repository.storageRepositoryId,
  })).sort(compare) } : base;
}
