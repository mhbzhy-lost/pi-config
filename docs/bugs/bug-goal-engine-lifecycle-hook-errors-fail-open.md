# Bug：Goal Engine 生命周期 hook 异常会 fail-open

## 现象
`before_agent_start`、`tool_call` 和 compaction 前的 replay/IO 异常依赖 runner 传播 throw，部分 Pi generic hook runner 会吞掉异常。

## 影响
恢复状态不确定时 mutation 可能继续执行，破坏 fail-closed 安全边界。

## 稳定复现
向 replay 或 candidate selection 注入异常；原 handler 抛出或返回 `undefined`，而不是显式 block/cancel。

## 根因
Extension 未在 hook 边界把异常转换为持久 recovery latch 与 Pi 定义的返回对象。

## 促成因素
单元 fixture 直接观察 throw，未覆盖 generic hook runner 吞异常的行为。

## 修复与验证策略
hook catch 中记录 `state:"active"` latch；before_agent_start 返回恢复消息，tool_call 返回 block，session_before_compact 返回 cancel；ambiguity 同样视为不确定性并持久化 latch。测试每种异常路径。

## TDD 证据
RED：新增 lifecycle ambiguity hook 测试后，旧实现只返回消息/`undefined`，没有 active receipt，测试因读取缺失 latch 失败。
GREEN：所有 hook 边界（scope、replay、session identity、candidate、discovery append）捕获异常；ambiguity 对 write block、对 compact cancel，并记录 active receipt。
