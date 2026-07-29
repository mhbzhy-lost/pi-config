# Plan revision store 阻断 amendment 准备

## 现象

v3 计划的 revision 2 使用监督请求发起的 amendment 准备会被 Store 拒绝。已发布的 IR artifact 即使只被重排 JSON 格式并同步更新 manifest 文件哈希，也仍可能被读取或作为幂等准备结果接受。

## 影响范围

后续批准修订无法冻结，监督请求流程中断。正式 artifact 的字节合同失效，异常写入可把非 Store 生成的字节伪装成有效 revision；Host 返回其他准备结果的身份时，Launcher 缺少回归保护。

## 复现步骤

1. 准备 revision 1 的 v3 计划，再以 revision 2、非 `initial-approval` 原因和 `supervisor-request` 发起人调用 `prepareRevision`。
2. 当前 Store 抛出仅允许 revision 1 初始批准的错误。
3. 将正式 `plan-ir.json` 仅改为另一种 JSON 空白格式，并更新 manifest 的 `irArtifactSha256`，随后读取 revision 或用相同输入重试准备。

## 根因

v3 身份条件把 revision 不为 1 与初始批准身份约束合并，误将 amendment 也拒绝。artifact 校验比较解析后的 JSON 语义，没有比较 Store 确定性编译产生的规范字节；候选回读亦未完整比对本次写入内容。

## 修复方案

分别约束 revision 1 的 Launcher 初始批准和 revision 2 以上的非初始监督 amendment。将 artifact 与 manifest 的校验收紧为规范 JSON 字节及完整字段形状，并在候选发布前逐字节回读 source、IR 和 manifest；补充 Host 五项身份不一致时的清理测试。

## 验证方式

新增 revision 2 amendment、真实 candidate、artifact 格式重排、候选回读和 Host revision/hash 串线测试。运行 revision、Launcher、Host 聚焦测试及 IR 回归测试。
