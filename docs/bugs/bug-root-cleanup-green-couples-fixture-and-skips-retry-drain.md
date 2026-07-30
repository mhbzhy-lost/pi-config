# Bug：Root cleanup GREEN 耦合 fixture 且跳过 retry drain

## 1. 现象

`0a4e9ca` 为让 B 转绿扩展 `grantCaller()` 返回 `runId`，并用
`recursive: callers.size > 0` 区分 A/B。该实现还以 `teardown.drained` 记录已完成的
drain，使后续 cleanup debt retry 跳过 startup/drain；transport 的 `end` 抛错时，
`endedSockets` 尚未记录该 socket。

## 2. 影响

- 公开的 grant 返回契约泄漏 `runId`。
- grant 删除语义依赖无关的 caller 状态，而不是 grant 自身的清理需求。
- grant/dispose 债务期间的 late owned run 可能未 `stop` 即被 release。
- transport retry 可能重复调用 `end`，破坏 per-socket at-most-once 语义。

## 3. 触发条件

- B fixture 从 `caller.runId` 取得 owned run，而非使用已知的 `callerRunId`，并额外创建了
  与断言无关的目录时，测试会推动生产代码扩展 grant response 并以 caller 集合决定递归删除。
- 首次 cleanup 在 grant 或 dispose 阶段留下债务后，期间有 late owned run 启动；retry 若复用
  `teardown.drained`，便不会再次 startup/drain。
- socket 的 `end` 首次抛错后重试；若标记在 side effect 后写入，同一 socket 会再次执行 `end`。

## 4. 根因

B test 使用 `caller.runId` 而非已知 `callerRunId`，且添加了不必要目录，令 fixture 细节被错误地
提升为公开接口与生产删除策略。cleanup phase 设计错误地把 drain 当成可永久 commit，忽略 retry 前
仍可能出现的 owned run。per-socket at-most-once 标记又晚于 side effect 调用，异常路径无法留下
已尝试结束的事实。

## 5. 修复方案

先以 tests-only 校准 B 与 exact grant response：B 直接使用已知 `callerRunId`，删除无关目录，并断言
grant 只返回 `callerToken`。随后增加 late owned run retry RED 与 end-throw retry RED。待 RED 固定后，
production 恢复仅返回 `callerToken`、以 `rm --force` 非递归删除 grant、每次 retry 重收敛
startup/drain，并在 transport side effect 前记录 per-socket 标记。

## 6. 验证方案

1. tests-only B 证明 grant response 精确为 `callerToken`，fixture 不再依赖 `caller.runId` 或无关目录。
2. late owned run retry RED 证明 grant/dispose 债务后新出现的 owned run 在 retry 中先经过
   startup/drain 与 `stop`，再 release。
3. end-throw retry RED 证明首次 `end` 抛错后，同一 socket 的 retry 不会再次调用 `end`，同时其余
   cleanup debt 仍可继续收敛。
4. GREEN 后运行 Root broker 相关用例，确认 grant 删除不再受 caller 数量影响，retry 每轮重收敛
   drain，且 transport 保持 per-socket at-most-once。
