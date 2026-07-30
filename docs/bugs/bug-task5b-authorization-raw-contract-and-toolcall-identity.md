# Bug: Executor authorization 未绑定原始合同与 toolCallId

## 症状

Boundary 只比较 compiler 的 canonical hash，没有比较 model-callable 输入与 event 中持久化 contract 的原始结构；`toolCallId` 也未验证或建立唯一映射。带首尾空格、重复数组项或 cwd lexical alias 的输入可归一化成相同 hash，并以 `executing(undefined)` 或复用的 toolCallId 消费授权。

## 影响

Boundary 无法证明模型逐字段原样调用 Event Writer 提交的 contract。Task6 需要按唯一 toolCallId 绑定 `tool_result`，缺失或跨 Attempt 复用会让结果归属不确定；canonical-equivalent 改写还会给后续 transport 新增非 canonical 字段语义时留下旁路。

## 复现

1. 在合法 contract 的 title 两侧加空格、requirements 添加重复项，或把绝对 cwd 改为可解析到同一路径的 lexical alias。
2. 重新 compile 后 hash 与持久化 `toolHash` 相同，当前 Boundary 允许并消费。
3. 省略 `toolCallId` 仍返回 `state: executing, toolCallId: undefined`。
4. 两个独立 Attempt 使用同一 toolCallId 都可授权。

## 根因

实现把 canonical semantic identity 当成“原始 exact contract”，且 one-shot Map 只以 `dispatchId + toolHash` 为 key，没有保存 executing toolCallId 的全局唯一关系。

## 修复

在 canonical compile/hash 验证之外，用结构化深比较要求输入与 `attempt.tool.contract` 完全相等；要求 toolCallId 为非空字符串，并以独立 Map 保证一个 toolCallId 只能属于一个 dispatch。所有检查完成后再原子写入两个 Map，值保存 executing authorization，而不是布尔值。

## 验证

三个 canonical-equivalent mutation 分别 RED/GREEN，且拒绝后合法原合同仍可授权。缺失、空、纯空白 toolCallId 均拒绝且不消费；跨 Attempt 重用 toolCallId 拒绝，换新 ID 后第二 Attempt 可授权。既有同 Attempt replay 与并行独立授权继续通过。
