# Bug：live lifecycle grant 重试重复创建 Plan Runner

## 1. 现象

live completion debt 触发 revival 时，`resume()` 已成功创建 `plan-runner-2`，但 revived caller grant 首次写入失败。自动重试再次调用 `resume()`，创建 `plan-runner-3`；最终 alias 指向第三代，而第二代没有 principal、alias 或 Root lifecycle 管理。

## 2. 影响

一次瞬时 grant I/O 失败可遗留真实 Plan Runner 进程。它既不能订阅 Root broker，也不在 logical caller 的 current generation 中；Root shutdown 可能无法按领域顺序识别和清理它，并可能造成重复模型执行。

## 3. 触发条件

Plan Runner revival 的 `resume()` 成功返回新 actual identity，随后 `grantRevivedCaller()` 在 grant 原子发布阶段失败，并且 live lifecycle debt 的自动 retry timer 到期。

## 4. 根因

Root 只在 grant 成功后保存 revived identity。grant 失败时虽然保留 live debt，却丢弃了已经创建的 `revivedRunId`、resume result、source actual 和 debt snapshot；下一次 retry 只能从 `resume()` 重新开始。

## 5. 为什么现有测试未发现

原 grant retry RED 的 fixture 让每次 `resume()` 都返回固定 `plan-runner-2`，不符合真实 resume 每次创建不同 actual 的行为；测试还错误期待两次 resume，因此把重复创建当成正确恢复。

## 6. 修复与验证

Root 为每个 logical caller 保存 pending revived handoff descriptor。resume 成功后先保存 descriptor，再尝试 grant；grant 失败保留 descriptor，timer retry 复用同一 `revivedRunId` 且不再次 resume。只有 resume 自身失败时允许下一次重新 resume。grant 成功后才删除 descriptor、切换 alias并消费/转移 debt snapshot；Root final release 清理 descriptor。RED 使用递增 actual identity，证明一次 resume、同一 revived grant 两次尝试、最终 alias 仍为 `plan-runner-2`，且不会创建 `plan-runner-3`。
