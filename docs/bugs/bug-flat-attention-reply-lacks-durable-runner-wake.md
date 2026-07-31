# Flat Attention reply 缺少 durable Runner wake

## 1. 现象

Root Main通过`plan_attention_reply`接受用户显式决定后，只把command写入`control/attention/<requestId>.reply.json`并返回`queued`。如果拥有该Attention的Plan Runner generation已携official terminal proof退出，后续没有事件触发logical caller revival；即使另一路径碰巧revive，fresh generation也不会启动仅在首次`plan_open`中创建的control timer，durable reply仍可能无人消费。

真实A2 Harness在冻结前静态审查中因此被判定NO-GO：四个Executor可以全部进入`waiting-attention`，Root也可以成功写入四个reply，但Plan会永久停在等待状态，直到Harness超时。

## 2. 真实证据与反证

- `plan_attention_reply`当前路径只读取projection、写入reply文件并返回`queued`，没有调用Broker wake。
- Broker只在logical caller存在未消费`callerFollowUps`或queued push且active generation已有official proof时revive。
- `plan_open`成功的one-shot `plan-opened` follow-up在首次revival后被消费，不能承担后续Attention决定。
- `startPlanControl()`只由首次`plan_open`调用；revived generation的`before_agent_start`只恢复execution binding和lifecycle subscription。
- 进程内timer不能作为反证：timer被`unref`，generation退出后不再读取新写入的command。

## 3. 根因

设计把“用户决定已durable提交”和“哪个Runner generation负责消费决定”拆成了两个边界，却只实现了前者。Root Launcher知道stable logical Plan Runner handle，但Broker没有Root内部的typed wake API；Runner recovery又只恢复Executor execution facts，没有恢复Plan control facts。

因此durable command存在于磁盘，但没有proof-driven调度债务，也没有fresh generation消费入口。

## 4. 正确修复

1. Root Broker提供仅供Root内部调用的Attention wake API，输入必须精确绑定stable logical caller和`attention-reply-<requestId>` wake identity；child RPC的`caller.followup(reason=plan-opened)`合同保持不变。
2. `plan_attention_reply`必须先原子写入command，再登记wake；登记失败返回error。相同command重试必须幂等重登记同一wake，不得重复决定或创建不同wake。
3. Broker继续只在official terminal proof后single-flight revive。active generation与reply timer竞态允许产生额外有限generation，但不能丢失决定，也不能限制总generation数。
4. revived generation在`before_agent_start`恢复durable Attention replies；复用现有`processAttentionReplies()`身份/version/hash fence和exact-once announcement，不另写旁路消费者。
5. 正常settle后的timer路径与recovery路径保持同一authorization、`attempt.attention-resolved`、ack和Supervisor reply语义。

## 5. TDD 验证

先提交tests-only RED并独立复现：

- Launcher测试要求成功写入reply后调用Root Broker logical Attention wake；wake失败时command保留且tool返回error，重试可恢复。
- Broker测试要求Attention wake按logical caller去重、等待official proof后revive，并且child `caller.followup`仍只接受`plan-opened`。
- Capsule/dependencies测试要求fresh generation的`before_agent_start`读取既有reply并发送exact `pi-plan-attention-reply-v1`，重复恢复不重复announcement/ack。

RED必须因API/恢复调用缺失而失败。GREEN只实现上述最小路径，再运行Launcher、Broker、dependencies、Capsule及固定socket suite。

## 6. 影响边界

影响Root Launcher、Root Broker内部API、Plan Runner recovery lifecycle及其focused测试。不修改wire push types、不授权`fanout-child`、不恢复Standalone Host、不改变Executor Supervisor RPC合同，也不把ACK/status/text当作terminal authority。

若不修，首次在A2真实Harness的30秒Plan等待超时暴露，诊断困难且会永久消耗冻结基线；当前冻结前修复代价中。若wake身份或恢复fence选错，会在并发reply、旧generation或跨Plan场景暴露，修复代价高。
