# Bug：Task 5A2 长文本 RED 无法重构完整 IR 语义

## 症状

Task 5A2 修正提交 `b7ac19e` 后，15 个用例均形成 RED，但 long-text 用例要求 `contract.requirements.join("")` 等于传入的 5000 个 `x`，并只选择 `startsWith("Plan instructions: ")` 的 facts 重构同一段 `x`。

## 影响

该断言无法由保留完整 IR 语义的实现满足。`task.body` 还包含 Files 声明，`plan.instructions` 还包含 Goal；若实现迎合测试，会丢弃这些已进入 `plan-ir.v3` 的权威内容。多个 instruction chunk 也无法都使用同一前缀后直接 join 并只移除一次前缀。

## 复现

编译 `v3Plan({ instructions: "x".repeat(5000), body: "x".repeat(5000) })`，可见 `ir.nodes[0].body` 为 Files 段加正文，`ir.instructions` 为 Goal 加正文。检查测试的 filter/join：continuation chunk 不带前缀时不会被选中；每个 chunk 都带前缀时 join 后会残留后续前缀。

## 根因

测试按 Plan Markdown helper 的参数值编写预期，没有从与生产相同的 current compiled IR execution view 获取完整字符串；同时没有先定义多 chunk facts 的可逆编码格式。

## 修复

测试改为从 `compilePlanToIR(approvedPlan)` 读取完整 `task.body` 和 `plan.instructions`。requirements chunks 直接连接后必须等于完整 task body；长 instructions 使用明确的带序号 chunk 前缀，测试逐项移除前缀后连接并比较完整 instructions。单 chunk happy-path 格式保持不变。

## 验证

修正后的 long-text 测试仍在当前 Coordinator 的 4096-byte compiler 限制处 RED，但期望可由无损分块实现满足。其余 14 个 Task5A2 RED 和既有 happy GREEN 不变，生产 Coordinator 相对 `2a1e116` 无差异。
