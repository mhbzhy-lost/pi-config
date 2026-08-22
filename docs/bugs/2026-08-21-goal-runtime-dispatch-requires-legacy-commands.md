# goal-runtime dispatch 错误要求 legacy commands

## 现象

在真实 Manual Preview 中，`doctor-managed-worktree-goal-runtime` 处于 active/pending，且尚未分配 workspace。`goal_status` 已签发 `goal_dispatch` action，但调用后 `stateChanged=false`，并因 `acceptance.commands` 缺失而被拒绝。

## 影响

`goal-runtime.v1` 的 task contract 是仅含结构化 `criteria` 的 transport；dispatch preflight 若仍按 legacy commands 规则校验，会阻止合法的 runtime task 在创建 workspace 前被派发。

## 修复方向

preflight 应以 generation capabilities 的 `taskContract` 选择 criteria-only 校验模式；未知 generation 继续 fail closed。本文不记录任何 token 或 ledger 正文。
