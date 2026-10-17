# 计划成果验收 Review 报告

- 日期：2026-10-17
- Reviewer run：`3b6fce24-6620-442f-be60-deff677b38ce`
- 性质：只读成果审阅；未修改代码、计划、测试或配置，未运行网络/Host/provider/kill/notify，未读取 settings/models/auth/credential/完整 session/authority/state，也未读取外部 models 备份。
- 审阅对象：runtime-closeout、supervisor-gate-recovery、subagent-operation-tools-guidance 三组计划、实现、测试、提交链、验收和后续账本。

## 1. 总体判定

| 计划 | 判定 | 依据 |
|---|---|---|
| runtime-closeout | **完成（按用户裁决收口）** | F1/P0/P1/P2/P3/V1/V2(L2)/D0–D3/N1/bash引导/edit/prompt/H1/scheduler/type尾项均有实现和实测；L3由用户裁决转为后验，不阻塞本批 |
| supervisor-gate-recovery | **部分完成** | B/G0/G1/G2/G2-wire完成并验证；C1/C2/C3 clear/inspect因upstream exact absence不可证而blocked，真实未实现，无空集合fallback |
| subagent-operation-tools-guidance | **范围内完成** | S0–S6完成；14工具注册、旧三名零注册、membrane旧upstream名保持、renderer按名、guidance迁移、S6聚焦验收完成；真实integration fixture旧工具名迁移另列后续 |

没有发现把 clear blocked 写成完成、把历史用户 incident 写成已修复、或用测试绿色抹掉明确未覆盖边界的情况。

## 2. Blocker / High

### Blocker

无。三份计划按自身已声明范围没有发现阻断性偏差。

### High

无新的High实现缺陷。Reviewer确认的主要风险均为Medium/Low或已由当前工作树后续提交处理。

## 3. Medium / Low 风险

### M1：G2 reply guard 持久化前缀不对称

- 位置：`packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-control-plane.ts` 的 `saveRoot` replyPayloads过滤；G2新增 key 形态为 `supervisor-reply-guard.v2:<root>:...`。
- 风险：若过滤只接受旧的 `${root}:` 前缀，则新的reply guard可能不会落盘；reload后第二道 `STEER_DUPLICATES_REPLY` 防线失效。
- 影响边界：receipts仍持久化并参与匹配，因此未证明已有行为已错误；这是writer/parser不对称的健壮性风险。
- 建议：扩大过滤至新v2前缀，或明确记录不持久化的设计；补fresh reload后重复正文steer合同测试。
- 状态：**未实施，待独立修复决策**。

### M2：S6聚合测试可复现性

- `docs/plans/records/2026-10-16-operation-tools/acceptance.md` 记录“24文件/492 tests”，但未记录完整文件列表。
- Reviewer用合理的24文件集合无法独立复现492，虽然各子任务精确命令和计数可复核。
- 建议：补精确命令文件清单，不修改测试数字，不重写历史证据。
- 状态：**文档补强待办**。

### M3：Supervisor计划复选框/架构文档不一致

- `docs/plans/2026-10-15-supervisor-gate-recovery.md` 的B/G0/G1/G2复选框仍未同步勾选。
- `docs/architecture/supervisor-gate-recovery.md` 尚未创建。
- 已有 `baseline.json`、`contract.md`、`acceptance.md` 和实际提交/测试。
- 建议：只做文档一致性修订；clear blocked继续保留，不将文档补齐等同于clear完成。
- 状态：**文档补强待办**。

### M4：scope-unverified的阻断范围与inspect缺失

- 位置：`supervisor-control-plane.ts` 的scope-unverified分支和G1策略。
- 当前fail-closed方向正确，但缺少可信child correlation时，某些路径可能阻断该run的后续steer；计划文字同时要求“不默认0、不阻断所有child”，并依赖尚未实现的inspect逃生口。
- 状态：**已登记为clear blocked/语义张力**，不在本轮擅自放宽门禁。

### M5：既有resource-isolation失败为陈旧测试断言

- `test/subagent-runtime-resource-isolation.test.mjs` 的一项失败仍断言旧英文description；当前 `TYPED_SUBAGENT_DESCRIPTION` 已是中文。
- 分类：测试陈旧，不是本次生产缺陷，也不是独立工具改造引入。
- 状态：**既有失败，待独立测试合同修订**。

### M6：ceiling-runtime三项失败的历史归因尚未独立复证

- `test/joint-upgrade-ceiling-runtime.test.mjs` 三项失败涉及ceiling注册/startup/drain观察。
- 现有记录称HEAD对照副本同样失败，倾向既有产品/环境问题；Reviewer未用历史checkout独立重证pre-S4归因。
- 状态：**既有失败，待独立来源分类**。

### M7：物理Host依赖与lock声明不同步

- manifest/lock override声明官方 `@earendil-works/pi-codemode@1.0.4`；当前物理 `node_modules` 仍为1.1.0。
- N1隔离安装online/offline各8/8，说明fresh安装闭包正确；不代表当前运行Host已重装。
- 状态：**部署注意项**，不得热替换当前Host依赖；fresh Host消费新lock/override即可。

### M8：handoff文档不在业务提交

- `.pi/handoff/context-handoff.md` 由父会话维护，可能落后于最新HEAD；不属于业务功能提交。
- 状态：**会话现场文档**。

### M9：H1-key数字未在closeout命令表独立列出

- H1-key `111/111` 已在状态表与`110cc0e`/相关记录中有证据，但closeout最终命令汇总没有单列。
- 状态：**低风险可追溯性补强**。

## 4. 计划与实现冲突核对

1. closeout旧授权表曾写network/SIGKILL not-granted，尾部addendum和后续记录已更新为用户授权后的N1/P3事实；应以addendum和最新记录为准。
2. gate计划中“request缺child关联不能阻断所有child”与当前scope-unverified fail-closed范围存在语义张力；没有因此放宽门禁，clear blocked仍明确。
3. gate V原本列出clear相关测试，但计划本身允许blocked分支不创建测试并单列未验；当前没有伪造这些测试通过。
4. workspace strategy仅对integrate有效：schema早拒被S2按计划移除，runtime `INVALID_WORKSPACE_STRATEGY`仍是权威；不是语义放宽。
5. closeout原F1双metadata行已被用户后来单独要求的footer小优化取代，最新提交为`2ca9053`；相关测试已同步迁移，旧双行描述属于历史记录，不应覆盖当前事实。
6. 工具计划“总计16”包含未来blocked inspect/clear；当前实际fresh模型面是14，不把blocked工具注册成空壳。

## 5. 已验证目标

Reviewer复核到的关键现有证据：

- G1策略：40/40；
- G2/G2-wire最终聚焦：173/173；
- S1/S2/S3：13/13、11/11、12/12；
- S5：179/179；
- S6组合：492/492；
- root/package typecheck和offline verify通过；
- fresh synthetic SDK probe确认14工具active/model-only、旧三名不active、nested不可调用；
- runtime closeout的P0/P1/P2/P3/V1/V2/D0–D3/N1等记录和用户关闭裁决一致；
- clear相关文件和测试不存在，证明clear没有被伪实现。

## 6. 明确未验证 / 后续范围

- 真实provider对新14个schema的兼容性；
- 真实integration fixture中旧工具名迁移后的端到端运行；
- 特定历史RPC/supervisor incident的字段级归因；
- clear/inspect功能；
- ceiling-runtime/resource-isolation既有失败的最终根因；
- 当前物理Host重装新codemode依赖；
- 用户实际TUI字体/色彩/闪烁/IME观感。

这些项目不因本审阅通过而自动标为完成。

## 7. 最小后续动作

1. 修复或明确记录M1 reply guard v2持久化前缀，并补reload重复正文steer测试。
2. 补S6 acceptance的精确文件清单。
3. 同步Supervisor gate计划复选框和可选架构文档；保留clear blocked。
4. 另行迁移真实integration fixture旧工具名；不修改历史docs/旧取证。
5. 独立归因ceiling-runtime/resource-isolation失败。

本报告是只读成果审阅整理，不授予上述后续任务自动实施授权；每项仍按用户范围、计划、资源和提交门禁执行。
