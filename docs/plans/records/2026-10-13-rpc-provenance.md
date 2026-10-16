# RPC `rpc:v1/session` 字段级 provenance 增量（R1）

- 任务：统一计划 `docs/plans/2026-10-13-remaining-runtime-execution.md` §R1（RPC字段增量）。
- 分类：`sourceClass=unconfirmed`、`evidenceMode=static`（与 `docs/plans/records/2026-10-11-runtime-followups/rpc-provenance.json` 一致，未升级）。
- 结论先行：**无现场样本 → blocked-evidence**。本轮未取得报错会话的字段级启动 metadata，生产代码不改、不加 fallback、不放宽门禁；R2 后继只处置记录，不在 R1/R2 修代码。
- 边界：只读已入库 bug 文档、历史 provenance JSON 与 `assertSpawnCapabilities` 公开源码；未读真实 session/settings/models/auth/credential/authority/.state/日志；未发真实 RPC/Host/provider/网络请求；未运行 test/typecheck（F1 占 unit）；不重跑历史 T0–T11，本记录为有限增量。

## 证据来源（全部静态）

1. `docs/bugs/2026-10-10-rpc-session-capability-negotiation.md`（入库 bug，含用户报错文案）。
2. `docs/plans/records/2026-10-11-runtime-followups/rpc-provenance.json`（历史结构化 provenance）。
3. `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`（本仓工作区实际源码，行号为当前现场）。
4. `packages/pi-subagents-enhanced/src/subagent-dispatch/rpc-client.ts`（用于文案区分）。

## public 调用链（源码逐行核实）

1. typed subagent 工具 `execute`（extension.ts:1591）→ `trace("tool-entered")` → 按 `action`/coding 判定路由：`executeControl`（1613）/ `executeCoding`（1619）/ `executeGeneric`（1623）。
2. admission：`resolveSpawnModel`（538）可提前失败（`AGENT_ADMISSION_UNAVAILABLE`/`UNKNOWN_AGENT`，551）；本次文案是 negotiation 失败，故静态可推 admission 已通过。
3. workspace 分配（`preallocate`，822 / 1034）→ `orchestratorCwd = workspace?.originRoot ?? ctx.cwd`（coding 828 / generic 1036）。
4. `trace.stage = "rpc-ping"`（831 / 1037）→ `rpc.ping(...)`（832 / 1038）。
5. generic 路径独有：`negotiateCapabilities` + `assertSpawnAllowed`（1040–1042，rpc-client.ts:92–119）；coding 路径无此步。
6. `assertSpawnCapabilities(capabilities, orchestratorCwd)`：coding 835、generic 1044。
7. 断言失败抛错（294–298）→ `execute` catch（1628）→ `failure(code, message, detail, keypath)`（240）→ 用户可见文本 `CAPABILITY_NEGOTIATION_FAILED: pi-subagents RPC capability negotiation failed; missing: rpc:v1/session`。

## 首观察偏离与分类

- **首个可观察偏离：`assertSpawnCapabilities`，发生在 `rpc.ping` 返回之后**（832→835 / 1038→1044 顺序）。`rpc.ping` 返回只能证明链路走到 session 断言，不证明更早 stage 无异常，也不证明 child 已启动。
- **文案唯一性**：用户文案含 `pi-subagents` 前缀（extension.ts:294）；`rpc-client.ts:119` 的同类错误无此前缀。故可静态定位到 `assertSpawnCapabilities`，排除 rpc-client negotiate 文案。该文案定位为 known（static）。
- **真实首偏离 unconfirmed**：上游 session context 未就绪、cwd 合同不一致、旧 Host/资源世代三个候选机制（bug 文档 §需要核实的候选机制）均无现场证据，保持 unconfirmed。

## `rpc:v1/session` 复合标签不能断言单根因

`assertSpawnCapabilities`（extension.ts:270–300）中，复合条件（285–292）为**六个子条件的合取**，任一失败都 push 同一个 `rpc:v1/session` 标签：

1. `result.version !== 1`；
2. `methods` 不含 `"spawn"`；
3. `session.sessionId` 非空；
4. `lifecycleSessionIdentity(session)` 非空（sessionFile ?? sessionId，261–268）；
5. `session.cwd` 非空；
6. `session.cwd !== cwd`（即与 orchestratorCwd 严格相等）。

另：显式 capabilities envelope 存在时（277）才检查四项 security capability（`asyncSpawn`/`processTerminalProof`/`launchResolvedExtensions`/`runtimeAcknowledgedExtensions`，278–282），失败时以各自名称入 `missing`。观察到 missing 列表仅 `rpc:v1/session`，意味着四项 security capability 检查通过**或** envelope 检查未执行——两者从文案不可区分。**单一复合标签 ≠ 恰好一个条件失败，不能断言单根因。**

## 已有字段投影逐项 known/unknown

**前提：用户报错字符串不是完整现场。**`failure()` 的结构化 details 静态推定仅含 `{ code }`：catch 路径（1628–1641）中 `isRpcFailure=false`（该错误无 `error.operation`，code 亦非 `SUBAGENT_RPC_FAILED`）→ `details = error?.detail` → undefined → `failure()` details 仅 `code`（240–255）。`stage`/`missingCapabilities` 只进 `diagnosticSink` trace 或抛出错误属性，不进用户可见 tool result。

| 字段 | known/unknown | 依据与值 |
| --- | --- | --- |
| code | known（文案投影） | `CAPABILITY_NEGOTIATION_FAILED`（extension.ts:295） |
| message/missing 列表 | known（文案投影，仅此） | `missing: rpc:v1/session`；`missingCapabilities` 完整数组本身未持久化到用户可见结果 |
| stage | unknown | 不进用户可见结果。static 推断：coding 路径 throw 时 `trace.stage="workflow-spawn"`（833）；generic 路径 `"rpc-ping"`（1037，1061 才改）。属静态分类，非现场观察 |
| `result.version`（ping 回包版本） | unknown | 不进文案；envelope/session 块内容未知 |
| methods（ping 回包） | unknown | 同上；`spawn` 是否在 methods 不可知 |
| session identity（sessionId/sessionFile/runId） | unknown | 报错会话无任何身份投影入库 |
| orchestrator cwd（`workspace?.originRoot ?? ctx.cwd`） | unknown | 取决于该次是否 worktree 分配，均未知 |
| 主会话启动 cwd | unknown | 未记录 |
| Gitroot | unknown | 未记录；originRoot 与子目录 cwd 不一致是候选机制 2，未证实 |
| worktree 是否派发 | unknown | 用户字符串不含；需该次工具入参 `worktree`/`cwd` 字段投影 |
| 报错会话实际加载版本 | unknown | 仅 static：计划基线 Pi `1.0.4`、pi-subagents `0.75.0`（bug 文档/remaining baseline）；实际加载与 session_start 结果未核实 |
| ping payload / 上游 session 块 | unknown | 候选机制 1 所需证据，未取得 |

## owner 与证据缺口

- **ownerComponent**：`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:assertSpawnCapabilities`（extension.ts:270）。
- **ownerScope**：repo-code-contains-assertion、production 根因未证实（`unconfirmed`）。owner 只说明断言在此产生，不说明六个子条件中哪个失败、更不说明上游为何给出不满足的回包。
- **证据缺口**：缺该会话字段级启动 metadata（ping 回包 session 块投影、启动首个异常、cwd/Gitroot/worktree/version/身份投影），无法区分六个子条件与三个候选机制，也无法证明 production reachability。

## blocked-evidence：最小取证清单（仅向用户申请字段，不催要凭据）

1. 该次 typed subagent 工具结果的完整 text（含 code 与 missing 列表）及结构化 details 投影（如 TUI 保存了 details）。
2. 该次派发入参投影：`worktree`/`cwd` 字段值（不需要 task 正文）。
3. 报错会话主会话启动 cwd 与 Git root 的路径字符串。
4. 报错会话实际加载的 pi / pi-subagents 版本（session_start 或包版本投影）。
5. 该次 toolCallId/runId 与启动首个异常的日志行（若存在；不含任务正文与凭据）。
6. 上游 ping 回包 session 块投影：sessionId/cwd/sessionFile 三者有无即可，不需要值本身。

**不需要也不读取**：完整 session、authority、凭据/token、`.state`、真实 settings/models/auth、完整日志正文。

## 无现场样本处置

- 本轮零新样本（未发真实 RPC/Host/provider/网络，未读真实 session），故 **blocked-evidence 成立**：静态事实不冒充个案，不进入 production 修复。
- 生产不改：`assertSpawnCapabilities` 保持 fail-closed，无 fallback、无门禁放宽；本任务 WritePaths 仅本 record。
- R2 后继（Deps=R1）只处置记录：Modify `docs/bugs/2026-10-10-rpc-session-capability-negotiation.md` + Create `docs/plans/records/2026-10-13-rpc-disposition.md`，不在其中修代码。

## 本轮验证（非真实 RPC）

- Markdown 写入指定路径 `docs/plans/records/2026-10-13-rpc-provenance.md`（路径审计通过）。
- `git diff --check` 通过；未 stage/commit/reset/stash；现有 dirty 现场（3 tracked-modified + 2 untracked docs + remaining baseline）未触碰。
- 未运行 test/typecheck；未发任何真实网络/Host/RPC 请求。

## 与历史记录的增量关系

承接 `rpc-provenance.json`（2026-10-11）与 bug 文档，不推翻其结论。本轮新增增量：六子条件逐条列举与行号证据、catch 路径 details 仅含 `{ code }` 的静态推定、coding/generic 双路径 throw 时 `trace.stage` 差异、rpc-client.ts 文案区分的行级证据、字段 known/unknown 投影表与最小取证清单。历史 T0–T11 不重跑。
