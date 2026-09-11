# bug：shared execution 的 AuthorizedDispatch brand 可被同 description symbol 伪造

## 现象

`dispatchExecution()` 要求 Host-only 的 `AuthorizedDispatch` envelope，但校验逻辑按 `Object.getOwnPropertySymbols()` 查找 `symbol.description === "authorized-dispatch"`。任何调用方都能用 `Symbol("authorized-dispatch")` 自建一个同 description 的 symbol，构造出结构相同、brand 为 `true` 的普通对象，并通过校验，绕过 T3 建立的 Host-only 授权边界。

## Provenance

- 实际入口：`packages/pi-subagents-enhanced/src/subagent-dispatch/execution.ts` 的 `assertAuthorizedDispatch()`，由 `dispatchExecution()` 在每次 shared execution 调用。
- 权威身份：可信 brand 的唯一权威来源是 `packages/pi-subagents-enhanced/src/subagent-dispatch/execution-contract.ts` 中模块私有的 `AUTHORIZED_DISPATCH` unique symbol，只有 `createAuthorizedDispatch()` 能写入它。
- 事件顺序：public adapter 构造 untrusted request -> Host 调用 `createAuthorizedDispatch()` 产出 branded envelope -> `dispatchExecution()` 校验 brand -> 交给 execute service。
- 首个偏离点：`execution.ts` 没有引用私有 symbol，而是用可被外部复制的 `symbol.description` 字符串比较代替 identity 比较；`Symbol.description` 是公开可读可重建的元数据，不能作为能力凭证。
- 数据来源分类：**production**。这是已注册的 public typed tool 的正常执行路径，伪造对象可由任意 caller 构造，不依赖手工 projection、mock event 或过期 fixture。

## 影响

授权边界形同虚设：任何能 import `dispatchExecution` 的调用方都可以自造 envelope 绕过 Host grant 的 profile、cwd confinement、isolation 和 capability 限制。

## RED 证据

`test/subagent-execution-contract.test.mjs` 的 “forged envelope with a same-description symbol is rejected” 断言伪造 envelope 必须 fail closed；当前 RED 为 `Missing expected rejection`，即伪造对象被接受执行，准确暴露 description-based 校验缺陷。

## 修复方向

将 brand 校验移入持有私有 symbol 的 `execution-contract.ts`，导出仅供内部深层模块调用的 `assertAuthorizedDispatch()`，用私有 symbol identity 与结构校验；`execution.ts` 删除 description 查找逻辑并调用该内部断言。该函数不加入 package exports、public barrel 或 tool schema。
