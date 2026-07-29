# Plan revision 身份不变量不完整

## 现象

冻结 revision 的 manifest 缺少父 revision 与 IR 版本；读取 artifact 时未从唯一 source 重新编译验证。Host handle 也未保留 source 内容和 Plan 语义哈希，Launcher 未将 Host 返回 handle 回绑到本次准备结果。

## 影响范围

攻击者或异常写入可修改 `plan-ir.json` 的业务内容并重算 artifact 文件哈希，仍被读取或幂等准备接受。不同 revision 或不同 Plan 的 Host handle 还可能在持久化前串线，导致运行身份与批准内容不一致。

## 复现步骤

1. 创建 v3 初始 revision 后，修改 artifact 的业务字段，保留旧 `ir.hash`，并同步更新 manifest 的 `irArtifactSha256`。
2. 调用 `readRevision` 或相同输入调用 `prepareRevision`，当前实现不会比较 source 重新编译结果与 artifact。
3. 令 Host 返回格式和路径都正确、但 identity 字段属于其他准备结果的 handle，Launcher 当前仍会持久化。

## 根因

Task 3 把 artifact 文件哈希与内嵌 hash 当作 IR 语义证明，遗漏了 source 是唯一批准输入这一信任边界。manifest 与 handle 的字段集也没有完全落实批准计划，`writeCurrent` 仍暴露旧的 manifest 参数合同。

## 修复方案

读取和候选发布验证统一从 `source.md` 解析并编译，逐项校验 IR、版本、parent revision、task hashes 及 manifest identity。将 current API 固定为 prepared revision，并扩展及回绑 Host/Launcher 的五项准备身份。

## 验证方式

新增 v3 fixture、artifact 篡改、revision 2 拒绝、candidate/current 生命周期及 Host identity 串线测试。运行 revision、Launcher、Host 聚焦测试和 IR 回归测试，并执行 diff 与暂存范围检查。
