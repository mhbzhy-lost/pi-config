# 新组合 supervisor 回复已实际消费但本仓receipt仍queued

## 数据来源分类：1（目标合法production入口缺陷）

- actual入口：Pi1.0.2官方physical CLI `dist/cli.js`，正式enhanced `subagent-runtime.ts`，真实typed `subagent`工具 → public RPC `params.script` → `runs.run` → 官方Node detached runner。
- child通过公开provider注册的合成模型产生规范contact_supervisor toolCall；工具为官方native来源，运行在独立PID，并非私有factory或手工写request/reply/event/proof。
- 权威身份与顺序：parent UUID、child runId、request UUID由官方Host与runner生成；child request → 父message_end → native pending → 本仓authorized pending → 父reply → child工具成功结果 → 官方process-terminal。全部正向真实时间。
- 首偏离点：`createControlledSupervisorAdapter`在native reply完成后调用`commitDelivery({intent})`，只写queued/consumed:false；本仓只有markDeliveryConsumed定义，没有实际生产调用者。child实际消费之后没有回传/关联observer推进receipt。
- 影响：本仓request仍pending、receipt仍queued，阻塞后续steer语义，恢复时可能保留幽灵pending。不得把queued写成delivered或把reply文件当child消费。

## 精确RED

- Node22：`j5-contact-receipt-red-22.log`与`j5-contact-consumption-public-evidence-22.log`。
- Node26：`j5-contact-receipt-current-red-26.log`。
- Node26最新隔离现场：`/tmp/joint-contact-e2e-YYx5Jj`。
- 同一live case断言已收紧为C1/C6共享产物；不扫描旧目录借用成功现场。
- 真实网络费用：0；合成provider只使用进程内注册、native本地文件通路与隔离Root Broker socket。

## 公开接点核对与停止决定

- 0.75公开15个API中未找到native supervisor child消费回执。
- native reply写入只报告replyTo/runId/agent；child的成功工具结果有requestId，但不自动作为父authority receipt。
- `subagent:process-terminal`是进程终局事实，不证明哪个request已消费；`subagent:async-complete`/status成功也不能代替消费。
- generic child现有capabilities为空且Root Broker身份未注入；所需消费observer如果经broker传递，必须定义可信身份、授权capability、generation、payload digest与生命周期。不能让generic child借用managed能力、读取真实会话或造新的平行authority。
- 通过canonical session读取回填同样需要冻结可信路径、session identity/processBirth、request/ownerGeneration、receipt绑定合同，不能仅从status给的任意路径或mock文本认定消费。

本计划在J5 C6门禁停止，目标仍NO-GO。未修当前0.87.1/0.71.0基线，未改上游、未提PR/工单、未放宽验收。候选保存精确RED；J6完整launcher/Doctor、J7–J9不执行。后续如解除阻塞，只能实现经明确合同审阅的本仓消费闭环，或用户明确接受queued-only语义；二者均不能靠自动兼容分支伪GREEN。
