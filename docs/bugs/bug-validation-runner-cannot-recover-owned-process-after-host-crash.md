# 验证运行器在 Host 崩溃后无法恢复已拥有进程

## 问题描述

现有 one-shot acceptance runner 把运行中的 supervisor、终态证明和释放进度主要保留在调用栈中；Host 在持久化边界之间崩溃时，重载方无法以租约和进程出生身份安全地检查、接管或保守处置资源。

## 根因

旧 `startManagedValidation` 在调用 `runCleanValidation` **之前**就把父 receipt 写成 `phase=process_bound`，但该 record 没有 `process` 字段，实际只是空的“绑定意图”。真实 supervisor PID/birth identity 仅在 `runCleanValidation` 内部的 nested validation lease 中写入；紧接着它就创建 `start` authorization 并启动业务 action。因此父 receipt 可恢复身份、Host observation durable ack 与 action 启动之间存在 crash window。

## 复现窗口

1. **空 process_bound / action started**：父 receipt 已显示 `process_bound`，但没有真实 PID、出生身份、process group 或 hash；`runCleanValidation` 内部已得到真实身份且可立即启动 action。Host 在此处崩溃时，重载方不能从父 record 证明或安全处置进程。
2. **process started / event missing**：supervisor 已启动而 `process_bound` 尚未形成可检查收据；重载方不能证明 PID、出生身份和租约归属，不能安全记录或释放。
2. **terminal artifact / event missing**：进程已终止并已有输出或终态证明，但 `terminal`、`recorded` 尚未持久化；重载方可能重复记录 artifact，或把内存 timeout 误作终态。
3. **release crash**：终态已记录、工作区或资源已开始释放，但 released 收据未落盘；重载方无法区分已释放、仍占用及身份漂移，可能错误删除资源。

## 修复方案

复用既有 `runCleanValidation` supervisor，并在其已 spawn+ready、捕获 birth identity、验证 process group、nested lease runtime 持久化并读回后、写 `start` authorization 前插入私有一次性屏障。屏障先 fsync 父 record 的 exact `process={pid,pidBirthIdentity,processGroupId,processIdentityHash}` 并读回验证，再调用 Host `onProcessBound`；callback resolve 是 durable ack，之后才可创建授权和启动 action。requested/lease_allocated 的 process 均为 null。callback 或身份验证失败只终止本 run 可证明 owned 的 group，并将父 record 和 nested lease 置为 `cleanup_debt`；未知身份不 kill。

恢复同时验证父 record 的 PID/birth/group/hash（且 group 必须等于 PID）、group probe 包含 PID，以及 nested validation lease 的 running runtime PID/birth 与 managed owner/workspace identity。任何未知或不匹配都只写 `cleanup_debt` 并保留 workspace/resource，完全匹配才幂等返回 `process_bound`。所有未 `released` 的 record（包括 cleanup debt）持续持有 resource claim，直到 typed/managed release 或后续债务处置；不得因 callback reject 已证实 supervisor terminal 自动释放。资源释放继续使用 managed worktree 的 owner-CAS。
