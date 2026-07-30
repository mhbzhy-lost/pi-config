# Bug：Root teardown 失败后丢失 cleanup ownership

## 1. 现象

Broker 的 grant cleanup 即使失败，仍会在 `finally` 中 dispose/clear；upstream dispose 失败后也会
clear。Root extension 的 `beforeRuntimeDispose` 即使失败仍在 `finally` unbind；generic typed runtime
的 `beforeDispose` 失败后也仍 finally dispose RPC 并删除 cleanup entry。于是首次 close 失败后，
第二次 close 已失去 registry、server、subscriptions、listener、owned run、grant、ledger 与 upstream
的引用，无法重试。

## 2. 影响

teardown 的短暂 I/O 或 RPC 失败会被不可逆地转换为 ownership 丢失：server 可能仍 listening，grant
目录或 subscriptions 可能仍存在，upstream 尚未 dispose，但 Root 已不能再次定位并完成清理。现有
`broker disposes upstream when grant cleanup fails` 测试表达了与 8C 目标相反的旧行为，tests-only
阶段必须先校准该预期。

## 3. 触发条件与证据

- A：grant `rm` 失败时不得 dispose/clear，server 仍 listening；移除目录债务后 retry 应成功。
- B：`upstream.dispose` 首轮 reject 后，必须保留 server object、subscriptions/listeners、ledger 与
  registry；retry 仅再 dispose 一次，成功后才清理。
- C：runtime `beforeRuntimeDispose` 中 Root broker close reject 后，`requireRootBroker` 仍返回同一
  broker，RPC 尚未 dispose；第二次 shutdown close 成功后才 unbind/dispose。
- 这些 RED 必须独立保存失败后的引用和可重入行为证据，而不只断言第一次 rejection。

## 4. 根因

资源释放被写成无条件 finally 路径，没有区分“外部 side effect 已成功提交”和“本地 ownership 已可
安全遗忘”。grant、transport、upstream 与 Root runtime marker 的提交点不同；失败时提前 clear/unbind
把仍负有清理责任的对象从 retry 路径移除。generic typed runtime 也缺少针对 Root 的保留模式。

## 5. 处理决策

Broker 按 `grants removed -> transport closed -> upstream disposed -> listener/maps release` 分阶段
提交。已完成 phase 可重入；失败时保留未提交 phase 及诊断引用，第二次 close 只继续剩余债务。Root
extension 仅在 broker close 成功后 unbind/reset marker。typed extension 增加 Root 专用的
retain-on-beforeDispose-failure 模式，默认行为保持不变。正常 close ordering 不变：drain Executors、
Plan Runner、`root.closing`、transport close、upstream dispose；cleanup debt 不广播 `root.closing`。

## 6. 验证

1. RED A 证明 grant `rm` failure 后无 dispose/clear、server 继续 listening；删除目录债务后第二次
   close 完成分阶段清理。
2. RED B 证明 upstream 首轮 reject 后 server、subscriptions/listeners、ledger、registry 都仍可见；
   retry 只补做一次 dispose，成功后才释放本地引用。
3. RED C 证明 `beforeRuntimeDispose` reject 后同一 broker 与 RPC ownership 均被保留；第二次
   shutdown 成功后才 unbind broker 并 dispose RPC。
4. GREEN 后运行校准的 Root Broker 与 runtime membrane 用例，确认 phase 完成可重入、失败只保留
   cleanup debt，且无额外 `root.closing` 广播。
