# Managed Workspace ledger 隔离与 legacy 记录恢复实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 跟踪。只有整体交付终态全部验证通过，才算计划执行完成；未满足时持续修复与验证。执行方式由计划编写完成后的用户选择决定。

**目标：** 清理并隔离遗留 `managed-workspace-ledger.v1` 冒烟记录，使合法 workspace 的 status、处置、terminal-proof、integration 和 `subagent_run_resume` 不再被无关坏记录阻断，同时保留对当前 owner 或无法确认身份的坏记录的 fail-closed。

**架构：** ledger 增加逐记录诊断与安全隔离能力；已知 workspace 的授权和绑定解析改用目标记录直读，不再依赖全局枚举。带 owner scope 的枚举只有在原始记录明确写有 `schemaVersion === "managed-workspace-ledger.v1"`、owner 形状可结构化解析且 scope 可证明不等于查询 scope 时才跳过并诊断；v2 校验失败或 owner 无法确认一律 fail-closed。无 owner 的全局扫描只对明确 v1 legacy 做诊断跳过，v2/未知 schema 仍阻断。已确认的六条 `goal-runtime-rpc-smoke-*` 记录通过带 hash 和显式授权的 quarantine 流程归档，不直接删除。

**技术栈：** Node.js `>=22.19.0`、TypeScript 原生 type-stripping、`tsc --noEmit`、Node `node:test`、现有 managed workspace ledger/coordinator/Root Broker 运行时。

## 全局约束

- 仓库和 package 的最低 Node 版本固定为 `>=22.19.0`；新增或迁移 TypeScript 实现必须由 `tsc --noEmit` 或等价静态检查覆盖。
- 当前工作树存在继承的 dirty 现场；执行时以实际 `git status --short` 快照为准，不在计划正文固定修改文件数量或路径。
- production/CLI 代码使用 `.ts`；共享实现放在 `packages/pi-subagents-enhanced/src/`，`scripts/` 只保留 CLI/诊断入口，不从 production 反向 import `scripts/**`。
- 未取得用户对新增测试的明确授权，不主动新增测试；本计划的强制验证只运行既有测试、类型检查、审计和临时只读验证。新增回归测试列为建议，待用户另行授权。
- 不执行 raw `git worktree` 管理、stash、reset 或覆盖 dirty 现场；`/Users/mhbzhy/yugang` 当前主树的 dirty 现场不属于本计划写入范围，具体文件以执行时快照为准。
- 任何数据恢复先完成 provenance、数据来源、首个偏离点和完整调用链分类；已确认的六条记录属于 goal-runtime RPC 冒烟测试残留，不为未知来源记录增加兼容分支。
- 不访问、输出或写入凭据；不修改 `pi/settings.json` 的 `enabledModels`；不创建 commit，除非用户另行明确授权。
- 本计划不使用 Goal Engine 执行；goal-runtime 只作为已确认遗留测试数据的来源和隔离验证对象。
- 文档、代码注释、诊断文案使用中文；错误码、函数名、路径和标准技术术语保持现有字面量。

## 现状证据与范围

- 目标 workspace `6d25b1de-8afe-4e47-b24c-06be741da184` 的 v2 record 本身合法；失败发生在 `ledger.listScoped()` 遍历全部分区并在 owner 过滤前校验六条 v1 record。
- `service.listOwned()` 被 `disposition-facade.ts`、`coordinator-server.ts`、`subagent-runtime.ts`、`run-binding-resolver.ts`、`terminal-proof-binding.ts` 和 completion reminder 复用。
- `managedCodingResume.prepare()` 先通过 `ownedReceipts(sourceRunId)` 调用 `workspaceService.listOwned({ ownerScope, runId })`，因此 `subagent_run_resume` 报同一个 `MANAGED_WORKSPACE_SCHEMA`；这不是新的 resume 参数错误。
- 现场文档称 2026-09-18 已清理历史 v1，但当前仍有六条 origin 指向已删除 `goal-runtime-rpc-smoke-*` 临时目录的 v1 record；具体为何在清理后残留尚无删除审计，计划只按已证事实处理。

## 文件职责锁定

- `packages/pi-subagents-enhanced/src/workspace/ledger.ts`：逐记录校验、owner-scope 过滤、invalid record 诊断回调和全 state root 的 legacy invalid 扫描。
- `packages/pi-subagents-enhanced/src/workspace/administration.ts`：审计投影、legacy quarantine plan/apply。
- `scripts/worktree-lifecycle.ts`：审计和 quarantine 的 CLI 参数与安全输出。
- `packages/pi-subagents-enhanced/src/workspace/service.ts`、`registry.ts`：目标 owner receipt 直读的公开服务契约。
- `packages/pi-subagents-enhanced/src/workspace/disposition-facade.ts`、`coordinator-server.ts`：处置和可信绑定的目标记录选路。
- `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`、`src/subagent-dispatch/{run-binding-resolver,terminal-proof-binding}.ts`、`workspace/completion-reminder.ts`：resume、proof、完成提醒的 run/workspace 选路。
- `scripts/probes/goal-smoke.ts`：冒烟进程的 workspace state root 隔离断言。

## 整体交付终态

| ID | 必须成立的条件 | 验证方法与环境 | 通过判据 | 证据位置 | 覆盖任务 |
| --- | --- | --- | --- | --- | --- |
| F1 | ledger 能识别并报告 invalid record；带 owner 的枚举只跳过明确 v1 且可证明外部 scope 的记录；无 owner 全局扫描只跳过明确 v1；v2-invalid、当前 owner 或 owner 无法确认的坏记录仍 fail-closed | 隔离临时 state root 的既有服务入口、一次性 fixture 和只读 audit | 外部 v1 被跳过并产生结构化诊断；v2-invalid、同 owner/未知 owner 仍抛原安全错误 | 临时验证输出、audit JSON、诊断记录 | T1、T6 |
| F2 | 目标 workspace 的 status/disposition/coordinator binding 不再通过全局 `listOwned()` 选路 | 运行现有 facade/coordinator 入口，并在同一 state root 放置无关 v1 record | 合法目标可得到 status/action token；foreign owner 仍返回 `MANAGED_WORKSPACE_OWNER_SCOPE`；无 `MANAGED_WORKSPACE_SCHEMA` 泄漏 | targeted test 输出、源码调用点审阅 | T2、T6 |
| F3 | `subagent_run_resume`、terminal-proof 绑定、completion reminder 在无关 v1 残留存在时不再被 schema 错误阻断 | 隔离 coordinator/Root Broker recovery fixture 与目标 run 查询 | run/workspace 绑定仍按唯一性和身份校验；无关坏记录只产生诊断；目标坏记录仍阻断而不误判为“无 workspace” | resume/proof/recovery 输出 | T3、T6 |
| F4 | 六条已确认的 `goal-runtime-rpc-smoke-*` v1 record 被 hash 绑定地归档到 quarantine，active `records/` 不再包含它们，且全 state root audit 能显示归档前后差异 | `worktree-lifecycle.ts` dry-run/apply，使用真实 `PI_CODING_WORKSPACE_DIR` | 只归档计划中精确匹配的六条；原始字节和 hash 可追溯；孤儿目录保留；未删除未知记录、已注册 worktree 或 queue 证据 | quarantine plan/apply 回执与全 state root audit JSON | T1、T5 |
| F5 | goal-runtime 冒烟入口显式使用临时 `PI_CODING_WORKSPACE_DIR`，不会回写默认 `var/workspaces` | 运行既有 probe 的环境断言和只读目录检查 | 每个 Host/child 进程的 state root 都位于 probe 临时根；默认 state root 无新增 smoke record | probe 输出、目录审计 | T4、T6 |
| F6 | 当前版本通过适用的类型检查、workspace/coordinator/resume 既有回归和 live audit；无新增未授权测试或 commit | 根目录和 package 命令，使用 fresh Host 后的真实 audit | 命令 exit 0；失败项按基线/回归分类，不以跳过验证宣告完成 | 执行回执与最终报告 | T6 |

**完成规则：** 所有 F1–F6 同时满足，且证据对应最终代码与 fresh Host；仅完成任务步骤、子代理自报成功或旧 Host 仍运行都不能替代终态验证。

**未满足时：** 在已授权范围内持续 `fix → test（验证）→ 对照终态`。若发现 unknown owner、活动 worktree/queue 引用、origin 与现场不一致、需要改变 yugang 主树或需要选择 integrate/discard，停止相关任务并报告，不自行扩大范围。

## DAG

```text
T1（ledger 诊断与 quarantine 契约） ──> T2（目标 receipt 与处置/绑定选路） ──> T3（resume/proof/reminder 选路） ──┐
                                                                                                      ├──> T5（live legacy quarantine 与 yugang 只读复核） ──> T6（终态验证）
T4（goal smoke state-root 隔离） ────────────────────────────────────────────────────────────────────────┘
```

## Waves

- Wave 1：T1、T4；T4 不依赖 T1，可并行。
- Wave 2：T2；等待 T1 的 ledger/诊断回调和服务边界。
- Wave 3：T3；等待 T2 的 `readOwned` 契约，接通 resume/proof/reminder。
- Wave 4：T5；等待全部代码变更集成后，独占 live state root 做归档和 yugang 只读复核。
- Wave 5：T6；等待 T5 与 fresh Host，执行最终验证。

**关键路径：** T1 → T2 → T3 → T5 → T6。

---

### Task 1：增加逐记录 invalid 诊断与 legacy quarantine 管理面

**Agent：** `delegate`

**Deps：** `none`

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/ledger.ts`
- `packages/pi-subagents-enhanced/src/workspace/administration.ts`
- `scripts/worktree-lifecycle.ts`

**Resources：** 隔离临时 state root；不得触碰 live `var/workspaces`。

**Files：**
- Modify：`packages/pi-subagents-enhanced/src/workspace/ledger.ts`
- Modify：`packages/pi-subagents-enhanced/src/workspace/administration.ts`
- Modify：`scripts/worktree-lifecycle.ts`
- Suggested Test（待用户授权）：`test/managed-workspace-ledger.test.mjs`、`test/managed-workspace-administration.test.mjs`

**接口契约：**
- Consumes：现有 `validateRecordEnvelope`、`validateRecord`、`listScoped`、`list` 和 `managed-workspace-ledger.v2` 记录。
- Produces：`listScoped({ owner, onInvalid? })` 与 `list({ ..., onInvalid? })` 的安全诊断回调，以及只读的 `scanInvalidRecords()` 全 state root 扫描；带 owner 的 skip 仅允许原始 `schemaVersion === "managed-workspace-ledger.v1"` 且 owner 结构可解析、scope 明确不等于查询 scope，v2-invalid/未知 owner 一律抛错；无 owner 的 callback 扫描仅允许明确 v1 legacy 跳过并诊断；诊断只包含 repository partition、filename/workspaceId、schema/error code、可确认的 owner scope，不包含 ownerToken、lease token 或原始私有路径；`inventoryManagedWorkspaces()` 返回全 state root 的 `invalidRecords`，有效 inventory 仍按 `originRoot` 投影；`planManagedWorkspaceLegacyQuarantine()` / `applyManagedWorkspaceLegacyQuarantine()` 生成并消费带 state root、record hash、action hash 和显式 authorization 的 archive 计划。

**终态关联：** `F1`、`F4`。

**验收标准：**

- [ ] **步骤 1：核对真实入口、身份和已有合同**：保持单条 `load/readRecord` 的 v2 严格校验；只在枚举路径增加 callback。先证明 invalid record 是 foreign/known legacy，不能从 schema 错误直接推导可删除。
- [ ] **步骤 2：完成最小实现**：先读取原始 `schemaVersion`。带 owner 的枚举只允许三元条件同时成立时跳过：`schemaVersion === "managed-workspace-ledger.v1"`、owner 形状可结构化解析、owner scope 可证明不等于查询 scope；v2 校验失败、owner 形状不可信或 scope 相同继续 fail-closed。无 owner 的 callback 扫描只对明确 v1 legacy 跳过并调用 `onInvalid`，不把 owner 字段当作授权依据；administration audit 显示全 state root invalid record debt；quarantine 只移动原始 record 到 state root 下的隔离目录，不删除未知记录、worktree、queue 或 outbox。
- [ ] **步骤 3：完成 quarantine 安全门**：apply 必须校验 plan hash、record bytes hash、schemaVersion、目标路径是 regular file、没有计划外变化；六条 smoke record 之外的记录不自动纳入。CLI 的默认命令只 dry-run，apply 必须单独带授权输入；全 state root audit 必须能在 originRoot 不存在时仍报告 invalid record。
- [ ] **步骤 4：运行适用的既有检查并记录结果**：`npm run typecheck:subagents-enhanced`；使用临时 state root 运行 `scripts/worktree-lifecycle.ts audit --json`，确认 invalid 诊断不泄露 token。
- [ ] **停止条件**：owner 无法确认、record hash 变化、发现已注册/存活的 worktree 或非空 queue 引用、计划外 schema 或未知来源记录时停止；孤儿 worktree 目录本身是保留的现场证据，不构成阻塞且不得删除；不得直接 `rm` 或 raw git 清理。
- [ ] **建议（待用户授权）：新增测试**：在现有 ledger/admin 测试中加入“foreign v1 被诊断并跳过、same-owner v1 仍 fail-closed、quarantine hash/CAS 拒绝篡改”用例。

---

### Task 2：目标 owner receipt 直读并切断处置/可信绑定的全局枚举依赖

**Agent：** `delegate`

**Deps：** `T1`（理由：使用 T1 的逐记录诊断契约，并保持当前 owner/unknown record 的 fail-closed 语义）。

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/service.ts`
- `packages/pi-subagents-enhanced/src/workspace/registry.ts`
- `packages/pi-subagents-enhanced/src/workspace/disposition-facade.ts`
- `packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts`

**Resources：** 隔离 coordinator socket/state root；最多一个 coordinator fixture。

**Files：**
- Modify：`packages/pi-subagents-enhanced/src/workspace/service.ts`
- Modify：`packages/pi-subagents-enhanced/src/workspace/registry.ts`
- Modify：`packages/pi-subagents-enhanced/src/workspace/disposition-facade.ts`
- Modify：`packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts`
- Suggested Test（待用户授权）：`test/workspace-disposition-settlement.integration.mjs`、`test/managed-workspace-service.integration.mjs`

**接口契约：**
- Consumes：T1 的 strict `ledger.load()`；现有 owner scope、lease、run 和 coordinator disposition 合同。
- Produces：`ManagedWorkspaceService.readOwned({ workspaceId, ownerScope })`，直接按 workspaceId 加载并校验 owner，返回不含秘密字段的 public receipt；facade/coordinator 的目标操作只使用该方法，`listOwned()` 仅用于真正的枚举。

**终态关联：** `F2`、`F3`。

**验收标准：**

- [ ] **步骤 1：核对真实入口、身份和已有合同**：审阅 `loadOwned`、`disposition-facade.dispatch`、`trustedWorkspace`、settlement、terminal-proof replay、public binding 和 `bindRun` 的当前调用链，确保目标 workspaceId 已由调用方提供。
- [ ] **步骤 2：完成最小实现**：增加 `readOwned` 并更新 registry 的 method contract；facade 和 coordinator 中所有 `.listOwned().find/.some` 的目标选路改为 `readOwned`；目标记录本身损坏、owner 不匹配或 ID 不存在时保持原错误语义，不把空结果当成无 workspace。
- [ ] **步骤 3：运行适用的既有检查并记录结果**：`node --test test/managed-workspace-service.integration.mjs test/workspace-disposition-settlement.integration.mjs test/managed-workspace-coordinator-recovery.test.mjs`；`npm run typecheck:subagents-enhanced`。
- [ ] **停止条件**：需要远端 `listOwned` 反推 repository、需要放宽 lease/owner/action token、或发现 target workspaceId 不足以证明唯一性时停止，不猜测身份。
- [ ] **建议（待用户授权）：新增测试**：在现有 service/coordinator fixture 中加入无关 v1 record 后，验证 status、action token 和 disposition facade 仍可用，并验证 foreign owner 仍拒绝。

---

### Task 3：修复 resume、terminal-proof、completion reminder 的 run-scoped 选路

**Agent：** `delegate`

**Deps：** `T1`、`T2`（理由：run-only 查询消费 T1 的逐记录诊断，已知 workspace 查询消费 T2 的 `readOwned`）。

**WritePaths：**
- `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/run-binding-resolver.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/terminal-proof-binding.ts`
- `packages/pi-subagents-enhanced/src/workspace/completion-reminder.ts`
- `packages/pi-subagents-enhanced/src/workspace/tool.ts`

**Resources：** 隔离 Root Broker/coordinator/resume fixture；不得启动 live Host。

**Files：**
- Modify：`packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`
- Modify：`packages/pi-subagents-enhanced/src/subagent-dispatch/run-binding-resolver.ts`
- Modify：`packages/pi-subagents-enhanced/src/subagent-dispatch/terminal-proof-binding.ts`
- Modify：`packages/pi-subagents-enhanced/src/workspace/completion-reminder.ts`
- Modify：`packages/pi-subagents-enhanced/src/workspace/tool.ts`
- Suggested Test（待用户授权）：`test/managed-workspace-recovery-rebind.integration.mjs`、`test/subagent-workspace-completion-reminder.test.mjs`、`test/subagent-runtime-root-broker*.mjs`

**接口契约：**
- Consumes：T2 的 `readOwned`；T1 的 `listOwned` foreign-invalid skip 与 structured diagnostic；现有 `TrustedRunBinding`、terminal-proof debt 和 resume intent 身份约束。
- Produces：`selectReceipt(runId, workspaceId)` 在 workspaceId 已知时直读；run-only 查询只接受唯一、身份完整的 valid receipt；无关 invalid record 不再抛 `MANAGED_WORKSPACE_SCHEMA`，当前 owner/unknown invalid 仍 fail-closed 并转换为既有 binding/debt 阻塞语义；无 owner 的跨 scope 复查使用只跳过明确 v1 的 `list({ onInvalid })`；completion reminder 记录 lookup debt 而不制造未处理 event-handler exception。

**终态关联：** `F3`。

**验收标准：**

- [ ] **步骤 1：核对真实入口、身份和已有合同**：确认 `managedCodingResume.prepare()` 的 `ownedReceipts(sourceRunId)`、`selectReceipt()`、远端 `client.listOwned({runId})`、`run-binding-resolver` 和 `terminal-proof-binding` 都不能把“查询失败”解释为“没有 workspace”。
- [ ] **步骤 2：完成最小实现**：已知 workspaceId 的路径改走 `readOwned`；run-only 查询使用 T1 的逐记录隔离；跨 scope 复查调用 `ledger.list({ onInvalid })`，只跳过明确 v1 并记诊断，v2-invalid/未知 schema 仍阻断；无法确认绑定时返回 `RESUME_BINDING_BLOCKED`/proof debt，不自动 resume、not-applicable 或伪造成功。completion reminder 对 lookup 失败走结构化 diagnostic。
- [ ] **步骤 3：运行适用的既有检查并记录结果**：`node --test test/managed-workspace-recovery-rebind.integration.mjs test/managed-workspace-terminal-proof-handoff.integration.mjs test/subagent-workspace-completion-reminder.test.mjs`；`npm run typecheck:subagents-enhanced`。
- [ ] **停止条件**：唯一性、owner scope、lease、runId、resume intent 或 terminal proof 任一事实缺失时停止；不得把 invalid record 静默变成空数组后继续 resume。
- [ ] **建议（待用户授权）：新增测试**：复现 foreign v1 record 存在时 `subagent_run_resume` 可继续，same-owner v1 时仍 `RESUME_BINDING_BLOCKED`；terminal-proof 无绑定时仍记债。

---

### Task 4：强化 goal-runtime 冒烟 state root 隔离

**Agent：** `executor`

**Deps：** `none`

**WritePaths：**
- `scripts/probes/goal-smoke.ts`

**Resources：** 仅临时目录；不得读取或写入 live `var/workspaces`。

**Files：**
- Modify：`scripts/probes/goal-smoke.ts`

**接口契约：**
- Consumes：当前 probe 已生成的临时 `root`、`PI_CODING_WORKSPACE_DIR=join(root, "workspaces")` 和 child Host 环境。
- Produces：probe 启动前的 state-root 断言，以及所有 spawned Host/child 使用同一临时 workspace root 的可观测证据。

**终态关联：** `F5`。

**验收标准：**

- [ ] **步骤 1：核对真实入口、身份和已有合同**：检查当前 probe 和所有它启动的 child 环境，不改变 Goal Runtime 业务状态或 Host 消息语义。
- [ ] **步骤 2：完成最小实现**：在 probe 中拒绝缺失、非绝对或落在仓库默认 `var/workspaces` 的 `PI_CODING_WORKSPACE_DIR`；输出只记录“临时 root 已隔离”的事实，不输出 token 或私有 session 内容。
- [ ] **步骤 3：运行适用的既有检查并记录结果**：运行现有 goal smoke 的 setup/环境检查；若发现另一个未隔离的历史 harness，记录路径并停止，不扩张为通用 fallback。
- [ ] **停止条件**：发现 probe 需要真实 Host/provider、凭据或 live state root 才能验证时停止并报告。
- [ ] **建议（待用户授权）：新增测试**：在现有 probe contract 中加入默认 state root 泄漏拒绝断言。

---

### Task 5：归档六条已确认的 smoke legacy record，并复核 yugang 现场

**Agent：** `executor`

**Deps：** `T1`、`T2`、`T3`、`T4`（理由：只能在最终代码已集成、审计/隔离入口可用后操作 live state root）。

**WritePaths：**
- `var/workspaces/**`（仅 runtime records 的归档移动源/目标；不修改 tracked source）

**Resources：** live `PI_CODING_WORKSPACE_DIR` 独占；`worktree:false`；不得并发其它 workspace 操作。

**Files：**
- Runtime-only：使用 `scripts/worktree-lifecycle.ts` 的 dry-run/apply quarantine，不直接编辑 JSON 或调用 raw git worktree 命令。
- Read-only：`/Users/mhbzhy/yugang` diff、`git worktree list`、workspace ledger/queue/outbox。

**接口契约：**
- Consumes：T1 生成的 quarantine plan、六条 record 的原始 bytes/hash、当前 state root 和现有 `6d25b1de-8afe-4e47-b24c-06be741da184` 现场。
- Produces：quarantine archive、apply receipt、前后 audit 对比，以及 yugang workspace 与主树的只读差异报告；不自动选择 integrate/discard/preserve。

**终态关联：** `F4`，并为 `F6` 提供 live 证据。

**验收标准：**

- [ ] **步骤 1：先 dry-run**：从全 state root invalid inventory 逐条确认计划精确包含六条 `goal-runtime-rpc-smoke-*` v1 record；逐条记录 provenance（其中一条由既有 goal smoke 文档直接指证，其余五条记录模式、owner、origin 和时间线一致但不扩大为更强结论）；origin 已不存在，record hash 与现场一致；确认没有已注册/存活 worktree、非空 queue item 或其它未知来源引用需要一并处理。
- [ ] **步骤 2：执行 archive**：仅按 plan/apply 的显式授权将原始 record 移入 quarantine；保留原始文件 hash、权限、partition 和 workspaceId；不删除 worktree、queue、proof outbox 或任何未知 record。
- [ ] **步骤 3：复核 live 管理面**：运行全 state root 的 `scripts/worktree-lifecycle.ts audit --json`，确认六条 invalid 已从 active records 移入 quarantine；再运行 yugang/origin-scoped audit，确认目标 v2 record 仍在且未被改写。对 yugang worktree 与主树做 diff/hash 比对；孤儿 legacy worktree 目录只保留并记录，不删除。若 owner scope 已结束、diff 不等价或存在未覆盖产物，停止并请求处置决策。
- [ ] **停止条件**：计划多出/少于六条、record hash 变化、存在已注册/存活 worktree 或非空 queue 引用、主树 dirty 现场无法区分归属，或需要 integrate/discard 的产品决策时停止；孤儿 legacy worktree 目录不触发停止但必须保留；不盲目回收 `6d25b1de`。

---

### Task 6：fresh Host 终态验证

**Agent：** `executor`

**Deps：** `T5`（理由：live state root 归档和代码版本必须稳定后才能验证）。

**WritePaths：**
- `none`（只读验证）

**Resources：** fresh Host、独立临时 test state root；不使用 live workspace 做破坏性测试。

**Files：**
- Read-only：T1–T5 所列源码、`var/workspaces` audit 输出和 `/Users/mhbzhy/yugang` 现场。

**接口契约：**
- Consumes：最终代码、quarantine receipt、既有测试和 audit 入口。
- Produces：命令 exit、测试计数、live audit、resume/proof/status 关键事实和未满足条件清单。

**终态关联：** `F1`–`F6`。

**验收标准：**

- [ ] **步骤 1：运行类型检查**：`npm run typecheck`。
- [ ] **步骤 2：运行 workspace 回归**：`npm run test:subagent-workspace`。
- [ ] **步骤 3：运行 coordinator/resume/proof/reminder 回归**：`node --test test/managed-workspace-coordinator-recovery.test.mjs test/managed-workspace-recovery-rebind.integration.mjs test/workspace-disposition-settlement.integration.mjs test/managed-workspace-terminal-proof-handoff.integration.mjs test/subagent-workspace-completion-reminder.test.mjs`。
- [ ] **步骤 4：运行 package 验证与 live audit**：`npm --prefix packages/pi-subagents-enhanced run verify:package`；使用 fresh Host 重新执行全 state root `node scripts/worktree-lifecycle.ts audit --json`，并核对实际工具 `subagent_worktree` 的 status/list action、resume 和 proof 路径的错误码。使用一次性临时 state root fixture（不落盘到仓库、不作为 production provenance）植入一条 foreign v1 和一条 v2-invalid 记录：验证 foreign v1 只诊断跳过，v2-invalid 仍 fail-closed；再运行 yugang live audit，区分生产现场证据与 fixture 证据。
- [ ] **步骤 5：记录基线差异**：当前已有 dirty 文件不得被覆盖；若既有失败与本计划无关，记录精确命令、exit、首个偏离点和 provenance，不能把失败改称通过。
- [ ] **停止条件**：fresh Host 未启动、live audit 仍含未知 schema debt、resume 把查询失败当成无 workspace、或任何验证需要新增未授权测试时停止并报告。

---

## 计划自检

- 规格覆盖：已覆盖六条 legacy record 的来源隔离、target-specific status/disposition、resume/proof/提醒路径、smoke state root 隔离和 live audit。
- 占位扫描：正文不使用 `TBD`、`TODO` 或未定义任务引用；每个任务均给出文件、接口、验收和停止条件。
- 类型一致性：`readOwned` 同时更新 service 实现、registry contract、facade/coordinator 调用方；T3 只消费该契约，不改变 resume intent 或 proof schema。
- DAG 审核：T1 是共享 ledger/admin 前置；T4 可与 T1 并行；live state 任务在全部代码集成后串行；验证在 live 现场稳定后执行。
- 终态审核：F1–F6 均有命令或现场核对方法；quarantine 与 yugang 处置决策分离，owner/lease/proof 不明时明确阻塞，不以删除记录或绕过 public API 宣告完成。
