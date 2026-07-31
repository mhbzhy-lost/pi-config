# Bug：pending revived handoff 在 started 迟到时逃逸 Root close

## 1. 现象

`resume()` 已返回新的 Plan Runner actual，但对应 `async-started` 尚未到达。此时 grant 可能成功或进入 retry timer；若 Root close 启动，startup barrier 和 role drain 都看不到该 actual，最终会取消 retry、清空 descriptor、关闭事件订阅并释放 Root。

## 2. 影响

真实 revived Plan Runner 进程可能在 Root shutdown 后继续运行，但没有 Root principal、alias 或 cleanup ownership。Root 无法证明它终止，违反 official terminal proof 才能释放 lifecycle 责任的约束。

## 3. 触发条件

revival 的 `resume()` 成功创建新 actual；其 `async-started` 事件晚于 resume result；Root close 在 started ownership 建立前发生。grant 成功和 grant 失败退避间隔两种路径都可能触发。

## 4. 根因

pending handoff 只保存 `revivedRunId` 与 resume result，不建立可等待的 ownership promise。close startup barrier 只收集已存在的 started observation、grant、revive 和 spawn promise，drain 只遍历 `ownedRuns`；resume result 与 started event 之间没有 lifecycle 屏障。

## 5. 为什么现有测试未发现

revival fixture 不发布 revived `async-started`，却允许 grant 与 alias 在没有 Root ownership 的情况下完成；测试只检查 retry/alias，没有在 started 延迟窗口调用 Root close，也没有要求 close 保留 cleanup debt。

## 6. 修复与验证

resume result 校验后建立与 `revivedRunId + asyncDir + lifecycleSession` 绑定的 started ownership promise，并把它写入 pending handoff。只有 `observeStarted` 接受完全匹配事实并登记 `ownedRuns` 后，revival 才可 grant。ownership promise 同时进入 close startup barrier；started 永不到时 close deadline 必须失败并保留全部 Root 资源，不能进入 release。started 迟到后，close retry按正常 role drain和 official proof继续。测试 fixture 默认发布真实形状的 revived started；专项 RED 关闭自动 started，证明 close 在 deadline 前不能释放，迟到 started 与 official proof 后才能收敛。
