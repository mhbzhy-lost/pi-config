# Supervisor pending 门禁过度收敛到run而非child

## 合法数据来源与首偏离点

合法native contact_supervisor→Root ingress→registerSupervisorRequest→成功reply→commitDelivery生成queued/consumed=false。旧request仍pending，旧resolveSupervisorControl仅按root/run/ownerGeneration查任意pending，无child区分，故A请求阻断B，成功回复仍阻断新steer。该调用链可由公开工具及权威broker correlation正常产生，分类1；不是用手工Map/非法状态证明生产可达。具体历史用户run仍未取证，不借fixture声称其个案归因完成。

旧wire接线在原生结果isError=true时仍commit queued，throw补偿则将request变failed并用failed幂等短路永久拒绝重试。属于同一合法公开投递链的失败事实处理缺陷。

## 最小修复边界

- G1纯策略复用；显式child index，不猜0、不broadcast；correlation缺失返回scope-unverified，不能把有界fleet投影当全child目录。
- 成功reply queued只表示已提交，不升级consumed。A的needs-reply只阻A；queued允许新正文steer，重复reply正文仍拒绝且child-scoped。
- v1 intent/parser保持严格；v2 intent和state/request严格解析，首次合法mutation写state.v2；只读diagnostics不触发迁移/TTL写。旧Host不能读取新schema，需fresh Host。
- failed receipt不参与成功幂等，失败reply仍pending，允许显式重试；isError与throw仅记录failed、不写queued，保留原native失败结果/异常边界。
- clear因上游exact absence不可证仍blocked，不改上游、不增fallback、不清当前真实控制状态。

## 本轮失败来源分类

早期inline补丁曾混用v1/v2 parser、key与state标签，产生真实回归。修复为严格分版本与原v1 key读取，不保留旧广播门禁为“兼容”。旧mock缺index/correlation无法证明新child隔离，测试按新产品合同补显式index与合法correlation，不为该mock改production兼容。新增wire throw测试误要求typed工具抛异常，实际既有工具投影为失败result；只改该测试期望。

## 验收

最终聚焦命令包含policy、wire、membrane、consumption、diagnostics、replay；实际counts及类型结果见 `docs/plans/records/2026-10-15-supervisor-gate/acceptance.md`。旧通过记录不替代最终修改后的复验。
