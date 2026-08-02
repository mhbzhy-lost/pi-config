# Subagent 状态提示了工具 schema 不支持的 resume

## 现象

失败 run 的状态输出明确给出 `Revive: subagent({ action: "resume", ... })`，系统 attention 提示也建议 routed resume；实际调用立即被工具 schema 拒绝，因为 action 只允许 `status/steer/interrupt/stop`。

## 影响范围

无法按诊断建议恢复因 fetch 失败的客户端修复 run；必须新派发剩余最小任务，增加上下文和调度成本。

## 复现步骤

对 failed run `7ed5d092-10bd-4f34-b72c-2c54f09ab4da` 调用 `subagent({action:"resume",id:...,message:...})`，得到 schema anyOf 校验失败并显示 action 不在允许集合。

## 根因

运行时状态/attention 文案与当前暴露给主代理的 `subagent` 工具 schema 版本不一致：后端知道 resume 语义，但前端工具契约未开放该 action。

## 修复方案

本任务不修改基础设施。对已落盘代码先独立验证，再使用新的完整 `dispatch-ir.v1` 派发剩余最小 TDD 修复；后续应让状态提示仅生成当前 schema 支持的动作，或在 schema 中正式开放 resume。

## 验证方式

新任务只修改 Socket handler 与对应单测，完成 RED/GREEN、完整 unit 和 tsc；原 failed run 不再重试。
