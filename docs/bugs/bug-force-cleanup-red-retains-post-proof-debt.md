# force-without-proof RED 在补 proof 后保留 cleanup debt

## 1. 现象

`c77ad58` 的 `Root verified force cleanup rejects force success without official proof` 只为 capture 配置了 initial 与 recapture 两项 exact birth identity。该用例首次 `closeRootSession()` 在 force 后没有 official proof 时，正确拒绝并保留 cleanup debt。

但 fixture 的 capture 数组耗尽时默认返回该 run 的 birth identity。若测试的 `finally` 随后补发 valid official proof，再次 cleanup 时，future production 仍必须执行 force 后的 death probe；该 probe 会得到旧 birth identity，而不是 `unavailable`。因此两次 close 后 debt 仍然存在，并可能留下仍在 listening 的 server。

## 2. 影响

该 RED fixture 不能准确表达 future GREEN 的完整清理边界：valid proof 不是 teardown 完成的充分条件，force 后还必须确认原 birth identity 已不可捕获。默认回退为 birth 会让本应完成的 finally cleanup 保持 fail-closed debt，造成资源残留噪音，并可能遗留 listening server。

若通过删去 production 的 post-force death check 来让测试清理通过，则会违反根因文档 `e3aa002` 所要求的“signal 后仍须 proof 加 death probe”边界，并把真实仍存活的进程误判为已清理。

## 3. 触发条件与证据

- 目标用例为 `c77ad58` 中的 `Root verified force cleanup rejects force success without official proof`，其 captures 是 `["executor-a-birth", "executor-a-birth"]`：initial 与 recapture 都 exact。
- 首次 close 没有 valid official proof，force success 后应拒绝并形成 debt；这一首次行为和断言保持不变。
- fixture 的 `captureProcessBirthIdentity` 对 `behavior.shift()` 耗尽后的默认值是 `identities.get(runId)?.birth`。
- `finally` 的 cleanup 会补发 valid proof 并再次调用 `closeRootSession()`。future production 在此 retry 取得 proof 后，按 `e3aa002` 的边界必须执行第三次、post-force death probe。
- 没有第三项 capture 时，该 probe 默认返回 birth，判断为仍存活，第二次 close 继续保留 debt；这解释了 cleanup 可留下 listening server 的原因。

## 4. 根因

RED 测试为“force 后无 proof”的首次 close 配置了完成 force fence 所需的 initial 与 recapture，却没有为 finally 的“补 proof 后 retry”配置 death probe 的预期结果。fixture 的默认行为是为未特别配置的 capture 提供 birth identity，不是“进程已不可用”。

根因不是 production death check 过严：production 必须在 valid proof 后再 probe，且只有旧 birth identity 不可捕获时才允许 teardown。缺少的是该单一测试 case 的第三个 capture，无法描述 force 后进程已经死亡的预期环境。

## 5. 处理决策

仅校准 `Root verified force cleanup rejects force success without official proof` 的 capture 序列第三项为 `"unavailable"`，使其为：initial exact、recapture exact、post-force death probe unavailable。

不得降低或绕过 production post-force death check；不得修改其余 7 个 RED case；不得改变 fixture 在 capture 数组耗尽时默认返回 birth 的行为。首次 close 的断言也不变，因为无 proof 阶段不应执行第三次 probe：第三项只供 finally 补 proof 后的 retry 使用。

## 6. 验证

本文件只记录 tests-only RED fixture 的 future GREEN cleanup 缺口，不修改 tests 或 production。

- 新 pattern 当前仍应为 8 RED、0 cancel；existing groups 的结果不变。
- future GREEN 下首次 close 仍应在 force 后缺少 official proof 时拒绝并保留 debt，且不消费第三次 capture。
- finally 补发 valid proof 后的 retry 应执行 post-force death probe；第三项 `unavailable` 表示旧 birth identity 已不可捕获，teardown 可完成，不再遗留 listening server。
