# Bug: 延后的 upstream shutdown debt 在并发与 reload 下不可靠

## 症状
Root Broker ordered drain 失败后，当前 shutdown handler 抛错，但 Pi 会记录并吞掉该异常并继续 reload。旧 runtime 没有再次执行 shutdown 的机会，其捕获的 upstream cleanup 与项目 RPC cleanup 永远遗失。并发 shutdown 还会重复执行 upstream cleanup；多个 upstream handler 中途失败时，已成功 handler 会在重试时再次执行。

## 影响
失败关闭不能在真实 Pi lifecycle 中偿还 cleanup debt，旧 RPC bridge、监听器和 runtime ownership 可能泄漏或被新 bootstrap 间接销毁。并发和部分失败会重复执行非保证幂等的 upstream 清理，可能破坏新 runtime 或造成资源状态不一致。

## 复现
真实 `DefaultResourceLoader` 执行“第一次 drain 失败 → reload → 新 runtime”时，观察到 `drain-1` 后直接进入第二代 runtime，旧代 `upstream-1`、`project-1` 从未执行。两个并发 shutdown 的顺序为 `drain, drain, upstream, upstream, project`。两个 upstream handler 中第二个首次失败时，重试顺序包含第二次 `upstream-1`。

## 根因
cleanup ownership 仅保存在单个 `createTypedSubagentExtension()` 闭包中，依赖同一 handler 被再次调用；没有放入跨 runtime 的稳定 cleanup registry。`afterBeforeDisposeCompleted` 是异步结束后的单个布尔值，既不是完整 shutdown single-flight，也无法表达每个 upstream handler 的独立完成状态。

## 修复
把未完成 shutdown 流程作为 generation-bound debt 存入现有稳定 cleanup store，并在新 runtime bootstrap 前先偿还旧 debt；失败时阻止新 upstream bootstrap 获得旧资源，同时保留 debt。完整 shutdown 使用 single-flight Promise，失败后清除以允许重试，成功后保持完成。每个捕获的 upstream handler 使用独立 record，成功后立即标记，仅重试失败与未执行项。

## 验证
先新增三个 RED 回归：并发 shutdown 只执行一次 upstream cleanup；多 handler 部分失败只重试失败项；真实 `DefaultResourceLoader`/等价真实 reload 在新 bootstrap 前偿还旧 generation debt。确认旧实现按预期失败后做最小修复，再运行 runtime membrane、生产 resource loader、Root Broker、全量测试及所有最终门禁。
