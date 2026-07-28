# Plan Runner pi-subagents Parallel Harness

## 目标

Harness用于确定性执行已批准Plan，同时把计划权威、Executor运行事实和Git副作用分开。当前支持Pi `0.82.0`/`0.82.1`，精确锁定`pi-subagents@0.37.0`与`typebox@1.1.38`。

## 角色

| 角色 | 责任 | 禁止事项 |
|---|---|---|
| Root Parent | 启动/附着thin Host，处理durable Attention | 不保存DAG，不派发Executor，不判定validated |
| thin Host | 管理Standalone Plan Runner进程和v3 handle | 不写Plan event，不接受Executor task/cwd |
| Standalone Plan Runner | 重放Plan、授权frontier、处理Supervisor、触发Gate | 不调用`subagent`，不改批准契约 |
| Executor | 在单个Attempt worktree实现并提交结果 | 不改DAG/cwd/resources，不派发Agent，不写accumulator |

Executor派发只走官方`pi-subagents` RPC v1。Plan Runner使用真实session file作为lifecycle/artifact fencing identity；RPC返回的Pi UUID作为额外process-local identity，两者不能混用。

## 事实与目录

- Plan event：Standalone Plan Session中的`pi-plan-event-v1`，是领域恢复权威。
- Git：base/result/accumulator commit与diff hash，是文件副作用权威。
- Executor artifact：官方async目录中的`status.json`和`events.jsonl`，是运行权威。
- Derived status：`var/plan-runs/<planId>/status.json`，只用于观察，Plan目录0700、文件0600。
- Host handle：`var/plan-runs/<planId>/host-handle.json`，schema固定为v3；Host stdout/stderr/status均为0600。
- Attempt lease：`var/plan-runs/<planId>/attempts/<attemptId>/workspace.json`，权限0600。

`var/plan-runs`、`var/plan-worktrees`、session、transcript、token和`.env`不得进入Git。

## 仓库根绑定

launcher是`originRoot`（Git业务工作树）和`stateRoot`（Plan运行状态根）的唯一权威。thin Host通过`PI_PLAN_ORIGIN_ROOT`和`PI_PLAN_STATE_ROOT`把二者带外传给Standalone Plan Runner；这两个字段不进入模型提交的`plan_open` JSON，也不依赖模型复述。

绑定阶段必须同时证明：`originRoot`是Git top-level、它与Plan worktree共享同一个`git-common-dir`、Plan worktree严格位于`<stateRoot>/var/plan-worktrees/<planId>`。status、Attention、result和control只使用验证后的`stateRoot`。禁止对`git-common-dir`执行`dirname()`来猜业务根：普通仓返回`/repo/.git`，submodule返回父仓`.git/modules/<path>`，两者没有可共用的目录层级语义。

## 正常执行

1. Plan Document编译为冻结IR，校验DAG、allowed paths、资源容量和并发所有权。
2. 从Plan event重放active claim，按Plan顺序选择可运行frontier。
3. 每个授权Task分配独立Attempt worktree和owner token。
4. Coordinator持久化dispatch intent，再通过RPC一次派发所有授权root。
5. 使用`pending -> bounded wait -> pending -> status`收敛completion或Attention。
6. RPC runtime的`complete`只表示进程正常结束，不等于业务成功。Coordinator随后读取自己分配的唯一Attempt output；严格匹配Attempt/task、`status=blocked`、`commit=null`、空`changed_files`及合法blocker codes时，记录`attempt.settled(blocked)`并以`executor_blocked`阻塞Plan，不读取Git HEAD或进入commit验证。结果文件限64 KiB、拒绝symlink并收紧为0600；缺失、畸形或非blocked结果继续走成功提交验证，不能绕过门禁。
7. validator检查Git谱系、cleanliness、路径、symlink和受控命令证据。
8. Integration Queue按Plan顺序串行cherry-pick并cleanup Attempt。
9. 四道Gate绑定同一HEAD；全部通过后写入validated和validatedHead。

## Attention

native Supervisor负责Executor到Plan Runner第一跳，durable Plan Control负责Plan Runner到Root第二跳。请求正文只落私有Markdown；投影只携带requestId、SHA和版本，typed通知额外携带无业务正文的操作指令和受控正文路径。Root存活期间由thin Host bridge轮询derived status并主动上送非空Attention，不要求用户先执行`plan-status`；发送成功后才去重，瞬时失败会重试，recover attach会重建轮询。Root读取正文并向用户展示，得到明确决策后调用`plan_attention_reply`；该工具从当前pending projection派生taskId、attemptId和runId，再写入fenced command。command的`expectedProjectionVersion`绑定不可变Attention请求版本，因此不受并行Attempt事件推进全局version影响；native delivery authorization再单独绑定当前Plan version。Standalone Plan Runner在command缺失或不匹配时禁止native reply，只有native delivery成功后才resolve。

`progress_update`不阻塞；`need_decision`、`interview_request`、scope、contract、外部副作用和用户偏好可进入`waiting-attention`。并发请求按requestId分别处理。

## 恢复规则

- v3 handle：status只读Host/Plan状态；recover只attach、不spawn替代Host。handle保存由进程启动时间和含唯一session目录的完整命令计算的`processIdentity`；identity捕获失败必须停止刚spawn的Host，pause/cancel/recover在每次signal前及stop grace轮询中重复核验，不能仅凭PID存活。
- 已绑定Executor：从Plan event和官方artifact匹配runId、asyncDir、session file、cwd及派发时授权的唯一output路径。
- 未绑定dispatch：dispatch intent落盘后的任意非协议spawn异常都视为不确定；只有唯一started fact才能绑定，无法唯一证明时进入`dispatch_uncertain`。
- integration.requested：HEAD未变时可重试；HEAD前进时仅在“单父提交、parent=expected HEAD、diff SHA=validated SHA”全部成立后补记`integration.finished`，否则进入`integration_recovery_ambiguous`。
- cleanup中断：event授权、owner token和release head允许幂等重试。
- v1/v2 handle：明确失败，人工迁移，不自动推测。

## 失败现场

路径越界、dirty result、缺commit、merge commit、symlink逃逸、验证失败、RPC不一致、stale base、patch篡改、cherry-pick冲突和cleanup failure都必须fail closed。合法Executor blocked与提交验证失败是两种不同终态：前者保留受控blocker/evidence摘要，后者保留validator错误码。除已授权的integrated cleanup外，Attempt worktree和证据保留。

排查顺序：

1. 读取Plan event和derived status确认领域迁移。
2. 读取v3 Host handle与Host process status，不能只看PID。
3. 读取绑定Executor官方artifact，避免解析格式化RPC文本。
4. 检查Attempt lease、Git HEAD、status和diff。
5. 修复后从恢复入口继续，不手工伪造event或重复spawn。

## 验证

```bash
npm test
npm run doctor
PI_REAL_BIN="$(command -v pi)" npm run test:subagents
PI_REAL_BIN="$(command -v pi)" npm run test:plan-harness
```

真实smoke使用本地`fake/deterministic`provider和父仓中的真实Git submodule，必须同时断言Plan到达`validated`、`validatedHead == headCommit`和accumulator产物精确满足输入任务。仅进程退出不算通过。
