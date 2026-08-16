# 修订执行意图后旧执行仍可能继续

## 问题描述

用户发出交互式转向、追问、中止或执行修订后，若只等待旧 Executor 自然结束，已被撤销的执行意图仍会继续运行；其陈旧结果或工作区还可能被错误集成。

## 复现步骤

1. Goal 的 action offer 和一个绑定 lease 的 Executor run 均处于活动状态。
2. 用户提出执行修订，但系统未先持久化暂停、撤销 offer 并请求精确停止。
3. 旧 Executor 自然成功结束，随后尝试集成其 workspace/result。

## 修复方案

先生成 durable suspend 与撤销 offer 的事件计划；仅向严格绑定 goal/task/attempt/run/lease 的 Root Broker facade 请求停止并等待 official terminal proof。受影响工作区只输出 preserve/quarantine/discard 策略，暂停期间阻断 dispatch、integrate、finalize，修订只可经 challenge 绑定的一次性用户 capability 协调。

## 协调动作矩阵

| 旧 Task / 变更 | 资源闭合 | 动作 | 附加事实 |
|---|---|---|---|
| 旧 projection 中不存在的新 Task | 不适用 | `add` | 无 |
| 非 accepted Task 明确 `remove` | task/run/workspace/resource 均 terminal 且 quarantine/release | `supersede` | 无 |
| 定义、依赖、Condition、write policy、budget 或适用性受影响的现有 Task | 同上且影响可证明 | `reverify` | 受影响 Condition 产生复验事实 |
| 完全不受影响 | 同上 | `keep` | 无 |
| 任一受影响 Task 的绑定 run/workspace/resource 未 terminal 或未 quarantine/release，或影响关系无法证明 | 不闭合/未知 | `block_until_terminal` | `applyAllowed=false`，只返回 attention/block plan |
| accepted Task 的未来适用性改变 | 任意 | `keep` | 独立 `task_applicability_reverify_required` 与 Condition 复验事实；绝不回退或 supersede 历史 status |

资源必须按 task/run/workspace/resource 身份绑定；无关 active 资源不阻塞无关 Task。只要任一受影响资源未闭合，整批不得消费 capability 或 append applied；闭合后才原子追加 consumed/applied。

## 补充根因与边界

foundation 曾生成彼此不同的 suspensionId、在无 active offer 时伪造撤销事实，并把 capability nonce 在签发阶段写入进程内 Set。这使重载后 ownership/消费权威丢失，且 apply 不能与消费原子化。修复将 suspensionId 复用于事件，只有 active offer 才输出撤销事件；签发不消费 nonce，协调结果返回同一批 consumed/applied 事件并依据 projection 的 nonce digest 拒绝重放。Root Broker 的 stop 失败只返回稳定 attention code，不透传上游错误。

## 本轮补充发现

1. Task projection 自身的 `dispatched`、`running`、`settling`、`disposing` 状态，以及其中 workspace 或 executor binding 显示的 active，都是持久化的活动权威；空 inventory 不能覆盖它们。
2. proposal 的 `add` 必须对应不存在的实体，`change` 和 `remove` 必须对应已有实体；Task 与 Condition 均须在生成 capability nonce 或事件前整体拒绝错配。
3. accepted 历史不可回退。accepted remove 仅写入绑定新 revision 的 `not_applicable` applicability 事实；accepted change 的 Condition 复验事实只能引用真实 changed Condition 或依赖，绝不能把 Task ID 伪装成 Condition ID。
