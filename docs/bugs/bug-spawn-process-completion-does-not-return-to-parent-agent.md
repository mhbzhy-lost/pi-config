# spawn_process 完成后无法唤醒主 Agent

## 现象

主 Agent 调用 `spawn_process` 后结束当前轮次。子 Pi 即使成功退出，主 Agent 也收不到模型可见的完成消息，会话停留在等待状态，无法继续跨仓库编排。

## 影响范围

任何把 `spawn_process` 当作任务委派工具的流程都可能静默中断。Agent 无法自动读取子进程结果、推进依赖任务或报告失败；同时该工具启动的子 Pi 禁用了 session、extensions 和 skills，不能承担完整 Goal Engine 工作。

## 复现步骤

让主 Agent 通过 `spawn_process` 启动一个会正常结束的短任务，并在派发后结束当前轮次。等待子进程退出；Fleet 状态文件会变为 `complete`，但主会话不会新增完成消息，也不会触发后续 Agent turn。

## 根因

`scripts/lib/tui/fleet-extension.mjs` 将子进程以 detached 模式启动并 `unref()`。退出处理器只写入临时 `status.json`，没有调用 Pi 消息投递接口，也没有持久化父子运行绑定或触发父 Agent 继续执行。工具描述却将其暴露为可委派长任务的 Agent 工具，形成错误能力承诺。

## 修复方案

从生产 Pi 的 Agent 工具面移除 `spawn_process`，保留具有完成通知语义的 `subagent` 作为唯一自动委派入口。本次不实现新的跨进程回调协议，也不删除历史运行目录。

## 验证方式

通过真实 Pi `DefaultResourceLoader` 加载生产 `pi/` 配置，断言扩展无加载错误，且最终工具集合中不存在 `spawn_process`。同时运行相关 Pi runtime 与 Subagent 回归，确认现有委派工具仍可用。
