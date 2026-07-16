# Plan Gate 误读验证命令并接受过期 HEAD

## 现象

计划解析器输出 `verification: ["node --test", ...]`，Gate runner 却把整个数组解构为单个可执行文件及参数；同时 runner 只读取真实 HEAD，没有核对事件 projection 中记录的 HEAD。

## 影响范围

合法计划的 deterministic Gate 无法正确执行一条或多条命令；若 projection 已过期，四类 Gate 仍可能针对另一个提交返回可验证结果，之后无法安全写入 `gate.finished`。

## 复现步骤

向 `runPlanGates()` 传入两个命令字符串并准备完整 projection，当前 deterministic Gate 失败且命令未全部执行。把 projection 的 `workspace.headCommit` 设为旧提交，当前 runner 仍可能返回 `validated: true`。

## 根因

Task 10 测试只覆盖失败路径，没有建立从 `parsePlanDocument().verification` 到 Gate runner 的正向 contract；runner 因而把“命令字符串数组”误实现为“单条命令的 argv”。HEAD 绑定也只在 runner 内部自洽，没有与 append-only projection 的 workspace identity 对齐。

## 修复方案

按顺序执行每个计划声明的命令字符串，任一非零即失败；Gate preflight 同时要求真实 HEAD 等于 `projection.workspace.headCommit`。命令字符串按显式验证 contract 交给固定 shell，不把未受信参数拼入命令。

## 验证方式

新增正向测试验证两条命令均执行且四类 Gate 通过；新增 stale projection 测试验证旧 HEAD fail-closed。随后运行 Gate 目标测试及完整 `npm test`。
