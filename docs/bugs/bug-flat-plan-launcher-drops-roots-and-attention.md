# Bug: 扁平 Launcher 丢失 Root 绑定与 Attention 合同

## 症状
提交 `f58dbb3` 将 Launcher 切换到 Root typed RPC 后，聚焦测试通过，但 Root 侧不再注册 `plan_attention_reply`，原有 Attention 轮询、非交互输入边界和一半 Launcher 回归测试被删除。更关键的是，真实 Plan Runner 仍从 `PI_PLAN_ORIGIN_ROOT` / `PI_PLAN_STATE_ROOT` 创建依赖，而 Root spawn 没有传递这两个值；在普通 Root 环境中直接得到 `stateRoot is required`。

## 影响
用户无法对 durable Plan Attention 作出回复，amendment/parallel Harness 的 Root bridge 失去公开工具。真实 Plan Runner 即使成功产生异步 run，也无法验证 worktree 与 immutable revision store，Task 4 的 mock GREEN 不能证明 flat runtime 可启动。被删除的输入和失败路径测试还会让后续回归静默进入主分支。

## 复现
1. `rg -n "plan_attention_reply" scripts/lib/plan/plan-launcher-extension.mjs` 无命中，但 `test/plan-amendment-harness.integration.mjs` 与 `test/plan-parallel-harness.integration.mjs` 仍直接调用该工具。
2. 在未设置两个 `PI_PLAN_*_ROOT` 变量的环境运行 `createPlanRunnerDependencies({})`，稳定报 `stateRoot is required`。
3. `git diff --numstat 7d754de..f58dbb3` 显示 Launcher 与测试共删除 707 行；Launcher 测试从 12 项降为 6 项。

## 根因
实现把 Task 4 误解成 Standalone Host 消费面的提前删除，整体重写 Launcher 和测试，而不是只替换 spawn/status/stop transport 与 handle identity。旧 Host 承担的 roots 带外传递没有被识别为独立安全合同；测试全部使用 fake broker，未覆盖真实 child extension 初始化。Task 9 才授权删除 Attention poller 与旧恢复面，但该边界也未被保留。

## 修复
先恢复 `f58dbb3^` 的全部仍有效 Launcher 行为和测试，再以增量 TDD 迁移 v4 handle 与 Root RPC。增加 Root-session 私有、identity-bound 的 roots sideband，使 Launcher 在 spawn binding 后发布、Plan Runner async extension 在有界期限内读取，且由 Root broker 生命周期回收；不得把 roots 放入模型提交的 `plan_open`、固定 grant schema或进程全局环境。保留 `plan_attention_reply` 的 current-Root 实现与既有输入/幂等测试；只移除确由 v4 transport 淘汰的 Host 字段和磁盘 handle attach。

## 验证
恢复后的 Launcher 全部历史测试必须先对当前实现 RED，再与新增 v4、Root B、grant cleanup、roots sideband 和真实 ExtensionRunner 测试一起 GREEN。额外运行 Capsule、Root broker、compat、amendment/parallel Harness 的可执行聚焦门禁、`npm run doctor` 与 `git diff --check`；外源 review 的真实 findings 修复后最多再跑一轮。
