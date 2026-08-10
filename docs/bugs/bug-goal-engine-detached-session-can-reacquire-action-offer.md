# Goal Engine 的 detached session 会重新取得动作凭据

## 1. 预期行为

可信 session 成功执行 `detach_session` 后，该 session 对 active Goal 的 authority 被持久撤销。后续显式或隐式 `goal_status` 可以只读返回 projection，但必须返回 `machineAction=null` 与 `action_token=null`，且不得创建 action offer、metadata decision 或 orphan disposition challenge。其他未 detached session 仍可取得同一 runnable task 的正常 dispatch offer。

## 2. 实际行为

当前 `goal_status` 只按 cwd 解析 active Goal，未在创建 status 派生状态前检查调用 session 的 detached binding。因此原 session detach 后再次调用 status 仍会追加 `goal.action_offered`，并返回新的 `goal_dispatch` token，重新获得 mutation authority。

## 3. 稳定复现

创建含 runnable task 的 Planned Goal，以当前可信 session 获得 `goal_dispatch` offer，并以该 token 成功调用 `goal_amend(operation=detach_session)`。记录 events、projection、registry 与 worktree；随后由同一 session 显式及隐式调用 `goal_status`。当前实现会新增 `goal.action_offered` 并返回 token。将 mock 的可信 identity 改为另一未 detached session 时，应仍能获得 fresh offer。

## 4. 根因

status handler 在取得 session identity 后立即计算 `metadataState`、orphan inventory/challenge 与 `machineActionForProjection`，并可能 append `goal.action_offered`；该流程没有先依据 projection 的 session binding 判断该 identity 是否已经 detached。

## 5. 影响范围

已放弃 Goal 的 session 可以重新派发、settle、integrate 或 amend，破坏 detach 的 authority revocation 语义；同时 status 还可能写入本不应属于 detached session 的人类 decision metadata/orphan challenge。不能改变未 detached session、completed watching detach、普通 metadata/orphan 决策、exact action-offer 或 root exact-seven ABI。

## 6. 修复与验证

在 `goal_status` 创建 metadata/orphan challenge 或 action offer 前，识别 current session 的 detached binding 并短路为只读响应。测试真实执行 active detach，再验证显式/隐式 status、无 authority mutation、另一 session 接管、跨 session target 与错误/stale token 拒绝的持久状态不变，并触发 `session_compact` 确认没有 recovery 注入。
