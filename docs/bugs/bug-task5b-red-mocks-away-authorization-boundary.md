# Bug: Task5B Capsule RED 用宽松 mock 绕过真实授权边界

## 症状

Capsule RED 把 `{ agent: "executor", task: "exact contract" }` 当作 exact `dispatch-ir.v1`，同时注入一个对任意输入都成功的 `authorizeExecutorDispatch` mock。测试又期望 control/generic subagent 输入被 Capsule 拦截。Boundary projection 的 durable tool 还遗漏了 Coordinator 始终写入的 `dependencyReceipts: []`。

## 影响

按当前测试实现会迫使 Capsule 重复一套不完整的 contract 识别逻辑，而不是把所有 typed validation 交给 session-local boundary；它也会让 context hash 校验依赖缺失 receipts 的隐式默认值。两者都会造成测试通过但真实 Coordinator contract 无法一致授权。

## 复现

1. 查看 Capsule 测试的 allowed input，缺少 `version/taskId/risk/objective/workflow/boundaries/acceptance/execution`。
2. 查看授权 callback，它不校验 input 却对所有调用返回成功。
3. 查看 boundary fixture 的 `tool`，没有 `dependencyReceipts`，但 context hash 手工使用空数组。

## 根因

测试把 Capsule 路由责任与 Boundary exact validation 责任混在同一个宽松 mock 中，并以简化 tool fixture 代替 Task5A 已建立的 durable tool 合同。

## 修复

Capsule 放行测试使用真实 compiler 生成且去掉派生 `hash` 的完整 `dispatch-ir.v1`，callback 只负责记录并成功；generic/control/未授权测试使用缺失 callback或显式抛错的 callback，断言 boundary reason 原样 block。Boundary fixture 补齐 `dependencyReceipts: []`，context hash直接使用该字段。

## 验证

校准后 Capsule 当前 production 仍仅在 active tools 与 exact dispatch forwarding 两处 RED；Boundary not-implemented 桩下五个顶层测试仍 RED。没有失败来自 unknown contract field、宽松 mock 的矛盾期望或缺失 durable receipts。
