# Bug：全局 Goal 状态解析绕过 Git 初始化错误合同

## 现象

接入 cwd namespace 后，typed Goal 操作在不存在或不可读的绝对 cwd 中不再返回结构化 `GIT_INFRASTRUCTURE_ERROR`，而是直接泄漏 Node.js `realpathSync()` 的 `ENOENT`/`EACCES`。首次修复只覆盖了 `goal_init`；外源复审进一步发现 `goal_status` 等 read/mutate 操作仍会绕过稳定合同。

## 影响

- typed tool 的稳定错误码和恢复提示发生回归。
- 调用方无法区分 Git/文件系统前置条件失败与 Goal Engine 内部异常。
- 全局状态 cutover 可能在旧 preflight 之前改变错误优先级，破坏既有自动恢复逻辑。

## 根因

新增的 `executionScopeFor()` 在 `assertRepositoryPreflight()` 之前调用 `resolveGoalStateScope()`；后者立即对 cwd 执行 `realpathSync()`。不存在或不可读的 cwd 因此在原有 `realpathForPreflight()` 将异常转换为 `GIT_INFRASTRUCTURE_ERROR` 之前抛出原生文件系统错误。`executionScopeFor()` 的首轮 catch 又限定 `operation === "init"`，留下 read/mutate 缺口。

## 触发条件

1. `ExtensionContext.cwd` 是格式正确的绝对路径；
2. 该路径在文件系统中不存在或无法读取；
3. 调用 `goal_init`、`goal_status` 或其他 typed Goal 操作；
4. 已配置或未配置 `PI_CODING_GOAL_DIR` 均可触发。

## 修复方案

在 `executionScopeFor()` 的 state scope 解析边界捕获 cwd canonicalization 的 `ENOENT`、`EACCES`、`ELOOP` 与 `ENOTDIR`。所有操作返回 `GIT_INFRASTRUCTURE_ERROR` 和 `stateChanged=false`；`goal_init` 保留原修复建议，read/mutate 返回恢复 cwd 后重试 typed Goal 操作的建议。不得创建 global identity、event、registry 或 legacy state。

## 验证方法

- 使用既有“nonexistent absolute cwd”测试作为 RED，确认旧实现返回原生 `ENOENT`。
- 分别以 `goal_init` 和 `goal_status` 触发不存在 cwd；GREEN 后确认错误码、错误文本和 `stateChanged=false` 恢复稳定合同。
- 同时运行 global state root 专项测试和完整 Extension 回归，确认合法 cwd 的 global/legacy 选择不受影响。
