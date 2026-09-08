# Idle Pi 短暂 Working 且无可见请求

## 现场

观察到的 Host cwd 为 `~/taoappuse`。当时该 cwd 没有其他活动 Pi session，因此“同 cwd 被重复打开”不是本次 working 闪现的既证前提，不能用重复 session 解释该现场。

Host 在 idle 时短暂显示 working，随后自行消失，期间没有可见请求。视觉 working 状态不等同于模型调用，也不足以证明 completion、queue continuation、UI prompt 或其他 agent start 中的任一来源。

## 当前调用链与身份

`pi-subagents` completion notifier 接收 `subagent:async-complete` 或 `subagent:foreground-complete` 后进行 ownership 判定。foreground 当前只比较 `sessionId`；async 当前同时比较 `sessionId` 与 `completionOwnerId`。被接受的 completion 会调用 `pi.sendMessage`，其默认 `triggerTurn` 为 true。

当前权威身份是 Host 的 sessionId 与 completionOwnerId。completion event 的 sessionId、completionOwnerId 和 source 是待收集的证据，不能从 TUI 状态反推。

## 首个待观测偏离点

此前没有将 completion received、ownership decision、`sendMessage` 参数与可由 ExtensionAPI `pi.on` 观察的 `agent_start`、`agent_end`、`agent_settled`、`ui_prompt_start`、`ui_prompt_end` 放入同一单调时间 trace，因而无法定位 working 前的首个原始事件。当前 ExtensionAPI 没有可订阅的真实 queue subscriber，因此不对 queue 声明 trace 证据。

本任务只在调用方显式启用的本机 trace 文件中记录结构化身份和生命周期元数据；不记录 prompt、task、completion summary 或消息正文，也不改变 notifier ACK、session、event 或 TUI。

## Production 可达性分类

来源尚未证实。尚未对 `~/taoappuse` 当前 Pi 进程执行 attach、停止、重启或注入，也尚未获得一次真实 Host 的有界 trace 复现。只有在 event session/owner/source 证据齐全后，才能分类为 accepted completion continuation、queue/UI 生命周期或其他 agent start。

## T13 复核分类

手工通过 `pi.events.emit(agent_settled)` 制造的 lifecycle 是测试不可达数据，仅删除该 harness 证据。ExtensionRunner lifecycle 仅由真实 `pi.on` 观察；没有把它伪装成 `pi.events` 消息，也没有注册不可达的 queue lifecycle。completion 的 ownership 匹配不构成 accepted delivery。`sendMessage` 无抛出仅记录实际 send-message 观测，因其 API 没有携带 completion/run 因果 identity，probe 不把它与任何 completion、batch、dedupe、suppress 或 lifecycle 记录拼接，统一返回 `unproven`。probe 从截断 tail 丢弃首个 partial line，并严格校验版本、枚举、身份和单调安全时间；坏记录返回有界结构化 unproven。

## Host Smoke 分类

先前“未加载 subagent tools”的 smoke 失败不是 package、trust 或 discovery 缺陷，而是 test harness 继承 `PI_SUBAGENT_CHILD=1` 后，主 Host extension 按既有 child marker 语义正确早退。清除两个 child marker 后，项目配置目录上的受控真实 Host smoke 通过 5/5。该分类不为 child marker 增加 production 兼容分支，不修改 settings，也不接触现有 Host session。
