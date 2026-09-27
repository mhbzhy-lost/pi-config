# 上下文使用量与压缩前 handoff 实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。执行方式由计划完成后的用户选择决定。

**目标：** 为 Pi agent 增加可调用的当前上下文使用量工具，并在接近预设安全阈值时提醒 agent 生成 handoff，降低自动 compaction 导致的上下文丢失风险。

**架构：** 新增 `src/context-usage/` feature-owned 实现，负责计算和格式化上下文快照、阈值判断及 handoff 提醒策略；`pi/extensions/context-usage.ts` 只负责绑定 Pi Host API、注册 agent tool 和事件提醒。工具调用 `ctx.getContextUsage()`，不自行解析 session JSONL，也不把累计 session token 当成当前上下文 token。handoff 内容由 agent 通过现有 `write` 工具写入约定路径，扩展只提供路径、状态和提醒，不自动伪造摘要。

**技术栈：** Node.js `>=22.19.0`、TypeScript 原生 type-stripping、Pi Extension API `registerTool` / `getContextUsage` / `sendMessage`、Node 内置 test runner。

## 全局约束

- 仓库和 package 的最低 Node 版本固定为 `>=22.19.0`；新增 TypeScript 实现必须由 `tsc --noEmit` 或等价静态检查覆盖。
- `pi/extensions/` 只放 Pi 自动发现入口及其入口级配置；可复用业务逻辑放在根 `src/<feature>/`，不得把 `pi/extensions/**` 作为实现库。
- `scripts/` 只放可直接执行的 CLI、初始化脚本和诊断探针；本功能不得新增 production 实现到 `scripts/`。
- 跨 feature 依赖只能通过对方明确的公开入口或 package exports；不得从 `src/**` 反向依赖 `pi/extensions/**`。
- 面向用户的精简、折叠、摘要、截断和换行只能发生在 TUI renderer 层；本功能返回给 agent 的结构化数据不得为 TUI 展示而改写。
- 文档、skill 正文和代码注释使用中文；专业标识符、API 名称和标准技术术语可保持原样。
- 执行 production 代码或配置变更前，必须遵循 `test-driven-development` skill；先写失败测试，再实现最小行为。
- 不修改 `pi/settings.json` 的 `enabledModels` 字段；本计划不涉及模型配置。
- `ctx.getContextUsage()` 的结果是 Pi 的当前上下文估计值；`tokens`/`percent` 可能为 `null`，工具必须显式表达未知状态。
- 当前 Pi API 不直接暴露“自动 compaction 的精确触发阈值”；本功能使用独立、可配置的 handoff 安全阈值，不得把它声称为 Pi 内部精确 compaction 阈值。

## DAG

```text
T1（接口契约与测试夹具） ──┬──> T2（快照/阈值核心逻辑） ──┐
                           └──> T3（Pi extension 绑定与提醒） ──> T4（集成验收与文档）
T2 ────────────────────────────────────────────────────────┘
```

依赖理由：

- `T2` 只消费 `T1` 定义的快照、阈值和未知状态契约，因此可独立测试纯逻辑。
- `T3` 需要 `T1` 的 tool 返回契约和 `T2` 的判断函数，才能绑定真实 `ExtensionAPI`。
- `T4` 必须等待工具、提醒和测试全部完成，才能验证自动发现入口、类型检查和回归。

## Waves

- Wave 1：T1（接口契约、fixture 和失败测试）
- Wave 2：T2、T3（T2 消费 T1 的纯逻辑契约；T3 可并行搭建 extension 测试桩，但实现完成需 T2）
- Wave 3：T4（集成验收、回归和使用说明）

**关键路径：** T1 → T2 → T3 → T4。

---

### Task 1：定义上下文快照、阈值策略和 handoff 契约

**Deps：** `none`

**WritePaths：**
- `src/context-usage/contracts.ts`
- `test/context-usage.test.mjs`

**Resources：** `none`

**Files：**
- Create：`src/context-usage/contracts.ts`
- Create：`test/context-usage.test.mjs`

**接口契约：**
- Consumes：Pi `ContextUsage` 形状 `{ tokens: number | null; contextWindow: number; percent: number | null }`，以及可选阈值配置 `{ handoffRatio: number; urgentRatio: number }`。
- Produces：
  - `ContextUsageSnapshot`：包含 `tokens`、`contextWindow`、`percent`、`remainingTokens`、`remainingRatio`、`estimated`、`status`。
  - `HandoffPolicy`：包含 `handoffRatio`、`urgentRatio` 和固定的 handoff 文件相对路径约定。
  - `ContextUsageToolDetails`：供 agent tool 的 `details` 使用，必须能区分 `unknown`、`normal`、`prepare-handoff`、`urgent-handoff`。

**验收标准：**

- [ ] **步骤 1：编写失败测试**

  在 `test/context-usage.test.mjs` 覆盖以下行为：
  - 正常值能计算剩余 token 和占比；
  - 达到 handoff 阈值时状态为 `prepare-handoff`；
  - 达到 urgent 阈值时状态为 `urgent-handoff`；
  - `tokens` 或 `percent` 为 `null` 时状态为 `unknown`，不得计算负数或伪造百分比；
  - `contextWindow` 非正数、阈值不在 `0..1` 或 urgent 阈值小于 handoff 阈值时拒绝配置。

- [ ] **步骤 2：运行测试确认 RED**

  运行：`node --test test/context-usage.test.mjs`

  预期：FAIL，错误指向待创建的 `src/context-usage/contracts.ts` 导出或待实现函数。

- [ ] **步骤 3：编写最小契约实现**

  在 `src/context-usage/contracts.ts` 定义中文注释的类型和常量，明确：
  - 默认 `handoffRatio` 为 `0.80`；
  - 默认 `urgentRatio` 为 `0.90`；
  - `estimated` 始终为 `true`，因为 Pi API 提供的是估计值；
  - handoff 路径使用项目内固定相对路径（例如 `.pi/handoff/context-handoff.md`），不得将凭据或秘密写入其中。

- [ ] **步骤 4：运行测试确认 GREEN**

  运行：`node --test test/context-usage.test.mjs`

  预期：PASS。

- [ ] **步骤 5：运行本任务相关静态检查**

  运行：`npm run typecheck:root`

  预期：PASS。

---

### Task 2：实现纯函数快照计算和工具输出格式

**Deps：** `T1`（理由：消费 `ContextUsageSnapshot`、`HandoffPolicy` 和状态枚举契约）

**WritePaths：**
- `src/context-usage/snapshot.ts`
- `src/context-usage/tool-output.ts`
- `test/context-usage.test.mjs`

**Resources：** `none`

**Files：**
- Create：`src/context-usage/snapshot.ts`
- Create：`src/context-usage/tool-output.ts`
- Modify：`test/context-usage.test.mjs`

**接口契约：**
- Consumes：T1 的 `ContextUsage`、`HandoffPolicy` 和状态类型。
- Produces：
  - `createContextUsageSnapshot(usage, policy): ContextUsageSnapshot`；
  - `createContextUsageToolResult(usage, policy): { content: Array<{ type: "text"; text: string }>; details: ContextUsageToolDetails }`。
- `content` 必须是 agent 可读的 JSON 文本；`details` 必须保留未压缩的结构化字段，不能为 TUI 做摘要或截断。

**验收标准：**

- [ ] **步骤 1：补写失败测试**

  在测试中验证 `createContextUsageSnapshot` 和 `createContextUsageToolResult`：
  - `128000` 窗口、`102400` token 返回 `0.8` handoff 边界和 `25600` 剩余 token；
  - 返回内容包含“估计值”语义和 `shouldPrepareHandoff`/`shouldUrgentlyPrepareHandoff`；
  - 未知值返回 `tokens: null`、`percent: null`，并要求 agent 下一轮再次查询；
  - 不返回累计 session token、cost 或历史 usage，避免概念混淆。

- [ ] **步骤 2：运行测试确认 RED**

  运行：`node --test test/context-usage.test.mjs`

  预期：FAIL，错误指向待创建的 snapshot/output 模块。

- [ ] **步骤 3：编写最小实现**

  实现纯函数：
  - 只使用 `ctx.getContextUsage()` 提供的当前值；
  - `remainingTokens = contextWindow - tokens`，并限制为不小于 `0`；
  - 计算距离 handoff 安全阈值的 token 数；
  - 对 `null` 状态返回明确的 `unknown`，不得回退到读取 session JSONL；
  - 工具文本使用稳定 JSON，便于 agent 判断和测试断言。

- [ ] **步骤 4：运行测试确认 GREEN**

  运行：`node --test test/context-usage.test.mjs`

  预期：PASS。

- [ ] **步骤 5：运行本任务相关回归**

  运行：`npm run typecheck:root && node --test test/context-usage.test.mjs`

  预期：PASS。

---

### Task 3：注册 agent tool 并增加压缩前提醒

**Deps：** `T1`、`T2`（理由：需要稳定的工具返回契约、快照计算和提醒状态）

**WritePaths：**
- `pi/extensions/context-usage.ts`
- `src/context-usage/reminder.ts`
- `test/context-usage-extension.test.mjs`

**Resources：** `none`

**Files：**
- Create：`pi/extensions/context-usage.ts`
- Create：`src/context-usage/reminder.ts`
- Create：`test/context-usage-extension.test.mjs`

**接口契约：**
- Consumes：Pi `ExtensionAPI`；`ctx.getContextUsage()`；T1/T2 的 policy、snapshot 和 tool result；项目已有 `pi.sendMessage` 事件消息模式。
- Produces：
  - agent-facing tool `context_usage`，无参数；
  - tool result 的 `content` 与 `details` 同步表达完整快照；
  - 达到阈值时最多对同一 active context 状态发送一次提醒，避免每次事件重复刷屏；
  - 提醒内容明确要求 agent 使用 handoff 路径写入文档，不自动生成或覆盖 handoff 内容。

**验收标准：**

- [ ] **步骤 1：编写失败测试**

  在 `test/context-usage-extension.test.mjs` 建立最小 fake Pi/Context：
  - 断言自动发现入口会调用 `registerTool`，工具名称为 `context_usage`；
  - fake `getContextUsage()` 返回正常值时，工具结果包含完整结构化数据；
  - 返回 `null` 时工具不触发 handoff 误报；
  - 达到 `prepare-handoff` 和 `urgent-handoff` 时提醒一次；重复触发同一状态不重复发送；
  - compaction 后上下文恢复为已知值时，提醒去重状态能够重新开始。

- [ ] **步骤 2：运行测试确认 RED**

  运行：`node --test test/context-usage-extension.test.mjs`

  预期：FAIL，错误指向待创建的 extension/reminder 实现。

- [ ] **步骤 3：编写最小实现**

  - 在 `src/context-usage/reminder.ts` 实现按 session/context 状态去重的提醒状态机；
  - 在 `pi/extensions/context-usage.ts` 绑定 `pi.registerTool`，执行时从传入 `ctx` 读取 `getContextUsage()`；
  - 通过 `pi.sendMessage` 发送非展示性提醒，避免把 TUI 文本替换成 agent 消息；
  - 不在扩展中调用自动 compaction，也不拦截或修改 Pi 的 compaction 结果；
  - 对未知值只返回状态，不发送“马上压缩”的错误提醒。

- [ ] **步骤 4：运行测试确认 GREEN**

  运行：`node --test test/context-usage-extension.test.mjs`

  预期：PASS。

- [ ] **步骤 5：运行相关回归**

  运行：`npm run typecheck:root && node --test test/context-usage.test.mjs test/context-usage-extension.test.mjs`

  预期：PASS。

---

### Task 4：集成验收、使用说明和全量回归

**Deps：** `T3`（理由：只有入口、工具和提醒完成后才能验证自动发现及最终行为）

**WritePaths：**
- `docs/context-usage-handoff.md`
- `test/context-usage.integration.test.mjs`

**Resources：** `none`

**Files：**
- Create：`docs/context-usage-handoff.md`
- Create：`test/context-usage.integration.test.mjs`

**接口契约：**
- Consumes：T3 已注册的 `context_usage` 工具和 reminder 状态机。
- Produces：用户可执行的配置/使用说明、自动发现集成测试和最终验证记录。

**验收标准：**

- [ ] **步骤 1：编写集成失败测试**

  验证 `pi/extensions/context-usage.ts` 可被当前 TypeScript/ESM 配置加载，且入口不依赖 `scripts/**`、不写入 `pi/settings.json`，工具 schema 为无参数对象。

- [ ] **步骤 2：运行测试确认 RED**

  运行：`node --test test/context-usage.integration.test.mjs`

  预期：在入口或集成断言尚未完成时 FAIL。

- [ ] **步骤 3：补充使用说明**

  在 `docs/context-usage-handoff.md` 说明：
  - `context_usage` 是 agent tool，不是 RPC `get_session_stats`；
  - `tokens`/`percent` 是估计值，compaction 后可能暂时为 `null`；
  - 80%/90% 是本扩展的 handoff 安全阈值，不是 Pi 内部精确 compaction 阈值；
  - agent 应将关键状态写入 `.pi/handoff/context-handoff.md`，并在压缩后优先读取；
  - 不得在 handoff 中写入凭据、token、证书或其他秘密。

- [ ] **步骤 4：运行集成测试确认 GREEN**

  运行：`node --test test/context-usage.integration.test.mjs`

  预期：PASS。

- [ ] **步骤 5：运行全量验证**

  运行：`npm run typecheck && npm test`

  预期：PASS；若仓库现有测试因外部环境失败，必须记录首个失败点和数据来源，不增加未经分类的 production fallback。

- [ ] **步骤 6：手工验收**

  在真实 Pi 会话中调用 `context_usage`，分别观察正常值、达到阈值和 compaction 后未知值；确认 agent 收到的是完整原始结构化结果，TUI renderer 未被修改，提醒不会重复刷屏。

---

## 最终验收清单

- [ ] agent 可以通过 `context_usage` 读取当前上下文 token、窗口上限、占比和剩余 token。
- [ ] 返回值明确标记为估计值，并正确处理 `null`。
- [ ] handoff 阈值与 Pi 内部自动 compaction 阈值明确区分。
- [ ] 达到 80% 时提醒准备 handoff，达到 90% 时提醒立即完成 handoff。
- [ ] 同一上下文状态不会重复发送提醒；compaction 后可重新触发。
- [ ] 扩展不自动篡改 agent 消息、tool result、session 内容或 compaction payload。
- [ ] handoff 文档路径和恢复流程有中文说明，且禁止写入秘密。
- [ ] `npm run typecheck` 与 `npm test` 通过。
