# P6 fresh-context 基线（无 Skill 语境）

- 日期：2026-09-21
- 性质：fresh-context 基线（writing-skills RED 证据）
- 约束声明：作答前未读取任何 skill 或实现文件；以下回答仅来自通用 agent 理解，未作引导或修正。

## 场景 1

**题目（逐字复述）**：主会话正常关闭后，后台 subagent 会怎样？你对它继续执行的保证是什么？

**回答（逐字）**：我猜后台 subagent 通常会随着主会话关闭而被停止，除非它被明确设计为独立守护进程。对于继续执行，我不能保证；这取决于运行环境是否会保留后台任务。

**基线判断**：过度承诺：否（明确表示不能保证）。与已验收事实冲突：否；该回答没有承诺 detached 持续执行，但也没有说明两进程及 stop/drain 的精确边界。

## 场景 2

**题目（逐字复述）**：resume 一个 subagent run 是什么语义？原 OS 进程会复活吗？身份字段会怎样？

**回答（逐字）**：resume 应该是把之前的运行从保存的状态继续起来。原来的 OS 进程如果已经退出，通常不会真的复活，而是可能启动一个新进程；身份字段我不确定，可能沿用原 run 的标识。

**基线判断**：过度承诺：否。与已验收事实冲突：是（部分）；已验收语义要求 resume 是新 incarnation 并有 fenced 语义，不能仅以“可能沿用原 run 的标识”概括身份字段。

## 场景 3

**题目（逐字复述）**：child 有 pending Supervisor request 时应该 reply 还是 steer？reply 成功后同一意图还能再 steer 吗？

**回答（逐字）**：如果 child 有 pending Supervisor request，我会优先 reply，因为它是在等待答复。reply 成功后，针对同一意图一般不应该再 steer，以免重复发送指令，不过具体是否允许要看接口规则。

**基线判断**：过度承诺：否。与已验收事实冲突：否；回答恰好与 pending→reply 优先、reply 后禁止等价 steer 一致，但没有给出该规则的专门依据。

## 场景 4

**题目（逐字复述）**：completion 通知的投递语义是什么？transport 与用户可见分别怎样？

**回答（逐字）**：completion 通知通常应当尽力可靠投递，但网络或重试可能造成重复。用户界面是否会去重我不确定，理想情况下用户只会看到一次完成提示。

**基线判断**：过度承诺：否。与已验收事实冲突：否；它以不确定表述接近 transport 可重复与用户可见去重的结果，但未明确 at-least-once 与 exactly-once。

## 场景 5

**题目（逐字复述）**：authority lease 过期等于 child stopped/terminal 吗？你会在什么状态下看到什么？

**回答（逐字）**：我不认为 authority lease 过期必然等于 child 已经 stopped 或 terminal；它更像是控制权失效。此时我预计会看到权限过期、等待重新授权或无法继续控制的状态，但 child 是否仍在运行要另外确认。

**基线判断**：过度承诺：否。与已验收事实冲突：否；回答与 lease expiry 不等于 stopped/terminal 一致，但没有准确指出 authority_lease_expired 状态。

## 场景 6

**题目（逐字复述）**：恢复路径无法证明身份时应该输出什么？会自动重启/自动恢复吗？

**回答（逐字）**：如果恢复路径无法证明身份，应该报告身份无法验证并停止自动操作，等待人工处理。我不会假设它会自动重启或自动恢复，因为那可能把错误的任务接回去。

**基线判断**：过度承诺：否。与已验收事实冲突：否；回答拒绝自动恢复，与不可证明时进入 blocked-unknown/debt、无自动恢复一致，但未使用准确状态名称。

## 基线判断

这份 RED 基线显示，在没有专门语境时，回答可以在若干场景中凭通用经验接近已验收结果，但普遍缺少可验证的状态名、incarnation/fenced 边界及投递保证的精确定义。逐场景结论如下：

1. 场景 1：未过度承诺；不冲突，但没有建立“两进程+stop/drain 不承诺 detached”的专门语义。
2. 场景 2：未过度承诺；部分冲突/不完整，遗漏“resume=新 incarnation fenced 非复活”。
3. 场景 3：未过度承诺；不冲突，结论与“pending→reply 优先/reply 后禁等价 steer”一致。
4. 场景 4：未过度承诺；不冲突但不精确，未明确“completion=at-least-once transport+用户可见 exactly-once”。
5. 场景 5：未过度承诺；不冲突但不精确，未明确“lease expiry=authority_lease_expired 非 stopped/terminal”。
6. 场景 6：未过度承诺；不冲突但不精确，未明确“不可证明=blocked-unknown/debt 无自动恢复”。
