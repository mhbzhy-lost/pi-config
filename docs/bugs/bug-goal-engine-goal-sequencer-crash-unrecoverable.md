# Goal Engine 崩溃后遗留 sequencer 无法恢复

## 现象
Goal 的 cherry-pick 或 merge 发生冲突、进程在 abort 前崩溃后留下 marker；重试把它一律当作用户 sequencer，永久拒绝。

## 影响
可证明由本次 Goal 创建的冲突现场无法自动回到 started 前的干净状态，任务只能人工修复，正常重试不可用。

## 稳定复现
使 disposition 已进入 disposing，创建真实 cherry-pick 或 merge conflict；marker 指向 persisted executorHead（或其范围），当前 ref/HEAD 与 originHeadBefore 一致；重试旧逻辑直接拒绝。

## 根因
现有 preflight 在所有 ownership 判断前拒绝 sequencer，缺少把持久化 origin 身份、策略和 executor 范围作为最低证明的恢复入口。

## 本次处置
先验证 originRef、originHeadBefore、strategy、executorHead，再只对 marker/range、ref、HEAD 和状态均匹配的 Goal sequencer 执行 abort；abort 后机械复核 ref、HEAD、status，否则闭锁失败。

## 防复发
真实 Git cherry-pick/merge 回归分别覆盖可归属恢复，以及 marker 不匹配、REVERT_HEAD、rebase 和未知 sequencer 的原样保留拒绝。
