# 子代理任务终态事件未落盘

## 现象

`task_status` 在 fake child 已发出 `close(0)` 后仍返回 `running`，目标测试因此失败或挂起。

## 影响

后台任务无法可靠报告完成，后续消息无法触发，shutdown 可能对未启动子进程调用 `kill`。

## 复现

运行 `node --test test/subagent-jobs.test.mjs test/subagent-extension.test.mjs`，在 job 启动后发出 stdout 与 close。

## 根因

任务启动是异步调度：`enqueue` 返回时 child 的监听器注册尚未完成，测试以任意 `setImmediate` 推测启动完成，可能在监听器注册前发出 close，事件被丢失。后续整组挂起的实际链路是失败断言触发 finally，shutdown 取消 queued job，但 queued job 的 `started` promise 未 resolve；测试随后等待该同步点。

## 修复与验证

job manager 提供明确的 `started` 同步点；测试等待该同步点后再发出 fake child 事件。queued 取消同样 resolve 此同步点，终态由同一 job 引用更新并只完成一次。调度函数只 await 启动与持久化，不等待 child 生命周期；`finish` 在清理与原子状态写入后以非阻塞方式触发下一次调度。
