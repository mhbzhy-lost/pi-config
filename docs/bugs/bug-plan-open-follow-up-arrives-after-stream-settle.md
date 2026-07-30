# Bug: Plan open follow-up 在 streaming settle 后才入队

## 症状

Plan Runner profile收敛为bootstrap工具后，真实child只调用一次`plan_open`，随后输出等待文本并完成；没有第二agent turn、`plan_continue`或Executor派发。Plan状态只有`plan.created`。

## 影响

动态工具授权本身已正确设置，但永远没有下一turn消费它。所有新Plan在打开后停止，Root broker不会得到Executor run或lifecycle事实。

## 复现

1. 首轮provider只看到`plan_open,read,grep`并调用`plan_open`。
2. Capsule成功打开Plan并为下一turn设置完整active tools。
3. 当前provider snapshot不含`plan_continue`，因此返回等待文本。
4. Capsule直到`agent_settled`才调用`sendMessage(...deliverAs:"followUp")`；此时stream队列已排空，print child不再等待异步触发的prompt并正常退出。

## 根因

follow-up的入队时点错误。Pi在streaming期间收到`deliverAs:"followUp"`会把消息交给当前agent loop并启动后续turn；`agent_settled`发生在该loop已经决定结束之后，不能作为一次性child的首轮到二轮交接点。

## 修复

在成功`plan_open`对应的`tool_result`事件中exactly-once发送`pi-plan-follow-up-v1`，使用`triggerTurn:true, deliverAs:"followUp"`。该事件发生时仍在streaming，当前首轮结束后agent loop立即处理follow-up，下一turn使用Capsule已激活的完整Plan和项目工具。保留`agent_settled`用于后续durable状态协调，不轮询。

## 验证

Capsule单测证明成功plan_open result只排入一次follow-up，失败或重复result不重复；真实Plan Runner session出现首轮`plan_open`，随后第二turn `plan_continue`和两个exact `subagent`调用，不在frontmatter声明项目工具。
