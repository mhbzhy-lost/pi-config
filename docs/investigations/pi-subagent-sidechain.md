# 调研: pi 的 subagent / sidechain 机制与 PiSessionCapture 适配方案

> 调研时间: 2026-07-17 | 分支: feat/support-pi-tracing | 工作流: /skill:invest
> 本报告不产出生产代码，仅产出调研结论与实施指导。所有结论标注 [confirmed] 或 [hypothesis]。

## 后续说明（runtime source adapter）

本报告的“暂不实现 sidechain”结论仅针对 Pi 内联 Task 模型：`subagents:record` 仍不投影为后端父子关系，也不新增 sidechain 字段。后续引入的 runtime source adapter 不解析该内联记录；它在每个启用扩展的独立 Pi 进程启动时登记真实 session JSONL，并由 `PiSessionCapture` 将其作为独立 `pi-cli` session 采集。因而，能够产生完整 Pi JSONL 的第三方独立子进程及嵌套子进程不受本报告结论限制，但同样不构造父子关系。

## 问题陈述

ai-coding-trace 追踪多种 coding agent 使用数据。`PiSessionCapture` 已实现核心上报通道（session_record、token_usage、adoption、skill）。

PiSessionCapture 当前缺失 subagent / sidechain 支持：
1. `subagents:record` custom entry 在 `consumePiCustomEntry` 中被跳过（只处理 `pi-checkpoint`）
2. session header 的 `parentSession` 字段在 `readSessionBootstrap` 中未被读取
3. `buildSessionRecordArtifacts` 的 session_record payload 无 `is_sidechain` / `parent_session_id` / `agent_id` / `transcript_kind` 字段（与 Claude 的四字段模型不一致）

本次调研要回答：
- `subagents:record` 的完整结构是什么？对后端有什么价值？
- `parentSession` 字段格式是什么？代表什么关系？
- Claude 的 sidechain 是如何实现的？能否复用？
- pi 的 subagent 类型有哪些？
- 是否需要新增 payload 字段？是否需要解析 `subagents:record`？result 是否需要截断？
- 投入产出比如何？是否值得投入，还是标记为「已知但暂不实现」？

## 调研过程

**信源 1: 源代码（最高可信度，第一优先级）**
- 精读 `src/core/history/PiSessionCapture.ts`（1912 行）：`readSessionBootstrap`(L503)、`consumeTranscriptRecord`、`consumePiCustomEntry`、`buildSessionRecordArtifacts`、`flushSessionPendingRecords`
- 精读 `src/core/history/ClaudeSessionCapture.ts`（3911 行）：`ClaudeSessionState`(L89-126)、`resolveSubagentPathParts`(L524-542)、`resolveTranscriptIdentity`(L1140-1183)、`applyTranscriptIdentity`(L1186-1194)、`buildSessionRecordArtifacts` payload(L3420-3457)、`SUBAGENT_SESSION_SEPARATOR=':subagent:'`(L458)
- 精读 pi 包 `dist/core/session-manager.js`：`appendCustomEntry`(L758-768)、`createBranchedSession` header(L596)、`newSession` header(L1041)、clone header(L1188)

**信源 2: 真实 fixture（运行时探测）**
- `src/tests/fixtures/pi-sessions/` 全量扫描，提取 `subagents:record`（18 条，2 个文件）与 `parentSession`（30+ 条 header）真实样本
- 对每条记录提取完整字段结构、type 枚举、status 枚举、result 长度分布、duration 分布

**信源 3: 项目文档（交叉验证）**
- `docs/investigations/pi-session-record-reporting.md`（既有结论：pi 省略 sidechain 四字段）
- `docs/investigations/pi-session-state-lifecycle.md`（ClaudeSessionState 字段结构）
- `docs/investigations/coding-agent-data-collection-flow.md`（P0 编排，sidechain 标为「低-中」）

## 根因 / 机制

### 机制 A: pi 的 subagent —— 内联 custom entry（`subagents:record`）[confirmed]

> 证据: fixture 18 条样本 + `session-manager.js:758-768` appendCustomEntry + `agent-session.js:1840-1843` appendEntry 暴露给工具

pi 不为每个 subagent 创建独立 session 文件。subagent 在主 session 内联运行，结束时由 subagent 调度工具（TaskExecute）通过 `appendEntry("subagents:record", data)` 写一条 custom entry 到主 session 日志。

**entry 顶层结构（`appendCustomEntry` 实现，session-manager.js:758-768）[confirmed]:**
```typescript
{
  type: "custom",
  customType: "subagents:record",
  data: { ... },          // subagent 摘要数据
  id: string,             // entry id
  parentId: string|null,  // 指向 leafId（时间序前驱 entry，非 parent session）
  timestamp: string       // ISO 时间戳（entry 写入时间）
}
```

**data 完整 schema（18 条样本全量统计）[confirmed]:**
```typescript
interface SubagentsRecordData {
  id: string;              // subagent 实例 id，如 "54213033-78e9-482"
  type: string;            // subagent 类型，枚举: "general-purpose" | "Explore"
  description: string;     // 任务描述，短文本（平均 20 字符）
  status: string;          // 完成状态，枚举: "completed"（18 条全部 completed，未见其他）
  result: string;          // subagent 最终报告（纯文本，非结构化 JSON）
  startedAt: number;       // Unix 毫秒时间戳
  completedAt: number;     // Unix 毫秒时间戳
}
```

**18 条样本统计 [confirmed]:**
| 维度 | 数值 |
|---|---|
| 总条数 | 18（文件 A: 10 条，文件 B: 8 条） |
| type 枚举 | `general-purpose` (16 条), `Explore` (2 条) |
| status 枚举 | `completed` (18 条，未见 in-progress/failed) |
| result 长度 | 1132 - 30555 字符（纯文本） |
| description 长度 | 平均 20 字符 |
| duration_ms | 61 秒 - 21 分钟 |
| startedAt/completedAt 格式 | Unix 毫秒时间戳（int，非 ISO 字符串） |

**关键观察：**
- `result` 是纯文本报告，**不是结构化 JSON**，且体量大（最大 30KB/条）。18 条全部 result 体积约 200KB，远超单条 session_record payload 的合理上限。[confirmed]
- `status` 全部为 `completed` —— subagent 的 in-progress 状态不会被持久化为 `subagents:record`（entry 仅在 subagent 结束时写入），所以 capture 永远只会看到 completed。即「subagent 执行中」这一中间态对 capture 不可见。[confirmed]
- `type` 的 `general-purpose` / `Explore` 对应 pi 的 subagent 类型（见机制 D）。

### 机制 B: pi 的 fork / clone —— 独立 session 文件 + parentSession 路径 [confirmed]

> 证据: 30+ 条 parentSession fixture + `session-manager.js` 三处 header 写入

pi 的 `/new`、`fork`、`clone` 会创建一个**全新的 .jsonl session 文件**，其 header 含 `parentSession` 字段指向源 session 文件的**绝对路径**。

**session header 结构（含 parentSession）[confirmed]:**
```typescript
{
  type: "session",
  version: 3,
  id: string,              // 新 session 的 id（与 parent 不同）
  timestamp: string,      // ISO 时间戳（新 session 创建时间，晚于 parent）
  cwd: string,
  parentSession: string   // 指向 parent session 文件的绝对路径，如
                          // "/Users/macrox/.pi/agent/sessions/--...--/<ts>_<uuid>.jsonl"
}
```

**parentSession 值格式验证（真实样本）[confirmed]:**
| 维度 | 结论 |
|---|---|
| 值类型 | string |
| 是绝对路径 | true（以 `/` 开头） |
| 以 .jsonl 结尾 | true |
| 指向另一个 session 文件 | true（文件名含不同的 uuid） |
| 与当前文件同目录 | true（同一个 cwd 编码目录） |
| parent 早于 child | true（parent 时间戳 < child 时间戳） |
| parent id ≠ child id | true |

**parentSession 写入的三种场景（pi session-manager.js）[confirmed]:**

| 场景 | 源码位置 | parentSession 值 | 语义 |
|---|---|---|---|
| `createBranchedSession`（fork 到某条消息形成分支） | session-manager.js:596 | `options.parentSession`（源文件路径） | 从源 session 分叉 |
| `newSession`（/new 或 fork 到根） | session-manager.js:1041 | `this.persist ? previousSessionFile : undefined` | 新 session 继承前一个 session 的路径引用 |
| clone（克隆 session 到新 cwd） | session-manager.js:1188 | `resolvedSourcePath` | 克隆自源文件 |

**关键结论：pi 的 parentSession 代表的是 fork / clone / branch 关系（session 血缘），与 Claude 的 sidechain（subagent 父子）是完全不同的概念。** [confirmed]

### 机制 C: Claude 的 sidechain —— 路径驱动的 subagent 模型 [confirmed]

> 证据: ClaudeSessionCapture.ts:524-542 (resolveSubagentPathParts) + 1140-1183 (resolveTranscriptIdentity) + 3420-3457 (payload)

Claude 的 subagent 是**独立文件**，存放在 `.../<projectId>/subagents/<parentSessionId>/agent-<agentId>.jsonl`。因此 Claude 能从**文件路径**提取 sidechain 身份。

**resolveSubagentPathParts（路径解析）[confirmed]:**
```typescript
// ClaudeSessionCapture.ts:524-542
function resolveSubagentPathParts(filePath: string): {
  parentSessionId?: string;   // 路径中 'subagents' 前一段 = parent session id
  agentId?: string;            // 文件名 'agent-<id>' 去前缀 = agent id
  isSubagentPath: boolean;    // 路径含 'subagents' 段 = true
}
```

**resolveTranscriptIdentity（身份构建）[confirmed]:**
```typescript
// ClaudeSessionCapture.ts:1140-1183
const isSidechain = source.isSidechain === true
                  || pathParts.isSubagentPath
                  || !!agentId;
// 复合 sessionId: `${parentSessionId}:subagent:${subagentId}`
```

**session_record payload 四字段（ClaudeSessionCapture.ts:3431-3434）[confirmed]:**
```typescript
parent_session_id: session.parentSessionId ?? null,
agent_id: session.agentId ?? null,
is_sidechain: session.isSidechain ? 1 : 0,
transcript_kind: session.isSidechain ? 'subagent' : 'session',
```

### 机制 D: pi 的 subagent 类型映射 [confirmed]

> 证据: fixture 18 条 type 枚举 + ClaudeSessionCapture 的 SUBAGENT_SESSION_SEPARATOR

`subagents:record` 的 `type` 字段取值：
- `general-purpose`（16/18）：pi 的通用 subagent 类型，对应 `agentType: 'general-purpose'`（与 TaskCreate/TaskExecute 的 agentType 一致）
- `Explore`（2/18）：pi 的探索型 subagent 类型，对应 `agentType: 'Explore'`

这两种类型即 pi TaskExecute 中可声明的 subagent 类型。capture 端只需透传字符串，无需枚举校验。[confirmed]

### 机制 E: pi 与 Claude 的模型差异（根因）[confirmed]

| 维度 | Claude | pi subagent (`subagents:record`) | pi fork/clone (`parentSession`) |
|---|---|---|---|
| subagent 存储形式 | 独立文件 `.../subagents/<parent>/agent-<id>.jsonl` | 主 session 内联 custom entry | 不适用（不是 subagent） |
| 身份提取来源 | 文件路径段 | custom entry 的 data 字段 | session header 的 parentSession 字段 |
| 是否独立 session 文件 | 是（每个 subagent 一个文件） | 否（内联在主 session） | 是（fork 产生新文件） |
| 关系语义 | subagent 父子（sidechain） | subagent 摘要（内联） | session 血缘（fork/clone） |
| Claude 的 `parent_session_id` 语义 | subagent 的父 session | 不直接对应 | 形式类似但语义不同（fork parent ≠ subagent parent） |

**根因：pi 的 subagent 是「内联摘要」模型，Claude 的 subagent 是「独立文件 + 路径身份」模型。两者无法用同一套路径驱动逻辑适配。** pi 的 `parentSession` 在形式上与 Claude 的 `parent_session_id` 相似，但语义是 fork/clone 而非 subagent，复用同一字段名会造成语义混淆。

### 机制 F: PiSessionCapture 现状的缺口 [confirmed]

> 证据: PiSessionCapture.ts 全文

1. **`readSessionBootstrap`（L503-535）**：只提取 `id` / `cwd` / `timestamp`，**未读 `parentSession`** —— fork/clone 血缘完全丢失。
2. **`consumeTranscriptRecord`**：`type === 'custom'` → `consumePiCustomEntry` → 只处理 `customType === 'pi-checkpoint'`，对 `subagents:record` 直接 `return`（跳过）。
3. **`buildSessionRecordArtifacts` payload（对应 L1535-1557）**：无 `is_sidechain` / `parent_session_id` / `agent_id` / `transcript_kind` 字段。这是 `pi-session-record-reporting.md` 当时的显式决策（「pi session 无 parentSessionId/agentId/isSidechain/transcript_kind 等子链概念，可省略」），但该决策是在发现 `subagents:record` / `parentSession` fixture 之前做出的。

置信度：高（全部由源码与 fixture 直接证实）

## 方案对比

### 方案 A: 全量对齐 Claude（解析 subagents:record + 追踪 parentSession + 新增四字段）

| 维度 | 评估 |
|---|---|
| 概要 | 完整镜像 Claude 的 sidechain 模型：解析 `subagents:record` 提取全部信息、在 `readSessionBootstrap` 读 `parentSession`、payload 新增 `is_sidechain`/`parent_session_id`/`agent_id`/`transcript_kind` |
| 工作量 | **L**：需新增 state 字段（subagent 列表）、`consumePiCustomEntry` 新增 `subagents:record` 分支、`readSessionBootstrap` 读 parentSession 并解析为 parent session id、payload 四字段、以及 pi 内联模型到 Claude 路径模型的语义映射（非平凡） |
| 风险 | **高**：(1) pi 的 `subagents:record` result 体量大（单条最大 30KB），全量进 payload 会显著推高 session_record 体积，触发 size-guard oversized 概率上升；(2) `parent_session_id` 语义与 Claude 不一致（fork ≠ subagent parent），复用字段名会让后端侧语义混淆；(3) pi 内联 subagent 没有独立 sessionId，强行套 `:subagent:` 复合 id 是人为构造 |
| 兼容性 | 需新增 payload 字段（后端需感知）；`consumePiCustomEntry` 新增分支不破坏既有 `pi-checkpoint` 处理 |
| 局限 | 无法真正建立 subagent 与其内部对话的关联（pi 不记录 subagent 内部对话），所谓「sidechain」只是一个摘要条目 |

### 方案 B: 轻量元数据上报（解析 subagents:record 仅取元数据 + parentSession 血缘）

| 维度 | 评估 |
|---|---|
| 概要 | 解析 `subagents:record` 但**只取轻量元数据**（type/description/status/startedAt/completedAt/duration），**不取 result**（避免 payload 膨胀）；`readSessionBootstrap` 读 `parentSession` 并从中解析出 parent session id，作为独立字段上报 fork 血缘；payload 不复用 Claude 的 `parent_session_id`（避免语义混淆），用语义明确的独立字段 |
| 工作量 | **M**：`consumePiCustomEntry` 新增 `subagents:record` 分支（提取元数据、丢弃 result）、`readSessionBootstrap` 读 parentSession + 路径解析为 parent id、payload 新增字段、state 新增 subagent 元数据列表 |
| 风险 | **中**：需设计新的 subagent 元数据承载形式（新事件 or 附挂 session_record）；parentSession 路径解析依赖文件名 `<ts>_<uuid>.jsonl` 格式（脆弱但 pi 稳定） |
| 兼容性 | 不破坏既有链路；新增字段对后端可选消费 |
| 局限 | result 丢弃意味着丢失 subagent 的最终报告内容（但该内容主 session 已部分消费）；fork 血缘字段需后端独立适配 |

### 方案 C: 标记为已知但暂不实现（推荐）

| 维度 | 评估 |
|---|---|
| 概要 | 将本次调研结论落档，明确 `subagents:record` 与 `parentSession` 已知存在但暂不实现 capture。仅记录到 `coding-agent-data-collection-flow.md` 的可选优化项。不做代码改动。 |
| 工作量 | **S**：仅文档 |
| 风险 | **低**：无代码改动，无回归风险 |
| 兼容性 | 无影响 |
| 局限 | subagent 使用模式与 fork 血缘对后端不可见（见价值评估） |

### 价值评估（决定推荐的关键依据）

**subagents:record 的后端价值 [hypothesis，基于数据特征推断]:**
- `type` / `description` / `duration`：轻量元数据，可用于分析「每 session 用了多少 subagent、什么类型、平均耗时」——有一定分析价值，但**当前后端无 subagent 专用表/事件消费这些数据**，需新增 schema 才能落地。
- `result`：subagent 的最终报告文本，体量大（1KB-30KB/条，18 条≈200KB）。该内容**已被主 session 的 assistant 消息部分消费**（主 session 决定如何使用 subagent 输出），全量上报与主 session 内容高度冗余，且会显著推高 payload 体积。**增量价值低、成本高。**
- `status`：18 条全部 `completed`，因 `subagents:record` 仅在 subagent 结束时写入，capture 永远只看到 completed —— **无法提供 subagent 失败/进行中信号，价值有限。**

**parentSession（fork/clone）的后端价值 [hypothesis]:**
- fork/clone 是相对低频事件（fixture 中 30+ 条多来自测试套件，真实用户场景更稀疏）。
- fork 血缘可用于「session 演进树」分析，但**当前后端无 session 血缘消费场景**。
- 字段获取成本低（header 直接读），但语义与 Claude 的 `parent_session_id`（subagent parent）不同，复用会造成语义混淆。

**综合判断：subagents:record 与 parentSession 对后端的价值当前为「低-中」（与 `coding-agent-data-collection-flow.md` 第 10 项评级一致），且当前无后端消费场景、无专用 schema。在无明确后端需求驱动前，投入产出比偏低。**

## 推荐方案

**推荐方案 C：标记为已知但暂不实现。**

理由（基于证据）：
1. **subagents:record 的核心价值字段 `result` 与主 session 内容高度冗余、体量大**，全量上报会推高 payload 体积、增加 size-guard oversized 风险，而增量信息有限。[confirmed result 体量] + [hypothesis 冗余性]
2. **subagents:record 的 `status` 永远是 completed**（entry 仅在结束时写入），无法提供 subagent 失败/进行中信号，监控价值有限。[confirmed]
3. **当前后端无 subagent 专用表/事件、无 session 血缘消费场景**，即使 capture 上报也无下游消费，无法形成数据闭环。[hypothesis，基于现有 docs 无 subagent 消费链路]
4. **pi 的 subagent（内联）与 Claude 的 sidechain（独立文件）模型根本不同**，强行套用 Claude 的 `is_sidechain`/`parent_session_id`/`agent_id`/`transcript_kind` 会引入语义混淆（fork parent ≠ subagent parent）。[confirmed 模型差异]
5. **`pi-session-record-reporting.md` 已显式决定省略 sidechain 四字段**，本次调研进一步证实该决策的合理性（pi 无 Claude 式 sidechain 概念）。[confirmed 既有决策]

### 若未来需要实现的实施指导（方案 B 为后备路径）

当后端出现明确的 subagent 使用分析需求或 session 血缘需求时，按以下步骤实施方案 B（此为后备，非当前推荐）：

**步骤 1: parentSession 读取（最小改动，独立于 subagent）**
- 文件: `src/core/history/PiSessionCapture.ts` `readSessionBootstrap`（L503-535）
- 改动: 从 header 读取 `parentSession`（绝对路径），用正则 `/_(019f[0-9a-f-]+)\.jsonl$/` 从文件名提取 parent session id（pi session id 为 UUIDv7，格式稳定）。
- state: 在 `PiSessionState` 新增 `parentSessionId?: string`（语义为 fork parent，非 subagent parent）。
- payload: 在 `buildSessionRecordArtifacts` payload 新增字段。**字段名不复用 `parent_session_id`**（避免与 Claude 的 subagent parent 语义混淆），建议命名为 `forked_from_session_id`（语义明确）。**不设 `is_sidechain`**（pi 主 session 非 sidechain）。

**步骤 2: subagents:record 元数据解析（若需 subagent 分析）**
- 文件: `src/core/history/PiSessionCapture.ts` `consumePiCustomEntry`（当前只处理 `pi-checkpoint`）
- 改动: 新增 `else if (entry.customType === 'subagents:record')` 分支，提取 `data.type` / `data.description` / `data.status` / `data.startedAt` / `data.completedAt`，计算 `duration_ms = completedAt - startedAt`。
- **result 处理**：**不取 result 全文**。如需保留摘要，用 `truncate(result, 500)` 取前 500 字符（远小于 MAX_CHAT_MESSAGE=12000），避免 payload 膨胀。建议直接丢弃 result。
- state: 在 `PiSessionState` 新增 `subagentRecords: Array<{id, type, description, status, durationMs, startedAt, completedAt}>`。
- 上报: subagent 元数据**不塞进 chat_message**（会污染对话语义），建议作为 session_record payload 的独立数组字段 `subagent_summaries`，或新增独立事件 `ai_subagent_record`（需后端配合建表）。

**步骤 3: 测试**
- fixture 已存在（`src/tests/fixtures/pi-sessions/` 下含 18 条 `subagents:record` 与 30+ 条 `parentSession` 的真实样本），直接复用。
- 在 `src/tests/pi-session-capture-verify.ts` 增加断言：parentSession 被解析为 parentSessionId、subagents:record 元数据被提取、result 不进 payload。

**风险与回滚:**
- parentSession 路径解析依赖文件名 `<ts>_<uuid>.jsonl` 格式，若 pi 改名格式会失效 —— 但 pi 的 session 文件名格式长期稳定，风险低。
- 方案 B 的新增字段对后端可选消费，不破坏既有 session_record 去重（payload_hash 含新字段，但既有 session 仍按旧 hash 去重）。
- 回滚：移除 `consumePiCustomEntry` 的 `subagents:record` 分支与 `readSessionBootstrap` 的 parentSession 读取即可完全回滚。

## PoC 结果

未执行 PoC。本次调研为纯只读分析，所有结论由源码与 fixture 直接证实，无需代码验证。若后续实施方案 B，可基于现有 fixture 直接跑 `pi-session-capture-verify.ts` 验证。

## 待确认 / 开放问题

1. **[hypothesis] 后端是否有 subagent 使用分析或 session 血缘消费需求？** 本次调研在仓库 docs 中未发现 subagent 专用表或 session 血缘消费链路。若有后端需求，请确认后再决定是否升级为方案 B。这是决定是否实施的唯一关键变量。
2. **[hypothesis] `subagents:record` 的 result 与主 session assistant 消息的冗余度**：本次调研确认 result 体量大（1KB-30KB），但未逐条比对 result 与主 session 对应 assistant 消息的内容重叠率。若冗余度低于预期，方案 B 取摘要的价值会上升。当前基于「subagent 输出经主 session 消费」的合理推断。

## 关键发现汇总

1. **[confirmed]** pi 的 subagent 通过主 session 的 `subagents:record` custom entry 内联记录（18 条 fixture），**不是独立 session 文件**。entry 顶层含 `{type, customType:"subagents:record", data, id, parentId, timestamp}`，data 含 `{id, type, description, status, result, startedAt, completedAt}`。
2. **[confirmed]** pi 的 fork/clone 通过 session header 的 `parentSession` 字段标记（30+ 条 fixture），值是**指向另一个 .jsonl session 文件的绝对路径**（同目录、parent 早于 child、id 不同），代表 session 血缘关系。
3. **[confirmed]** pi 的 subagent `type` 取值为 `general-purpose`（16 条）与 `Explore`（2 条），对应 pi TaskExecute 的 agentType。
4. **[confirmed]** `subagents:record` 的 `status` 全部为 `completed`（entry 仅在 subagent 结束时写入），capture 永远看不到 in-progress/failed 状态。
5. **[confirmed]** `subagents:record` 的 `result` 是纯文本（非 JSON），体量 1KB-30KB/条，18 条合计约 200KB，远超单条 session_record payload 合理上限。
6. **[confirmed]** Claude 的 sidechain 是**路径驱动**模型（`subagents/` 路径段 + `:subagent:` 复合 id），与 pi 的内联 custom entry 模型根本不同，无法直接复用。
7. **[confirmed]** PiSessionCapture 当前 `readSessionBootstrap` 未读 `parentSession`、`consumePiCustomEntry` 跳过 `subagents:record`、payload 无 sidechain 四字段 —— 与 `pi-session-record-reporting.md` 既有决策一致。
8. **[hypothesis]** subagents:record 与 parentSession 对后端价值「低-中」，当前无后端消费场景与专用 schema，建议**暂不实现**（方案 C），待出现明确需求后再按方案 B 实施指导推进。

## 信源标注

| 结论 | 信源 | 状态 |
|---|---|---|
| subagents:record 18 条结构 | `src/tests/fixtures/pi-sessions/--Volumes-workspace-pi--/...jsonl` + `--Volumes-workspace-ai-coding-trace--/...jsonl`（全量提取） | [confirmed] |
| appendCustomEntry 结构 | `pi dist/core/session-manager.js:758-768` | [confirmed] |
| appendEntry 暴露给工具 | `pi dist/core/agent-session.js:1840-1843` | [confirmed] |
| parentSession 是绝对路径指向同目录另一文件 | fixture 全量验证（30+ 条） | [confirmed] |
| parentSession 三种写入场景 | `pi dist/core/session-manager.js:596,1041,1188` | [confirmed] |
| ClaudeSessionState 四字段 | `ClaudeSessionCapture.ts:89-126` | [confirmed] |
| resolveSubagentPathParts 路径解析 | `ClaudeSessionCapture.ts:524-542` | [confirmed] |
| resolveTranscriptIdentity 复合 id | `ClaudeSessionCapture.ts:1140-1183` | [confirmed] |
| Claude payload 四字段 | `ClaudeSessionCapture.ts:3431-3434` | [confirmed] |
| PiSessionCapture readSessionBootstrap 不读 parentSession | `PiSessionCapture.ts:503-535` | [confirmed] |
| PiSessionCapture consumePiCustomEntry 只处理 pi-checkpoint | `PiSessionCapture.ts`（consumePiCustomEntry） | [confirmed] |
| PiSessionCapture payload 无 sidechain 字段 | `PiSessionCapture.ts` buildSessionRecordArtifacts | [confirmed] |
| 既有决策省略 sidechain 字段 | `docs/investigations/pi-session-record-reporting.md` 机制 C | [confirmed] |
| sidechain 评级「低-中」 | `docs/investigations/coding-agent-data-collection-flow.md` 第 10 项 | [confirmed] |
| result 与主 session 冗余、后端无消费场景 | 基于 data 特征与 docs 推断 | [hypothesis] |

源码与 fixture 为最高信源，[confirmed] 项均有具体文件行号支撑；[hypothesis] 项已注明推断依据。
