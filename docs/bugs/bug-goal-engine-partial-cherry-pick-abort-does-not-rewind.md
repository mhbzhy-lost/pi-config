# 多提交 cherry-pick 异常终止后 abort 未回退 HEAD

## 现象
Goal 集成多个 cherry-pick 时，首个提交完成后的 Git 进程异常终止会留下已前移的 HEAD、首提交文件或 sequencer marker；旧代码捕获原始错误后只尝试 abort 并吞掉其结果。

## 影响
失败的集成不是原子的：origin 混入部分 Goal 提交，后续重试或用户操作面对残留的 Git 现场。

## 稳定复现
在真实仓库的 `post-commit` hook 中一次性终止其 Git 父进程，再执行包含两个提交的 `cherry-pick` 集成。首个提交已写入，但集成调用抛错；Git 可提示 HEAD 已移动且拒绝 rewind。

## 根因
`cherry-pick --abort` 的成功退出码不保证回退已提交的首项。旧 catch 忽略 abort 异常，也没有对 ref、HEAD、用户可见状态和全部 sequencer 状态作机械后置验证。

## 本次处置
仅在 Goal marker、目标 ref 和调用前 origin 身份可证明时恢复。先 abort 并复核；若 marker 已清除而 HEAD 未回退，在仍绑定同一 originRef、干净状态的前提下显式 `reset --hard originHeadBefore`，再复核全部后置条件。任何无法证明或复核失败均闭锁并提示人工恢复。

## 防复发
真实 Git 的一次性 post-commit hook 回归覆盖首项提交后中断，验证 HEAD、状态、marker/sequencer 和首项文件均恢复；Goal-owned 崩溃重试复用相同恢复后置条件，用户及范围外 sequencer 保持不变。
