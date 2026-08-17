# Bug: 模型输出嵌套字段为 JSON 字符串导致 subagent 派发失败

**日期**: 2026-08-14
**状态**: 已修复
**影响**: 使用 qwen3.8-max、gpt-5.6-sol 等模型时 subagent 派发连续失败

## 现象

在 `~/new-api-account-pool/` 项目的 pi 会话中，subagent 派发失败 87 次。
错误信息：

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

部分模型（qwen3.8-max、gpt-5.6-sol）在 function calling 时将嵌套对象/数组
输出为 JSON 字符串而非实际对象：

```json
// ❌ 模型输出（错误）
{
  "workflow": "{\"mode\": \"tdd\"}",
  "requirements": "[\"需求1\"]"
}

// ✅ 期望输出（正确）
{
  "workflow": {"mode": "tdd"},
  "requirements": ["需求1"]
}
```

这是模型的 structured output 能力问题，不是 pi schema 设计问题。
Claude Opus 和 Peach-07-17-DogFooding 不受影响。

## 失败分布

| 错误类型 | 次数 | 占比 |
|----------|------|------|
| 使用不存在的 `action: "resume"` | 25 | 28.7% |
| 缺少必填 `agent` 字段 | 25 | 28.7% |
| 嵌套字段为字符串 | 15 | 17.2% |
| 空 writePaths | 9 | 10.3% |
| 输出 token 截断 | 7 | 8.0% |
| writePaths 超 32 项 | 2 | 2.3% |

本修复针对「嵌套字段为字符串」类型（15 次，17.2%）。

## 修复方案

在 `scripts/lib/subagent-dispatch/ir.ts` 的 `compileCodingDispatchIR` 入口
添加兼容层，对 `workflow`、`requirements`、`context`、`boundaries`、
`acceptance`、`execution` 六个字段进行透明转换：

- 检测值是否为字符串且以 `{` 或 `[` 开头
- 尝试 JSON.parse，成功则替换为解析后的对象/数组
- 解析失败则报错（malformed JSON）
- 非 JSON 字符串保持原样，由后续校验报错

## 测试

- 测试文件: `test/subagent-dispatch-ir-coercion.test.mjs`
- 覆盖: 各字段单独转换、全部同时转换、hash 一致性、无效 JSON 拒绝、
  错误类型拒绝、非 JSON 字符串不转换、空白填充处理

## 不修复的问题

以下问题属于模型能力缺陷，不在 extension 层修复：

- `action: "resume"` 不存在：模型应重新派发而非 resume
- 缺少 `agent` 字段：schema 已明确要求
- 输出截断：需精简 payload 或换模型
- writePaths 超限：需拆分任务
