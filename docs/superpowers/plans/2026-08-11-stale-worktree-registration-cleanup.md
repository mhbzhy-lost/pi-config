# 历史 Worktree 空登记清理实施计划

> **供 agentic workers 使用：** 每个逻辑变更先加载 `test-driven-development`，严格执行 RED→GREEN；派发时加载 `subagent-dispatch`。

**目标：** 为 94 条历史 `resources=010` 空 worktree 登记增加挑战绑定的 migration-only 受管清理入口，并在不删除 branch/ref、owner receipt 或现存 worktree 的前提下完成一次性清理。

**架构：** Inventory 从严格的 `path missing + prunable + no owner manifest` 集合生成 canonical snapshot 与一次性挑战。CLI dry-run 只返回挑战；apply 必须携带完全匹配挑战，重新 inventory 后才允许逐路径执行精确、非 force 的 registration removal，并进行全局 before/after 不变量复核。任何快照漂移或非候选资源都 fail closed。

**技术栈：** Node.js ESM、`node:test`、Git worktree porcelain/plumbing、SHA-256 挑战。

## 全局约束

- 禁止 raw `git worktree add/remove/prune/move/repair/lock/unlock`；执行只能经 `node scripts/worktree-lifecycle.mjs ...`。
- 不删除 branch/ref；不删除 9 条 `released/001` owner receipt；不修改 `.state/goal-engine/**`。
- 不依据 TTL、clean 或 `/tmp` 自动授权；必须绑定本次人类明确清理请求与精确 snapshot challenge。
- apply 前后验证 origin HEAD、全部 branch refs、现存 worktree、owner manifest 字节与普通工作区文件均不变。
- 当前无关 dirty：`pi/settings.json`、`.state/worktree-lifecycle/`、handoff 文档；不得回退或提交。

## DAG

```text
T1 受管 stale-registration 清理原语
  ↓
T2 真实仓库挑战绑定执行与验证
```

## 并行调度组

- Wave 1：T1
- Wave 2：T2（依赖 T1 的稳定 CLI 与 challenge 合同）

### Task 1：挑战绑定的受管清理入口

**Deps:** none

依赖理由：无；本任务先产出稳定 migration CLI 合同，供真实执行使用。

**WritePaths:**
- `scripts/lib/worktree-lifecycle/inventory.mjs`
- `scripts/worktree-lifecycle.mjs`
- `test/worktree-lifecycle-recovery.test.mjs`
- `test/worktree-lifecycle-inventory.test.mjs`
- `docs/bugs/bug-stale-worktree-registrations-cannot-be-authorized-for-pruning.md`

**Workflow:** tdd

- [x] 写 RED：临时仓库创建 missing+prunable+no-owner 登记，dry-run 返回稳定 `snapshotChallenge` 与候选；dirty/present/locked/non-prunable/有 owner manifest 均不进入候选。
- [x] 写 RED：apply 缺 challenge、错误 challenge、candidate/HEAD/branch/prunable reason 漂移时无 Git/file mutation。
- [x] 写 RED：正确 challenge 只删除批准 registration；branch ref、main HEAD、existing worktree、manifest bytes、ordinary files 不变。
- [x] 实现 `planStaleRegistrationCleanup()` 与 `applyStaleRegistrationCleanup()`；挑战绑定排序后的完整 registration、候选 branch head、canonical origin/common-dir 和 owner manifest digest。
- [x] CLI 增加 `prune-stale-registrations --json [--apply --challenge <sha256>]`；缺 apply 时永远只读。
- [x] GREEN：lifecycle 与 shell focused tests 110/110，`git diff --check` 通过。

### Task 2：真实历史债务清理与零副作用验证

**Deps:** T1

依赖理由：只能消费 T1 生成并重新验证的精确 challenge，不手工构造删除命令。

**WritePaths:** none

**Workflow:** existing-tests

- [x] 记录 before：worktree porcelain、branch refs、HEAD、lifecycle manifest hash、普通 status、Doctor warning 数与 audit 分类。
- [x] 运行受管 dry-run，确认精确 94 个候选且全部为 `missing/010/prunable/no-owner`；记录 challenge。
- [x] 使用同一 challenge调用受管 apply，精确移除 94 条登记。
- [x] 记录 after：worktree 仅剩主工作树；94 条 warning 消失；9 条 released receipt 保留；branch/HEAD/manifest/status 与 before 相同；Doctor 0 error。
- [x] 运行 lifecycle focused tests 与 `git diff --check`；不提交用户无关 dirty。

## 完成标准

- 94 条空登记全部经受管 challenge 清理；0 条未经授权登记被改动。
- branch/ref 零减少，现存 worktree 零误删，owner manifest 零变化。
- 9 条 released receipt 保留；Doctor 不再报告这 94 条 warning。
