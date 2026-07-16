# Bug：兼容性测试猜测 Subagent 终态为 completed

## 1. 现象

真实 async worker 已退出且 `exitCode: 0`，`status.json` 已完整生成，但测试断言 `state === "completed"` 失败，实际值为 `"complete"`。

## 2. 影响

已成功的 spawn、模型执行和 artifact 落盘被误报为失败，后续 status/interrupt/stop 测试无法继续；若把错误枚举带入 Plan projection，会导致真实终态永远无法识别。

## 3. 稳定复现

运行 `PI_REAL_BIN="$(command -v pi)" node --test test/pi-subagents-runtime.integration.mjs`。status artifact 显示 `state:"complete"`、step `status:"complete"`、`exitCode:0`，测试末尾稳定得到 `actual 'complete' / expected 'completed'`。

## 4. 证据

本次真实 artifact 的 `lifecycleArtifactVersion` 为 `1`，顶层和 step 均使用 `complete`。worker session、transcript、model attempts、tokens 和 endedAt 均存在，证明不是未完成或截断状态。测试中的 `completed` 没有上游类型或 artifact 依据。

## 5. 根因

集成测试根据自然语言习惯猜测 lifecycle 枚举，没有以 `pi-subagents` v1 artifact schema 和真实 `status.json` 为事实源。`completed` 与领域层未来可能使用的命名混淆，但 runtime 层必须保留上游原始 `complete`。

## 6. 修复与验证策略

保持当前真实失败作为 RED，把 runtime 断言改为 `state === "complete"`，并额外断言 step `exitCode === 0`、sessionFile 和 outputFile 存在。Plan 领域 projection 后续可映射自己的状态，但 artifact reader 不重命名上游枚举。重跑真实 spawn GREEN 后再开始下一项。
