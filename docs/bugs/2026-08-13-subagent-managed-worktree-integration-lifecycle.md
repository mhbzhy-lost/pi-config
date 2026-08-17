# Subagent 受管 worktree 集成回主干时 integrate 失效，被迫手动 git merge + 手动清理

## 一句话描述

并行派发 `execution.worktree:true` 的 coding 子代理后，各 worktree 完成工作无法经 typed `workspace_disposition(integrate)` 合回主干，最终只能显式授权 `git merge --ff-only` 合入，再逐字授权清理 6 个 `preserved` worktree。

## 复现流程

1. 在项目仓库（如 `crash-analyzer-agent`）并行派发多个 `subagent`，`execution.worktree:true`，各 worktree 基于同一 `main` commit。
2. 子代理完成提交后，主 agent 调用 `workspace_status`，期望看到 `action_token` 与 `allowed_dispositions` 含 `integrate`。
3. 观察 `workspace_status` 只返回 `Workspace <id>: active` 文本，`action_token`/`allowed_dispositions` 对模型不可见（`details` 被工具渲染层丢弃）。
4. 期间 `main` 上落任意直接提交（或先集成另一个并行 worktree），origin HEAD 前进。
5. 即使从原始 JSONL 挖出 `details`，`allowed_dispositions` 也只有 `preserve/discard`，没有 `integrate`。
6. 把目录型 `writePaths`（不带 `/**`）里的改动全部被判为越界，`integrate` 被静默移出允许列表。
7. 主 agent 只能 `preserve` 全部 worktree，新建 transport worktree 反复搬运 commit；最后用户授权 `git merge --ff-only refs/heads/subagent/<id>` 合入。
8. 合入后 6 个 worktree 仍以 `preserved` 注册，需用户逐字授权"清理这 6 个 preserved worktree"，再手工执行 `preserved -> reclaimable -> released` 两步释放。

## 根因（6 条，互相叠加）

### ① integrate 被「origin 原地冻结」门禁卡死（核心）

- 位置：`scripts/lib/subagent-dispatch/workspace-controller.mjs` 的 `statusManagedSubagentWorkspace`（`snapshot.originHead === lease.record.originHeadAtAllocation` 才 `allowed.push("integrate")`），以及 `scripts/lib/subagent-dispatch/workspace.mjs` 的 `integrateSubagentWorkspace`（`state.originHead !== lease.originHeadAtAllocation` 抛 `WORKTREE_ORIGIN_DRIFT`）。
- 根因：subagent 路径没有复用 goal engine 已有的「origin 干净前进容忍」能力 `inspectOriginIntegrationBaseline({ allowForwardAdvance: true })`（goal engine 的 `disposing` 阶段在用），而是手写了一条更严的硬门禁。并行 worktree 逐个合入必然使 origin 前进，任何第二个合入都失格。

### ② writePaths 目录语义是隐形地雷

- 位置：`scripts/lib/goal-engine/workspace.mjs` 的 `describeWritePath` / `matchesWritePath`（共享原语，goal engine 与 subagent 双 import）。
- 根因：不带 `/**` 的目录路径被当成 `{ type: "file" }`，仅 `changedFile === path` 精确相等才匹配，目录下所有改动被判越界，`integrate` 被移出允许列表。IR schema 与 SKILL 均未提示 `/**` 语义。

### ③ integrate 被拒原因被静默吞掉

- 位置：`scripts/lib/subagent-dispatch/workspace-controller.mjs:34` 的 `try { assertWorkspaceChangesWithinPaths(...); allowed.push("integrate"); } catch {}`。
- 根因：写路径校验失败时错误被 `catch {}` 丢弃，主 agent 无法知道 integrate 被拒的具体原因，只能读源码逆向推断。

### ④ 续作 run 无法重绑 terminal proof

- 位置：`scripts/lib/subagent-dispatch/workspace-ledger.mjs` 的 `bindWorkspaceRun`（`record.runId !== null` 即拒绝），`extension.ts` 仅在首次 spawn 时 bind 一次。
- 根因：向已存在 worktree 续派 executor（`execution.cwd` 指向原 worktree、不设 `worktree`）时，新 run 不绑定 ledger，`terminalProof` 仍反映首个（可能失败的）run，导致 integrate 被拒。

### ⑤ 工具结果 `details` 对模型不可见

- 位置：`scripts/lib/subagent-dispatch/extension.ts` 的 `executeWorkspaceAction` 返回 `details: workspacePublic(...)`（含 `action_token`/`allowed_dispositions`），但会话渲染只把 `content` 文本交给模型。
- 根因：模型看不到做 `workspace_disposition` 必需的一次性 token 与允许动作列表，只能 grep 原始 session JSONL。

### ⑥ preserved worktree 无法经 typed disposition 释放

- 位置：`workspace_disposition` 的 `disposition` 枚举只有 `integrate | preserve | discard`，`discard` 仅在 `active` 且 clean+observed 时可用；`preserved` 状态无 typed 出口。
- 根因：释放 `preserved` worktree 唯一路径是 pi-config 的 `scripts/worktree-lifecycle.mjs` CLI（不在项目仓库内），且需 `preserved -> reclaimable -> released` 两步，第一步 `markDisposition` 未暴露为 CLI 子命令。

## 修复方案（统一到共享原语，不 fork 路径）

1. **① 复用 goal engine 前进容忍**：subagent `integrate` 删除手写 `originHead === originHeadAtAllocation` 硬门禁，改调 `inspectOriginIntegrationBaseline({ originRef, originHeadBefore: originHeadAtAllocation, allowForwardAdvance: true })` 建立 baseline，再 `integrateExecutorWorkspace`。goal engine 顺序 `integrating` 阶段的 `allowForwardAdvance=false` 保持不变（是正确不变量）。
2. **② 修共享 writePath 语义**：`describeWritePath` 对目录型路径（结尾 `/` 或 `/**`）统一归一为目录前缀；不匹配时给出可操作错误而非静默越界。
3. **③ 暴露被拒原因**：`statusManagedSubagentWorkspace` 收集 integrate 被拒原因（origin drift / writePaths 越界 / dirty / 无 commits 等）到返回值的 `integrate_blocked_reasons`，供模型可见文本展示。
4. **④ 支持续作重绑**：`bindWorkspaceRun` 允许在 `state === "active"` 且旧 run terminal 已 observed 时重绑新 run（或新增显式 `rebind` 语义），使续作 run 的成功 proof 生效。
5. **⑤ 公开 action offer 进模型文本**：`workspace_status` 的返回 `content` 文本直接包含 `action_token`、`allowed_dispositions`、`integrate_blocked_reasons`，不依赖 `details`。
6. **⑥ 扩展 typed disposition 覆盖 preserved 释放**：新增 `workspace_disposition` 的 `disposition: "release"`（或复用 `discard` 覆盖 `preserved`），内部走 `markDisposition(preserved -> reclaimable)` + `releaseManagedWorktree` 两步，保持 owner-CAS 与「无 --force」。

## 影响范围

- 修改：`scripts/lib/goal-engine/workspace.mjs`（共享 writePath 语义）、`scripts/lib/subagent-dispatch/workspace-controller.mjs`、`scripts/lib/subagent-dispatch/workspace.mjs`、`scripts/lib/subagent-dispatch/workspace-ledger.mjs`、`scripts/lib/subagent-dispatch/extension.ts`、`skill-overrides/subagent-dispatch/SKILL.md`。
- 测试：`test/subagent-dispatch-workspace.test.mjs`、`test/subagent-workspace-controller.test.mjs`、`test/subagent-workspace-ledger.test.mjs`、`test/goal-engine-workspace.test.mjs`、`test/subagent-runtime-membrane.test.mjs`（或新增对应 RED）。
- goal engine 顺序集成不变量不变，不允许把 `integrating` 阶段的 `allowForwardAdvance` 放宽。
