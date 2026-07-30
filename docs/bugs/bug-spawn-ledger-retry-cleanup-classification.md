# Bug: Spawn ledger 错分可重试失败与已清理运行

## 症状

Root broker 把所有 upstream spawn rejection 都永久记为 `uncertain`；Executor grant 写入失败后即使 stop 成功，也仍记为 `uncertain`，且 ledger 没有 `not-started` / `cleaned` 状态。Plan execution backend 只发送稳定 requestId，没有发送同值 spawnKey。Trusted requestId 还会先替换非法字符，可能把不同 identity 归一成同值。

## 影响

明确未启动或已成功停止的 Executor 无法安全重试，Attempt 在整个 Root session 内被永久 fence；backend legacy/recovery 路径仍绕过 ledger，reply 丢失时可能重复 spawn；不同非法 requestId 可能碰撞，削弱诊断与后续复用安全性。

## 复现

1. 让 upstream 首次抛出带 `spawnDisposition: "not-started"` 的错误，再以同 spawnKey 重试；当前第二次返回 `spawn_uncertain`。
2. 让 upstream 返回 binding、grant write 失败、stop 成功；当前 lookup 返回 `uncertain` 而非 `cleaned`。
3. 调用 execution backend spawn；当前 RPC options 只有 requestId，没有 spawnKey。
4. 分别使用 trusted requestId `dispatch/a` 与 `dispatch?a`；当前都被规范成 `dispatch-a`。

## 根因

Ledger 只按“broker 是否调用过 upstream”分类，没有要求 upstream 用显式 disposition 证明调用前失败，也没有把 cleanup proof 纳入状态转换。Backend 沿用了旧 RPC 的单 requestId 约定。Client 的 requestId helper 原为随机 ID 清洗设计，被错误复用于可信 durable identity。

## 修复

只有显式、严格的 `spawnDisposition: "not-started"` 才允许 ledger 进入可重试 not-started；未标记 rejection 保持 uncertain。Grant/ownership 失败后 stop 成功进入 cleaned，并允许同 key、同 params 的受控重试；stop 失败保持 uncertain并保留两项错误证据。Backend 同时传 `requestId + spawnKey = dispatchId`。Trusted requestId 不做替换，非法值直接 `REQUEST_ID_INVALID`。Settled 后清空 promise，保留最小 reply/binding供 Root-session lookup。

## 验证

独立 RED 覆盖 not-started 同 key 重试、未标记 rejection 继续 fence、grant 失败且 stop 成功的 cleaned lookup/重试、stop 失败 uncertain 与双错误、backend exact metadata、两个规范化碰撞输入严格拒绝。原有顺序/并发幂等、caller isolation、model spawnKey剥离和 legacy无 key兼容继续通过。
