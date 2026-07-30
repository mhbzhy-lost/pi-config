# Bug: Task6A RED 混淆 broker identity 边界并被夹具异常阻断

## 症状

Task6A tests-only RED 要求 upstream spawn params 包含 trusted `spawnKey`，与 broker-private ledger 边界冲突；lookup helper 直接返回 `BrokerResponse`，测试却按 socket helper 的 `{ reply }` 读取，新增 lookup/preflight 用例以 `TypeError` 而不是目标协议断言失败。Extension resolver 用例也把“调用、payload、metadata forwarding”串在一个测试中，首个失败会遮蔽后续证据。

## 影响

若按错误 RED 实现，Root upstream runtime 会收到领域 dispatch identity，破坏 runtime 不知道领域 parent/拓扑的约束。夹具 `TypeError` 和复合断言无法证明 `spawn.lookup`、caller 隔离、not-started 或 resolver metadata 合同，可能让错误实现误绿。

## 复现

1. 运行 `node --test test/root-subagent-broker.test.mjs`：lookup 相关用例出现 `Cannot read properties of undefined`。
2. 查看 trusted metadata 用例的 expected upstream call，其中包含 `spawnKey`。
3. 运行 extension 测试：resolver 未调用后立即在 `resolved.length` 失败，payload 与 raw metadata 断言未独立执行。

## 根因

测试同时混用了 socket helper 和 direct server dispatch 两种返回形状；调整挂起时只替换了调用路径，没有同步规范 response fixture。设计上又把“client 到 broker 的可信 metadata”误当成“broker 到 upstream 的 spawn 参数”，没有在测试中明确 ledger 消费并剥离 identity 的 trust boundary。

## 修复

统一 direct dispatch helper 返回 raw `BrokerResponse`，每条测试先直接断言目标 response code/state，不再解构不存在的 `reply`。将 spawned lookup、unknown lookup、caller isolation、conflict 与 uncertain 分成独立 tests。Client metadata 用例断言 durable key 可 lookup、model key 不可 lookup，且 upstream params 不含任何 `spawnKey`。Extension 将 resolver invocation、exact payload、raw RPC metadata 拆成独立 RED，并用 compiler 的 exact hash。

## 验证

现有 28 条 broker 基线保持通过；每个新增能力要么直接断言缺失 API/错误 response，要么在独立测试中失败，不出现 `TypeError`、timeout 或前置断言遮蔽。全局搜索确认 expected upstream spawn params 不含 `spawnKey`，暂存区为空，提交只含测试夹具与本根因文档的独立提交。
