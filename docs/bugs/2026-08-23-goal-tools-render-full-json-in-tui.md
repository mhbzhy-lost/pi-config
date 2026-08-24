# Goal 工具在 TUI 渲染完整 JSON

## 症状

fallback TUI renderer 会展示完整的 Goal 工具调用和结果，包括很大的 execution 合同、action token、审批数据、objective、criteria 及原始 JSON。

## 根因

Goal 工具注册没有提供 `renderCall` 或 `renderResult`，因此 fallback 会渲染公开工具 payload，而不是仅供展示的投影。初始候选 renderer 还把 planned 和 runtime init 输入混为一谈，并且没有遵守以权威 `details.value` 为先的结果读取边界。

## 修复

为八个公开 Goal 工具注册有宽度上限的 display-only renderer。它们从公开调用形状和安全的结果白名单派生 ASCII 单行摘要。runtime init 仅在 `execution.schema=goal-runtime.v1` 时统计其 tasks 和 conditions；planned init 统计顶层 tasks。结果解析优先读取 object 或 JSON-string `details.value`，仅在该字段不存在时回退至 text JSON。不改变 Goal execution、schema、content、details 或 state 行为。

## 回归覆盖

renderer 测试为每个公开工具和每个 `goal_amend` operation 断言字面摘要，并覆盖安全结果解析、partial/error 状态、宽度限制、仅 ASCII 输出和敏感/raw 数据隐藏。extension 集成测试确认全部八个已注册工具均使用该 renderer。
