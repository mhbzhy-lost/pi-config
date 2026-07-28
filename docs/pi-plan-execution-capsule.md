# Pi Plan Execution Capsule

## 使用方式

批准计划后，由Root Parent启动独立Plan Host：

```text
/plan-run docs/superpowers/plans/<approved-plan>.md
/plan-status <plan-id>
/plan-recover <plan-id>
/plan-cancel <plan-id>
```

每个Plan使用独立`pi-plan/<planId>`分支和`var/plan-worktrees/<planId>` accumulator worktree。每个活动Attempt再使用独立分支、cwd和owner token；无路径或资源冲突的root Task可以并行。

## 运行边界

运行链路固定为：

```text
Root Parent -> thin Host -> Standalone Plan Runner -> pi-subagents RPC -> Executor
```

- thin Host只启动、观察、中断和停止Standalone Plan Runner，不派发Executor，也不写Plan领域事件。
- Standalone Plan Runner不是`PI_SUBAGENT_CHILD`或fanout child；Host启动时删除继承的`PI_SUBAGENT_PARENT_SESSION`，再由新session建立自己的identity。
- Plan Runner不能调用`subagent`。Plan Capsule根据批准的DAG、路径和资源生成固定RPC请求。
- Executor只能在已分配Attempt worktree中运行，不能改变DAG、cwd、allowed paths、资源或集成顺序，也不能继续派发Agent。

Host handle使用`pi-plan-handle.v3`，包含`hostRunId`、`processIdentity`、PID、实际session file、Plan status路径和worktree。`processIdentity`由进程启动时间与含唯一session目录的完整命令计算；identity捕获失败必须停止刚spawn的Host，recover、pause和cancel在实际signal前及stop grace轮询中重复核验，不能只凭PID存活。v1/v2及缺少该字段的旧v3 handle不自动猜测或迁移。

## 三类事实

三类事实不得相互替代：

1. append-only `pi-plan-event-v1`与Git提交证明Task、Attempt、Attention、integration、Gate和Plan终态。
2. 官方`pi-subagents` lifecycle artifacts证明Executor的runId、session、cwd和运行终态；result只允许读取派发时绑定的唯一output路径。
3. `var/plan-runs/<planId>/status.json`、Host process status和widget只是可再生投影，不能产生`accepted`、`integrated`或`validated`。

RPC格式化status文本只用于reconcile定位；typed lifecycle必须读取官方artifact。PID存活也不能推导Plan成功。

## 调度与恢复

Harness先重放活动Attempt的资源claim，再按Plan顺序选择frontier。路径所有权是exclusive资源；声明资源支持shared容量和exclusive占用。授权完成后才创建Attempt worktree并发出RPC spawn。

`attempt.dispatch-requested`之后的非协议spawn异常直接视为不确定；若无法从started event、spawn reply和官方artifact唯一绑定run，Plan进入`dispatch_uncertain`并保留现场，禁止自动重复spawn。已绑定run恢复时必须同时匹配session file、runId、asyncDir、cwd和授权output。

Executor完成不等于结果可接受。Attempt必须通过以下检查：

- 基于批准base的单个非merge descendant commit；
- worktree无越界tracked/untracked变化；
- rename两端、symlink和`.git`边界合法；
- 只执行Plan contract注册的验证命令；
- stdout/stderr和diff hash形成不可变证据。

## Attention

Executor通过native Supervisor向Standalone Plan Runner请求输入。Plan Runner执行固定控制循环：

```text
pending -> 1000ms bounded wait -> pending -> plan_status
```

blocking请求一旦持久化为`waiting-attention`，Plan Runner就不得再自行回复，包括计划已明确fail-closed结果的情况。请求正文写入0600 Markdown和durable Attention event；Root存活期间thin Host bridge持续轮询derived status，转发包含requestId、Attention request version、正文路径/SHA和无业务正文操作指令的非空通知，不要求用户先执行status命令。通知发送成功后才去重，瞬时失败会重试，recover attach会重建轮询。Root读取正文并获得用户明确决策后调用`plan_attention_reply`，由工具从当前projection派生并写入taskId、attemptId、runId完整的durable command。command版本绑定不可变Attention请求，native delivery authorization另行绑定当前Plan version，因此并行Task的无关事件不会让用户回复stale。command缺失、过期或不匹配时native reply必须拒绝；只有native reply成功后才能resolve。

`waiting-attention`不是终态。Host或Root重启后从event和command inbox恢复，不重复通知、不串线。

## 集成与Gate

只有Integration Queue可以写accumulator。它按Plan文档顺序串行cherry-pick validated Attempt，并校验owner token、expected HEAD、validation hash和patch hash。若进程在cherry-pick成功后、`integration.finished`落盘前退出，恢复时只接受“HEAD是expected HEAD的单父子提交且diff SHA等于validated SHA”的唯一证明；否则进入`integration_recovery_ambiguous`。冲突会abort回该item的expected HEAD并保留Attempt worktree，不自动rebase。

只有deterministic、plan-audit、external-review和final-completeness四道Gate都绑定同一clean HEAD并通过，Plan才能进入`validated`。完成声明必须同时满足：

```text
lifecycle == validated
validatedHead == headCommit
```

失败、blocked、cancelled、interrupted和cleanup failure均保留证据；受控`.pi-subagents` runtime artifact仅在授权cleanup阶段删除。

## 显式Merge Back

`validated`不会修改origin，也不会push。合回前重新确认`validatedHead`仍等于accumulator HEAD，且origin工作区允许合并，然后由用户显式执行：

```bash
git merge --no-ff "pi-plan/<planId>"
```

HEAD变化、Gate stale或origin冲突时禁止合回，先恢复Plan或处理现场。
