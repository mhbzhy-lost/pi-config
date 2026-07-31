# 双 Plan Harness 在 Runner 收敛前关闭 Root

## 1. 现象

真实双Plan Harness已完成两个Plan的integration与Gate，但关闭Root后发现终代Plan Runner缺少official `ProcessTerminalV1`。一个Runner被TERM后状态仍为`pending`，另一个live-lifecycle revival在extension加载时连接已关闭broker并失败；Root session只有`close.started`，没有`close.completed`。

## 2. 影响

Harness主体业务成功却无法证明Root shutdown、official terminal和socket生命周期收敛。直接放松sidecar检查会把真实cleanup debt误判为GREEN。

## 3. 时间线

- 两个Plan均投影为`validated`。
- 终代Runner仍在消费尾部`plan_status`，另一Plan的live lifecycle debt触发新generation。
- Harness看到Plan terminal后立即结束Root RPC stdin。
- Root开始关闭时终代Runner尚未自然形成official terminal；其中一个被TERM，另一个在broker关闭后才加载extension。
- Pi RPC进程退出，保留`pending` status且没有sidecar。

## 4. 根因

Harness把Plan领域terminal错误地等同于Root-owned actual run集合已经收敛。Plan projection可以先于尾部Runner turn和live lifecycle continuation完成；因此关闭Root前必须另有runtime quiescence barrier。

## 5. 触发条件

Plan刚完成Gate时仍有终代Runner turn，或旧generation official proof同时携带未消费的live lifecycle debt；Harness在这些run形成official terminal前关闭Root。

## 6. 修复与验证

新增tests-only quiescence driver：持续枚举runtime下actual runs，要求调用方已知的6个initial run始终存在，见过的run集合只能增加；每个run均须有匹配runId且通过完整协议解析的official observed terminal。run集合或terminal指纹变化会重置quiet window；quiet window显式取`1秒revival retry上限 + 5秒Root startup barrier预算 + 0.5秒落盘余量`，所有run持续收敛6.5秒才允许关闭Root。timeout必须区分缺proof与集合持续变化未静默，并输出最后run集合、缺失列表和最后变化时间。双Plan Harness只在该barrier后关闭Root，关闭后仍重新枚举并逐项验证sidecar、PID `ESRCH`、`close.started/close.completed`和broker socket删除。不得用status文本、进程死亡或固定短sleep替代official proof。
