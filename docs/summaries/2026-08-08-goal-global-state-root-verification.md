# Goal Engine 全局状态目录验证

## 结论

Goal Engine 已支持通过 `PI_CODING_GOAL_DIR` 保存新产生的结构化状态，并按 Pi Extension 的 canonical cwd 建立独立 namespace。Goal 不绑定 session ID；同一 cwd 的新 Pi session 可恢复同一 Goal，不同 cwd 即使共享物理全局根也不会共享 registry。

当前 `planned-goal` 仍安全固定在 `/Users/mhbzhy/pi-config/.state/goal-engine`。实现不会复制、移动或改写这个 active legacy Goal；它完成后，同 cwd 的下一个新 Goal 才切换到全局根。

## 环境变量

`scripts/pi-shell.zsh` 使用：

```zsh
export PI_CODING_GOAL_DIR="${PI_CODING_GOAL_DIR:-$_PI_CONFIG_ROOT/var/goals}"
```

该表达式满足：

- 默认值为 `/Users/mhbzhy/pi-config/var/goals`；
- 用户预设的绝对路径原样保留；
- 不从 `PI_CODING_AGENT_SESSION_DIR` 推导，因此不会把 Goal 状态混入 session JSONL。

环境变量由新启动的 wrapper Pi 继承。当前已运行且启动时没有该变量的 Pi 继续使用 legacy root，避免 reload 时发生隐式搬迁。

## cwd namespace

当前仓库的解析结果示例：

```text
canonical cwd: /Users/mhbzhy/pi-config
namespace:     --Users-mhbzhy-pi-config--_b2c6e439e7c3ae8f
state root:    /Users/mhbzhy/pi-config/var/goals/--Users-mhbzhy-pi-config--_b2c6e439e7c3ae8f
```

namespace 由三部分组成：

1. Pi session 风格的可读 cwd 标签；
2. canonical cwd 的 SHA-256 前 16 位摘要；
3. namespace 内 `identity.json` 的完整 canonical cwd 二次校验。

因此 `/a/b-c` 与 `/a-b/c` 即使可读标签相同，也会得到不同目录。可读部分按 UTF-8 字节截断，完整目录名不超过 240 bytes。

`identity.json` 使用 `0600` 创建，格式为：

```json
{
  "schemaVersion": "goal-engine.cwd-identity.v1",
  "canonicalCwd": "/Users/mhbzhy/pi-config",
  "namespace": "--Users-mhbzhy-pi-config--_b2c6e439e7c3ae8f"
}
```

identity 不一致、文件损坏或同一 goal ID 同时出现在 global/legacy root 时均 fail closed，不覆盖已有文件。

## legacy cutover

状态根选择规则：

| 条件 | 权威 root |
|---|---|
| 未配置 `PI_CODING_GOAL_DIR` | `cwd/.state/goal-engine` |
| 仅 legacy 存在 active Goal | legacy，原地完成 |
| 仅 global 存在 active Goal | global |
| 两侧均存在 active Goal | `GOAL_STATE_ROOT_CONFLICT` |
| 显式 goal ID 只存在一侧 | 该侧 |
| 显式 goal ID 两侧重复 | `GOAL_STATE_IDENTITY_CONFLICT` |
| 两侧均无 active Goal，执行 `goal_init` | global |

legacy Goal 的 event、projection、lease 和 worktree 路径不搬迁，避免破坏 Git worktree registration 和既有绝对 identity。global Goal 的 event、projection、registry、lease 和 Executor worktree 全部位于 cwd namespace 下；Git origin 仍是 ExtensionContext.cwd 对应仓库。

## Git preflight

- legacy root 继续要求 `.state/goal-engine/` 未受跟踪且被 `.gitignore` 忽略；
- global root 不再要求仓库包含该 ignore 规则；
- 有效 HEAD、attached symbolic ref、Git 顶层 cwd 和文件系统可读性检查保持不变；
- cwd 不存在时继续返回结构化 `GIT_INFRASTRUCTURE_ERROR` 和 `stateChanged=false`，不泄漏原生 `ENOENT`。

## 测试隔离

测试不得继承生产 `PI_CODING_GOAL_DIR`：

- Extension 单元测试 wrapper 默认注入空 `goalStateEnv`；
- global 专项用例显式使用临时根；
- 真实 Host 普通 legacy fixture 清除继承值；
- 真实 Host global 用例在 finally 中恢复环境并删除自有临时目录。

这样从新版 Pi wrapper 执行测试也不会写入真实 `var/goals`。

## 验证证据

以下命令已通过：

```bash
node --test test/pi-shell.test.mjs
# 5/5

node --test test/goal-engine-state-scope.test.mjs
# 初始 10/10；外源复审补强权限、symlink 与不可用根目录门禁后 13/13

node --test test/goal-engine-extension.test.mjs
# 初始 124/124；补充空 global status 与非 init cwd 错误门禁后 126/126

node --test test/goal-engine-runtime.integration.mjs
# 18/18

node --test test/goal-engine-extension.test.mjs test/goal-engine-events.test.mjs test/goal-engine-workspace.test.mjs
# 修复一次既有 nonexistent-cwd 错误合同回归后，相关三组回归通过；最终 Extension 单组通过 126/126

npm test
# 830/831；唯一失败为既有 pi/settings.json enabledModels 与 test/migration-contract.test.mjs 期望不一致，和本改动无关
```

真实 Host 专项验证了：

- 两个临时 Git 仓库共享一个 `PI_CODING_GOAL_DIR` 时产生两个 namespace；
- identity 中 canonical cwd 分别匹配两个仓库；
- 同 cwd 新 session 可恢复原 Goal；
- 两个仓库均不产生 `.state/goal-engine`。

## 外源复审

使用 DeepSeek 对 `fb0bbe6..HEAD` 完成两轮上限的穷举式复审：

- Round 1 的真实问题是已存在 namespace/identity 未复验 `0700/0600` 和 symlink；已用 `lstat + O_NOFOLLOW + fstat` 修复并增加 RED。
- Round 2 的真实问题是全局根不可写时泄漏原生错误，以及非 init 操作的 cwd realpath 错误未结构化；已增加 `GOAL_STATE_ROOT_UNAVAILABLE` 和统一 `GIT_INFRASTRUCTURE_ERROR`。
- “空 global root 会使 status 抛 ENOENT”不成立：`store.listGoals()` 对缺失 registry 返回空数组；新增真实 Extension 用例证明 `goal_status` 返回 `NO_ACTIVE_GOAL` 且 global/legacy 均零写入。
- “read 默认 global 会创建 identity”不成立：identity 仅在 global registry 已包含 Goal 时复验；空 status 专项确认无副作用。
- 摘要长度、legacy 非 canonical 字符串和冲突 fixture 等其余项不影响安全：完整 identity 防摘要碰撞，legacy 保留原绝对路径是为了不破坏既有 worktree lease。

按两轮上限停止外源调用；未把外源严重度直接当作修复依据。

## 回滚与后续边界

- 临时取消配置该变量只会让新进程回到 legacy 视图，不会删除 global 状态；恢复相同变量即可重新读取。
- 不允许在 global 和 legacy 两侧手工复制同一个 active Goal；冲突必须人工核验，系统不会自动选择。
- 本次不修改 Goal event schema、task schema、Root Broker、action token 或 session storage。
- 后续多 Git 仓库任务可共享当前 Pi cwd 对应的这个控制面根；外部目标仓库不得创建自己的 Goal state。
