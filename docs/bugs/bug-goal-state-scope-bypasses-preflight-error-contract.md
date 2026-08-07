# Bug：全局 Goal 状态解析绕过 Git 初始化错误合同

## 现象

接入 cwd namespace 后，`goal_init` 在不存在的绝对 cwd 中不再返回结构化 `GIT_INFRASTRUCTURE_ERROR`，而是直接泄漏 Node.js `realpathSync()` 的 `ENOENT`。既有回归测试因此失败，调用方也失去 `stateChanged=false` 与修复建议。

## 影响

- typed tool 的稳定错误码和恢复提示发生回归。
- 调用方无法区分 Git/文件系统前置条件失败与 Goal Engine 内部异常。
- 全局状态 cutover 可能在旧 preflight 之前改变错误优先级，破坏既有自动恢复逻辑。

## 根因

新增的 `executionScopeFor()` 在 `assertRepositoryPreflight()` 之前调用 `resolveGoalStateScope()`；后者立即对 cwd 执行 `realpathSync()`。不存在的 cwd 因此在原有 `realpathForPreflight()` 将异常转换为 `GIT_INFRASTRUCTURE_ERROR` 之前抛出原生 `ENOENT`。

## 触发条件

1. `ExtensionContext.cwd` 是格式正确的绝对路径；
2. 该路径在文件系统中不存在或无法读取；
3. 调用 `goal_init`；
4. 已配置或未配置 `PI_CODING_GOAL_DIR` 均可触发。

## 修复方案

在 `executionScopeFor()` 的 state scope 解析边界捕获 cwd canonicalization 失败。`goal_init` 必须复用原有 preflight 错误合同，返回 `GIT_INFRASTRUCTURE_ERROR`、`stateChanged=false` 和“修复文件系统访问后重试 goal_init”的建议；不得创建 global identity、event、registry 或 legacy state。

## 验证方法

- 使用既有“nonexistent absolute cwd”测试作为 RED，确认旧实现返回原生 `ENOENT`。
- GREEN 后确认错误码、错误文本和 `stateChanged=false` 恢复原合同。
- 同时运行 global state root 专项测试和完整 Extension 回归，确认合法 cwd 的 global/legacy 选择不受影响。
