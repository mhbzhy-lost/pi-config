# force review RED 被前置断言阻断

## 1. 现象

HEAD `436599f` 的 `Root force terminal review cleans each observation before the next phase` 将两个行为放在同一测试中：先断言 `recaptureSawWaiter === false`，再断言 `deathSawProof`。当前第一个断言实际为 `true != false`，测试立即失败，后续关于 late artifact proof 的断言不会执行。

因此，测试名称虽然同时覆盖 observation cleanup 与 late continuation，但当前 focused RED 只暴露 graceful waiter 在 recapture 前尚未清理；late artifact 是否会污染 proof 没有独立的 RED 证据。

## 2. 影响

项目约束要求每个行为都有独立 RED，且不得被前置断言阻断。组合测试使两个失败模式共用一个失败出口：修复或改变第一个断言后，才可能发现第二个行为仍然错误。

这会降低 force terminal review 的诊断能力，也会让测试结果无法证明 graceful observation cleanup 与 force observation late continuation 分别受到保护。

## 3. 触发条件与证据

- `436599f` 的组合测试先在 recapture callback 记录 `terminalWaiters.has(runId)` 到 `recaptureSawWaiter`，随后才在 death callback 记录 `terminalProofs.get(runId)` 到 `deathSawProof`。
- 当前 focused 2 RED 中，该测试的第一项为 `assert.equal(recaptureSawWaiter, false)`，实际得到 `true`，因此 `assert.equal(deathSawProof, eventProof.runnerProcessInstanceId)` 未执行。
- 组合测试原本保持 force artifact read pending，使 matching official event 先赢得 proof race；death callback 再释放同 run、不同 `runnerProcessInstanceId` 的有效 late artifact proof。若 force observation 在 death probe 前未完成清理，late continuation 可覆盖 event proof。

## 4. 根因

一个顶层测试同时承担两条独立的异步时序断言，且使用顺序断言。JavaScript 测试在第一个 assertion 抛出后会退出 `try` 的正常路径，即使 `finally` 继续释放 deferred read，也不会执行第二个 assertion。

这里的 RED 证据被控制流耦合，而不是由被测行为耦合。graceful close 资源在 recapture 前是否清理，与 force observation 的 late artifact continuation 是否覆盖 official event proof，必须分别拥有可单独失败的测试。

## 5. 处理决策

将组合测试拆成 3 个顶层 `Root force terminal review` 测试，每项只保留一个行为的 RED：

- A：只测试 close 集成路径中 graceful waiter 是否在 recapture 前清理。继续通过 graceful close 触发 force，并独立断言 `recaptureSawWaiter === false`。
- B：不经过 graceful close，直接对 owned run 调用 `broker.forceCleanup(run, new Error('missing official proof...'))`。保持 force artifact read pending，让 official event 先赢得 proof race；在 death callback 释放 late proof，独立断言 event proof 未被 late artifact 覆盖。该测试直接调用公开 class method，仅作为隔离 graceful 资源的窄单元边界；其 `finally` 仍释放有效 proof 并 close，且不得 patch 真实 signal。
- C：保留 recapture proof 到达时跳过 signal 的行为，独立验证 recapture proof 成立后不发送 signal。

该拆分遵循已决定的边界：force observation cleanup 通过直接 `forceCleanup` 窄单元测试隔离 graceful 资源。测试 fixture 应继续在 `finally` 中释放 deferred read 并完成有效 proof/close，以免异步资源悬挂或影响其他测试。

## 6. 验证

校准后的预期结果为：新 pattern 3 RED、0 cancel；现有 force 测试 8/8；full suite 为 108 PASS、3 RED。三项 RED 分别对应 A 的 graceful waiter cleanup、B 的 late proof 不覆盖 event proof、C 的 recapture proof 跳过 signal，任一项均不会被另一项的前置 assertion 阻断。

本次为 docs-only 记录，不修改 tests 或 production。后续实现时应分别运行 focused force tests 与 full suite，确认 A、B、C 的 RED/GREEN 状态与上述校准值一致。
