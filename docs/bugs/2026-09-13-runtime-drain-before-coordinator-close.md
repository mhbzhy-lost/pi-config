# Runtime teardown drain 顺序

## 只读诊断结论

Root runtime 的 production 可达 teardown 链为 `beforeRuntimeDispose` → coordinator runtime close / Root Broker close → workspace service session unbind。诊断确认旧实现先关闭 coordinator，再关闭 Root Broker；因此 Root Broker 已接收且已登记的 child `coordinator.request` 可能在响应返回前失去下游。本文不将未证实的具体 socket 时间窗口写成确定事实。

## 修复目标

保持 coordinator callbacks/transport 可用，先关闭并解绑 Root Broker，等待 integration request、run drain 与 proof delivery，再关闭 coordinator，最后解绑 workspace service 并清理引用。异常路径同样需要尝试完成各项清理并保留可观察 debt。

## Provenance 更新

已确认的首个偏离点是 runtime `beforeRuntimeDispose` 在 Root Broker drain 前关闭 coordinator runtime；这会使已接收的 child `coordinator.request` 失去下游。现场未证实具体 socket 时间窗口，因此不将其写成确定时序。
