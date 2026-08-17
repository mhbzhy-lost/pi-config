# legacy Goal dispatch 泄漏 acceptance.commands

## 复现

legacy supersede replacement 为兼容旧 Goal reducer，会在 Goal projection 内部继承历史 `acceptance.commands`。该信息用于旧日志 replay 和 Goal 主控验收，必须保留。

但 `goal_dispatch` 调用 `compileTaskContract` 时曾将该合同原样作为 transport：`acceptance` 同时包含 string `criteria` 与 `commands`。当前 Subagent typed tool 的 schema 是 criteria-only，因 `acceptance.commands` 为 additional property 而拒绝合同，Executor 未启动。

## 修复边界

Goal→Subagent transport 必须始终只携带 `acceptance.criteria`。legacy `commands` 仅保留在 Goal projection，作为只读历史及主控验收信息；不进入 transport requirements、acceptance 或 contract hash。`dispatch-ir` 的直接 compile/render 历史兼容 ABI 不在本缺陷修复范围内。
