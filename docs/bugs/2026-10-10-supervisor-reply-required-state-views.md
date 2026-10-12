# `SUPERVISOR_REPLY_REQUIRED`：回复提交与消费视图的差异

## 当前结论与处理范围

用户要求独立调查大量 `SUPERVISOR_REPLY_REQUIRED: Supervisor control request blocked.` 是否为 bug。只读报告：`/tmp/pi104-supervisor-reply-required-provenance.md`，run `227b62d5-a946-413a-9566-a15f2f92e445`；本轮结构化记录：`docs/plans/records/2026-10-11-runtime-followups/supervisor-provenance.json`。

**窄结论：静态状态链已记录，真实消费 provenance 未补齐；该错误码本身仍是正常 fail-closed 安全门禁。**本会话“reply 成功、pending 空、steer 仍拒绝”的现象可由当前两套状态视图解释，未取得真实消费样本证明 gate bug，也未发现本轮现代化改变门禁的证据。不能据此保证所有同类报错都不是 bug，也不能用已有测试预期证明产品语义无缺陷。

本记录只沉淀诊断和后续问题，不在现代化计划中修复，不改控制面或放宽门禁。

## 已核实的生产链与首偏离

1. child 请求经上游 native supervisor channel 投递给 parent。
2. parent 的 `message_end` 登记到本仓 supervisor control plane。
3. reply 调用上游写入回复并删除其待决请求；上游 `pending` 可立即变空。
4. 本仓 `commitDelivery` 默认只写 queued/consumed=false，durable request 仍为 pending。
5. 同一 run 的 steer 在 `supervisor-control-plane.ts` 的 `resolveSupervisorControl` 内发现任一 pending request，即返回 `SUPERVISOR_REPLY_REQUIRED`。
6. 当前消费对账通过 `subagent:process-terminal` 触发 `reconcileSupervisorConsumption`，只有匹配到可信 child session 的消费事实才推进 replied；终局失败/关闭亦有清理路径。

因此：**工具 `pending` 没有展示上游请求，不代表本仓 durable gate 已解除**。`writeReply` 本侧提交不证明 child 已收到/消费；这是 M05B 已纠正的元数据合同。

## 影响与限制

- 未回复请求时拒绝 steer，是防止用 steer 替代 supervisor 决策协议的正常行为。
- 回复提交后消费未证实时，仍可能拒绝不同内容的新 steer。由于 mid-run 没有实时消费观察，窗口可能持续到 child 终局，不只是数毫秒的传输延迟。
- 该门禁本身不阻止 child 使用已收到回复继续运行；本会话 M07 之后完成，与“未永久卡住该 run”一致。但正常完成不证明所有请求最终成功对账，也不证明其它场景不存在卡死。
- 持久化模式下事务重载可按 request 的 20 分钟 TTL 标过期；这不是任意运行环境下的绝对解除保证。非持久化、终局事件/对账失败等边界仍须按真实事实判断。
- 延迟的 waiting-for-reply attention 是观察快照，不能作为“回复未消费”或“需要恢复”的独立权威证据。不得据此盲目 resume 或 interrupt 来绕过门禁。

## 本会话样本分类

| 样本 | 当前判断 |
|---|---|
| M01 replyTo UUID 曾误抄一个字符，返回 NOT_PENDING，改正后成功 | 明确调用参数错误，不是 production gate bug |
| M07 正确 reply 成功，pending 空，steer REPLY_REQUIRED，随后 run 完成 | 与上述 queued/durable pending 合同一致，未证明本轮回归；保留“模型视图与门禁不一致”的产品限制 |
| M05A/M05B 曾 pending 有项而首次 reply NOT_PENDING、随后成功 | 来源未证实；实际两次 replyTo、登记时序及诊断事实不足，不能定案为参数错误或 race |
| 回复成功后旧 attention 到达 | 可解释为观察快照滞后；不把这一现象泛化成所有 attention 都无效 |

旧 `docs/bugs/2026-10-05-supervisor-consumption-receipt.md` 已记录过“实际消费但本仓 receipt queued”的真实生产缺陷候选；其历史 NO-GO 表述是当时状态，不能被本次诊断改写为已经永久解决或用户已接受所有 queued-only 语义。

## 现代化后待办

- [ ] 若用户需要回复后在 child 运行中追加 steer，先明确产品合同：pending 展示、queued/consumed 与门禁状态如何一致表达，不冒充消费已确认。
- [ ] 核对存疑 NOT_PENDING 样本的精确 replyTo 与登记/调用时间（只请求必要非敏感元数据，不读取凭据或整个会话）。
- [ ] 如发现回复已被权威证实消费但 gate 仍不解除，记录真实 public 入口、身份、事件和资源顺序，再按来源门禁决定最小修复。
- [ ] 可评估错误文案明确“已提交但消费未证实”这一分支；不因文案改进放宽权限、增加第二 authority 或在当前计划内插入修复。

## 本轮 provenance 结论

- `sourceClass=unconfirmed`、`evidenceMode=static`；未取得真实 NOT_PENDING/reply/consumption 字段级样本，不能分类为 production gate defect。
- 状态映射固定为：`submitted` 是本侧调用接受；`queued/delivered` 是本仓 receipt；`consumed` 必须有可信 child session 对账；`gate-open` 是 durable pending 的派生结果，不是持久字段。
- owner 在本仓 supervisor control plane，但本轮没有生产样本证明首个偏离；保持 gate、identity、消费对账和 fail-closed 边界不变。

未运行测试、真实 reply/steer/Host、模型或 MCP；未修改 production。既有测试只是实现合同的支持证据，不是整个运行流程无 bug 的证明。
