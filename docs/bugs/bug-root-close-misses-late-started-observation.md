# Bug：Root close 漏掉 late-started observation

## 1. 现象

`closeRootSession()` 只在入口处快照 `startedObservations`、`executorGrants`、`callerGrants`
和 spawn promises。若 durable spawn 在该快照之后才 emit trusted `async-started`，并注册仍为
pending 的 birth capture，close 会漏掉这项新 observation。spawn promise 又可能先于 capture
settle，导致 close 直接 drain 初始 identity，既不等待新 observation，也不会停止对应 Executor。

## 2. 影响

Root 的关闭结果可能在仍有可信、已出生但尚未可收集的 durable Executor 时返回成功。该 Executor
不会进入官方 stopped proof 的收集和验证路径，造成运行残留与关闭完成语义不一致。该缺口只影响
close 中的观察收敛；不是通过广播 `root.closing` 来处理 cleanup debt 的理由。

## 3. 触发条件与证据

- close 已完成入口快照，但 durable spawn 仍处于 pending startup。
- spawn release 时同步 emit executor `async-started`，并注册 pending birth capture。
- spawn promise 在 birth capture release 前先 settle。
- 独立 RED 应把该 pending durable spawn 视为初始 barrier 的一部分：capture release 前，close
  必须保持 pending 且 `stops=[]`；release 后必须 stop 该 Executor、取得有效 official proof 并完成。
- 当前实现会在 capture release 前提前 stop/close，说明一次性快照和初始 drain 无法覆盖 late-start。

## 4. 根因

close 的 barrier 被实现成入口对象的静态集合，错误假定 spawn promise settle 即表示其后续的
trusted observation 已经可见且可 drain。实际 startup 包含两个独立时间点：promise settle 与
birth capture/`async-started` 注册；后者可晚于前者。因此初始 identity drain 不构成关闭时的完整
observation 集合。

## 5. 处理决策

在固定的总 deadline 内重复收集 close barrier，直到 pending startup collections 清空。每一轮都要
重新纳入新注册的 observation、grant 与 spawn/birth capture，并以 `Promise.allSettled()` 等待该轮
收集结果后再判断是否收敛。deadline 不得续期；超时不得触发 stop、teardown 或 dispose，避免把
未完成的 startup 误当成可清理 identity。正常成功关闭的顺序仍保持为 drain Executors、Plan Runner、
`root.closing`、transport close、upstream dispose。

## 6. 验证

1. 新增独立 RED：pending durable spawn 被纳入初始 barrier；capture release 前 close pending 且
   `stops=[]`，release 后停止该 Executor、读取有效 official proof 并完成。
2. GREEN 后，close 在总 deadline 内持续收集 late-started observation；每轮 collection 使用
   `allSettled`，不会因单轮 rejection 丢失后续收集机会。
3. deadline 到期时断言未调用 stop、teardown、dispose，且 deadline 没有被新一轮 collection 延长。
4. 既有正常 close ordering 断言保持不变：Executors、Plan Runner、`root.closing`、transport、
   upstream 依序完成。
