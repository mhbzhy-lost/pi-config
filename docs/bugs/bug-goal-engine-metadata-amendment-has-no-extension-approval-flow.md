# Goal Engine 元数据修改未接通扩展审批流程

- **现象**：`goal_amend` 虽声明 `update_goal`，但没有由真实 Pi 输入生成审批回执的流程。
- **影响**：代理可能绕过用户确认修改 Goal 元数据，审批身份也无法审计。
- **根因**：扩展未把 input/session custom entry 与 `recordHumanChoice`、proposal hash 和 action offer 连接。
- **触发条件**：代理请求元数据修改，或会话重载后需要继续审批。
- **修复方案**：持久化同会话 proposal/challenge/decision/consumed 生命周期；仅将精确 interactive/rpc 用户选择规范化为回执，并仅为已批准且未过期 proposal 签发 action offer。公共 `goal_amend` 联合必须用 TypeBox-compatible `anyOf`；旧版无 operation 输入补为 `patch_active` 后，`prepareArguments` 仍必须二次 fail-closed。
- **验证与回归**：覆盖 proposal→批准→status offer→apply、拒绝/跨会话/重载/重放，以及真实 Host schema 边界。
