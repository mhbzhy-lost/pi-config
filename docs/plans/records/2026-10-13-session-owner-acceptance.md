# S1v：受控 session owner 入口回归验收记录

- taskId：`dispatch-db601d21`（计划节点 `S1v`，Deps：S1a→S1b）
- 基线：HEAD `a9875d62a75a0d5ee2893646ea5a96e89bbf8e27`，现场物理 SDK `@earendil-works/pi-coding-agent@1.0.4`，Node `v26.8.1`，macOS `27.0.1`
- 本任务写路径：`test/session-owner-runtime.integration.mjs`、本文。**未修改任何 production 源码**（`src/session-owner/{lifecycle,extension,registry}.ts` 保持 S1b 交付原样）。
- 终态：`verified`（仅指本记录实际运行的证据）；PTY/真实 CLI 与真实用户 Host 条款为 `blocked-environment`，不计为功能完成。

## 1. 静态核对：S1b 新事务 vs 现场 SDK 调用顺序

只读核对 `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session-runtime.js`、`agent-session.js`、`session-manager.js`、`session-cwd.js`、`utils/paths.js` 与 `src/session-owner/lifecycle.ts` 的调用点，逐条对齐 S1g 冻结合同：

| 核对项 | 现场 SDK 事实 | lifecycle 实现 | 结论 |
|---|---|---|---|
| resume 首个目标访问 | `switchSession`：`emitBeforeSwitch("resume", sessionPath)` → cancelled 即 return → `SessionManager.open` → `assertSessionCwdExists` → `teardownCurrent` → `createRuntime` | `beforeSwitch` 只做有界 header 验证 + `reserveSwitchTarget`，不调 `open` | 一致：claim 严格早于 open/teardown |
| teardown 顺序 | `session.abort()` → shutdown handlers → `beforeSessionInvalidate` → `session.dispose()` | `shutdown(resume)` 仅 `updateOwnRecord` 改 `transitioning`，省略 pending/receipt 字段 | 一致：shutdown 不提前 claim，也不清 pending |
| resume 提交 | 新 runtime 的 `session_start{reason:"resume", previousSessionFile}` 在 `bindExtensions` 内 emit | `start` 从持久 record 取 receipt 重建 plain token，交 `commitSwitchTarget` 同 guard 重校验 | 一致：事件不带 nonce |
| new/fork | `emitBeforeSwitch("new")` 不带 target；`emitBeforeFork(entryId,{position})` 只有 entryId | `beforeSwitch(new)`/`beforeFork` 只核验 source 可用性与冲突，不 claim | 一致：新 ID 后置提交 |
| import | 先算 `destinationPath` → `emitBeforeSwitch("resume", destinationPath)` → 未存在时 destination 此刻尚无文件 → 之后才 `copyFileSync` → `open` | 目标 stat ENOENT → `unverifiable("blocked-upstream")` → 显式 cancel | 一致：外部 import 子路径 fail closed，不 copy/不猜 ID |
| reload | `session.reload()` 先 emit `session_shutdown{reason:"reload"}` 再 emit `session_start{reason:"reload"}` | `shutdown(reload)` 直接 return；`start(reload)` 走 `commitSwitchTarget(kind:"reload")` | 一致：reload 不释放、不清 pending |
| 结果 hook | SDK 不公开 switch 结果事件，method result 不广播给 extension | 无任何自动 `abortSwitchTarget` 调用点 | 一致：无自动 rollback 承诺 |
| 路径规范化 | `normalizePath`/`resolvePath`：不 trim、不替换 Unicode 空格，先展开 `~`，`file://` 走 `fileURLToPath`，相对路径按 `process.cwd()` | `resolveEventPath` 同规则；随后 `normalizeSessionPath`（realpath） | 一致；macOS 符号链根（`/var`→`/private/var`）在断言中显式取 canonical 形式 |

**未发现 production 源码与合同不符，也未发现类别 2 fixture 需要 production fallback。** 本文件既有的两个「内层失败」用例只使用 public getter 形态（`getCwd/getSessionId/getSessionFile` + `ui.notify` + `shutdown`）并注入 registry 异常，属合法 public 链，未改其断言、未加兼容代码。

## 2. 实际运行命令与真实计数

unit 窗口独占执行（显式命令，不用 `npm test`、不用 all-integration glob）：

| 命令 | exit | 真实计数 |
|---|---:|---|
| `node --test --test-name-pattern='^(waitForRecord\|real AgentSessionRuntime\|session_start \|session_before_switch \|owner-less)' test/session-owner-runtime.integration.mjs`（改动前基线） | 0 | 6 tests / 6 pass / 0 fail |
| `node --test --test-name-pattern='^(真实 SDK：)' test/session-owner-runtime.integration.mjs`（新增两用例） | 0 | 2 tests / 2 pass / 0 fail |
| `node --test --test-name-pattern='^(waitForRecord\|real AgentSessionRuntime\|真实 SDK：\|session_start \|session_before_switch \|owner-less)' test/session-owner-runtime.integration.mjs`（最终） | **0** | **8 tests / 8 pass / 0 fail / 0 cancelled / 0 skipped，duration ≈ 0.6s** |
| `git diff --check` | 0 | 无空白错误 |
| `git diff --cached --name-only`（wc -l） | 0 | 0（index 为空，未 stage） |

真实 SDK 的 in-process 用例不启动 PTY、不启动真实交互 Host、不读用户配置：`agentDir`/`sessionDir`/`registry` 全在 `mkdtemp` 临时根内，`createAgentSessionServices` 走 `resourceLoaderOptions` 的 `noSkills/noPromptTemplates/noThemes/noContextFiles` + 仅注入 `installSessionOwnerExtension`，`modelRuntime.refresh({allowNetwork:false})`，`auth.json/models.json` 指向临时 agentDir（无凭据、无 provider 网络、无付费请求）。

## 3. 目标矩阵覆盖归属（精确）

已在本记录 §2 实际运行验证（真实 SDK，非 fake）：

- **runtime resume 正常事务**：`real AgentSessionRuntime invokes new, resume, fork, import, reload, and factory failure lifecycles` — `switchSession` 返回 `{cancelled:false}` 且记录 `active`。
- **runtime new**：同用例，`newSession()` 后记录 `active`（新 ID 后置提交）。
- **runtime fork**：同用例，`fork(entryId)` 返回 `{cancelled:false, selectedText}` 且记录 `active`。
- **runtime import（输入已在 sessionDir 内）**：同用例，按普通 resume 完成，记录 `active`。
- **runtime reload**：同用例，`session.reload()` 后记录 `active`（reload 不释放）。
- **factory/replacement 失败**：同用例，`failReplacement` 下 `newSession()` rejects，记录停在 `transitioning`（不伪造 rollback）。
- **before 阶段被更晚 handler 取消 → 保旧 source**：同用例 `cancelResume` 分支，本次新增断言：记录 `active`、顶层三字段不变、`pendingSessionFile === realpath(target)`、`switchReservation.phase === "reserved"`、receipt.source 等于当前顶层身份、`aborts` 从未发生。
- **外部 import 缺 header → blocked**：新增 `真实 SDK：外部 import 的 destination 在 before 时尚无 header → blocked-upstream 取消且不复制` — `importFromJsonl` 返回 `{cancelled:true}`；记录仍 `active`、三字段不变、`pendingSessionFile === null`、无 reservation；`sessionDir` 目录清单不变（未发生 copy）。
- **runtime 双 owner 同目标 resume 竞争（同 PID 异 ownerId）**：新增 `真实 SDK：两个 owner 竞争同一 resume 目标 → 胜者原子提交，败者取消且不动自己记录` — 胜者 `{cancelled:false}`、顶层身份换成目标、pending 清空、receipt `committed`；败者 `{cancelled:true}` 且记录逐字段等于竞争前。
- **quit own-only**：同一新用例内 `loser.runtime.dispose()` 后 registry 只剩胜者记录（同 PID 不共享归属）。
- **受控入口 startup 矩阵（-c / -r / --session / --session-id / --fork）**：由既有 `test/session-owner-wrapper.test.mjs`（11 项，launcher prepare + fake Pi 决策，不 exec 真实 Pi）与 `test/session-owner-contract.test.mjs`（15 项，startup 形态/recent/精确 ID/prefix 歧义 fail closed）拥有；本窗口未重跑（S1b 交付时 `40/40` 为 contract+extension.integration 的真实测量）。

明确 blocked（不以 fake 或关闭记录冒充）：

1. **PTY / 实际 CLI 回归 6 项未运行**（`真实 Pi Expect PTY 落盘…`、`active recent blocks -c`、`-c pins exact free recent`、`--no-extensions cannot bypass`、`selecting picker blocks`、`SIGKILL owner cleaned by ESRCH`）。需要完全临时 HOME/session/state/无 provider 网络的独立 `visibleHost` 窗口授权；本任务只有 unit 窗口，故未运行，也不声称启动过任何真实 Host 或用户 session。
2. **跨进程真并发同目标 race** 不可由受控公开 API 制造：新用例覆盖的是「序列化两阶段竞争（胜者已 claim/提交，败者 before 阶段被身份冲突取消）+ 同 PID 异 owner 冲突」；registry 层的 guard 内原子双 owner 争抢仍由 S1a `test/session-owner-registry.test.mjs` 覆盖，本窗口未重跑该文件。全局互斥不在此宣称。
3. **真实 `SessionManager.open` 失败（reserve 之后 open 抛错）无法用公开 API 构造**：凡能通过 16KiB 有界 header 门（type/id/cwd 齐备且 cwd 可 canonicalize 为既存目录）的既存 regular file，`open` 必成功；会令 `open` 失败的形状（空文件、非法 JSON、缺字段、超 1MiB header）都在更早的有界门就被 `target-unverifiable` 取消，reserve 尚未发生。因此该条款只有 S1b `test/session-owner-extension.integration.mjs` 的事件级证据（`open 失败保留 active source+pending…`），在真实 SDK 层记 `blocked-evidence`，不伪造通过。
4. **EPERM/坏记录 fail closed 与陈旧 `.guard` 人工处置**：属 registry 层证据（`reserve只清理ESRCH记录，存活或EPERM的外部PID记录保留并继续冲突` 等），本窗口未重跑；真实进程 ESRCH 清理路径依赖上表第 1 项 PTY 用例，故为 blocked-environment。

## 4. fixture 与数据来源分类

- 类别 1（合法 public 链）：新增/修改断言全部使用 SDK 公开导出 `createAgentSessionServices`/`createAgentSessionFromServices`/`createAgentSessionRuntime`/`SessionManager.create/open`/`runtime.switchSession|newSession|fork|importFromJsonl|dispose`/`session.reload()` 与 registry 公开 API。
- 类别 2（fixture 形状不合法）：本次未新增任何 production fallback；新用例改为自生成合法 `SessionManager` 会话文件（真实 header 由 Pi 自己写入）而非手拼缺文件路径。macOS 符号链根差异以 `realpath` 显式对齐，不改 registry 严格三字段比较语义。
- 未读取真实 settings/models/auth/credential/authority/`.state`/完整 session 正文；未新增网络或通知；未 kill 任何非 fixture 进程；未 stage/commit/stash/reset。

## 5. 残余风险

- S1v 的 PTY/真实 CLI 与真实用户 Host 条款尚未运行，因此「受控启动矩阵在真实 wrapper 下仍成立」只能引用历史证据，不能引用本记录；`Z` 收口时须按 `blocked-environment` 记账。
- 外部 import 子路径仍是产品级 `blocked-upstream`（上游缺公开输入路径/header/可信 identity），本记录只验证 fail closed，不验证成功导入。
- 双 owner 竞争用例覆盖串行 claim/commit；真并发只能靠 registry guard 原子性保证，其证据在 S1a 文件而非本窗口。
- `cwdOverride` 与保留 target cwd 不一致的 commit 拒绝路径只有事件级证据（S1b），真实 SDK 层未新增（`switchSession` 的 `cwdOverride` 不改变 before 事件字段，故无新增可验证面）。
- 新用例依赖 `mkdtemp` 根的 canonical 路径；若 session 目录后续被符号链化，record 与运行时身份可能按既有合同 fail closed（docs/session-owner.md 已列该限制），本记录不宣称已消除。
