# Bug: subagent coding-contract 校验错误缺少可操作的 keypath

**日期**: 2026-08-14
**状态**: 已修复

## 现象

当 executor 的 coding contract 顶层不是对象，或嵌套字段类型错误时，
返回信息不能让模型可靠地定位错误字段。`CodingDispatchContractError` 仅将位置
写入兼容字段 `detail`，extension 的可见文本只显示错误码和消息；例如
`context.knownFacts` 或 `boundaries.writePaths[0]` 没有明确的公开 keypath。

同时，pi-ai 会在调用 extension 的 `execute()` 前使用 TypeBox 校验
`TYPED_SUBAGENT_PARAMETERS`。原有 schema 仅放行了字符串化 JSON，坏的原生
嵌套对象和数组成员仍会在框架层被拒绝，无法到达
`compileCodingDispatchIR()` 已有的点号和索引路径校验器。

## 根因

1. `CodingDispatchContractError` 把校验位置作为未命名的 `detail` 字符串保存，
   extension 的 `failure()` 未将其作为可见文本或结构化 `keypath` 输出。
2. 原 schema 的字符串化 JSON 兼容分支无法让畸形的原生嵌套对象和数组成员到达
   IR 校验器；随后为此加入的无约束 `{}` 回退又错误地接受了数字、布尔值、null
   和不相关的容器类型。
3. 类型错误消息只写了期望类型，没有写入实际运行时类型，模型无法区分字符串、
   数组、null 或数字。

## 错误契约

- 正常工具调用的顶层 schema 始终是 object；数组、原始值和 null 在 framework
  校验阶段被拒绝。直接调用 extension 的防御性分支仍对顶层非对象使用 `keypath=$`。
- 嵌套错误使用点号或索引路径，例如 `context.knownFacts`、`workflow.mode`、
  `boundaries.writePaths[0]`。
- 可见错误文本显式包含 `keypath=<path>`；`details` 同时保留兼容字段 `detail`
  并公开 `keypath`。
- 类型不匹配同时说明 `expected <type>` 和 `received <runtime-type>`。
- 对象或数组字段中的普通 prose 字符串仍会被拒绝；合法的 JSON 字符串对象和数组
  继续由 `compileCodingDispatchIR()` 解析并接受。

## 实现

- `CodingDispatchContractError` 增加命名 `keypath` 字段，原 `detail` 保持兼容。
- IR 校验器将顶层位置从内部的 `contract` 改为 `$`，并统一生成包含期望和实际
  运行时类型的类型错误。
- extension 将 `keypath` 写入可见文本和 `details.keypath`。
- `CODING_SCHEMA` 保留每个字段原有的富结构分支，并增加仅用于路由到 IR 的窄回退
  分支：`requirements` 仅接受数组或字符串；`workflow`、`context`、`boundaries`、
  `acceptance` 和 `execution` 仅接受对象或字符串。畸形的预期容器及其成员会到达 IR
  以获得精确深层 keypath；数字、布尔值、null 和不相关容器仍由 schema 在顶层字段
  keypath 拒绝。
- `TYPED_SUBAGENT_PARAMETERS` 保持 `type: object`，因此 provider 兼容的公共工具
  schema 不会放行顶层非对象；direct `execute()` 的防御性 `$` 诊断保留。
- `workflow.mode=tdd` 的 reason 规则没有修改。

## TDD 验证证据

先更新 `test/subagent-dispatch-validation-errors.test.mjs` 和
`test/subagent-dispatch-schema-coercion.test.mjs`，再执行 RED：

```text
node --test test/subagent-dispatch-validation-errors.test.mjs test/subagent-dispatch-schema-coercion.test.mjs
```

RED 结果：15 个测试中 2 个失败，证明 root 的非对象分支仍被 schema 接受，且 `{}`
回退会让 object 字段接受不相关的数组。

实现后执行 GREEN：

```text
node --test test/subagent-dispatch-validation-errors.test.mjs
node --test test/subagent-dispatch-ir.test.mjs test/subagent-dispatch-ir-coercion.test.mjs
node --test test/subagent-dispatch-schema-coercion.test.mjs
```

结果：四个 focused suites 合计 42/42 通过。覆盖 object-only 根、数组和对象字段的窄
回退、原生与 JSON 字符串化 contracts、畸形嵌套值的 IR 路由，以及 schema 对不相关容器、
数字、布尔值和 null 的拒绝。

另执行了 `node --test test/subagent-dispatch-extension.test.ts`：8/9 通过；首个
spawn 测试在其既有的 1 秒 timeout 下失败，且 generic/control 测试保留 120 秒计时器。
这属于本任务明确排除的 child start timeout 范围，未修改该行为。
