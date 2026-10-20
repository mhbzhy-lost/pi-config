# 非隔离 top-level RPC 兼容 lane 的失败归因

## 本轮实际执行

命令：`node --test test/pi-subagents-runtime.integration.mjs`（既有测试，未修改该文件），日志 `/tmp/rc-pi-subagents-runtime.log`，exit 1。

- `PI_REAL_BIN=/Users/leshi.zhy/pi-config/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`（环境变量已存在，指向本仓安装的 Host）。
- 结果：**5 tests / 3 pass / 2 fail**。通过项：generic child 无 Root Broker 时 required integration extension 为 no-op；coding Host 加载 child integration 工具与 prompt 且 generic 非 Git cwd 不启动 coordinator；installed runtime 解析到受支持 Pi 与精确依赖版本。
- 失败项 1：`top-level RPC compatibility waits for a completing executor without nested events`（1.17s）→ `compat_spawn failed: … "No active extension context for subagent RPC."`。
- 失败项 2：`top-level RPC compatibility observes attention, replies, and resumes the executor`（63.1s）→ `Pi RPC timed out after 60000ms`。

## 首个偏离点与来源

- 失败项 1 的错误文本来自**上游** `packages/pi-subagents-enhanced/node_modules/pi-subagents/src/extension/rpc.js:587`：`SubagentRpcError("no_active_session", …)`，即 fixture 的 `compat_spawn` 在没有活跃 upstream extension context 时调用 `rpc.spawn`。
- 本批未提交改动不覆盖该路径：`extensions/subagent-runtime.ts` 的 diff 只有 8 行，作用是在 `coordinatorRuntime?.client` 存在时用 `createCoordinatorDispositionFacade` 包装 `workspaceService`；`subagent-dispatch/extension.ts` 的 diff 只有 intent-id import、`CODING_ACCEPTANCE_EVIDENCE` 删除 `tests-added` 与两处 `intentId` 派生。
- `test/fixtures/deterministic-provider-state.mjs` 的本批改动对 legacy 分支是等价的：当 `toolNames` 不含 `supervisor_request_pending` 时，`pendingName`/`replyName` 仍为 `subagent_supervisor` 且参数仍带 `action`，与迁移前逐字一致；失败项 1 在 supervisor 决策之前就已失败，与该 fixture 无关。

## 历史对照（同一 lane 的既有结论）

`docs/plans/records/2026-09-23-runtime-remediation/E-PI-ISOLATION.md` 已记录：

- **隔离**版 top-level RPC lane（临时 origin/cwd/state/agent/HOME/XDG/TMP/session 全绑定）曾 exit 0（约 2.35 秒）。
- **非隔离** attention lane 45 秒超时，被明确归类为“可终止性/环境证据，不是 production 缺陷结论”，并要求保持 blocked、不运行；同时写明“不得通过更长 timeout、删除 live 目录或 fallback 到仓库 cwd 来修复”。
- 残余风险已列出 Host 对 state root 的隐藏 fallback 与 broker socket 路径派生。

当前文件里已不存在隔离版用例，只剩两个直接对仓库 live state 启动真实 Host 的 lane，与上述“环境受限”结论一致。

## 分类

按缺陷数据来源门禁归为 **类别 3：来源尚未证实（环境受限）**：

- 不能证明这是本批或当前 production 的可达缺陷（错误源自上游 RPC context 判定，且历史同 lane 已被判为环境证据）；
- 也不能证明它只是 fixture 污染（lane 确实启动真实 Host 并使用仓库 live state）。

因此 fail closed：不延长 timeout、不隔离/删除 live 目录、不为本 lane 增加生产 fallback、不修改上游 `node_modules`、不重复运行该 lane。

## 现场副作用（如实记录，未读取正文）

运行该 lane 期间/之后 `var/` 下出现以下 mtime 变化；`var/` 与 `.pi/` 未被 git 跟踪（除既有两个 dirty 文件），未删除或修改任何文件，也未读取 session 正文：

- `var/workspaces/supervisor-control/supervisor-{69b34b0c…,80fe379c…,82cb4676…}.json`（14:54:36、15:01:00、15:04:55）。
- `var/sessions/subagent-artifacts/.last-cleanup`（14:55:18）。
- 既有旧 session 文件 mtime：`2026-09-30T08-21-58-899Z_01a0f167…jsonl` 与其 `run-0/session.jsonl`（15:09:14）、`2026-10-16T09-55-38-028Z_01a14423…` 的 `run-0/session.jsonl`（15:09:20）、`2026-10-17T04-49-51-175Z_01a14831…jsonl`（15:09:51）。这些写入发生在 lane 退出（15:05:55）之后，`ps` 未发现残留的 `pi-coding-agent/dist/cli` 或 deterministic provider 进程，成因未确证；只记录 mtime 事实，不推断内容变化。

## 解阻条件

需要隔离 lane（临时 origin/cwd/state/HOME/XDG/session 全绑定）重新落地，或取得同次 Host 侧 extension context 激活证据（ upstream rpc context 的建立点、Host 版本、state root 解析结果），才能判定是上游兼容面缺口还是环境问题。在此之前该 lane 保持 `blocked-evidence/environment`，不计入本批通过项，也不重复运行。
