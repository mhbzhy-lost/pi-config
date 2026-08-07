# Bug：Goal Engine 测试继承生产全局状态目录

## 现象

配置 `PI_CODING_GOAL_DIR` 后，既有 Extension 和真实 Host 测试会继承运行测试的 Pi 进程环境。原本应写入临时仓库 `.state/goal-engine` 的 fixture 会改为写入真实全局 Goal 根目录，并导致断言与清理边界失真。

## 影响

- 测试可能污染或覆盖当前 cwd namespace 下的真实 Goal registry、event 和 workspace。
- fixture teardown 只删除临时仓库，无法清理由生产环境变量重定向到仓库外的状态。
- 在未配置该变量的旧会话中测试通过，在新 wrapper 会话中失败，形成环境相关回归。

## 根因

`createGoalEngineExtension()` 的生产默认值正确读取 `process.env`，但测试 wrapper 没有显式注入隔离环境。真实 Host 测试同样直接加载生产 Extension，且测试文件没有在普通 legacy 用例中清除继承的 `PI_CODING_GOAL_DIR`。

## 触发条件

1. 通过新版 `scripts/pi-shell.zsh` 启动 Pi，使 `PI_CODING_GOAL_DIR` 有值；
2. 在该 Pi 中运行 Goal Engine Extension 或 runtime integration 测试；
3. 测试未显式传入临时 `goalStateEnv`，或未在真实 Host 用例中使用临时全局根。

## 修复方案

1. Extension 单元测试 wrapper 默认注入空 `goalStateEnv`，只有 global state 专项用例显式传入临时目录。
2. 真实 Host 测试文件在普通 legacy 用例中屏蔽继承值；`PI_CODING_GOAL_DIR` 专项用例临时设置独立目录，并在 finally 中恢复环境和删除 fixture。
3. 禁止测试使用真实 `var/goals`，也不得依赖调用者恰好未设置环境变量。

## 验证方法

- 先以临时非空 `PI_CODING_GOAL_DIR` 运行既有 legacy init 用例，确认旧 fixture 被重定向并失败。
- GREEN 后在同样的继承环境下运行 Extension 测试，确认仍只写测试自有路径。
- 运行真实 Host 双 cwd 专项，确认只产生两个临时 namespace，仓库 cwd 和真实生产 Goal 根均不受影响。
