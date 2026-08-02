# Bug: crash replay 无法恢复 unbound dispatch cancel fence

## 症状
backend 只有 `recoverBinding()`；`attempt.dispatch-requested` 在 run binding 提交前 crash 时，projection 有完整 spawn request 却无法在新进程注册 unbound dispatch。

## 影响
amendment recovery 调用 supersede 得到 dispatch not found，无法捕获 reply-lost 的 late lifecycle start；旧 hash Attempt 可能继续运行或 Plan 永久停在 cleanup pending。

## 复现
重放到 status=dispatch-requested、无 attempt.bound 的 projection，创建新 backend 并调用 supersede；当前没有合法 API 注入 dispatch request，只能失败或重新 spawn。

## 根因
backend 把 dispatch registry 视为仅由当前进程 `spawn()` 创建，缺少从单写者事件重建 transport cancel intent 的入口。

## 修复
增加 `recoverDispatch()`：在 capabilities 协商后严格校验完整 normalized spawn request，只注册当前 session 的 unbound entry，绝不调用 rpc.spawn。相同 request 幂等，身份/请求冲突拒绝；之后 supersede 等 exact lifecycle 或 bounded uncertain。

## 验证
新增 no-spawn RED/GREEN、late lifecycle stop、timeout uncertain、retry proof、重复幂等和 request conflict；dependencies recovery 从 projection.tool 重建后不重派旧 hash。
