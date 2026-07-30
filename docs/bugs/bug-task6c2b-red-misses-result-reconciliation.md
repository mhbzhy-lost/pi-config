# Bug：Task 6C2b RED 未约束结果恢复闭环

## 症状

Tests-only 提交 `00169a0` 声称覆盖 Executor `tool_result` 提交与 cleaned 重试，但只新增了 Boundary、Capsule 和 Coordinator 的单一 happy path。所谓真实用例只直接调用 Root Broker 的 `spawn` 与 `spawn.lookup`，没有启动 Plan Runner、没有发送 Capsule `tool_result`，也没有验证 Boundary 授权被释放。

## 影响

Task 6C2b 缺少 error result、identity mismatch、重复结果、持久化失败重试、缺失 capability、Coordinator terminal/CAS stop 和 uncertain fence 的先行失败证据。若直接进入 GREEN，Plan Runner 可以只接通成功路径而遗漏 reply 丢失恢复与 late cancel cleanup，且测试仍可能通过。

## 复现

在 `00169a0` 上分别运行 Boundary、Capsule 和 Coordinator 测试，可见新增接口分别以缺失方法或缺失路由失败；运行 `node --test --test-name-pattern='cleaned tool result lookup releases' test/root-subagent-broker.test.mjs` 得到 `1/1` 通过。检查该测试可见它只构造 `RootBrokerServer` 并读取既有 ledger 状态，未加载 `plan-runner.ts` 或 `plan-capsule-extension.mjs`。

## 根因

一次分派同时要求四个层级和多个独立状态分支，Executor 将验收矩阵压缩成每层一个最小示例，并把既有 Broker cleaned 行为误当成 Plan Runner 结果恢复证据。父级没有在分派前把“每个分支必须有独立 RED”和“真实用例必须经过 Capsule handler”拆成可机械核对的逐项测试清单。

## 修复

保留 `00169a0` 中三个有效接口 RED，但新增第二个 tests-only 检查点。分别补齐 Boundary success/error/mismatch/complete/release/uncertain、Capsule success/error/exactly-once/retry/fail-closed、Coordinator duplicate/terminal stop/identity mismatch，并把通过的 Broker-only 测试改为真实 Plan Runner grant/bootstrap/tool_call/execute/tool_result/re-authorize 流程。

## 验证

在不改生产文件的前提下逐组运行新增测试：每个行为必须因目标接口或路由缺失而失败，不能出现 fixture 错误、超时或取消；真实 cleaned 用例必须在第二次 Boundary 授权处 RED，并确认 Broker ledger 已先进入 `cleaned`。GREEN 后再运行 Boundary、Capsule、Coordinator、Backend、Broker、Dependencies 和 doctor 累计门禁。
