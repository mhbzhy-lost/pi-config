# Plan Runner durable Attention 未形成 Root 用户交互

## 1. 现象

真实 Plan `c3bfeb3c-d209-4acb-bf06-7056eab99dd6` 与 `6834c7f1-08a2-48d9-98db-8cf7ab242633` 中，Executor 均通过 native Supervisor 提交 `need_decision`。Standalone Plan Runner 成功持久化 Attention 正文和事件，thin Host 也向 Root Session 写入了 `pi-plan-attention-v1`。

但 Root 消息的 `content=[]`。两次 Root assistant turn 都只生成空文本，用户未看到请求，也没有机会回复。约数秒后 Standalone Plan Runner 自行调用 `subagent_supervisor reply`，将 Attention 标为 resolved，并使 Plan 进入 blocked。用户只能在之后主动查询 status 才发现问题。

## 2. 直接原因

- `plan-host-runtime.mjs::forwardAttention()` 只写 `customType/details`，没有给 Root 模型可执行的正文指令。
- `plan-launcher-extension.mjs` 只注册 `plan_run`，没有 Root 可调用的 durable Attention reply 工具。
- `plan-runner-dependencies.mjs::authorizeSupervisorReply()` 在找不到 Root command 时仍返回授权，允许 Plan Runner 直接回复已经升级为 `waiting-attention` 的请求。

## 3. 根因

两级 Attention 设计只实现了存储和轮询，没有完成 Root 交互闭环。测试分别验证了“Host发过引用”和“预先手工写入command后可以消费”，但没有验证真实 Root 收到非空通知、可通过公开工具写入command、且command缺失时Plan Runner不能抢先resolve。

## 4. 影响范围

- `need_decision`、`interview_request`及其他blocking Attention可能对用户完全不可见。
- Root Parent名义上负责durable Attention，实际上没有受控回复入口。
- Plan Runner可绕过Root fencing自行解决已升级请求，导致用户决策窗口消失。
- Plan仍能fail closed，因此不会错误集成代码，但会永久丢失人工介入机会。

## 5. 修复方案

1. typed Attention携带非空、无敏感正文的操作指令，要求Root读取0600正文、向用户展示并等待明确回复。
2. Root注册`plan_attention_reply`工具；工具从当前pending projection派生task/attempt/run身份，校验requestId和projection version后写入durable command inbox。
3. Standalone Plan Runner只允许与durable Root command逐字段一致的native reply；缺失command时fail closed并保持`waiting-attention`。
4. 保持Host只转发正文路径和SHA，不复制Executor prompt、凭据或业务正文。

## 6. 验证策略

- RED：Host转发消息必须有非空操作正文；旧实现返回空content。
- RED：Root工具可对pending Attention写入fenced command；旧实现没有该工具。
- RED：没有durable command的Supervisor reply必须拒绝；旧实现错误授权。
- GREEN：定向Host/Launcher/Capsule/Dependencies测试、完整`npm test`和真实Attention roundtrip通过。
- 真实验收必须证明Root Session收到非空消息、用户回复前Attention保持pending、command写入后才resolve。

## 验证结果

- RED阶段三个断言分别证明旧实现缺少消息正文、Root工具和command硬门禁。
- 定向Host/Launcher/Dependencies测试：`38/38`。
- 完整单测：Attention相关全部通过；总计`468/469`，唯一失败是既有`tmcp` Skill已暴露但migration固定期望列表未同步，与本修复无关。真实Pi Runtime gate同样只因这一固定Skill列表失配失败。
- Plan Capsule：`2/2`；Subagents Runtime：`3/3`；真实submodule Plan Harness：`1/1`。
- Doctor通过；Node语法检查通过。
- 根Pi必须完整重启后才能替换已绑定的launcher工具；`/reload`不足以证明新`plan_attention_reply`已激活。
