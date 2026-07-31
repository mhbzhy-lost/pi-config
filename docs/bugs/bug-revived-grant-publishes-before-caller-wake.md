# Revived grant 先于 caller wake 发布

## 1. 现象

`performCallerRevive()` 先等待 `grantRevivedCaller()` 完成，随后才把 FIFO 队首写入 `callerWakes`。新 actual run 的 grant、principal、alias 与 active generation 已经提交时，Root-owned wake identity 仍可能尚未绑定。

## 2. 影响

已读取 grant 并通过鉴权的新 Plan Runner 若在该边界调用 `ping`，响应可能缺少 `callerWake`。bootstrap 会把缺失视为合法初始 generation，Attention recovery 退回无 wake 路径，无法证明本代只处理 FIFO 队首 command。

## 3. 时间线

- `dc21d47` 引入每代 FIFO wake 与认证 `ping.data.callerWake`。
- focused tests 在 `performCallerRevive()` 完全结束后才调用 `ping`，全部通过。
- 独立 review 发现 grant commit 与 wake map commit 分属两个函数、两个 await continuation。

## 4. 根因

wake identity 没有作为 revived grant transaction 的输入。`grantRevivedCaller()` 只提交 token、principal、alias 与 generation；调用者在事务返回后补写 `callerWakes`，因此无法从代码结构保证“可鉴权即有 wake”。

## 5. 触发条件

revival 带有 Attention FIFO 队首，且新 actual run 在 grant 对外可见后、调用者补写 `callerWakes` 前完成认证 `ping` 时触发。自定义或未来变慢的 grant writer 会扩大该窗口。

## 6. 修复与验证

把可选 `callerWake` 传入 `grantRevivedCaller()`，在 grant 对外发布前预绑定到 actual run；任何 grant 失败或 close fence 必须回滚该绑定。RED 在受控 `writeGrant` 边界直接观察 map，要求 grant writer 运行时 wake 已存在，并验证写失败后 map 不残留。
