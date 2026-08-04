# Goal Engine originRef 恢复绕过

## 现象
处于 disposing 的任务先判断补丁是否已集成；用户切换到含同一补丁的 other ref 后，该判断返回真，恢复跳过集成前检查，写入 applied 并释放工作区。

## 影响
Goal 会在未授权分支上确认集成并删除可供人工恢复的 workspace、branch 和 lease，错误分支的历史与资源状态都可能被破坏。

## 稳定复现
让第一次集成完成后在 applied 事件追加处失败；在已含相同补丁的 other ref 上切换并重试。旧逻辑的 isExecutorWorkspaceIntegrated 返回真，随后发生 applied 写入或资源释放。

## 根因
恢复分支只依赖 isExecutorWorkspaceIntegrated 的补丁等价判断；originRef 检查只在 active 或 integrateExecutorWorkspace 内，未覆盖 disposing/applied 的事件与资源副作用。

## 本次处置
在 active、disposing、applied 的所有自动动作前统一核验当前 symbolic ref 与持久化 originRef；该检查位于 isIntegrated、HEAD 读取、事件追加和 release 之前。

## 防复发
Extension 真实 Git 回归覆盖 disposing 已集成和 applied 未释放后切换 other ref，断言 other HEAD/status 不变且 workspace、branch、lease 保留。
