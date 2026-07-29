# Bug: Plan amendment service 只校验部分 revision identity

## 症状
`createPlanAmendmentService()` 回读 current revision 时只比较 manifest `planHash/irHash`，未比较 `planId/revision/manifestSha256/sourceBytesSha256/irVersion`。Direct input 还允许 `expectedProjectionVersion:0` 与空 source；service 测试的 fake append 未通过真实 reducer。

## 影响
被错配或替换的 revision artifact 可能在共享 plan/IR hash 的局部 fixture 下通过 service 前置检查；调用者也可能绕过 Capsule schema 的最小值/非空约束。测试无法证明 service 生成的 payload 真能被 reducer 原子接受。

## 复现
让 `readRevision()` 返回错 planId、revision、manifestSha256、sourceBytesSha256 或 irVersion，但保持 planHash/irHash；当前 service 不会在 parse/prepare 前拒绝。传 version 0 或空 source 也不会由 service input validator 立即拒绝。

## 根因
service identity check 只复制了两个 hash 比对，未复用 Task 5 的完整 revision binding 维度；测试只记录 append 调用名，没有把 payload 应用到 `applyEvent()`。

## 修复
在写前精确比对 read revision 与 projection 的 planId、revision、manifest SHA、source SHA、plan hash、IR version/hash 及 manifest 内 planId/revision。收紧 projection version 为正整数、source 非空。测试 append 使用真实 `applyEvent()` 或等价严格 reducer assertion。

## 验证
新增逐字段 mismatch matrix，断言每项在 prepare 前拒绝；新增 version 0、空 source、过长 reason/source 测试；合法 append payload 通过真实 plan.amended reducer并产生 supersede-requested projection；全部 amendment/revision/Event Writer 回归通过。
