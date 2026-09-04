# Subagent validation 错误在 TUI 展示完整 Received arguments

## 现象与来源

2026-09-03 taoappuse production session `2026-09-03T03:44:15.606Z` 中，真实 subagent schema validation toolResult 以 `Validation failed for tool "subagent":` 开头，随后包含有用错误列表、空行、`Received arguments:` 和完整长 JSON。Pi validator 生成的完整内容是 agent/session 所需原始事实；问题仅是 subagent TUI renderer 把它全部显示，造成刷屏。

该异常属于预期 production validation result 未被专用 TUI renderer 正确精简（AGENTS 第 1 类），不是 mock 缺字段或手工拼接的不可达状态。

## 首个偏离点与完整调用链

```text
public typed subagent call
  -> Pi schema validator
  -> authoritative toolResult: validation header + errors + Received arguments JSON
  -> project createSubagentToolRenderers.renderSubagentResult
  -> formatCompactSubagentToolResult
  -> 非 status/steer 分支直接返回完整 text
  -> TUI 展示完整 arguments JSON
```

首个偏离点是 subagent 专用 compact formatter 没有识别 validation result 的显示边界。修复只能在 renderer 中截取 `Received arguments:` 之前的 header 与错误列表；原 result、args、details、session 和 LLM 输入必须保持不变，普通 runtime error 继续完整显示。
