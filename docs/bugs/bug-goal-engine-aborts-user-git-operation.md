# Goal Engine 错误中止用户 Git 操作

## 现象
origin 已有用户 cherry-pick 或 merge 冲突时，Goal Engine 的失败恢复可能执行 `--abort` 并清除用户 sequencer。

## 影响
用户正在处理的冲突、暂存区状态和 sequencer 元数据被破坏，可能丢失未提交的解决工作。

## 稳定复现
制造真实 cherry-pick conflict 或 merge conflict 后调用集成；调用前后精确比较 HEAD、symbolic ref、porcelain status、`CHERRY_PICK_HEAD` 和 `MERGE_HEAD`。

## 根因
集成前没有 sequencer/干净状态门禁，catch 也没有证明 sequencer 属于本次 Goal 命令便无条件 abort。

## 本次处置
副作用前拒绝任何已有 sequencer 或 rebase 状态；仅在 clean preflight 后由本次命令创建且 marker 属于 executor 范围时 abort。

## 防复发
真实 Git sequencer 回归测试要求所有调用前后 oracle 完全一致，并对无法证明所有权的现场 fail closed。
