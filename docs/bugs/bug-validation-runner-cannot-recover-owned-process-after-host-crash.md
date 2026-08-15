# 验证运行器在 Host 崩溃后无法恢复已拥有进程

## 问题描述

现有 one-shot acceptance runner 把运行中的 supervisor、终态证明和释放进度主要保留在调用栈中；Host 在持久化边界之间崩溃时，重载方无法以租约和进程出生身份安全地检查、接管或保守处置资源。

## 复现窗口

1. **process started / event missing**：supervisor 已启动而 `process_bound` 尚未形成可检查收据；重载方不能证明 PID、出生身份和租约归属，不能安全记录或释放。
2. **terminal artifact / event missing**：进程已终止并已有输出或终态证明，但 `terminal`、`recorded` 尚未持久化；重载方可能重复记录 artifact，或把内存 timeout 误作终态。
3. **release crash**：终态已记录、工作区或资源已开始释放，但 released 收据未落盘；重载方无法区分已释放、仍占用及身份漂移，可能错误删除资源。

## 修复方案

抽取 durable managed-validation 服务，在 `requested`、`lease_allocated`、`process_bound`、`terminal`、`recorded`、`released` 每个外部副作用前持久化 intent。恢复仅依据 lease、PID birth identity、process group 与终态 artifact；无法证明时写入 `cleanup_debt` 并保留资源。资源 claims 由 lease 调度，释放继续使用 managed worktree 的 owner-CAS。
