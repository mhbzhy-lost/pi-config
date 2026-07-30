# Bug: Flat Plan Runner provider 跨派发波次误算完成进度

## 症状

Plan Runner 完成第一批 Executor、集成结果并进入第二批 `dispatch-required` 后，确定性 provider 可能直接返回等待文本，不再调用第二批 `subagent`；即使第二批通过其他方式完成，后续 `validated` 状态也不会触发 `plan_continue` 集成。

## 影响

包含依赖链、amendment 后续任务或其他多波次 frontier 的真实 Harness 会永久停在运行中。单波次 parallel 测试仍可通过，因此该问题会被基础 happy path 隐藏。

## 复现

1. 第一轮 `plan_continue` 返回一个 `dispatch-required` contract，并收到一个 `subagent` 结果。
2. 第一轮 Attempt 进入 `validated`，调用 `plan_continue` 完成集成。
3. 下一轮 `plan_continue` 返回新的单个 `dispatch-required` contract。
4. Provider 用全会话 `subagent` 结果总数与第二轮 contract 数量比较，误判第二轮已经全部派发；第二轮完成后又因全会话 `plan_continue` 结果数大于一而拒绝集成。

## 根因

Flat Plan Runner 状态机按工具名统计整个 session 的累计结果，没有把 `subagent` 结果和 `plan_status` 后的集成动作限定到最新 `plan_continue` 波次。累计数量不是当前 frontier 的进度，也不能表达消息顺序。

## 修复

以最新 `plan_continue` 结果的消息索引作为派发波次边界，只统计该索引之后的 `subagent` 结果。集成判断改为比较最新 `plan_status` 与最新 `plan_continue` 的消息顺序：仅当最新 validated/succeeded status 晚于最后一次 continue 时调用 `plan_continue`，不依赖累计次数。

## 验证

增加独立 RED 覆盖第二个 `dispatch-required` 波次仍原样派发新 contract，以及第二波 validated status 仍调用 `plan_continue { reason: "integrate" }`。保留单波次 exact contract、push-driven status 和 Attention fence 全量回归。
