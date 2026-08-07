# Bug：Goal integration 失败重试无法接受 origin 的安全快进

## 现象

`goal_integrate` 第一次调用时，如果 origin 工作区不干净，会先写入 `task.workspace_disposition_started`，随后报错 `Origin must be clean before integration`。用户将无关改动正常提交、使工作区恢复 clean 后，重试固定报错 `Origin HEAD mismatch before integration`，task 永久停留在 `workspace.phase=disposing`。

## 影响

- 已成功 settle 的 task 无法 integrate、release 或 accept；整个 Goal 被首个 disposing task 永久阻塞。
- 现有 typed tools 没有合法动作刷新已冻结的 `originHeadBefore`。
- 协调器只能诉诸 raw Git 或直接改 `.state` 才能绕过，破坏 Goal Engine 的审计与恢复边界。

## 根因

`goal_integrate` 的 active 分支在执行 origin clean/sequencer preflight **之前**就持久化 `task.workspace_disposition_started`，其中冻结当时的 `originHeadBefore`。`integrateExecutorWorkspace()` 在 retry 时要求当前 HEAD 与该值字节级相等。第一次失败后的正常 clean 操作如果通过新 commit 完成，origin 只发生安全快进，但 reducer 没有可审计的 baseline 重绑事件，workspace 层也不区分“同 ref 的安全快进”与“改写历史/切换 ref/脏工作区”。

## 触发条件

1. task 已 succeeded，workspace clean 且含可集成提交；
2. origin 工作区存在无关未提交改动；
3. 第一次 `goal_integrate` 写入 disposition-started 后因 origin dirty 失败；
4. 用户通过正常 commit 清理 origin，HEAD 成为旧 `originHeadBefore` 的后代；
5. 原样重试 `goal_integrate`。

## 修复方案

1. active integration 在持久化 disposition-started 前先执行只读 origin preflight，避免已知 dirty/sequencer/ref mismatch 形成不可执行状态。
2. 为既有 disposing 状态增加 `task.workspace_disposition_rebased` 事件；仅当 origin 同一 symbolic ref、工作区 clean、无 sequencer/rebase、旧 HEAD 是当前 HEAD 的祖先时，才把 baseline 从旧 HEAD 原子推进到当前 HEAD。
3. 非快进、detached/错 ref、dirty、sequencer、无法证明 ancestry 均 fail closed；不自动 reset、rebase、stash 或改写用户提交。
4. retry 在 durable rebase event 后按新 baseline 集成；事件保留 previous/current HEAD 供审计与 reload replay。

## 验证方法

- Extension 集成测试先复现 dirty 首次失败，再创建无关 clean commit，确认旧实现重试报 HEAD mismatch。
- GREEN 后确认产生唯一 rebase event、成功 integrate/release，并可 reload/replay。
- 覆盖非快进、错 ref、dirty、sequencer 与 ancestry probe failure，全部保持 disposing 且不写 rebase/applied event。
- 运行 Goal Engine workspace、events、extension 与真实 Host 相关回归。
