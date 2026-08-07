# Bug：新 dispatch-ir.v1 错将 acceptance.commands 作为可执行输入

## 一、现象

新 `dispatch-ir.v1` 同时接受 `acceptance.criteria` 与 `acceptance.commands`，并把 commands 写入 canonical hash、子代理 prompt 和 RPC spawn 的 `acceptance.verify`。

## 二、影响

调用方可通过本应仅声明验收目标的 dispatch contract 注入命令；同一任务的 hash、prompt 和 RPC 载荷因此依赖可执行字符串，破坏 criteria-only 新控制面边界。

## 三、原因

初版 IR、JSON Schema、prompt 和 spawn adapter 沿用了旧 acceptance.commands 模型，未在新 strict schema 与旧日志只读 replay 之间切断写入路径。

## 四、修复方案

`dispatch-ir.v1` 的 acceptance 严格只允许非空 `criteria`。将 `commands` 视为 unknown field 拒绝；canonical IR/hash、prompt 和 RPC spawn 均不产生或转发 commands/verify。v1/v2/v3 历史记录的 commands 仅由其 legacy replay decoder 只读处理，不通过本新 dispatch parser。

## 五、验证

先增加 RED 用例：含 commands 的 contract 被拒绝，且编译的 prompt 与 RPC spawn 不含 commands 或 `verify`。实现后运行：

```sh
node --test test/subagent-dispatch-ir.test.mjs test/subagent-runtime-membrane.test.mjs test/subagent-dispatch-rpc.test.mjs
```

## 六、残余风险

本次只收紧新 `dispatch-ir.v1` dispatch 边界；历史 v1/v2/v3 replay 的 decoder 不在本改动范围，仍须由其独立迁移回归保证只读兼容。
