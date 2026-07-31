# Amendment Executor fixture 忽略 typed write scope

## 1. 现象

真实 amendment Harness 的首个 Executor 没有调用 `contact_supervisor` 或 `bash`，只输出 `deterministic`，随后被 upstream acceptance 判为“implementation task未产生编辑”并以exit 1结束。Plan投影进入Attempt `failed`，无法到达Attention和amendment crash窗口。

## 2. 影响

`test:plan-harness`的amendment纵向场景在业务前提阶段失败，不能证明event-to-pointer崩溃恢复、supersede cleanup、revision 2 dispatch和Gate。

## 3. 时间线

- Plan Runner提交typed `dispatch-ir.v1`并启动Executor。
- Executor收到的真实用户prompt含`## Declared Write Scope`和`1. "decision.txt"`。
- `deterministicExecutorCommand()`能解析该typed scope。
- `decideDeterministicAmendmentTurn()`却只用`/^Allowed paths: decision\.txt$/m`识别旧文本。
- amendment selector返回`undefined`，common selector也没有amendment decision分支，最终输出`deterministic`。

## 4. 根因

amendment专用selector与通用command parser各自维护写路径识别；前者保留旧Plan prose格式，没有复用已支持typed dispatch prompt的判定结果。现有测试只构造`Allowed paths: decision.txt`，没有使用真实`Coding Dispatch Contract v1`形状。

## 5. 触发条件

`PI_PLAN_HARNESS_AMENDMENT=1`，Executor任务写路径为`decision.txt`，prompt来自当前typed dispatch renderer而不是旧原始任务文本。

## 6. 修复与验证

先增加provider RED：使用含`Declared Write Scope`的真实最小typed prompt和成功`contact_supervisor`结果，必须选择保持old Executor活跃的`sleep 120; ... decision.txt` bash命令。最小实现复用`deterministicExecutorCommand(userText)`和解析后的decision写路径，不恢复旧任意文本猜测。focused provider suite和下一冻结HEAD真实Harness验证GREEN。
