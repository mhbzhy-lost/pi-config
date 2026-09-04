# Subagent attention 控制提示与实际 Supervisor 消息重复展示

## 现象

Executor 发出 supervisor request 时，TUI 除了显示实际的 `← executor <title>:` 消息，还显示一张 `Subagent needs attention` 卡片。卡片包含 run、token/tool 统计以及 status、steer、resume、interrupt 调用建议，重复占用大量空间但没有新增用户决策信息。

## 数据来源与分类

- 实际入口：合法 async subagent 在 `contact_supervisor` 等等待点产生 `needs_attention` control event。
- 生成调用链：upstream control event -> `formatControlNoticeMessage()` -> `sendMessage(customType="subagent_control_notice", display=true)` -> upstream `SubagentControlNoticeComponent` renderer。
- 权威身份与顺序：control event 的 run、agent、step、activity facts 由当前 async runner 产生；同一等待点还通过 native supervisor channel 发送实际 request。
- 首个偏离点：增强插件保留了 upstream `subagent_control_notice` renderer，导致辅助控制提示与已精简的真实 supervisor request 同时可见。
- 分类：预期 production 数据未被正确处理。事件与消息均由合法 runtime 通道产生。

## 修复边界

增强插件在 TUI renderer 注册层覆盖 `subagent_control_notice` 为空组件。custom message、trigger turn、control event、structured details、session 内容以及主 agent 实际收到的信息均保持不变；实际 `subagent_supervisor_request` 继续展示。
