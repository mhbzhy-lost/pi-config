# Heartbeat 与主进程意外退出后的孤儿清理 provenance

## 调查结论

本次只读静态调查基于 `/tmp/pi-heartbeat-parent-death-orphan-cleanup-current.md`，未运行真实 parent-SIGKILL、Host、child 或 runner。结论的证据模式为 `static`，不能升级为完整 production crash proof。

当前链路可确认：managed/coding child 在绑定成功、lease 已创建并持续续租的前提下，主进程消失后由 child-side watchdog 在约 45–65 秒窗口内让 runner 自身收到 SIGTERM；generic/detached child 按设计不接入该 heartbeat；绑定失败 child 可能没有 watchdog；runner 内独立 detached bash/后代没有由该 watchdog 进行进程组清理。正常主会话关闭另有 broker close/force cleanup 路径，不能与 SIGKILL 场景混写。

## 覆盖矩阵

| 路径 | sourceClass | birth/ACK | renewal | parent-loss | termination | descendant reaping | owner |
| --- | --- | --- | --- | --- | --- | --- | --- |
| managed/coding，绑定成功 | static | 有绑定与身份校验 | Root Broker 15s/60s lease | watchdog 等 lease 过期 | runner 自 SIGTERM | 未证明覆盖 detached descendant | 本仓 broker/watchdog + upstream runner |
| generic/detached | static | facade/runner 启动事实存在 | 不接入 root heartbeat | 按设计可独立存活 | 无本仓父死清理 | 无 | upstream detached runtime |
| binding-failed | unconfirmed | ACK/绑定失败路径存在 | 无可靠续租消费 | 无 watchdog 保证 | 未证明 | 未证明 | owner 与 production 可达性待证 |
| runner child | static | runner identity | 依附 runner lease | runner 退出 | runner watchdog | 内嵌 session 随 runner | runner/watchdog |
| runner bash descendant | static | Pi bash detached 进程组 | 不受 runner self-SIGTERM 传播保证 | 可能成为 OS orphan | 自然结束或其它机制 | 未覆盖 | upstream bash/runtime |

`45–65s` 仅由 15s 续租、60s lease 和约 5s child 检查粒度推导，前提是绑定成功、lease 已推送、事件循环正常、没有睡眠/阻塞/权限异常；不是端到端实测。

## 数据来源分类与决策

- 当前证据主要是公开源码静态链和历史静态报告，不能证明 generic、binding-failed 或 descendant 缺口已在某个用户生产样本中发生，因此这些路径保持 `static` 或 `unconfirmed`。
- 不能把 `test/session-owner-runtime.integration.mjs` 的 registry SIGKILL 实验当作 subagent 清理证据。
- 本仓已有 managed/coding owner，但 detached descendant 和 generic owner 位于上游边界；本轮不修改 broker、lease、child lifecycle、node_modules，也不做 kill 实验。
- 最小决定：关闭本轮 production 修复，保留覆盖边界；若未来要修复，先取得具体 production provenance、上游 owner 合同和新的授权/计划。

## 验证限制

未读取真实 session、authority、settings、models、auth；未启动真实 Host/RPC/provider/model/MCP/child；未执行 SIGKILL。
