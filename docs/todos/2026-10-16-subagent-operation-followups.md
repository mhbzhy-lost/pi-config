# Subagent 独立操作工具后续待办

> 总体后续事项统一索引见 `docs/todos/2026-10-16-runtime-independent-followups.md`。本文保留subagent工具专项细节；跨runtime的idle/triggerTurn/resume/scheduler/heartbeat/RPC等事项不在此重复展开。

> 本文是 2026-10-16 之后的后续待办账本，不回滚已完成的 runtime-closeout 或独立工具 S0–S6 结论。每项都必须按真实证据收口；blocked 不得用 fallback 或文档改写冒充完成。

## 总览

| 编号 | 事项 | 状态 | 下一步 |
|---|---|---|---|
| F1 | Supervisor clear/inspect 分支 | blocked-upstream | 等上游提供可证明的 exact absence / root 归属，或另行批准上游协作方案 |
| F2 | Supervisor gate V/Z 文档 | pending-doc | 补独立 gate acceptance / architecture 记录，保留 clear blocked |
| F3 | 真实 integration fixture 旧工具名迁移 | pending | 逐组迁移旧 `subagent` / `subagent_worktree` / `subagent_supervisor` 调用并运行对应 integration |
| F4 | ceiling-runtime 既有失败 | pre-existing-failure | 单独归因和立项；不归因于独立工具改造 |
| F5 | resource-isolation 既有失败 | pre-existing-failure | 单独归因和立项；不归因于独立工具改造 |
| F6 | TUI L3 观感 | user-post-check | 用户发现问题后按新 bug 处理，不重开 closeout |
| F7 | 外部 models 备份 | protected-local-artifact | 不读取、不提交、不删除；由用户自行决定处置 |

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

- `test/fixtures/heartbeat-parent-host.ts`
- `test/fixtures/heartbeat-provider.ts`
- `test/fixtures/joint-upgrade/contact-provider.mjs`
- `test/fixtures/deterministic-provider-state.mjs`
- `test/fixtures/recovery-resume/scripted-model-server.mjs`
- `test/fixtures/repository-merge-queue-acceptance/root-provider.mjs`
- `test/subagent-managed-worktree.integration.mjs`（存在 `tools[1]` 位置依赖）
- 其他真实 `.integration.mjs` 中按旧工具名或工具数组位置消费的调用者

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
