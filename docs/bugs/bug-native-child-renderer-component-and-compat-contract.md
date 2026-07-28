# Bug：Native child renderer 与 Pi main 组件及兼容合同不一致

## 1. 现象

Renderer cache key 缺少 `cwd`；恰好 64 MiB 被拒绝；compat probe 只检查 5 个 public exports，少于实现真实 imports；assistant 以 `aborted/error` 结束且 tool 没有 result 时，重建的 tool shell 仍保持未完成状态。

## 2. 影响

同一 session 在不同 cwd 下可能复用错误的 read/edit/find 路径显示。合法的 64 MiB 边界文件违反计划合同。Pi 升级移除额外组件时 compatibility gate 仍会通过，直到 extension import 失败。失败或中止的 child tool 在只读历史中可能永久显示为运行中。

## 3. 稳定复现

- 以不同 `cwd` 和相同其他 options 渲染同一 session，当前 key 相同。
- 创建 exact 64 MiB regular file，`>= MAX_SESSION_BYTES` 直接拒绝。
- 向 compat fake module 只提供现有 5 个函数，gate 通过，但 renderer 还导入 6 个其他 public APIs。
- 创建 stopReason 为 `aborted/error` 且有 toolCall、无 toolResult 的 assistant，tool component 未收到错误 result。

## 4. 证据

Cache key 当前含 realPath/fingerprint/width/expanded/hideThinking/outputPad/theme，但无 `cwd`。Size 条件为 `>=`。Renderer import 列表包含 `BashExecutionComponent`、branch/compaction/custom components、`parseSkillBlock` 和 skill component，probe 未检查。Tool 重建无条件 `markExecutionStarted()/setArgsComplete()`，没有复现 Pi main 在 aborted/error 时向 pending tools 注入 error result 的分支。

## 5. 根因

Task 2 实现只覆盖了计划示例的最小 capability 列表和成功 tool path，没有从真实依赖面反推 compat contract，也没有把所有影响 component 输出的输入纳入 cache key。大小比较把“最大 64 MiB”误读为严格小于。

## 6. 修复与验证策略

先增加 RED 测试：cwd 变化必须重渲染；exact 64 MiB 通过路径边界而 over-limit 拒绝；compat fake 缺任一真实 import 都失败；aborted/error pending tool 显示错误终态；custom entry 文本确实渲染。实现最小补齐 key、`>` 边界、完整 public export gate，并按 Pi main 的 pending-tool error 逻辑重建。不得引入 private Pi imports 或改变 Fleet fallback。
