# Bug：Security Gate Bash 输入字段不匹配

## 1. 现象

`security-gates` 会读取 bash 工具输入中的 `workdir` 或 `cwd`，并将其作为策略执行目录。

## 2. 影响

调用方可伪造未被 Pi schema 支持的字段，改变删除和 Git 命令的安全判断上下文。

## 3. 稳定复现

在 `tool_call` 事件中传入 bash `command`，同时附带伪造的 `input.workdir` 或 `input.cwd`。

## 4. 证据

Pi `0.80.6` 的内建 bash schema 只声明 `command` 和 `timeout`。新增 RED 测试证明旧实现会采用伪造的 `input.workdir`，且在 `ctx.cwd` 缺失时静默放行。

## 5. 根因

扩展沿用了 OpenCode 风格的目录字段适配，但 Pi 0.80.6 内建 bash schema 只定义 `command` 和 `timeout`；真实执行目录只能来自可信的 `ctx.cwd`。

## 6. 修复与验证策略

忽略 bash 输入中的 `workdir` 和 `cwd`，只使用 `ctx.cwd`；若上下文缺失，按 fail-closed 返回阻断结果。

测试覆盖伪造目录字段不影响判断，以及缺失 `ctx.cwd` 时必须阻断；与 Task 3 shell policy 合并运行 23 项测试。
