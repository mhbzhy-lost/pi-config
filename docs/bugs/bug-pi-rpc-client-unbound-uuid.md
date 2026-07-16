# Bug：Subagent RPC Client 未绑定 Web Crypto randomUUID

## 1. 现象

外层 `/compat-probe` 已成功执行，但调用 `createSubagentsRpcClient(pi.events).call("ping")` 时抛出 `Value of "this" must be of type Crypto`，请求尚未发送到 event bus。

## 2. 影响

默认配置下 RPC client 完全不可用；只有单元测试显式注入 `randomUUID` 时才能通过，导致测试无法覆盖真实宿主默认路径，Task 1 的真实 ping 被阻断。

## 3. 稳定复现

运行 `PI_REAL_BIN="$(command -v pi)" node --test test/pi-subagents-runtime.integration.mjs`。Pi command 和 prompt response 均成功，临时 Extension 在 client 生成 requestId 时稳定抛出 Crypto receiver 类型错误。

## 4. 证据

`scripts/probes/pi-subagents-compat.mjs` 将默认参数直接赋值为 `crypto.randomUUID`，随后以裸函数 `randomUUID()` 调用。Pi Extension 的 Web Crypto 实现要求方法 receiver 为原 `Crypto` 对象。现有全部 client 单元测试都注入箭头函数，因此没有执行默认分支。

## 5. 根因

依赖注入默认值保存了需要 receiver 的宿主方法引用，调用时丢失 `this`；测试设计又只覆盖注入路径，未覆盖生产默认路径。这是 JavaScript method extraction 的调用约定错误，不是 `pi-subagents`、Pi event bus 或认证兼容问题。

## 6. 修复与验证策略

先增加不传 `randomUUID` 的回归测试并观察当前实现抛出 Crypto receiver 错误；再把默认值改为 `() => crypto.randomUUID()`，保持显式注入接口不变。单元 GREEN 后重新运行真实 ping；只有 ping 返回 version、methods 和 capabilities 后才继续验证其他 method。
