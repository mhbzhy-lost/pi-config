# Bug：Plan Harness 独立审查发现恢复与安全缺口

## 现象

Harness 全量门禁与真实 smoke 通过后，独立代码/安全审查仍发现六条可复现缺口：spawn reply 丢失被错误归类、cherry-pick 成功后事件落盘前崩溃无法恢复、Host PID 复用可能误发信号、Attention 仅在显式 status 时转发、runtime result 路径可越界读取、Host/Plan 状态文件权限依赖 umask。

## 影响

- 已启动 Executor 可能被错误标记为普通派发失败，破坏“禁止不确定重复派发”的恢复语义。
- 集成提交已经写入 Git、但 `integration.finished` 未落盘时，Plan 重启会永久阻塞。
- v3 handle 中过期 PID 被复用后，pause/cancel 可能向无关进程发送信号。
- Root Parent 仍存活但用户未主动执行 `plan-status` 时，durable Attention 不会主动上送。
- 被篡改的官方 runtime status 可诱导 Plan Runner 读取授权 result 之外的 JSON 文件。
- 同机其他用户可能读取 Host stdout/stderr/status 与 Plan projection。

## 根因

1. Coordinator 把 `backend.spawn()` 的非协议异常统一映射为 `dispatch_failed`，没有把 RPC 发送后的响应丢失视为不确定状态。
2. Integration Queue 只实现正常 `requested -> cherry-pick -> finished` 路径，没有用 `expectedHead + result diff hash` 对账未记账提交。
3. Host signal API 只验证 PID 存活，没有把不可复用的进程启动身份与 handle 绑定；初版修复尝试从 `ps` 读取 `PI_PLAN_HOST_RUN_ID` 环境变量，但 macOS `ps` 不会暴露该值，真实回归测试证明合法 Host 也会被错误拒绝。第二版虽绑定了启动身份，但 identity 捕获失败会遗留已启动 Host，且 signal grace period 内未重复核验。
4. Attention bridge 挂在 `status()` 调用上，但 Launcher 没有为活动 handle 建立轮询器；初版轮询修复又在发送前写去重集合，瞬时发送失败后不重试，且 `plan-recover` 没有重建轮询。
5. Runtime artifact reader 对 `results[].outputFile` 直接 `path.resolve()` 后读取，没有和派发请求中授权的 output 绑定。
6. Host stream/status 与 Plan projection 创建文件时没有显式 mode，继承默认 `umask`。

## 触发条件

- RPC 已启动 run，但 spawn reply 超时、连接断开或响应解析失败。
- 进程在 `git cherry-pick` 成功后、`integration.finished` append 前退出。
- Host 退出、PID 被复用，再执行 recover/pause/cancel。
- Executor 进入 `waiting-attention` 后 Root 没有调用 `plan-status`。
- runtime `status.json` 中 result output 指向派发授权路径之外的绝对路径、`..` 或 symlink。
- 运行环境 umask 为 `022` 或更宽松。

## 为何已有测试未发现

- dispatch 测试把 reply lost 固化成 `dispatch_failed`。
- 集成测试只覆盖冲突 abort 与 cleanup failure，没有在 cherry-pick 和 finished event 之间注入崩溃。
- Host 测试只断言 signal 使用 handle PID，没有模拟 identity mismatch。
- Attention 测试通过两次主动 `status()` 验证去重，没有验证 Launcher 后台轮询。
- Runtime artifact 测试验证字段白名单与 binding identity，但没有验证 result 路径授权。
- 权限测试只覆盖 Attention 正文、command inbox 和 verification evidence。

## 修复策略

1. dispatch-requested 落盘后，除明确协议违规外的 spawn 异常一律 fail closed 为 `dispatch_uncertain`。
2. Queue 重放 `integration.requested`；若 HEAD 未变则重试，若 HEAD 恰为单个子提交且 diff hash 匹配则补写 `integration.finished`，否则阻塞。
3. spawn 后读取 `ps` 提供的进程启动时间与完整命令，计算 `processIdentity` 写入 v3 handle；identity 捕获失败立即停止刚 spawn 的 Host。signal/reconcile 前重新计算并比较，stop 在每次 signal 前及 grace 轮询中持续核验，身份变化立即停止。
4. Launcher 为活动和 recover attach 的 handle 建立有界轮询；Attention 仅在发送成功后去重，失败由下一轮重试；Root shutdown 只清轮询器，不停止 Host。
5. 把派发授权 output 写入 execution binding，读取 result 时要求 canonical path 精确匹配；同时拒绝 artifact 内引用的绝对/穿越路径。
6. 私有目录显式 `0700`，Host stdout/stderr/status 与 Plan status 显式 `0600`。

## 审查中不采纳项

- lifecycle `sessionId` 并非 RPC UUID：真实 `pi-subagents@0.37.0` probe 已证明 ping UUID 与 lifecycle/session artifact 路径是两种官方标识，当前双字段实现正确。
- “两个独立 Plan Runner 同时集成同一 Plan”不属于受支持入口：Launcher 通过唯一 planId、workspace branch 与持久 handle 阻止第二次 spawn，recover 只 attach；仍保留 Git HEAD fail-closed 防线。
- `.pi-subagents` 宽泛清理只删除 owned Attempt 内未跟踪 runtime 文件；tracked 文件、其他未跟踪文件、owner/status/disposition 不匹配均阻断，且这些文件不进入受验证提交，暂列非阻断残余风险。
