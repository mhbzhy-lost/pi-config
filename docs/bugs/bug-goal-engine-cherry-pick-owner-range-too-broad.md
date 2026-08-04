# Goal-owned cherry-pick 所有权范围过宽

## 现象
Goal 的恢复逻辑把 `CHERRY_PICK_HEAD` 指向 executorHead 的任意祖先视为本 Goal 所有；用户正在处理的较早祖先 cherry-pick 会被错误 abort。

## 影响
恢复重试会破坏用户 Git sequencer、工作区冲突现场和待完成的 cherry-pick，违背无法证明所有权时保留现场的约束。

## 稳定复现
创建 lease 后在 executor 分支提交；在 origin 上构造指向 `baseCommit` 或更早祖先的真实 cherry-pick 冲突，使该 marker 是 executorHead 祖先但不在 `baseCommit..executorHead`。调用恢复路径会被旧逻辑当作 Goal-owned 并 abort。

## 根因
cherry-pick 所有权只使用 `merge-base --is-ancestor marked executorHead`，该关系包含范围下界 `baseCommit` 及其全部祖先，未证明 marker 是 executor 本次待集成提交范围中的排他成员。

## 本次处置
在原有祖先关系外，要求 marker 也属于 `lease.baseCommit..executorHead`；范围外或无法证明时闭锁拒绝，不追加事件、不 abort、不移动 ref/HEAD，也不清理资源。merge 仍只接受 `MERGE_HEAD === executorHead`。

## 防复发
使用真实 Git 仓库回归覆盖范围外祖先用户 cherry-pick 的 ref、HEAD、status 和 marker 原样保留，并保留多 commit 范围内 Goal-owned cherry-pick 崩溃恢复用例。
