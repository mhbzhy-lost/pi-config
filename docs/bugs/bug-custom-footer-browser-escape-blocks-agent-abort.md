# Bug：Subagent Browser 激活时 Esc 无法中断当前 Agent 轮次

## 1. 现象

Custom footer 的 subagent browser 激活后，按 Esc 只退出 child 会话浏览界面；如果主 agent 正在由 subagent completion 通知触发的轮次中执行，该轮次不会被中断，仍会继续输出和调用工具。

## 2. 影响

用户失去对当前模型轮次的即时中断能力。长任务或通知密集场景下，这会表现为主 agent 自动续跑；用户只能退出浏览界面，无法终止当前轮次。Esc 不应永久暂停通知：当前通知被消费后，未来不同 ID 的新通知仍需正常唤醒主 agent。

## 3. 稳定复现

1. 启动一个会产生 child completion 通知的主会话，并进入 footer subagent browser。
2. 在通知触发的主 agent 轮次仍处于 streaming 状态时按 Esc。
3. Browser 退出并恢复原 editor，但主 agent 继续执行。
4. 在 browser 未激活时重复同样操作，Pi 默认 editor 会调用 `restoreQueuedMessagesToEditor({ abort: true })`，最终执行 `agent.abort()`。

## 4. 证据

`pi-tui` 的 `TUI.handleInput()` 先遍历全局 input listeners，只有未被 listener 消费的输入才会交给 focused editor。`pi/extensions/custom-footer.ts` 的 browser controller 在 browser 激活时匹配 Esc，调用 `exitBrowser()` 后返回 `{ consume: true }`。因此 Pi 默认 editor 的 Esc handler 没有执行机会。目标会话在 browser 外按 Esc 时写入了 `stopReason: "aborted"`，证明核心 abort 路径本身有效；其后恢复执行来自 53 秒后到达的不同 completion ID，而不是旧通知重放。

## 5. 根因

Browser 把“退出只读浏览态”和“消费终端 Esc”绑定成了一个动作，没有考虑 streaming 时 Esc 还承担 Pi 保留的 `app.interrupt` 语义。全局 listener 位于默认 editor 之前，一旦返回 `consume: true`，扩展就剥夺了核心中断处理权。

## 6. 修复与验证策略

Browser 激活时的 Esc 仍先退出 browser、恢复 editor 和草稿，但该按键不得被全局 listener 消费，让同一个 Esc 继续到达 Pi 当前 focused editor 并触发默认 abort。为真实 `TUI.handleInput()` 链增加 RED：browser 激活且 streaming editor 收到 Esc 时，browser 退出一次且 editor 的 abort handler 也执行一次；普通导航、Kitty release、Alt+O 和非 Esc 输入仍由 browser 消费。当前 completion 在通知 watcher 接受时已经标记 seen 并删除 result 文件，因此 abort 后不重放；另以不同 completion ID 验证未来通知仍可 `triggerTurn`。
