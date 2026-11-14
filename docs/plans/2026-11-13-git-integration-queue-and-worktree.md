# 独立 Git Durable FIFO Queue 与 Pi Worktree 接入计划

## 目标

使用上游 `pi-subagents` 的 `worktree: true` 能力，增加一个独立的、repository-scoped 的 Git Durable FIFO Queue。Queue 只处理显式提交的 Git 集成请求，不管理 subagent、Pi session 或 worktree 生命周期。由于上游 clean handoff 会回收 worktree/branch 且 manifest 不稳定地提供最终 commit hash，queue 第一阶段同时支持已验证 commit 和已验证 handoff patch 两种 Git 输入。

完成后：

- `subagent_spawn` 支持可选 `worktree: boolean` 并原样透传给上游；
- 主 agent 可以用 `bash` 检查、修改、测试和 commit 保留的 worktree；
- 主 agent 通过专用 queue tool 提交已验证的 clean commit；
- queue 对同一 Git repository 的受管集成提供 durable FIFO、幂等、单写临界区和 fail-closed 保护；
- subagent 结束时由机械 adapter 判定 `NO_CHANGE`、`ENQUEUE`、`PRESERVE` 或 `FAIL_CLOSED`；
- `PRESERVE` / `FAIL_CLOSED` 回执包含 worktree、Git 状态、原因码和建议动作；
- 不恢复旧 `pi-subagents-enhanced` 的 workspace/coordinator/subagent 生命周期绑定系统。

## 当前前置问题

执行 queue 计划前先修复两个已观察到的 TUI 问题：

1. `subagent-notify` 的 completion receipt 从 `details.runs` 恢复任务标题；当前只读取 `taskInfo/title/task` 的逻辑在真实回执中可能取不到标题，导致显示“未命名任务”。需要核对上游 completion details 的实际字段，恢复原始 spawn title，并在找不到时保留可诊断的 fallback。
2. footer 当前只在交互切换时刷新。subagent completion、状态变化和 queue 相关状态更新时必须主动调用 `tui.requestRender()`，使 footer 不依赖 `Alt+O` 等偶然交互刷新。
3. 所有 subagent 控制工具的 verbose tool result 必须统一收敛。`subagent_resume` 当前会把 `Revived async subagent`、Session、Async dir、Intercom target 和 polling guidance 等上游正文刷到 compact tool 行下方；`subagent_spawn/status/steer/stop/resume` 折叠态只保留标准 compact 行，详细结果保留给模型和结构化 payload，不在 TUI 中重复渲染。

## 边界

### 保留

- repository-scoped durable FIFO queue；
- requestId 幂等；
- queue revision/lease；
- 单 repository 单 active integration；
- target HEAD、branch、index、worktree 和 sequencer 校验；
- target 漂移、身份不匹配、状态不确定时 fail closed；
- queue 重启恢复；
- conflict evidence 和确定性审计排序。

### 不做

- subagent 自己调用 queue；
- queue 创建、删除或拥有 worktree；
- queue 管理 child resume/steer/stop/terminal proof；
- 自动 stash、reset、覆盖或删除 dirty worktree；
- 自动解决语义冲突；
- 阻止 queue 外的任意 Git 操作；
- 恢复旧 workspace/coordinator 全量实现。

## 任务 DAG

### T0：修复现有 subagent receipt 与 footer 刷新

**依赖：** 无。

**文件：**

- `src/subagent/renderer.ts`
- `src/tui-lite/index.ts`
- `src/subagent/index.ts`
- 相关既有 runtime/renderer 测试

**内容：**

- 根据真实 `subagent-notify.details.runs` 字段恢复 spawn title；
- 保持多 run completion 的 title 与 runId 对应；
- completion、状态变化和 queue 相关事件触发 footer 重绘；
- 不通过用户交互或轮询刷新状态；
- 不改变模型收到的 message、tool result 或结构化 details。

**验收：**

- 真实 completion receipt 不再显示“未命名任务”；
- run 完成后 footer 自动从 active 列表移除；
- 不需要 `Alt+O` 切换或其他交互触发刷新。

### T1：确认上游 worktree handoff 契约

**依赖：** T0。

已核对 `pi-subagents` 当前版本在 child 结束和 worktree cleanup 前提供的事实：

- worktree path；
- base commit；
- branch/ref；
- direct async worktree 会在 `asyncDir/parallel-handoff.json` 写入 `repoRoot`、`baseCommit`、`patch.path`、`patch.branch`、`patch.changed` 和 cleanup task；
- clean 且 handoff patch 可验证的 worktree 会被 upstream 回收；
- dirty、patch 无法验证或 cleanup proof 不完整的 worktree 会被 upstream 保留；
- completion details 会携带 `handoffPath`，但不保证提供最终 commit hash。

**停止条件：** 如果上游不再提供可验证的 handoff manifest/patch，或 completion 时 handoff 已不可读，则停止自动集成实现，先报告生命周期阻塞。adapter 不能等待已经被 upstream 回收的 worktree，也不能把 branch 名当作 commit 身份。

### T2：抽取 Git repository identity 与状态探针

**依赖：** T1。

**建议路径：**

```text
src/git-integration-queue/repository.ts
src/git-integration-queue/records.ts
```

**内容：**

- 通过 canonical Git common-dir 计算 repository identity；
- 识别 repository root、target ref、当前 HEAD；
- 检查 tracked/staged/untracked/deleted/renamed 状态；
- 检查 sequencer/rebase 状态；
- 检查 base 与 HEAD 的祖先关系；
- 不接受调用方伪造 identity/base/head 事实。

### T3：实现独立 Durable FIFO Queue

**依赖：** T2。

**建议路径：**

```text
src/git-integration-queue/queue.ts
src/git-integration-queue/ledger.ts
src/git-integration-queue/records.ts
src/git-integration-queue/daemon.ts
src/git-integration-queue/client.ts
```

queue 接收 Git 事实或经校验的 handoff artifact，不接收 subagent/session 绑定：

```ts
enqueue({
  repositoryRoot,
  targetRef,
  source: {
    kind: "commit" | "handoff-patch",
    commit?,
    patchPath?,
    baseCommit?,
    handoffPath?,
  },
  requestId,
  metadata,
})
```

状态：

```text
queued → admitted → integrating → completed
                              ↘ preserved/conflict
```

第一阶段优先支持已验证 source commit 的 fast-forward；对 upstream handoff patch，queue 在自己的受控临时 Git 集成环境中验证并应用 patch，再生成可审计的 candidate commit。source 不是当前 target 的安全后代、patch 无法验证或 target 漂移时，进入 preserved/conflict，不自动启动 agent 或解决语义冲突。

### T4：提供三个最小 Pi 专用 tool

**依赖：** T3。

只提供：

```text
git_queue_inspect
git_queue_status
git_queue_enqueue
```

`inspect` 只读 worktree/repository/queue eligibility；`status` 读取 repository queue；`enqueue` 接收 adapter 验证过的 commit 或 handoff manifest，只允许 clean 且可验证的输入进入 queue。handoff patch 必须绑定 `repoRoot`、`baseCommit`、patch path、cleanup evidence 和 immutable digest。

不提供 `git_worktree_commit`、`git_worktree_add`、`git_worktree_remove` 或 force merge tool。主 agent 在 worktree 内的修复、测试和 commit 使用 `bash`，但目标分支集成必须经过 queue tool。

### T5：实现 completion 机械判定 adapter

**依赖：** T1、T2、T4。

判定矩阵（基于 upstream handoff manifest）：

```text
patch.changed == false + worktreeRemoved == true
  → NO_CHANGE
patch.changed == true + worktreeRemoved == true + patch 可验证
  → ENQUEUE（handoff-patch）
cleanup task preserved/未回收或 patch 无法验证
  → PRESERVE
manifest、repoRoot、baseCommit、cleanup 或 digest 无法确认
  → FAIL_CLOSED
```

`NO_CHANGE` 和 `ENQUEUE` 自动处理；`PRESERVE` 与 `FAIL_CLOSED` 保留现场并要求主 agent 介入。禁止自动 stash、reset、覆盖和删除。`ENQUEUE` 可以提交 source commit，也可以提交 upstream handoff patch；queue 不删除 worktree，upstream 已经完成的 cleanup 事实只作为输入证据。

### T6：统一结构化 integration receipt

**依赖：** T5。

```ts
type WorktreeIntegrationReceipt = {
  kind: "git-worktree-integration";
  outcome: "no-change" | "enqueued" | "preserved" | "failed-closed";
  repositoryRoot: string;
  worktreePath: string;
  targetRef?: string;
  baseCommit?: string;
  headCommit?: string;
  clean?: boolean;
  changedFiles?: string[];
  queueRequestId?: string;
  reasonCode?: string;
  reason?: string;
  requiresOperator: boolean;
  suggestedAction?: string;
};
```

`content` 提供简洁 TUI/模型摘要，`details` 保留完整机器事实。`PRESERVE` / `FAIL_CLOSED` 至少包含 worktree path、reasonCode、reason 和 suggestedAction。

### T7：恢复与冲突边界

**依赖：** T3、T5。

- daemon 重启恢复 queued/admitted/integrating；
- lease 失效时安全恢复或 preserve；
- target 漂移进入 preserved/conflict；
- dirty worktree 保留现场；
- 不实现无限自动重试；
- 主 agent 可用 bash 解决冲突，再通过 inspect/enqueue 继续。

### T8：验证与迁移

**依赖：** T0–T7。

验证只使用临时 Git repository、临时 worktree、临时 state root 和临时 socket，不触碰用户现有 worktree。

既有回归命令：

```bash
npm run typecheck && \
node --test test/pi-runtime.integration.mjs test/bash-async.test.mjs \
  test/compact-tools-renderer.test.mjs test/compact-tools-extension.test.mjs && \
git1 diff --check
```

queue FIFO 并发、幂等、重启恢复、target 漂移、四状态判定、dirty 保留等新增测试和全新 fixture 需要单独授权后创建；未授权前只使用现有测试和临时验证脚本。

## 完成契约

- **F1 AUTO：** `subagent_spawn` 暴露并透传可选 `worktree`；由 `node --test test/pi-runtime.integration.mjs` 验证。
- **F2 AUTO：** receipt 正确恢复 title，footer 在 completion/status 事件后自动刷新；由既有 runtime/TUI 验证和人工启动 smoke 验证。
- **F3 AUTO：** queue 按 canonical common-dir 分区，具备 durable FIFO、幂等和单 active integration；由授权后的 queue contract 命令验证。
- **F4 AUTO：** Git identity、clean、祖先关系和 target HEAD 漂移门禁 fail closed；由授权后的 Git facts/queue acceptance 命令验证。
- **F5 AUTO：** `NO_CHANGE/ENQUEUE/PRESERVE/FAIL_CLOSED` 判定符合矩阵；由授权后的 classifier contract 命令验证。
- **F6 MANUAL：** 主 agent 能在 `PRESERVE/FAIL_CLOSED` 后使用 bash 修复并通过 `git_queue_enqueue` 继续；操作者按回执步骤验证。
- **F7 MANUAL：** 多个 Pi session 和多个 upstream worktree 能共享同一 repository queue；操作者执行多客户端 smoke 验证。
- **F8 AUTO：** 既有回归命令全部通过；统一命令见 T8。

停滞判据：同一 F 项连续两轮验证输出无实质变化时停止修改，记录证据、阻塞原因和下一步恢复动作。

## 执行模式

执行前由用户选择：

1. **subagent 并发驱动**：更快，但需要处理 worktree、合并和冲突；
2. **主会话串行执行**：上下文连续、合并风险低，但执行时间更长。

计划审阅完成后再选择执行模式；在选择前不开始实现。

## 计划审阅记录

自动审阅未完成：审阅子会话因无可用模型账号退出，未产生技术意见。主会话 inline 复核确认：

- queue 与 subagent/worktree 生命周期边界已分离；
- `PRESERVE` / `FAIL_CLOSED` 的主 agent 介入路径已明确；
- queue 只对显式 enqueue 的 Git 集成负责，不宣称拦截 queue 外的任意 Git 操作；
- 上游 worktree handoff/cleanup 时机仍是 T1 的真实前置阻塞，未验证前禁止进入 T5；
- 新增 queue contract/fixture 测试仍需单独授权，未授权前不创建；
- 当前 bugfix 已独立提交，queue 新能力尚未开始实现。

在用户选择执行模式前，计划保持未执行状态。

## 执行进度

- T0：完成，已包含在 `955b9bc` bugfix commit；
- T1：完成。已确认 upstream direct async worktree 的 `parallel-handoff.json`、patch、cleanup task 和 `handoffPath` 契约；
- T2：完成 repository identity/Git facts 初版；
- T3：完成 durable FIFO queue、Unix socket daemon、requestId 幂等、commit fast-forward 与 handoff-patch candidate 集成初版；
- T4：完成 `git_queue_inspect`、`git_queue_status`、`git_queue_enqueue` deferred tools；
- T5：完成初版。subagent completion 的 `handoffPath` 会经过机械 classifier，eligible handoff patch 自动提交 repository daemon；
- T6：完成初版。integration receipt 通过独立 custom message 返回，原始 subagent completion 不被改写；
- T7：完成初版。daemon 重启时无法证明的 integrating item fail-closed 为 preserved；
- T8：自动验收完成；当前修复版 `npm run typecheck`、`npm test`（419 tests，418 passed，1 todo，0 failed）、`npm run test:all-integration`（61 tests，59 passed，2 skipped，0 failed）和 `git1 diff --check` 均通过。queue contract、daemon lease/protocol、source/handoff 和 TUI 回归均包含在统一验收中。

## F6/F7 手工 smoke 记录

- F6：通过（证据目录：`/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/pi-gq6-JIFKiK/evidence`）。保留态 receipt 为 `preserved/WORKTREE_PRESERVED`；主 agent 用 bash 在 source worktree commit，source/target 均恢复 clean；通过注册的 `git_queue_enqueue` tool 入队后 queue item 为 `completed`，target fast-forward，未重复集成。
- F6 修复版重跑：通过（证据目录：`/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/opencode/f6-fixed-Sq7Hwn/evidence`）。未设置 `PI_GIT_QUEUE_STATE_DIR` 或 `PI_GIT_QUEUE_SOCKET_DIR`，使用默认 state root 和生产 socket 派生；receipt 为 `preserved/WORKTREE_PRESERVED`，主 agent bash commit 后通过专用 enqueue tool 恢复，queue 为 `completed`，target/worktree clean，并记录 pi-config HEAD、target HEAD、真实 socket 和 lease 清理。
- F7 基础设施并发 smoke：通过（证据目录：`/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/pi-gq7-7oKjNy/evidence`）。两个独立 Pi RPC session 各自加载 queue extension 并产生不同 session ID；两个独立进程同时调用 enqueue，共享同一个 repository queue daemon，最终 sequence 1/2 均 `completed`，target clean，cleanup 后无残留 worktree。
- F7 端到端 subagent child：通过（真实 GLM-5.3）。证据目录：`/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/opencode/glm-queue-1UvKUJ`。两个独立 Pi RPC session 各调用一次 `subagent_spawn(worktree:true)`；child 分别在 upstream 独立 worktree 创建并提交 `session-a.txt`、`session-b.txt`，产生真实 `parallel-handoff`；两个 handoff 自动生成 `enqueued` receipt 并共享同一 `repositoryId`/daemon。queue sequence 1、2 均 `completed`，最终 `main` 包含两个文件、target clean，worktree 已由 upstream 回收。

## 计划终态

修复版 F1–F8 的 AUTO/MANUAL 必要条件均已满足；F6 默认路径重跑和 F7 真实 GLM evidence 均已落盘，当前实现、自动回归和真实 smoke 对应同一修复工作树版本。此文档的实现建议路径保留为历史计划描述；实际 feature-owned 实现位于 `src/git-integration-queue/`，符合当前 AGENTS 规则。
