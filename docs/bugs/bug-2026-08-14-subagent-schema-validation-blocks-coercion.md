# Bug: schema 验证层拦截了 ir.ts 的字符串化 JSON 兼容逻辑

**日期**: 2026-08-14
**状态**: 修复中
**关联**: bug-2026-08-14-subagent-stringified-json-fields.md（ir.ts 层修复）

## 现象

ir.ts 的 `coerceContractFields` 已正确实现字符串化 JSON 转换，
但模型（qwen3.8-max 等）派发 executor 时仍然报错：

```
Validation failed for tool "subagent":
  - requirements: must be array
  - workflow: must be object
  - context: must be object
  - boundaries: must be object
  - acceptance: must be object
  - execution: must be object
```

## 根因

验证分两层，执行顺序为：

1. **框架层**：pi-ai 的 `validateToolArguments()` 用 TypeBox `Compile`
   编译 `TYPED_SUBAGENT_PARAMETERS` JSON Schema，在调用 `execute()` 之前
   校验参数。`CODING_SCHEMA` 中 `workflow` 声明为 `type: "object"`、
   `requirements` 声明为 `type: "array"` 等，字符串值直接不通过。

2. **业务层**：`execute()` 内部调用 `compileCodingDispatchIR()`，
   其中 `coerceContractFields()` 负责将字符串化 JSON 解析为对象。

框架层先于业务层执行，字符串化字段在框架层即被拒绝，
`coerceContractFields()` 永远没有机会运行。

## 修复方案

在 `extension.ts` 的 `CODING_SCHEMA` 中，对 6 个可转换字段
（`workflow`、`requirements`、`context`、`boundaries`、`acceptance`、
`execution`）使用 `anyOf: [原始schema, { type: "string" }]`，
让框架层验证放行字符串值。真正的类型校验和转换仍由
`compileCodingDispatchIR()` 负责，不降低安全性。

## 测试

- 测试文件: `test/subagent-dispatch-schema-coercion.test.mjs`
- 覆盖: 字符串化字段通过 schema 验证、原生对象仍通过、
  完整 stringified payload 通过、无效 payload 仍被拒绝
