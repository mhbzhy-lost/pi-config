# Bug：Root drain 的 terminal deadline 晚于 stop RPC

## 1. 现象

`RootBrokerServer.drainRun()` 先执行：

```ts
await this.upstream.stop({ runId, dir });
```

待 stop RPC resolve/reject 后才创建 `terminalTimeoutMs` timer。若 stop RPC 长时间 pending，official `subagent:process-terminal` 即使已经到达，drain 也仍卡在 stop await；若 proof 也未到达，则配置的 terminal deadline 完全没有开始计时。

## 2. 影响

Root graceful shutdown 的固定 deadline 失效。上游 typed RPC 自身的 timeout 会与 terminal deadline 串行叠加；若 injected upstream 或 transport 没有自身 timeout，Root close 可永久阻塞，无法进入 8B2 的 artifact polling、verified process-group SIGKILL 或 cleanup debt 判定。Plan Runner 也因此不能获得有界的 shutdown 顺序。

## 3. 触发条件与证据

- 当前实现位于 `scripts/lib/subagent-dispatch/root-broker-server.ts` 的 `drainRun()`。
- waiter 在 stop 前安装，但 timeout 在 stop `await` 返回后才创建。
- 已有 ordered-drain 测试覆盖 stop resolve、stop throw、unknown proof 和 terminal timeout，没有覆盖永不 settle 的 stop Promise。
- 权威计划 Task 8 要求“发送 upstream stop，等待 event/artifact（固定 deadline）”，并单独要求覆盖 stop timeout 后的 verified process-group SIGKILL。
- 父级静态审查 `1cee8bb` 时确认：将 `upstream.stop()` 替换为 never-settling Promise，会使 `closeRootSession()` 超过 `terminalTimeoutMs` 仍保持 pending。

## 4. 根因

实现把 stop ACK 当成进入 terminal-observation 阶段的前置条件。该顺序隐含假设 stop RPC 自身总会有界返回，但 Task 8 的信任模型明确规定 stop ACK 不是 terminal proof，stop transport 也可能超时或丢 reply。固定 deadline 应约束“stop 已请求到 terminal 已证明/形成 debt”的完整观察窗口，而不是只约束 stop ACK 之后的一段等待。

## 5. 处理决策

- 8B2 先新增独立 RED：upstream stop 返回 never-settling Promise，`terminalTimeoutMs` 到期后 close 必须进入 artifact/force/debt流程，不能永久 pending。
- stop 调用必须在安装 waiter 与 deadline 后启动；stop promise 必须附 rejection handler，避免 deadline 先结束后产生 unhandled rejection。
- official observed proof 一旦到达，可以完成该 run 的 terminal 判定，不等待 stop ACK；stop ACK、`status.state="stopped"` 与 async-complete 仍不能单独解锁。
- 若 deadline 前 stop 抛错但随后 official proof 到达，仍视为 terminal 成功；若 proof 不到达，stop错误只作为 cleanup诊断。
- artifact polling、birth identity重捕获、process-group SIGKILL 与第二阶段 proof等待按 8B2 独立实现，不回退到 synthetic terminal。

## 6. 验证

1. never-settling stop RED 在明显小于外部 test timeout 的窗口内失败于当前 production，而不是挂住测试进程。
2. GREEN 后 stop pending、stop throw、stop resolve 三条路径都由同一 fixed deadline约束。
3. observed event 可在 stop pending 时立即完成 drain；没有 proof 时进入 artifact/force/debt，不 dispose upstream。
4. focused Root Broker、完整 suite、protocol 与 process birth helper 全部回归通过。
