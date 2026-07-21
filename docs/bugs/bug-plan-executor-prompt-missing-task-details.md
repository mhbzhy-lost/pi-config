# Bug: executor 收到的 prompt 缺少任务细节

## 现象

executor 创建了 `sandbox/smoke.txt` 但没有 `git add/commit`。

## 根因

`coordinator.mjs:buildExecutionPrompt()` 生成的 prompt 只有一句：

```
Execute plan task task-1.
```

缺少任务描述（要创建什么文件）和 worktree 操作要求（需要 git commit）。
executor 凭猜测创建了文件，但不知道需要提交。

## 修复

`buildExecutionPrompt` 应包含：
1. 计划中该 task 的完整内容（Files 列表）
2. 明确指示在 worktree 中 commit 变更
