# Observation 缺少可恢复的 Host 权威

## 根因
partial Runner 把调用者的 `assertRequestDurable` 当作 authority，并在 managed terminal 后才补写 process-bound；因此业务动作并不受 Goal event durable ack 约束。它还以非 canonical JSON 计算 Condition hash，并把 verdict 字符串而非 R4 ledger 的 strict verdict/evidence summary 写入事件。

## 影响
崩溃可落在 request、lease、process、terminal、record、release 任一窗口；调用者可伪造持久化证明或影响结论。Cycle 0 还可能污染支持证据与 Finding，导致校准结果被误作产品满足。

## 修复
managed supervisor 虽可持久化，但旧 Host 在 callback、start authorization 与 terminal append 间崩溃时仍会丢失编排权威。Runner 现在以最新 `loadProjection` 与 deterministic 找回的 managed receipt 共同决策；恢复时 callback 每次重读 projection，只有 lease 可追加 process、相同 hash 的 process 才确认，其余组合拒绝。managed durable terminal 仅补唯一 Goal terminal，active/debt 不会 record/release。

Runner 只信 Host 私有 `loadProjection`/`persistEvent`，每个外部阶段 append 后读回验证。R3 process callback 先持久化 `condition.observation_process_bound` 并等待 ack，才允许业务 action。artifact 以 no-follow regular 0600/nlink=1 读取，Host classifier 的四个稳定 code 派生 canonical R5 evidence，Goal event 严格使用 R4 payload。Reducer 同步限制 calibrating=Cycle 0、active>=1；Cycle 0 仅保存可判定性 history，不能支持 Condition 或派生 Finding。
