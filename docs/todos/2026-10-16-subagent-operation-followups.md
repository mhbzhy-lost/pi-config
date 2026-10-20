# Subagent 独立操作工具后续待办

> 总体后续事项统一索引见 `docs/todos/2026-10-16-runtime-independent-followups.md`。本文保留subagent工具专项细节；跨runtime的idle/triggerTurn/resume/scheduler/heartbeat/RPC等事项不在此重复展开。

> 本文是 2026-10-16 之后的后续待办账本，不回滚已完成的 runtime-closeout 或独立工具 S0–S6 结论。每项都必须按真实证据收口；blocked 不得用 fallback 或文档改写冒充完成。

## 总览

| 编号 | 事项 | 状态 | 下一步 |
|---|---|---|---|
| F1 | Supervisor clear/inspect 分支 | blocked-upstream | 等上游提供可证明的 exact absence / root 归属，或另行批准上游协作方案 |
| F2 | Supervisor gate V/Z 文档 | architecture-updated；S6 精确清单 evidence-gap（不可还原） | 架构已补，既有 G2 acceptance 复用；现存 TAP 日志无文件路径，保留历史 492/492 报告值，不重跑猜测 |
| F3 | 真实 integration fixture 旧工具名迁移 | migration-verified（除孤立 fixture） | contact/heartbeat/注册/managed-worktree/model-selection/real-git 已迁移并实跑；`repository-merge-queue-acceptance/root-provider.mjs` 由 probe 合同测试 43/43 验证；`recovery-resume/scripted-model-server.mjs` 全仓无消费方，无法行为验证。清单见 `fixture-inventory.md` |
| F4 | ceiling-runtime 既有失败 | existing-checks-passed | 3 个既有生命周期 case 本轮通过，见当前验证记录 |
| F5 | resource-isolation 既有失败 | fixture-contract-fixed | 旧英文描述断言迁移后 focused 通过，未改生产隔离 |
| F8 | 五-child 真实验收改为“主 Agent 接管”姿势 | not-started（独立立项） | 用户裁决 child 完成即正常退出，原“五 child 全部自发布 + 4 冲突续跑”场景 obsolete（三跑证据见 `acceptance-probe-taskid.md`）。若要真实模型验收接管路径，需设计 handoff → `subagent_run_resume` → `recovery.activate-resume` → resumed child 解决冲突并发布的 probe，并预算 4 次额外真实模型续跑；未获授权前不实施 |
| F6 | TUI L3 观感 | user-post-check | 用户发现问题后按新 bug 处理，不重开 closeout |
| F7 | 外部 models 备份 | protected-local-artifact | 不读取、不提交、不删除；由用户自行决定处置 |

## 当前增量证据

本轮结果与精确命令、未覆盖范围见 [当前验证记录](../plans/records/2026-10-17-runtime-convergence/current-validation.md)。下文早期失败与迁移清单保留为来源，不再代表全部当前状态。Supervisor architecture 已存在：[架构](../architecture/supervisor-gate-recovery.md)；G2 acceptance 原本已存在，不需要重新创建。

## F1：Supervisor clear/inspect blocked 分支

### 范围

- C1：upstream pending observer 的可靠 absence 观察；
- C2：单 request challenge/CAS/audit clear；
- C3：`inspect` / `clear` 独立工具注册。

### 当前证据

上游 `pending=[]` 无法区分：

1. 请求确实不存在；
2. wrong-session 导致内存 pending 被移除但请求文件仍存在；
3. channel 目录读取失败后被上游静默跳过。

因此当前禁止：

- 把空数组解释成 exact absence；
- 签发 clear challenge；
- 删除上游 request 文件；
- 添加 `force`、bulk clear 或 root-wide clear；
- 修改上游来制造本仓兼容分支。

### 已完成部分

- G0 已冻结：显式 child index / correlation 子集可用于 gate；absence blocked；
- G1 纯策略已提交：`bcad81a`；
- G2/G2-wire 已提交：`08ae9ca`；
- gate clear 不应阻塞独立工具 14 项的注册和验收。

### 解阻条件

- 上游提供 root/owner 可验证字段并区分 wrong-session 与真正删除；或
- 用户另行批准修改/协作上游接口，并重新编写合同、验收和部署边界。

## F2：Supervisor gate 文档收口

### 待办

补充独立文档：

- `docs/plans/records/2026-10-15-supervisor-gate/acceptance.md`；
- `docs/architecture/supervisor-gate-recovery.md`（如需要长期架构说明）。

### 必须记录

- G1/G2 的实际测试数量、退出码和提交；
- child A/B 隔离、queued reply 放行、failed retry、v1/v2 迁移；
- C1/C2/C3 的 blocked-upstream 原因；
- 不读取真实用户 pending、session、authority 或 state；
- 不把 diagnostics 宣称为 clear 或历史 incident 修复。

## F3：真实 integration fixture 旧工具名迁移

S4/S6 已验证 fresh synthetic SDK 工具面，但以下真实 fixture 仍需独立迁移和验证：

### 已发现的重点路径

- 已迁移并实跑：`test/fixtures/heartbeat-provider.ts`、`test/fixtures/joint-upgrade/contact-provider.mjs`、`test/fixtures/deterministic-provider-state.mjs`、`test/subagent-managed-worktree.integration.mjs`、`test/subagent-model-selection.integration.mjs`（21 处位置依赖）、`test/subagent-auto-integration-real-git.integration.mjs`（1 处位置依赖）、`test/pi-runtime.integration.mjs`。
- 只改名、端到端未跑：`test/fixtures/recovery-resume/scripted-model-server.mjs`、`test/fixtures/repository-merge-queue-acceptance/root-provider.mjs`。
- 有意保留旧名（负例/上游兼容面，不得迁移）：`workspace-operation-tools`、`subagent-operation-tools`、`supervisor-operation-tools`、`operation-guidance-contract`、`joint-upgrade-model-only`、`deterministic-provider`。
- 仍未处理的死路径诊断：`scripts/probes/dispatch-branch-probe.ts` 的 `action` 分支；非 runtime 可达文本，保留并由 owner 决定。
- 逐项状态、命令与日志见 `docs/plans/records/2026-10-17-runtime-convergence/fixture-inventory.md`。

### 迁移原则

- 新名称按对象和操作使用：`subagent_start`、`subagent_run_*`、`managed_workspace_*`、`supervisor_request_*`；
- 不修改历史 docs/research/旧验收记录中的事实；
- 不把 fixture 迁移结果冒充真实用户 Host 或 provider 兼容证明；
- 不运行 heartbeat SIGKILL 实验，除非另有明确授权；
- 每组迁移单独验收、单独 commit；
- 发现 fixture 仅测试陈旧断言时只修测试，不给 production 增加兼容分支。

## F4：ceiling-runtime 既有失败

当前记录为既有失败，不归因于本次独立工具改造：

- `test/joint-upgrade-ceiling-runtime.test.mjs`：3 项；
- 失败涉及 ceiling 未注册、startup 未失败、drain 失败观察等既有行为。

后续需要独立数据来源分类和最小计划。不得在本 TODO 下顺手修改 capability ceiling、child permissions 或 startup rollback。

## F5：resource-isolation 既有失败

- `test/subagent-runtime-resource-isolation.test.mjs`：1 项既有失败；
- 未被独立工具 S4/S6 引入；
- 后续需独立复现、来源分类和 owner 决策；
- 不得为本 TODO 增加 fallback 或放宽资源隔离。

## F6：TUI L3 用户后验

机器 L2 已在 `docs/plans/records/2026-10-15-runtime-closeout/visual-acceptance.md` 记录 8/8。用户已裁决：L3 不阻塞 closeout，实际发现问题时另立 bug。

观察重点：

- 长中文标题和 `(delegate)` 续行对齐；
- 三类活动同场时图标、标题、状态列稳定；
- Alt+O / Esc 后 draft、editor、中文输入法恢复；
- 深浅主题无明显残影、闪烁或不可读颜色。

复现问题时提供截图、终端宽高、主题和步骤，不需要完整 session/config。

## F7：外部本机 models 备份

当前保护现场：

```text
pi/models.json.bak-qoder-thinking-20261016161901
```

本仓约束：

- 不读取正文；
- 不 stage/commit；
- 不自动删除；
- 不将它作为代码或验收失败处理；
- 由用户自行决定保留、归档或删除。

## 已完成项目索引

- runtime closeout 总账：`docs/plans/records/2026-10-15-runtime-closeout/acceptance.md`；
- 独立工具 S6：`docs/plans/records/2026-10-16-operation-tools/acceptance.md`；
- 独立工具架构：`docs/architecture/subagent-operation-tools.md`；
- Supervisor gate G0 合同：`docs/plans/records/2026-10-15-supervisor-gate/contract.md`；
- Supervisor gate G2 验收：`docs/plans/records/2026-10-15-supervisor-gate/acceptance.md`；
- 独立工具实施计划：`docs/plans/2026-10-16-subagent-operation-tools-guidance.md`。

**本 TODO 不构成自动执行授权；后续每项需要按本仓执行合同、资源和用户授权推进。**
