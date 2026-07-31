# Bug：Supervisor followUp custom message 未形成 durable Attention

## 症状

把Root-owned Supervisor push改为 `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })` 后，真实A2从2/4 Attention退化为0/4。Root session仍有4个native request，四个Executor仍各调用一次`contact_supervisor`，但两个Plan Runner canonical session都没有Supervisor custom message。

至少一个缺失request已触发queued-push revival并启动新generation，仍未写出Attention事件。

## 影响

Pi消息投递成功与Plan Attention持久化之间没有确认。Broker可能移除FIFO并认为push已交付，但旧generation可在custom message落盘前退出；revived generation在`before_agent_start`收到followUp也可能不形成后续custom message。

四个Executor永久等待reply，两个Plan均卡active，Root早停cleanup缺少完整official proof和close.completed。

## 复现

1. Root-owned adapter对Supervisor push使用followUp delivery。
2. 两个Plan共派发4个typed Executor并让其发送request。
3. 观察Root persisted session有4个 `subagent_supervisor_request`，Broker还为proof后的request创建queued-push revival。
4. Plan Runner canonical sessions零Supervisor custom message，status保持active/attention null直至Harness超时。

## 根因

`pi.sendMessage`是agent消息调度API，不是领域事件提交确认。即使使用followUp，subagent print-mode generation也可能在消息真正触发`message_end`前结束；在`before_agent_start` backlog flush中，followUp同样没有提供可await的Attention持久化承诺。

Capsule当前只在`message_end(customType=subagent_supervisor_request)`调用`recordSupervisorRequest`，所以消息未落盘就等于领域事实丢失。

## 修复

Plan Runner为Root-owned adapter注入现有`deps.recordSupervisorRequest(message,{ctx})`作为async提交回调。adapter按requestId维护generation-local FIFO：

- subscription ready前flush的push，在`startLifecycleSubscription(ctx)`返回前drain；
- live push在`agent_settled`与`session_shutdown`drain；
- 成功后移除，失败保留供后续hook重试；
- callback模式不再依赖`pi.sendMessage`，非Plan fallback保留原路径。

继续复用Plan dependencies的active Attempt、身份、64KiB、evidence、event version和derived status校验，不在adapter重写领域规则。

## 验证

tests-only RED覆盖：backlog push必须在subscription start返回前被callback提交；live push只在agent_settled以真实ctx提交；首次callback失败后队列保留并在session_shutdown重试；exact duplicate只提交一次。

GREEN后运行adapter、Plan dependencies/Capsule/provider、Root revival、完整Broker门禁，再冻结新HEAD唯一运行A2。`d92cffc...`严禁重跑。
