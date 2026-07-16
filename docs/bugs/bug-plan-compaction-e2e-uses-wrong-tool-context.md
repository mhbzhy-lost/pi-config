# Plan Compaction E2E 使用错误 Tool Context 参数

## 现象

真实 compaction E2E 调用 test-only `compact_plan_session` 后返回 `ctx.compact is not a function`，session 中没有 `compaction` entry，Plan 停止继续执行。

## 影响范围

仅影响新增 compaction E2E fixture；生产 Plan tools 使用正确的五参数签名，不受影响。

## 复现步骤

运行 `PI_REAL_BIN="$(command -v pi)" node --test --test-name-pattern="real Plan Runner compacts" test/plan-capsule.integration.mjs`。session JSONL 显示 tool result 为 `ctx.compact is not a function`。

## 根因

Pi 0.80.6 tool execute 签名是 `(toolCallId, params, signal, onUpdate, ctx)`；fixture 最初错把第二参数当 ctx。修正签名后又暴露 `ctx.compact()` 会先 abort 当前 agent operation，从正在执行的 tool 内触发会等待该 tool 自身结束，形成死锁。默认 `keepRecentTokens=20000` 也会让短 fixture 无内容可压缩。

## 修复方案

test-only marker tool 只结束当前 turn；Extension 在随后的 `agent_end` 从事件 ctx 触发一次 compaction，并用 project settings 将 `keepRecentTokens` 调低。仅在 `onComplete` 后发送专用 marker follow-up；deterministic provider 只在该 marker 与 marker tool 同时存在时调用 `plan_continue`。

## 验证方式

真实 session JSONL 必须出现 `plan.created → compaction` 顺序；之后同一 Plan 继续 nested worker 与 Gates，最终 `validatedHead` 等于 worktree HEAD。结束后确认无残留 runner/Pi。
