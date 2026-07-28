# Work Summary: pi Coding Agent CLI 会话追踪全链路实现

## 1. Why — Motivation & Value

**问题**：ai-coding-trace 已支持追踪 20+ 种 coding agent（Claude Code、Cursor、Codex 等），但 pi coding agent CLI 的会话数据完全没有被采集。pi 用户的使用数据（代码采纳、token 消耗、执行链路）对后端不可见。

**价值**：
- 后端可看到 pi 用户的 token 消耗统计（SLS token_usage 通道）
- 后端可看到 pi 会话级聚合记录（SLS session_record 通道）
- trace 系统可看到 pi 执行链路（OTel trace 通道）
- pi 用户的代码采纳事件可上报（SLS adoption 通道）
- pi 成为 ai-coding-trace 支持的第 22 种 coding agent，追踪覆盖面扩大

**可观测症状**：pi 用户执行 `ai-trace status` 后，后端无任何 pi 相关数据；pi 的代码采纳事件未出现在 webview 实时事件流中。

## 2. How — Approach & Tradeoffs

### 方案选择

选择**方案 A（纯文件轮询 SessionCapture）**，而非方案 B（扩展 Hook 注入）或方案 C（RPC 集成）。理由：
- pi 的 session JSONL 格式结构清晰、字段完整（含 token 用量、成本、模型信息、工具调用、树结构），是采集的核心数据源
- 无需修改 pi，完全外部轮询，风险最低
- ClaudeSessionCapture 作为完整参考实现已验证该模式可行

### 架构设计

```mermaid
graph TD
    subgraph 触发层
        A[SessionCaptureRuntime piCycleTimer 60s] --> B[PiSessionCapture.runTranscriptCycle]
    end

    subgraph 采集层
        B --> C[discoverTranscriptFiles]
        C --> D[readJsonlFileIncrementally]
        D --> E[consumeTranscriptRecord]
    end

    subgraph 上报层
        E -->|adoption| F[ClaudeSessionAdoptionProjector 共用]
        E -->|token_usage| G[flushTokenUsage]
        E -->|session_record| H[flushSessionPendingRecords]
        E -->|OTel trace| I[flushSessionOtelTrace]
    end

    subgraph 存储层
        F --> J[CodeAdoptionSqliteStore outbox]
        E --> K[SessionSqliteStore 8 表]
    end

    J -->|SLS| L[SLS adoption]
    G -->|SLS| M[ai_token_usage]
    H -->|SLS| N[ai_session_record]
    I -->|OTLP| O[/v1/traces]
```

### 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 复用 Claude 前缀模块 | `ClaudeSessionSqliteStore` + `ClaudeSessionAdoptionProjector` | 通用模块，避免重复 ~250 行投影逻辑 |
| Session_record 用 Codex 式直接数组 model | `PiReportMessage[]` | pi 线性 JSONL 无需 requestId 聚合 |
| OTel trace 是 session_record 的"转换式双写" | 复用同一份 payload → OTLP spans | 独立 report_channel='otel-traces' |
| OTel fire-and-forget + flushState 超时保护 | 不阻塞 SLS 主链路 | 与 Claude 一致 |
| Repo 上下文 60s 频率限制 + 三级候选探测 | `[cwd, filePath dirname, session.cwd]` | 对齐 ClaudeSessionCapture |
| Cursor defer 策略 | `canAdvanceCursor` + `process_next_attempt_at` | 上报失败时保留旧 offset 等待重试 |

### 已知限制

- **无 ToolDetection 条目**：pi 无 GUI 进程、无 hook 注入点，仅由 piCycleTimer 驱动。这是设计选择，非缺陷。
- **无 /v1/code 直报路径**：pi 无 hook 能力，走 transcript 轮询。延迟 ≤60s，可接受。
- **无 degraded 状态**：pi 的 cursor defer 策略已覆盖该场景。
- **独立 Pi 子进程**：runtime source adapter 在每个启用扩展的 Pi 进程 `session_start` 时登记真实 JSONL；daemon 将其作为独立 `pi-cli` session 采集。因此创建完整 Pi JSONL 的独立子进程（含嵌套子进程）可进入既有 cursor、token、tool、adoption、session record 与 OTel 链路。
- **内联 `subagents:record`**：Pi 内联 Task 模型仍仅在父 session 写入摘要；不投影为后端 sidechain，不新增父子关系字段，也不采集其 `result` 全文。该边界与独立 Pi 子进程的 JSONL 采集互不冲突。

## 3. What — Concrete Changes

### 核心实现

| 文件 | 变更 | 说明 |
|------|------|------|
| `src/core/history/PiSessionCapture.ts` | 新增 1945 行 | pi 会话采集核心：4 条上报通道 + 12 项基础设施 |
| `src/core/history/ClaudeSessionSqliteStore.ts` | 修改 | 新增 `listModelUsageRecordsBySession` 委托方法 |
| `src/core/history/session-otel-env-snapshot.ts` | 修改 | 新增 `PI_CLI` 分支调用 `collectPiAgentArtifacts({ enabledKinds })` |
| `src/core/history/session-otel-agent-artifacts.ts` | 新增 | `collectPiAgentArtifacts` 收集 AGENTS.md/skills/prompts/settings.json |
| `src/core/history/HistoryProcessor.ts` | 修改 | `triggerPiProjectsBackfill` 集成 |
| `src/core/history/createHistoryRuntimes.ts` | 修改 | PiSessionCapture 装配 |
| `src/core/AICodeAnalyticsServiceV2.ts` | 修改 | `runPiCliBackfill` 方法 + `buildToolDetectionEntries` pi 不注入（设计选择） |
| `src/core/backfill/BackfillManager.ts` | 修改 | piCli trigger/state/handler 集成 |

### 配置/工具

| 文件 | 变更 | 说明 |
|------|------|------|
| `src/utils/tool-control.ts` | 修改 | piCli 配置项（6 处：enabled/backfill/trigger/config/cycle/hook） |
| `src/utils/backfill-cli-options.ts` | 修改 | pi-cli 条目（`--clientType=pi-cli` 或 `pi`） |
| `src/types/client-type.ts` | 修改 | `PI_CLI = 'pi-cli'` 枚举值 |

### 测试

| 文件 | 变更 | 说明 |
|------|------|------|
| `src/tests/pi-session-capture-verify.ts` | 新增 | 6 阶段验证：mock/state/token-usage/record/defer/fixture |
| `src/tests/pi-session-capture-smoke-verify.ts` | 新增 | 280 个真实 session 的冒烟测试 |
| `src/tests/fixtures/pi-sessions/` | 新增 | 280 个脱敏真实 pi 日志（228 个 cwd 目录，4.9MB） |
| `src/tests/client-type-constants-verify.ts` | 修改 | PI_CLI 常量断言 |
| `src/tests/backfill-service-verify.ts` | 修改 | piCli snapshot 条目 |
| `src/tests/hermes-backfill-manager-verify.ts` | 修改 | piCli snapshot 条目 |
| `src/tests/path-exclusion-verify.ts` | 修改 | piCli snapshot 条目 |
| `src/tests/qwen-code-backfill-config-verify.ts` | 修改 | piCli snapshot 条目 |
| `src/tests/tool-control-verify.ts` | 修改 | piCli snapshot 条目 |
| `src/tests/wukong-backfill-verify.ts` | 修改 | piCli snapshot 条目 |

### 调研报告

| 文件 | 说明 |
|------|------|
| `docs/investigations/pi-session-tracking.md` | pi 会话数据存储完整调研 |
| `docs/investigations/pi-session-state-lifecycle.md` | active/idle/sealed 状态机 |
| `docs/investigations/pi-token-usage-reporting.md` | SLS token_usage 上报通道 |
| `docs/investigations/pi-session-record-reporting.md` | SLS session_record 上报通道 |
| `docs/investigations/pi-otel-trace-reporting.md` | OTel trace 上报通道 |
| `docs/investigations/pi-repo-context.md` | repo 上下文采集 |
| `docs/investigations/pi-backfill.md` | ranged cycle 和 backfill 集成 |
| `docs/investigations/pi-oversized-line-usage.md` | JSON 扫描超大行 usage |
| `docs/investigations/pi-cursor-defer.md` | cursor 推进 defer 策略 |
| `docs/investigations/pi-skill-call-tracking.md` | 双信号 skill 调用追踪 |
| `docs/investigations/pi-subagent-sidechain.md` | subagent 分析（方案 C：暂不实现） |

### 4 条上报通道实现细节

| 通道 | 方法 | 去重 | 重试 |
|------|------|------|------|
| SLS adoption | `projectAdoption` → `ClaudeSessionAdoptionProjector` 共用 | `event_fingerprint` (md5) | CodeAdoptionSqliteStore outbox 无限重试 |
| SLS token_usage | `flushTokenUsage` → `reportSessionTokenSkill` | `payload_hash` (sha1), report_scope='token_usage' | report_status failed 可重试 |
| SLS session_record | `flushSessionPendingRecords` → `sendRawRecord` | `payload_hash` (sha1), report_scope='session' | report_status failed 可重试, `canAdvanceCursor=false` 时不推进 cursor |
| OTel trace | `flushSessionOtelTrace` → `session-otel-trace-reporter` | `payload_hash` (sha1), report_channel='otel-traces' | 3 次重试上限, oversized 永久跳过 |

### 12 项基础设施能力

| 能力 | 关键实现 | OOM 防护 |
|------|----------|---------|
| Session 状态机 | `refreshSessionStatus` (active<10min/idle<2h/sealed>2h) + `evictTerminalSessionIfSealed` | sealed 后停止处理 |
| Repo 上下文 | `maybeUpdateRepoInfo` (60s 频率, 三级候选 `[cwd, filePath dirname, session.cwd]`) | — |
| Backfill | `resolveTranscriptCycleOptions` + `buildTranscriptBackfillExtra` + BackfillManager | `RANGE_MAX_PENDING_CHAT_MESSAGES=500` prune |
| Oversized line | `parseOversizedTranscriptUsagePrefix` (512KB prefix+suffix JSON 扫描) | `TRANSCRIPT_LINE_MAX_BYTES=8MB` |
| Skill 追踪 | `detectPiSlashSkill` (user `/skill:` → status='requested') + `consumePiCustomEntry` (checkpoint `<skill>` → status='success') | — |
| Cursor defer | `canAdvanceCursor` + `markTranscriptProcessingFailure` + `process_next_attempt_at` 发现过滤 | deferred 不堆积 |
| Crash breadcrumb | `recordCrashBreadcrumb('pi.transcript.parse-json-line-failed', ...)` | — |
| Duplicate 检测 | `toolSignatureSeen` Map + `taskHasDuplicateToolCall` | — |
| 发现过滤 | `MAX_TRANSCRIPT_DISCOVERY_FILES=2000` + `TRANSCRIPT_DISCOVERY_LOOKBACK_MS=7天` | 文件数上限防 OOM |
| Hot/quiet window | `SESSION_QUIET_WINDOW_MS=5min` + `TRANSCRIPT_HOT_THRESHOLD_MS=2min` | — |
| Tool-control | `piCli` 配置项 + `pi-cli` backfill 条目 | — |
| OTel env snapshot | `collectPiAgentArtifacts` (AGENTS.md/skills/prompts/settings.json) | `MAX_AGENT_ARTIFACT_FILES` + `MAX_AGENT_ARTIFACT_SOURCE_BYTES=2MB` |

## 4. Impact — Downstream Effects

### 影响范围

- **SessionCaptureRuntime**：新增第 5 个 60s cycle timer（piCycleTimer），与 claude/codex/hermes/openclaw 并行
- **SQLite session-capture.db**：pi 数据写入同一数据库（client_type='pi-cli'），表结构无变化
- **SLS**：新增 pi-cli 的 adoption/token_usage/session_record 三种事件
- **OTel**：新增 pi-cli 的 OTLP spans（含 env snapshot + agent artifacts）
- **Webview**：pi 的代码采纳事件自动出现在实时 SSE 事件流中
- **macOS 状态栏 App**：pi 的 token/cost/session 数据自动出现在 SUMMARY/HEATMAP/MODEL SHARE 中
- **BackfillManager**：新增 piCli trigger/state/handler，支持 `--clientType=pi-cli` 补采

### 兼容性

- **向下兼容**：所有变更均为新增逻辑，不修改现有 Claude/Codex/其他 agent 的采集和上报行为
- **无 breaking change**：SQLite schema 无变化（复用现有表），SLS 事件格式对齐 Claude/Codex
- **回滚安全**：通过 tool-control 禁用 pi-cli 即可停止采集，无需回滚代码

### 迁移步骤

无迁移步骤。pi-cli 默认 'auto' 模式，pi CLI 安装后自动启用（由 piCycleTimer 驱动）。

### 合并后应监控/验证

- pi session 的 SLS adoption 事件是否正常到达后端
- pi session 的 token_usage/session_record 事件是否正常到达后端
- pi 的 OTel trace 是否正常到达 Sunfire
- pi session 的 cursor 是否正常推进（无 stuck）
- pi session 的 oversized line 是否被正确处理（无 OOM）

## Skipped Reviews

| Gate | Skip Reason |
|------|-------------|
| 机制对抗性审查 (Phase 2) | 无硬触发条件命中：无 hypothesis 被用作 confirmed，机制链置信度为 high。用户选择跳过。 |
| 方案对抗性审查 (Phase 3) | 无硬触发条件命中：无不可逆操作，无 hypothesis/confirmed 混淆。用户选择跳过。 |
