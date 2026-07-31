# Bug：Root-owned Supervisor push 未作为 follow-up 投递

## 症状

真实A2中Root session持久化了4个唯一Supervisor request，但一个Plan只有2个waiting-attention，另一个Plan的2个Attempt保持active。缺失Plan的task-1发生在旧generation最后agent turn已settle、process terminal尚未观测的窗口；task-2已触发queued-push revival，却仍未进入新generation的canonical session。

四个Executor都已exact一次调用 `contact_supervisor`，Broker也为缺失Plan创建了queued-push revival，因此不是native request缺失、owner推断或requestId碰撞。

## 影响

Supervisor request可能被Broker标记delivered并从FIFO移除，但Plan Runner从未形成 `message_end`，Attention事件和durable body永久缺失。Executor持续等待reply，Plan卡在active，Harness最终超时。

这同时破坏active generation尾部投递和revived generation subscription-ready flush两条路径，属于消息丢失而非延迟。

## 复现

1. Plan Runner派发两个typed Executor后进入最后一个`plan_status` turn并即将settle。
2. 在agent turn结束、process terminal proof到达前让第一个Executor发送Supervisor request；socket尚存，Broker direct write成功。
3. 在proof后让第二个request进入logical FIFO并触发revival。
4. 观察旧/新generation都没有对应custom message，Plan仍active；Root session仍可看到四个native request。

## 根因

`root-owned-subagent.ts`对Supervisor push使用 `pi.sendMessage(message, { triggerTurn: true })`。该选项在正在settle的turn尾部或`before_agent_start`期间收到push时，不保证把custom message安排到当前turn之后。

同模块lifecycle路径已使用 `deliverAs: "followUp"`，因此能跨相同边界安排后续turn。Supervisor路径遗漏了该语义。

## 修复

Supervisor request的 `sendMessage` options改为exact `{ triggerTurn: true, deliverAs: "followUp" }`。保留customType、content、details、display和requestId dedupe不变。

不修改Broker FIFO、owner推断、revival或subscription-ready协议；修复点只负责Pi session内的后续turn投递。

## 验证

先收紧现有`mirrors Supervisor request pushes as an exact Plan Attention`单测，使当前实现因缺失`deliverAs`而RED；最小一行GREEN后运行adapter全量、Plan Capsule/provider、Root revival和Root Broker回归。

随后冻结新HEAD唯一运行A2，必须得到4个Attention完整roundtrip、双Plan validated、全actual official terminal、PID ESRCH、close.completed和socket ENOENT。旧HEAD `18f2e0d...`严禁重跑。
