# Bug: Task 5A2 pending replay 未锚定完整 tool 与权威 workspace lease

## 症状

Task5A2 最终 production diff 已能拒绝 contract、output、dependency receipts、revision 与 context hash 篡改，但独立复审发现两条仍可通过的自洽事件变异：只改 `attempt.dispatch-requested.tool.task` 等执行字段；或同时改 allocation/dispatch 事件的 workspace、contract cwd 与 contract hash。

## 影响

前者会污染 supersede recovery 仍会读取的 `agent/task/cwd/output/timeoutMs`，导致无法定位或错误恢复未绑定 dispatch。后者可让待派发 contract 指向不属于 allocator authoritative lease 的目录，绕过 Attempt workspace ownership。两者都会让 durable intent 脱离 current IR 或权威物理资源身份。

## 复现

1. 生成合法 pending intent，仅把 dispatch event 的 `tool.task` 改为另一段合法 prompt，保持 contract、toolHash 和 dispatchContextHash 不变；当前 `prepareAuthorizedDispatches()` 仍返回 `dispatch-required`。
2. 生成合法 allocation + dispatch 事件，同时把两者的 workspace `path/ownerToken` 改成 forged lease，同步修改 `tool.cwd`、contract `execution.cwd` 并重算 contract/toolHash；current context hash 不含 workspace，reducer 保持自洽，当前 prepare 仍返回 forged contract。
3. `plan-runner-dependencies.mjs` 的 supersede recovery 仍从 `attempt.tool` 读取 `agent/task/cwd/output/timeoutMs`，所以这些字段不是可忽略的历史冗余。

## 根因

Coordinator 只重建 typed contract 与动态 output/receipts，没有重建并比较完整 durable tool descriptor。workspace expected contract 又以 projection 事件中的 `attempt.workspace.path` 为输入，而没有调用 attempt-workspace 的 authoritative lease reader；事件自身无法充当独立信任根。

## 修复

Coordinator 用同一 helper 从 current IR、Attempt identity、authoritative output/receipts 和 expected contract 重建完整 tool，并对 pending `attempt.tool` 做 deep strict equality，保留现有 contract 双重 compile/hash 与 context hash 门禁。

为 Coordinator 注入 `inspectWorkspace` capability。每个 pending 在返回前构造完整 lease identity并调用 validator；Plan Runner dependencies 将现有 `inspectAttemptWorkspace` 接入。Validator 只验证 lease ownership/repository identity并允许已启动 Executor 的 dirty/advanced HEAD，不把 allocation-event 前的 pristine 条件错误扩张到 pending dispatch。

## 验证

先提交 tests-only RED：完整 tool self-consistent tamper 与 workspace/contract self-consistent tamper 均在 reducer 接受后以 `Missing expected rejection` 失败，并断言零 allocation、零 append。Dependencies 测试证明 production 默认 `inspectAttemptWorkspace` 被传给 Coordinator pending replay。修复后 Coordinator、Attempt Workspace、Plan Runner Dependencies、Events/IR/dispatch IR 聚焦与完整回归全部通过，再执行独立复审。
