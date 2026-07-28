# Plan Harness 真实 Smoke 在 Executor 绑定后阻塞

## 1. 现象

运行真实 Standalone Plan Runner smoke 时，Plan 成功创建 Attempt workspace，并通过官方 `pi-subagents` 绑定 Executor run；随后 Plan 在 `projectionVersion=5` 进入 `blocked`，未产生 `attempt.settled`、validation、integration 或 gate 结果。

## 2. 影响

Plan Runner Harness 无法满足“gate 到达终态且产物符合输入任务”的可用性标准。当前单元测试通过不能替代真实流程验收，Crash Fix V2 并行建设继续保持阻塞。

## 3. 稳定复现

```bash
PI_REAL_BIN="$(command -v pi)" \
PI_CODING_AGENT_DIR=/Users/leshi.zhy/pi-config/pi \
node --test /Users/leshi.zhy/pi-config/test/plan-parallel-harness.integration.mjs
```

## 4. 证据

首次复现约 8.7 秒后失败。derived status 显示：

- `lifecycle=blocked`
- `projectionVersion=5`
- Attempt `status=active`
- 已有 `runId` 和独立 Attempt workspace
- `resultCommit=null`
- gates 为空

这说明阻塞发生在 `attempt.bound` 之后、completion 收敛之前。首次测试清理了临时目录，下一次复现必须保留 Host status、Plan session、Executor status 和 Plan event 证据。

## 5. 根因

真实证据确认有两个独立根因：

1. smoke Host 使用 `noExtensions=false`，`pi-subagents` 已由 Pi package 自动加载，但测试又把同一路径加入 `extraExtensions`。两个 Runtime 实例分别响应 RPC/lifecycle/wait，导致RPC调用归属不确定；`subagent_wait`可落到未持有活动run的实例。Host现改为隔离模式，只显式加载官方RPC扩展和Plan Runner扩展。
2. 即使只加载一个Runtime，`pi-subagents@0.37.0`仍使用两种官方session标识：RPC `ping.session.sessionId`是Pi UUID，而lifecycle事件及`status.json.sessionId`是`sessionFile`路径（内部`resolveCurrentSessionId`优先session file）。Backend错误地把RPC UUID用于lifecycle/artifact fencing，因此稳定触发`LIFECYCLE_SESSION_MISMATCH`。Backend应同时校验两者，并以`sessionFile`作为durable lifecycle identity。
3. Host虽然拒绝`PI_SUBAGENT_CHILD`/`PI_SUBAGENT_FANOUT_CHILD`，但启动子进程时仍继承Root Parent进程的`PI_SUBAGENT_PARENT_SESSION`。官方Runtime因此把Standalone Host创建的Executor标为nested，并用继承route而不是Host自己的session归属background work；`subagent_wait`返回“没有活动run”，completion无法唤醒当前Plan循环。Host必须显式从子进程环境删除该变量，随后由自己的`session_start`建立session identity。
4. RPC spawn reply可能早于async `status.json`进入可枚举状态。第一次固定`subagent_wait`在runner启动前约16ms执行，初始集合为空后立即返回；紧接着的`plan_status`仍看到Attempt active，确定性Plan Runner却输出文本并结束。控制循环必须在active状态重复`pending -> bounded wait -> pending -> status`，不能把一次空wait当终态。
5. Executor完成后，官方Runtime在Attempt worktree写入`.pi-subagents/artifacts`。validator有意忽略该受控runtime目录，但`git worktree remove`仍把它视为未跟踪内容并拒绝cleanup，导致已集成Task被`workspace_cleanup_failed`阻塞。cleanup必须在owner/disposition/clean检查后确认该目录无tracked文件，只删除这一个受控目录，再执行非force worktree删除；其他脏文件继续拒绝。
6. 确定性 Executor 使用英文 commit subject，当前 `security-gates` 要求 subject 包含中文，bash 工具返回 `commit subject 必须包含中文`。子进程仍以模型正常停止收尾，因此官方 Executor 状态是 `complete`，但 worktree 没有可接受 commit。

Backend 对 session mismatch 的 fail-closed 行为本身正确，不应放宽。修复应去掉重复 Runtime 加载，并让确定性 fixture 使用符合仓库规范的提交信息。

## 6. 修复与回归标准

修复必须满足：

1. 真实 Executor completion 由官方 `status.json`收敛，不解析格式化文本；
2. Plan 依次完成 settle、validation、integration 和四道 gate；
3. Plan 终态为 `validated`，且 `validatedHead == headCommit`；
4. accumulator 的 `README.md` 精确为输入任务要求的 `base\nworker\n`；
5. 修复后重复运行真实 smoke 通过，并保留场景名、终态和 validatedHead 证据。
