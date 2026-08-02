# Bug: plan.amended reducer 未验证 Supervisor Attention 授权

## 症状
amendment service 会查找 resolved blocking Attention，但 `plan.amended` reducer 只验证 requestId 格式和未使用，事件调用者可提交任意合法 requestId。

## 影响
绕过 service 的 Event Writer 路径可以 commit 未经 Supervisor 请求授权的 revision；replay 也无法证明 revision commit 来源符合领域合同。

## 复现
在含 revision identity、但没有 matching Attention 的 projection 上直接应用合法 `plan.amended`；当前 reducer 接受并推进 revision。

## 根因
授权校验只放在 service orchestration，没有进入单写者 reducer 的原子不变量；早期 event fixtures 也没有构造 Attention，掩盖了缺口。

## 修复
reducer 要求 projection 中恰好一个 Attempt 的 blocking Attention 满足 `requestId` 相等且 `status:"resolved"`；零个、多个、pending/escalated/nonblocking 都拒绝且 projection 不变。保留 service 的前置校验用于 fail-before-prepare。

## 验证
参数化 event RED/GREEN 覆盖 missing/unknown/duplicate/pending/escalated/nonblocking；合法 resolved blocking event 接受并 replay；service 继续在 prepare 前拒绝非法来源。
