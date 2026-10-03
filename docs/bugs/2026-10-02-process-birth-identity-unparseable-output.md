# process birth identity 将不可解析 ps 输出误判为身份

日期：2026-10-02

## 来源分类

分类：预期 production 数据未被正确处理。`captureProcessBirthIdentity` 是 coordinator/broker/queue 使用的合法生产入口，实际调用 `ps -ww -p <pid> -o lstart= -o command=`。当前实现只拒绝空输出，对任意非空 stdout 直接计算 SHA-256。

## 首个偏离点

`packages/pi-subagents-enhanced/src/subagent-dispatch/process-birth-identity.ts` 在得到非空 stdout 后直接 hash；`integration-queue.ts` 的独立实现具有相同问题。`garbage` 等不可解析输出因此会产生可用 identity，随后被判定为 `mismatch`，可能回收仍存活的 owner。

## 生成调用链

合法 claim/recovery 入口 → birth identity 捕获 → `ps` stdout → 非空检查 → SHA-256 → registry/queue 的 owner 判定。损坏或不可解析 stdout 在非空检查处未被拒绝，是首个偏离点。

## 修复约束

仅增加格式拒绝，不改变合法 stdout 的原始字节和 hash 输入；非法输出映射为 unavailable/undetermined，不得进入 mismatch。保留 ps 执行异常及 cause 链。
