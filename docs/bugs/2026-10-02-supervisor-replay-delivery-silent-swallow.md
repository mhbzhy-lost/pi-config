# supervisor replay delivery 失败静默返回

日期：2026-10-02

## 来源分类

分类：预期 production 数据未被正确处理。合法 replay 入口在 delivery sink 抛出异常时进入 `createSupervisorReplay` 的总 catch；原实现只返回 `blocked-unknown`，没有保留诊断证据。

## 首个偏离点与调用链

`replaySupervisor` → `deliverySink.hasDelivered/deliver` → delivery 异常 → `supervisor-replay.ts` 总 catch。安全判定（fail closed 返回 blocked）正确，缺陷仅为丢失原 error/cause。

## 修复边界

增加非阻断 diagnosticSink，携带原始 error/cause 与 phase；diagnostic sink 自身失败不能改变 replay 的 blocked 结果，也不能产生新的静默。
