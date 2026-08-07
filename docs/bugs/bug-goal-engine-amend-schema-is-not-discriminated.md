# Goal Engine amend schema 缺少顶层对象声明

- **现象**：Pi 通过 DeepSeek 发送任意请求时返回 400，提示 `goal_amend` schema 的顶层 `type` 为 `null`，即使本轮没有调用该工具。
- **影响**：DeepSeek 会在生成回答前拒绝整个工具清单，因此所有启用了 Goal Engine 工具的请求均无法发送。
- **根因**：`goal_amend` 改为七分支 `anyOf` 判别联合后，schema 顶层未保留 `type: "object"`；本地 Host 接受该标准 JSON Schema 形状，但 DeepSeek 要求函数参数 schema 显式声明顶层对象类型。
- **触发条件**：Goal Engine 扩展启用、`goal_amend` 位于当前 active tools 中，并使用会严格校验函数参数顶层类型的提供商。
- **修复方案**：在不改变七个对象分支及合法参数集合的前提下，为联合 schema 增加顶层 `type: "object"`。
- **验证与回归**：注册真实扩展后断言 `goal_amend.parameters.type === "object"` 且七个严格 `anyOf` 分支仍然存在；运行 Goal Engine 单元测试与真实 Pi Host 集成测试。
