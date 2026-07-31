# Bug：Supervisor ACK RED 混淆 announcement 与 request consumption

## 症状

新增tests-only RED把成功`supervisor.ack`后的期望写成`broker.supervisorRequests.has(requestId) === false`。同组未ACK重放测试则直接调用`broker.lifecycle(...)`，没有建立owned Plan Runner，也没有经过`acceptTerminalProof`。

## 影响

若按该oracle实现，ACK会删除native reply所需的owner、context和pending state，后续`supervisor.reply`必然返回unknown。重放测试即使变绿，也不能证明official observed proof是唯一revival authority。

## 复现

1. route一个`expectsReply: true`的Supervisor request。
2. 按测试期望执行ACK并删除`supervisorRequests`。
3. 再由Plan提交reply，Broker无法找到request/context。
4. 另一测试对未进入`ownedRuns`的run调用普通`lifecycle`；该方法找不到spawn ledger entry后直接return，不会接受terminal proof。

## 根因

测试把“Plan已持久化Attention的announcement ACK”误当成“native request已消费”。真正的消费边界是`supervisor.reply`成功。

同时测试使用了面向lifecycle push投影的方法，而非Root shutdown/revival共用的strict official proof入口，导致authority建模错误。

## 修复

ACK成功只设置announcement状态并移除该request的queued replay，必须保留`supervisorRequests`和reply context。测试继续断言`supervisor.pending`可见该request，并在ACK后的official proof后不重新排队。

未ACK测试显式建立Plan Runner `ownedRuns`事实，构造包含runner instance和exit0的observed proof，再调用`acceptTerminalProof`；只以该入口触发未ACK replay。

## 验证

RED必须分别证明：foreign/unknown ACK fail closed；owner ACK幂等且保留pending reply；ACK后official proof不重放；未ACK时同一official proof把exact request排队。协议测试另断言ACK params只允许exact `requestId`。
