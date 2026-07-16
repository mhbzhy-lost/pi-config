# Bug：pi-subagents 兼容性 Probe 检查了错误的 RPC 接口层

## 1. 现象

`test/pi-subagents-runtime.integration.mjs` 报告 stable RPC v1 的 `ping/status/spawn/interrupt/stop` 全部缺失，同时报告 sentinel Extension 未加载；据此无法通过 Task 1 硬门禁。

## 2. 影响

测试会把“probe 没有访问正确接口”误判为“`pi-subagents@0.34.0` 与 Pi `0.80.6` 不兼容”，从而错误阻塞后续迁移。该失败也不能证明 Plan child Extension、nested safety、structured details 或 stop lifecycle 的真实行为。

## 3. 稳定复现

运行 `PI_REAL_BIN="$(command -v pi)" node --test test/pi-subagents-runtime.integration.mjs`，测试稳定返回五个 `missing RPC method` 和 sentinel/nested/stop 失败；Pi 进程本身正常退出，社区包临时安装和版本检查成功。

## 4. 证据

Pi RPC 文档定义 `get_commands` 只返回 extension slash commands、prompt templates 和 skills，不返回 custom tools 或 `pi.events` channels。`pi-subagents@0.34.0/src/extension/rpc.ts` 将 stable v1 注册到 `subagents:rpc:v1:request` 与 `subagents:rpc:v1:reply:<requestId>` 的进程内 event bus；当前测试却把 `get_commands` 的名称与 `ping/status/spawn/interrupt/stop` 比较。测试生成的 sentinel 还使用了旧式 `pi.registerTool(name, options, handler)` 签名，而 Pi `0.80.6` 要求 `pi.registerTool({ name, ... })`；即使注册成功，custom tool 也不会出现在 `get_commands`。

## 5. 根因

实现把两个不同协议都称为 RPC 后错误合并：外层 Pi JSONL RPC 用于驱动 headless 会话，内层 `pi-subagents` RPC 是 Extension 间的 `pi.events` bridge。probe 没有创建测试 Extension 作为内层 RPC client，而是尝试从外层命令枚举发现内层 method；sentinel 同时采用错误 API 并从错误枚举面验证，导致所有关键断言在真正调用社区 bridge 前就失败。

## 6. 修复与验证策略

先新增会失败的测试，要求临时 probe Extension 通过正确的 `pi.registerCommand()` 暴露一个外层 `/compat-probe` 控制入口；该命令在 Pi 进程内先订阅 reply channel，再向 `pi.events` 发送 stable v1 envelope，并通过结构化 Extension UI notify 返回结果。单元测试验证 event ordering、timeout 和输出解析；真实测试再用该桥调用 `ping/spawn/status/interrupt/stop`，并通过专用 Plan/worker profiles 验证 child Extension 与 nested safety。`get_commands` 只用于证明 `/compat-probe` 命令加载，不再用于推断 stable RPC methods。
