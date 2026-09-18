# 2026-09-18 var/workspaces 历史遗留清理记录（用户批准）

## 决策与授权

用户于 2026-09-18 批准处置方案 A（清理历史遗留 record，连带遗留 worktree 引用）。依据 V2-only 迁移决策「发现旧 v1 record 时 fail closed，由人工清理失败现场」执行。

## 清理范围与安全核查

`var/workspaces/repositories/`（gitignore 的本地运行时数据，268MB/14752 文件）全部 16 个分区均为 2026-09-06 至 09-15 的历史遗留：

- 16 个 workspace record 缺 V2 字段（terminalProof/publishedArtifact/integrationHistory 等），触发 doctor `[error] managed workspace record schema is invalid`（fail closed 属预期）。
- 11 个遗留 worktree 的宿主归属与内容核查：
  - 7 个 HEAD 已在宿主历史（uniapi、mtl-cli、pi-config×2、ai-native-deilvery×2、crash-analyzer）：无丢失。
  - 3 个（new-api-account-pool，HEAD=e109284）：commit 已在宿主 `backup/pre-node-qoder-split-20260913` 分支：无丢失。
  - 1 个（8a090d81，host=project）无 HEAD（空 worktree）：无内容。
  - 2 个有未跟踪文件的 worktree：
    - 3219a21f（uniapi）：仅 `.pi/` 运行时目录（LEGACY_PATHS 排除项）：无价值。
    - 201acd22（crash-analyzer-agent）：`tests/test_tool_call_dispatch.py`（347 行）与 `tests/test_tool_call_errors.py`（408 行）为 09-14 17:37 的旧版中间产物；宿主同名文件 21:01 更新且在 git 历史（a816dbf）演进：worktree 版为过期草稿，无丢失。
- 同目录的 terminal-proof-outbox、coordinator metadata 等运行时文件同属历史现场。

## 清理动作

删除 `var/workspaces/repositories/` 下全部 16 个历史分区（含 records/worktrees/outbox）。清理后 doctor 的 `inspectWorktreeLifecycle` 应不再遇到旧 schema record。

## 不涉及

本轮（09-17/18）所有测试与真实验收均在 tmpdir 隔离 stateRoot 运行；真实验收现场（tu6cnL、vt9Uj4 等）位于系统 tmpdir，不受本次清理影响。

## 附：全量 npm test 分类（2026-09-18，唯一一次）

879 测试，876 通过，3 个既有失败（经干净 HEAD worktree 对照验证均在本 durable-fifo 计划开始前已失败，非本会话回归）：

1. `init-pi.sh reproducibly installs Pi`：`skill-overrides/external-llm-review/` 整目录于 2026-09-14 被工作区删除（外部 review provider 迁移），`test/init-pi.test.mjs` 仍 copyFile 其文件——测试与目录迁移未同步。
2. `loads exactly one enhanced runtime`：upstream pi-subagents intercom 的 native `subagent_supervisor` 工具在 session_start 延迟注册，覆盖我们注册的同名 supervisorTool（Pi registerTool 后注册覆盖前者），`SUPERVISOR_TARGET_UNAVAILABLE` 断言失效。需要上游语义决策（工具名冲突仲裁），非本计划范围。
3. `production Pi does not expose spawn_process`：`pi/extensions/openai-codex-proxy.ts`（0.85.1 升级轮未提交改动）的 `hostPackageEntry("undici")` 用 createRequire 从进程 cwd 推断 root，测试进程（node --test）无 repo-local undici → 扩展加载失败。生产环境（pi bundle argv）不受影响。

本会话引入的 2 个失败已同步修复：`reviewer-agent.test.mjs`（reviewer/executor profile 本会话新增 fallback models 断言）、`subagent-runtime-root-upstream.test.mjs`（fake service 补 `recordTerminalProof`）。

### 附注（2026-09-18 第二次更新）

- 失败 3（undici resolver）已按 TDD 修复：`pi/extensions/openai-codex-proxy.ts` 的 `hostPackageEntry` 改为三起点解析（进程推断 root → 模块自身 URL → 逐级向上 node_modules），测试进程不再依赖 argv 布局；RED/GREEN 见 `test/openai-codex-proxy-extension.test.mjs`（5/5）。
- 失败 1（init-pi / external-llm-review）确认为 2026-09-14 工作区删除 `skill-overrides/external-llm-review/` 的未收尾遗留：`init-pi.sh:104` 与 `test/init-pi.test.mjs` 仍引用已删目录，且无迁移目标。属外部 review provider 工作流的未完成变更，超出本计划（durable-fifo-resumed-child）范围，记录为既有债待该工作流收尾时处理。
- 失败 2（native supervisor 覆盖）确认为 upstream 工具注册顺序问题，需要工具名冲突仲裁的设计决策，超出本计划范围，保留既有债记录。

## 附：计划完成后 reviewer 审阅意见与处置（2026-09-18）

Reviewer（openai-codex/gpt-6-astra，run 9aff78e3）结论：需修复（非根本缺陷）。核心恢复链、四项不变量、状态机幂等、四个生产缺陷修复、既有债分类、资源清理、上游边界均复核通过。三项意见处置：

1. **高（pi/models.json、pi/settings.json 大幅未提交改动）**：归属核实——settings.json 最后写入 9/14 14:17、models.json 9/17 00:02，均早于本计划首个产物（9/17 17:07），为继承的 0.85.1 升级轮与本机 provider 配置改动，非本计划写入；models.json 本机定义按仓库规则经 skip-worktree 不提交。以归属澄清结案。
2. **中（coordinator registry 遗留 .lock 仅按 30s TTL 回收，活跃慢 claim 可能被误删）**：确认属实并 TDD 修复。lock 现写入 owner `{pid, birthIdentity}`；回收仅限确认 owner 死亡（pid 不可用或 birth 不匹配），活跃 owner 的 lock 不受 wall-clock 年龄影响；无 owner 数据的旧格式 lock 保留 TTL 兜底。RED→GREEN：`test/coordinator-registry-lock.test.mjs` 5/5（含慢 claim 超龄不回收、死 PID 回收、PID 复用回收、旧格式 TTL 兜底与 TTL 内不回收）；回归 multi-root-session/coordinator/repository-identity 18/18；typecheck 通过。
3. **中（resume_activation 统计高估：failed intent 计入 activation）**：确认属实并 TDD 修复。`collectAcceptanceRecoveryEvidence` 的 `resume_activation` 改为仅统计 `activated`/`completed`（failed 无法证明 recovery.activate-resume 完成）。RED→GREEN：`test/repository-merge-queue-acceptance-probe.test.mjs` 43/43。注：修复后口径下五 child ACCEPTED 现场（vt9Uj4）的 resume_activation 实值为 4（7 个 intent 中 4 个 completed）——验收结论不变（settlement 判定依据的是最新 intent completed，而非该统计）。
