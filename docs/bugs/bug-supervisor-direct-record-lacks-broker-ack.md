# Bug：Supervisor direct record 缺少 Broker 持久化 ACK

## 症状

Root-owned adapter直接调用Plan `recordSupervisorRequest`后，Broker仍只知道push已写入subscription socket，不知道Attention领域事件是否成功持久化。Plan Runner generation在socket写出与本地FIFO入队、record完成之间退出时，请求无法可靠重放。

当前`session_shutdown`顺序更早暴露该问题：typed subagent runtime先注册shutdown handler并先`rpc.dispose()`，adapter后注册的drain才执行。

## 影响

Broker可移除caller push FIFO并等待native reply，但Plan projection没有Attention。Executor永久等待，Plan保持active。即使adapter direct callback覆盖常见settle窗口，最后一批已写socket但尚未触发`data`callback的push仍可能静默丢失。

重叠`agent_settled`和`session_shutdown`时，后者等待前者同一失败promise并直接继承rejection，不会用shutdown ctx重试。`dispose()`清空pending FIFO也会把未提交请求静默删除。

## 复现

1. Broker向active Plan Runner subscription写Supervisor push。
2. 在client `data`callback入队或Attention append完成前触发generation shutdown。
3. typed runtime先关闭RPC subscription；adapter drain看不到尚未入队的frame，或等待settled drain的失败promise后直接抛出。
4. official terminal proof到达后Broker没有“未ACK请求”状态，因而不会为该请求排队并revive。

## 根因

现有协议只有`supervisor.pending`和`supervisor.reply`，没有由Plan Runner在领域提交成功后发送的应用层ACK。transport write被错误地当成了领域交付完成。

adapter本地FIFO也只记录message，不区分“领域record已成功、ACK尚未成功”，所以简单重试会重复append同一Attention；Plan dependency目前对exact replay也不幂等。

## 修复

新增owner-fenced `supervisor.ack` RPC。Broker为每个pending request保存`announced`状态；只有Plan Runner完成exact `recordSupervisorRequest`后才能ACK。未ACK请求在其Plan Runner official terminal proof到达时重新进入caller FIFO并触发proof-driven revival；ACK后移除对应queued replay。

adapter queue item分离`recorded`与`acknowledged`阶段：record成功但ACK失败时只重试ACK。Plan dependency对同runId、requestId、kind和message hash的现有pending Attention返回exact幂等结果，冲突仍fail closed。

同时让adapter drain handler先于typed runtime shutdown handler注册；并发shutdown等待失败drain后用自身ctx重试；dispose不再清空未提交FIFO。

## 验证

RED覆盖：未ACK请求在official proof后排队并revive；ACK后proof不重放；错误owner/unknown request拒绝；record成功但ACK失败不重复record；真实handler顺序下record发生于`rpc.dispose`前；重叠settled/shutdown由shutdown重试。

GREEN后重跑protocol/client、Root revival、完整固定socket Broker、adapter、Plan dependency和真实Pi startup门禁，再冻结新HEAD唯一运行A2。
