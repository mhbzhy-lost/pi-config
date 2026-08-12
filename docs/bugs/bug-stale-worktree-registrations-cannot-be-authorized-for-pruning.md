# Bug：历史 Worktree 空登记无法通过受管入口清理

## 现象

`node scripts/worktree-lifecycle.mjs audit --json` 当前报告 94 条 `resources=010`、`state=missing`、`WORKTREE_IDENTITY_MISMATCH`：实际目录已经不存在，只剩 Git worktree administrative registration。另有 9 条 `released/001` owner receipt，它们是正常审计记录，不产生 warning。

`reconcile --json` 对 94 条空登记全部给出 `automaticAction=none`，`reconcile --apply` 因而没有候选。直接执行 raw `git worktree prune` 虽能消除登记，但违反项目生命周期门禁，且没有绑定用户批准的精确快照。

## 影响

Doctor 每次输出 94 条历史 `WORKTREE_IDENTITY_MISMATCH` warning，真实新债务容易被噪声淹没。当前只能永久保留噪声或绕过受管入口，二者都不可接受。

## 根因

现有 lifecycle 只授权带 current owner receipt 的 `001/111` reclaimable/released 重试。历史 `010` 登记产生于 owner registry 上线前，没有 owner token；CLI 又没有“人类批准精确 stale-registration 快照后只清 Git administrative record”的迁移通道。

## 修复边界

新增显式 migration-only 受管命令：

1. dry-run 只枚举 path 不存在、Git 标记 prunable、无 owner manifest 的 `010` 登记，并生成绑定 path、HEAD、branch、prunable reason 的挑战摘要；
2. apply 必须提交完全匹配的挑战，快照保留 Git porcelain 的完整 `prunable` reason，并绑定所有 owner manifest 的文件名与 SHA-256 digest；执行前重新检查候选集合和 manifest digest，变化即 fail closed；
3. apply 的 final gate 后仍存在 TOCTOU：全局 `git worktree prune --expire now` 没有选择参数，窗口中新登记的 stale registration 会被连带清除，事后 postcondition 只能发现而不能阻止该错误。因此保留公开命令名 `prune-stale-registrations`，但改为对 challenge 批准的每个 path 执行精确、不带 `--force` 的 `git worktree remove <path>`；不删除 branch/ref，随后验证批准登记消失、原有未批准登记和 owner manifests 不变；
4. 任一 unreadable、symlink、wrong-mode 或无效 owner manifest 都使计划/apply 全局 fail closed，绝不可将其当作无 owner；origin HEAD、全部 branch refs、现存 worktree、owner manifests 的字节摘要与工作区文件必须保持不变；
5. 不删除 9 条 released receipt，不删除任何 branch/ref，不依据 TTL 自动授权。

## 验证证据

- 清理前 audit：104 项 = main 1、missing/010 94、released/001 9；既有 reconcile 对 94 条 missing 均给出 `automaticAction=none`；
- 受管 dry-run 精确生成 94 个候选及 snapshot challenge；同一 challenge apply 精确移除 94 条登记；
- 清理后 audit：10 项 = main 1、released/001 9；worktree 仅剩主工作树，Doctor 为 0 error、2 条既有限制 warning；
- branch refs、main HEAD、owner manifest hash 和普通工作区 status 与清理前一致；
- focused lifecycle/shell tests 110/110 通过；完整测试 1115 项中 1086 通过，29 项均为既有 Goal Engine legacy-generation fixture 失败；
- 若精确 remove 中途失败，apply fail closed 并报告 cleanup debt；不得回退到 `--force` 或全局 prune。

## 续跑多候选缺陷

精确 remove 的循环每次都会重新读取快照，以阻止在执行期间的漂移；但原先的预期快照只移除了已完成路径的 `registrations`，没有同步移除 `candidates`。同一 challenge 中第一个候选删除后，实际快照的两个集合都会少一项，第二项因此被误判为 challenge mismatch，无法续跑。

修复要求预期快照同时过滤两个集合，仅移除已成功路径；`ownerManifests`、仓库根/公共目录和未处理候选的完整字段保持原样。若某次精确 remove 失败，保留此前已完成的行政登记和失败候选，返回 `WORKTREE_STALE_REGISTRATION_REMOVE_FAILED`，不 force、不全局 prune、不删除 branch/ref。
