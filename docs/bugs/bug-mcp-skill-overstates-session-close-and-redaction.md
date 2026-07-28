# Bug：MCP 薄 Skill 过度声明会话关闭与模型前脱敏

## 1. 现象

`dp3-mcp` 与 `crash-mcp` 的首版文档声称每条命令都会关闭 TMCP 会话，并要求在发送模型前投影
PII/signed URL；实际 wrapper 直接 `exec um ... -f json`，这两项保证均超过当前实现能力。

## 2. 影响

- Ultima 某些错误路径在连接建立后直接 `process.exit(1)`，不会执行 `finally` 中的
  `closeMcpClient()`；服务端会话可能只能等待超时回收。
- `um` 将完整工具结果写到 stdout，Pi 的 Bash tool 会先把原始结果放入模型上下文；事后投影无法
  实现“模型前脱敏”。
- GREEN artifact 和静态测试可能在上述事实不成立时仍宣称验收通过。

## 3. 稳定复现

- 查看本机 Ultima `call-tool.ts` 与 `list-tool.ts`：连接后的 catch 分支调用 `process.exit(1)`，
  cleanup 位于后续 `finally`。
- 查看两个 wrapper：`call` 以 `exec "$UM" ... -f json` 原样转发 stdout，没有响应投影层。
- fake `um` 测试只覆盖成功参数转发和鉴权前置，无法证明上游失败 cleanup 或响应脱敏。

## 4. 证据

- `@ali/ultima 0.2.77` 的 `process.exit()` 会立即结束 Node 进程，JavaScript `finally` 不再执行。
- Ultima `call-tool.ts` 的 JSON 分支直接 `process.stdout.write(formatToolResultJson(result))`。
- 两个 Skill 的数据边界写的是发送模型前投影，但 CLI 没有字段 schema 或 sanitizer。
- reviewer 独立核对了源码、wrapper 与 GREEN artifacts，未执行真实网络调用。

## 5. 根因

设计目标“wrapper 不保留跨调用状态”被错误表述为“每条命令在所有路径可靠发送协议 close”；数据
最小化目标也被错误表述为“通用 CLI 能在模型看到前动态脱敏”。薄 wrapper 只负责固定 server 和收窄
参数面，不能替代 Ultima cleanup，也不知道每个工具返回 schema。

## 6. 修复与验证策略

- 保持 wrapper 薄且不修改 Ultima：文档改为生命周期委托给 `um tmcp client`，wrapper 不保留状态；
  明示正常成功路径关闭、部分上游错误路径可能依赖进程/socket 与服务端超时回收。
- 明示 raw stdout 会进入当前 agent 上下文；调用前用 schema 的列/字段能力最小化。不能排除
  PII/signed URL 的工具禁止通过 Pi 的模型可见 CLI 调用，应改用批准的非模型消费者。
- 先增加静态 RED，防止重新出现“所有路径都 close”或“CLI 已模型前脱敏”的表述，再更新两个 Skill、
  GREEN artifacts 和实施计划。
- 不在本任务引入 MCP SDK、daemon、连接池或通用响应 sanitizer。
