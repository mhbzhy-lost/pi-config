# Plan Runner 兼容门禁误判运行时语义

## 1. 现象

真实 Standalone Attention 探针在 Executor 阻塞于 `contact_supervisor` 时，父进程调用的 `subagent_wait` 持续等待直至测试超时；同时 async status 显示 `isNested: true`。后续重跑时，全局 Pi 已由 `0.82.0` 更新为 `0.82.1`，精确版本断言失败。

## 2. 影响

旧门禁把 native Supervisor 请求错误地当成 `subagent_wait` 的即时唤醒信号，并把 root async 的 route 元数据误判为 nested child event。它既会阻断正确的 Standalone 拓扑，也无法直接证明高频 nested event 已从 Executor 路径消失。

## 3. 时间线

1. completion 场景通过，证明公开 RPC spawn 和正式 wait 可用。
2. Attention 场景中 child 已进入 `contact_supervisor`，但 wait 未返回。
3. 阅读 `subagent-control.ts`，确认存在 `currentTool` 时 idle attention 分类明确返回空。
4. 阅读`async-execution.ts`，确认root async会创建route元数据供潜在后代使用；只有真正的nested child才写nested event。
5. 发现测试进程继承当前Root Parent的`PI_SUBAGENT_PARENT_SESSION`，导致所谓Standalone run重新挂入外层nested route；移除继承值后由新进程建立自己的session identity。
6. 确认0.35.1的RPC status能定位active run，但typed details为空且格式化文本不暴露`currentTool`；该限制已由`bug-pi-subagent-status-details-not-typed.md`记录。
7. 重跑版本门禁时发现当前全局Pi为`0.82.1`。

## 4. 根因

- `subagent_wait` 只根据 async run 的 terminal/attention projection 收敛；native Supervisor pending request 本身不会把 run 投影为 `needs_attention`。
- root async的`nestedRoute`是潜在后代的路由基础设施，不等同于nested child，也不等同于nested event。
- 继承外层`PI_SUBAGENT_PARENT_SESSION`会破坏Standalone边界；但`PI_SUBAGENT_CHILD`和`PI_SUBAGENT_FANOUT_CHILD`不能通过清除来伪装root。
- RPC status的公开契约可定位run/state，0.35.1尚不提供typed activity details，`currentTool`必须从spawn返回目录内的官方status artifact读取。
- 测试把已验证的Pi patch版本写成单值`0.82.0`，没有表达显式支持集合。

## 5. 修复方案

- Attention顺序改为：公开RPC `spawn`，公开RPC `status`确认active run，官方status artifact确认`contact_supervisor`，给native Supervisor poller留出扫描窗口，正式`subagent_supervisor pending/reply`，最后正式`subagent_wait`等待terminal。
- Standalone启动时移除继承的`PI_SUBAGENT_PARENT_SESSION`并验证新session identity；若存在child/fanout标记则fail closed。
- 后续生产控制循环采用“Supervisor pending -> 1秒有界wait -> Supervisor pending”，不假设request会立即打断wait。
- 在 child 阻塞期间统计 nested event 文件并要求为 0；允许一个 root route 元数据文件。
- Pi 版本改为显式支持集合 `0.82.0`、`0.82.1`，未来版本仍默认拒绝。
- 保持 Executor 无 `subagent` 工具，继续禁止 fanout。

## 6. 验证与防复发

- 确定性 provider 单元测试覆盖非阻塞 Attention 顺序。
- 真实Pi集成测试覆盖RPC active status、status artifact、Supervisor pending/reply、terminal wait、精确cwd、session重建和无nested event。
- capability evaluator分别拒绝未知Pi版本、未重建session、RPC找不到active run、Supervisor状态不可见和任意nested event文件。
