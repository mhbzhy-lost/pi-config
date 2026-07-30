# Root terminal deadline 后缺少 verified process-group force cleanup

## 1. 现象

`drainRun()` 在首次 terminal deadline 到期时直接记录 missing proof debt 并结束该 run 的等待。当前路径没有在 deadline 后重新捕获 PID 的 birth identity，也没有注入或调用 process-group signal；因此已拥有且仍可验证的 run 不会进入受身份围栏约束的强制清理。

## 2. 影响

Root drain 可能在子进程组仍存活时仅留下 cleanup debt，资源无法在本轮关闭中被收敛。若未来不加身份围栏地补入 signal，则 PID 复用、陈旧 PID 或身份冲突会把信号发给非 owned 进程组，扩大清理操作的安全边界。

## 3. 触发条件与证据

- owned run 的首次 terminal deadline 到期，且尚无有效的 official terminal event、sidecar 或 status mirror proof。
- 已持久化的 `ownedRuns` 含有 `pid`、`birthIdentity` 与 `identityState`；birth identity helper 使用完整 `ps` stdout 的 SHA-256。
- 当前 `drainRun()` deadline 分支直接形成 missing proof debt，未重新调用 `captureProcessBirthIdentity(pid)`，也未注入或调用 `kill(-pid, 'SIGKILL')`。
- normal close 已具备 ordered drain、official artifact 与 cleanup debt；本缺口只涉及 terminal deadline 后缺少经过验证的 process-group force cleanup。

## 4. 根因

当前实现把“首次 deadline 内未获得 terminal proof”作为唯一结论，未将其区分为“不能证明 terminal”与“已验证 owned process group 仍可被安全强制终止”两个阶段。缺少 deadline 后的 exact birth recapture fence 和 process-group signal 依赖，使强制清理既没有可执行入口，也没有 fail-closed 的身份判断。

## 5. 处理决策

- 仅当 owned run 的 `identityState === 'verified'`、初始 `birthIdentity` 非空，并且 deadline 后重新执行 `captureProcessBirthIdentity(pid)` 得到与初始值 exact 相同的 hash，才允许强制清理。`pid` 必须为正数；信号目标必须明确为负的 process-group target `-pid`，调用为 `kill(-pid, 'SIGKILL')`。
- recapture 与初始 identity mismatch 视为 stale PID；初始 identity unavailable、recapture unavailable 或 identity conflict 均禁止 signal。上述所有情形都必须形成明确 cleanup debt，并保留 server、subscriptions、listener、owned grants、ledger 与 upstream RPC，不能以局部资源释放伪造清理完成。
- signal 不是 proof。发送 signal 后不得合成 terminal，必须在新的固定 deadline 内继续等待 valid observed official event、sidecar 或 status mirror。获得 proof 后仍须重新 probe：仅当旧 birth identity 已不可捕获时才可确认 run 已清理；若仍匹配旧 identity，或变为其他 identity，均 fail closed。
- 单个 run 的 force 失败不得跳过同一 phase 的其他 run；该 phase 必须使用 `Promise.allSettled`，汇总后抛出 `AggregateError`。retry 只处理仍无 terminal proof 的 cleanup debt。全部 Executors 都获得 proof 后，才允许进入 Plan Runner。

## 6. 验证

本次为 tests-only RED 验收矩阵，不实现 production 或测试代码：

- verified exact success：verified owned run 的初始与 recaptured birth hash exact 相同，且仅对负 process-group target 发出 `SIGKILL`。
- force 后无 proof：signal 后在新的固定 deadline 内仍无有效 official event、sidecar 或 status mirror，保留 debt。
- force 后仍存活：获得 proof 后 probe 仍捕获旧 identity，fail closed。
- stale mismatch：recapture hash 与初始 hash 不同，不得 signal，保留 debt。
- initial unavailable：初始 birth identity 为空或不可用，不得 signal，保留 debt。
- recapture unavailable：deadline 后无法重新捕获 identity，不得 signal，保留 debt。
- conflict：identity state 或身份记录冲突，不得 signal，保留 debt。
- 同 phase all-settled+retry：一个 run force 失败时其余 run 仍完成处理，phase 在 `Promise.allSettled` 后以 `AggregateError` 汇总；retry 仅重试无 terminal proof 的 debt，Executors 全部 proof 前不得启动 Plan Runner。
