# Bug: amendment 资源占用判定与 Frontier 不一致

## 症状
`validateAmendment()` 用固定 Attempt 状态集合推断 active resource claims；`authorizedFrontier()` 则以 `workspaceReleased !== true` 且状态未进入 `cancelled/failed/integrated` 判断 claim 是否仍存在。两者对 `succeeded`、`blocked`、`interrupted` 等状态结论不同。

## 影响
amendment 可能接受低于实际未释放 claim 的新容量，后续 Frontier/recovery hydrate 同一 projection 时失败；也可能遗漏在旧 effective hash 下已 succeeded 但尚未验证/集成的 Attempt。

## 复现
构造 `succeeded`、`blocked` 或 `interrupted` Attempt 且 `workspaceReleased !== true`，降低对应 resource capacity，运行 `test/plan-amendment.test.mjs`；当前 amendment 校验不拒绝，但 `authorizedFrontier()` 仍把这些 Attempt 的 claim 纳入。

## 根因
amendment 模块复制了状态枚举，没有复用资源释放事实的语义。Attempt status 与 workspace/resource lease 生命周期不是同一个维度。

## 修复
将资源 claim 判定改为与 Frontier 一致的 predicate：workspace 未释放，且状态不是 `cancelled/failed/integrated`。supersede 单独覆盖仍可产出或携带旧合同结果的 `workspace-allocated/dispatch-requested/active/waiting-attention/succeeded/validated`，不再用资源 predicate 代替合同状态。

## 验证
参数化覆盖 `succeeded/blocked/interrupted` 在 release 前阻止 capacity 下调、`workspaceReleased:true` 后不再占用；断言 succeeded 在 effective hash 改变时 supersede，而 released/failed/cancelled/integrated 不 supersede；关联 Frontier 测试保持通过。
