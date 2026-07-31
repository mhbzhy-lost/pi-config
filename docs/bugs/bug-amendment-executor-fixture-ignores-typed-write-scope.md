# Amendment Executor fixture 忽略 typed write scope

## 1. 现象

真实 amendment Harness 的首个 Executor 没有调用 `contact_supervisor` 或 `bash`，只输出 `deterministic`，随后被 upstream acceptance 判为“implementation task未产生编辑”并以exit 1结束。Plan投影进入Attempt `failed`，无法到达Attention和amendment crash窗口。

## 2. 影响

`test:plan-harness`的amendment纵向场景在业务前提阶段失败，不能证明event-to-pointer崩溃恢复、supersede cleanup、revision 2 dispatch和Gate。

## 3. 时间线

- Plan Runner提交typed `dispatch-ir.v1`并启动Executor。
- Executor收到的真实用户prompt含`## Declared Write Scope`和`1. "decision.txt"`。
- `decideDeterministicAmendmentTurn()`的Supervisor回复后分支已复用typed scope，但首轮没有结果时返回`undefined`。
- common selector的首轮`contact_supervisor`分支仍只匹配`Allowed paths: decision.txt`。
- 真实首轮因此未调用Supervisor工具，最终输出`deterministic`。

## 4. 根因

amendment专用selector的回复后路径与common selector的首轮路径分别维护写路径识别；只修前者仍会在真实首轮失败。现有post-reply测试覆盖长bash，却没有断言同一typed prompt在无结果时先发`contact_supervisor`。

## 5. 触发条件

`PI_PLAN_HARNESS_AMENDMENT=1`，Executor任务写路径为`decision.txt`，prompt来自当前typed dispatch renderer而不是旧原始任务文本。

## 6. 修复与验证

增加两段provider RED：同一`Declared Write Scope` typed prompt在无结果时必须先选择`contact_supervisor`；有成功Supervisor结果后必须选择保持old Executor活跃的`sleep 120; ... decision.txt` bash命令。最小实现让common selector的decision分支复用`deterministicExecutorAllowsPath()`，保留legacy兼容且不恢复任意文本猜测。focused provider suite和下一冻结HEAD真实Harness验证GREEN。
