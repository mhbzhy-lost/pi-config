# Bug：bounded-wait 测试在 GREEN 后保留 watchdog timer

## 1. 现象

`test/root-subagent-broker.test.mjs` 的 `closeOutcome()` 使用 `Promise.race()` 比较 close结果与90ms watchdog，但close先完成时没有取消watchdog。Task 8B1 GREEN后，三个测试本体约8ms、23ms、23ms，focused进程总时长仍约263ms。

## 2. 影响

残留timer让测试进程在断言完成后继续存活，掩盖production waiter是否真正释放，并会干扰8B2的artifact polling、force deadline和open-handle验收。随着新增deadline测试，残留timer数量会累积，造成不稳定时长和错误的资源债判断。

## 3. 触发条件与证据

- `closeOutcome()` 创建 `setTimeout(..., watchdogMs)` 后只返回 `Promise.race()`，没有保存或clear timer。
- 父级运行 `node --test --test-name-pattern='Root shutdown bounded wait' test/root-subagent-broker.test.mjs`：三项均PASS，单项约8/23/23ms，总duration约263ms。
- `f5dd0a9` 已使production stop-failure waiter从约253ms降至约1.4ms，因此剩余等待可归因到test helper。
- 当前RED阶段watchdog自身获胜，所以问题只在GREEN或close提前reject/resolve时暴露。

## 4. 根因

helper只表达了“先到结果”，没有为输掉race的timer建立所有权和cleanup。Promise settle不会自动取消另一个分支的底层timer；timer仍由Node event loop持有直到90ms回调执行。

## 5. 处理决策

- `closeOutcome()` 保存timer handle，并在 `finally` 中clear。
- watchdog获胜时仍保留原`{state:'watchdog'}`结果；只改变已结束race的资源清理，不弱化任何行为断言。
- 不使用`unref()`代替clear；测试需要证明自己释放资源，而不是让进程忽略资源。
- 该修复属于已有三项GREEN直接覆盖的test-only helper hygiene，不新增production行为；随8B2 tests-only checkpoint单独保留明确diff边界。

## 6. 验证

1. bounded-wait focused仍为3/3。
2. 三项close提前完成后没有90ms watchdog handle残留；总duration不再按每项watchdog串行累积。
3. 8B2新增polling/force RED即使失败也在finally完成broker teardown并自然退出。
4. Root Broker全量和`git diff --check`保持通过或仅出现预期8B2 RED。
