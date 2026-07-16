# Bug：Interrupt/Stop 测试的 compat-wait fixture 未正确接入 child

## 1. 现象

新增 interrupt 测试尚未执行到真实门禁：生成的 probe source 重复声明 `deadline/status`；即使删除重复块，compat-wait profile 也没有加载 wait Extension，tool handler 参数签名错误，status loop 还等待错误 mode。

## 2. 影响

测试可能在 child 启动、tool 注册或 30 秒无效轮询处失败，并把 fixture wiring 错误误报为 interrupt/stop 不兼容；未终态 child 还可能在 cleanup 时再次丢失临时依赖。

## 3. 稳定复现

读取 `test/pi-subagents-runtime.integration.mjs` 的生成模板即可稳定确认：同一 scope 两次声明 `const deadline` 和 `let status`；agent frontmatter 只有 `tools: compat_wait`，没有 `subagentOnlyExtensions`；tool `execute(_args, ctx)` 与 Pi 五参数签名不符；loop 只在 `status.details.mode === "management"` 时 break，而真实 status 已证明 mode 为 `single`。

## 4. 证据

Pi `0.80.6` ToolDefinition 签名为 `execute(toolCallId, params, signal, onUpdate, ctx)`。`pi-subagents@0.34.0` agent frontmatter 明确要求通过 `extensions` 或 `subagentOnlyExtensions` 把 custom Extension 加入 child argv。已通过的 status 测试真实返回 `details.mode:"single"`；management mode 属于 interrupt 等控制结果，不是普通 status result。

## 5. 根因

测试实现复制了两段轮询代码，并再次根据字段名称猜测宿主 API，没有把已验证的 profile Extension wiring、ToolDefinition 签名和 status payload 契约复用为单一 fixture。多个独立错误叠加，使当前 RED 不具备诊断 interrupt/stop 的意义。

## 6. 修复与验证策略

先删除重复声明；在 profile 写入绝对 `subagentOnlyExtensions` 路径；按真实签名从第三个参数读取 AbortSignal；status RPC 任一次成功即结束 readiness loop，run/state 继续由 artifact 证明。Interrupt 不解析格式化 text，只断言 RPC 无错误、management mode 和 artifact paused/control event；stop 断言 typed `state:"stopping"/runId` 后等待真实 terminal artifact。每个 run 终态后再 cleanup。
