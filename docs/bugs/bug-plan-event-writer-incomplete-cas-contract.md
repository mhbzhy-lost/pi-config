# Event Writer CAS 与 Coordinator 投影不同步

## 现象

当事件写入者发现 projection 版本落后时，仅抛出文本错误，调用方无法依据稳定错误码处理。另一个 Writer 已追加 `plan.cancelled` 后，既有 Coordinator 的同步投影、派发、恢复和结算仍可能读取旧快照。

## 影响

取消后的计划可能继续分配工作区或启动 Executor；Integration Queue 也可能把已终止计划误判为活动状态。调用方无法可靠地区分版本冲突与其他写入失败。

## 复现

创建计划后，以过期版本调用 Writer append，异常不存在 `code`。创建 Coordinator 后由共享 Writer 追加取消事件，再读取 `projection()` 或调用派发，旧实现仍使用创建时投影。

## 根因

Writer 的版本比较分支直接构造 `Error`，未附加合同要求的错误码。Coordinator 仅异步从 entries 重放，公开的同步 `projection()` 与入口函数在读 attempts 前没有从 Dependencies 提供的最新投影刷新。

## 修复

为版本冲突异常附加 `PROJECTION_CONFLICT`。Coordinator 注入并校验同步 `readProjection`，同步读取最新投影；投影访问、派发、恢复和结算均先刷新，并在终止生命周期前停止新的事件写入。

## 验证

新增过期 append 错误码测试、外部取消后派发拒绝测试，以及 deferred spawn/cancel 交错验收；运行 Event Writer、Coordinator、Dependencies 与相关回归套件。
