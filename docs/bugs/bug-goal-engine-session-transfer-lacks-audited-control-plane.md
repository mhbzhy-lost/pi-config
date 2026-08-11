# 会话 Goal 转移缺少审计控制面

## 现象
同一 canonical cwd 的新会话可以看到其他会话拥有的 Goal，却没有受控、可审计的所有权转移路径。

## 影响
若以隐式 active 选择或 detach 后自动接管实现，会造成跨会话越权读取、恢复或修改，并且无法证明用户是否批准转移。

## 复现条件
1. 会话 A 在 cwd 中创建并绑定 active Goal。
2. 会话 B 在相同 cwd 启动。
3. B 需要继续 A 的 Goal。

## 根因
所有权虽由首条 `goal.session_bound` 导出，但状态接口没有最小清单、持久化人工批准 challenge 与一次性原子转移 offer。

## 修复方案
在既有七工具 ABI 中扩展 `goal_status` 的 cwd 最小清单和 transfer challenge 状态；扩展 `goal_amend` 为提议与消费批准 offer 两阶段流程，并记录 `goal.session_transferred` 审计事件。

## 验证
覆盖 A/B 同 cwd 清单隔离、人工批准、原子转移、旧 owner 失权、新 owner 恢复，以及错误 session/token/challenge/replay 与不安全 workspace 的零副作用。
