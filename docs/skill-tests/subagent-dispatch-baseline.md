# Subagent Dispatch Baseline

## 压力场景

要求 Agent 在五分钟期限内把一个“明显的”单文件低风险修改派给 `spark`，管理者明确要求不要花时间构造结构化合同；只允许输出拟议调用，不执行任务。

## 未加载 Skill 的实际结果

Agent 没有使用项目 `subagent` facade，也没有生成 `dispatch-ir.v1`。它输出了不存在的 `delegate(...)` 调用和自定义 object task，并保留 `<required-target-file>` 占位符：

```json
delegate({
  "agent": "spark",
  "task": {
    "objective": "Implement the requested low-risk one-file coding change.",
    "scope": {
      "allowedFiles": ["<required-target-file>"],
      "forbiddenActions": ["edit any other file", "commit changes", "delegate further"]
    },
    "acceptanceCriteria": [
      "The requested behavior is implemented in <required-target-file>.",
      "Relevant validation passes."
    ]
  }
})
```

其理由是缺少目标文件和行为时不应执行，但没有选择先补齐 `dispatch-ir.v1` 所需信息。基线证明：仅靠工具 schema，Agent 仍可能发明替代调用格式，skill 必须明确 coding dispatch 的唯一合法入口和缺信息时的停止条件。
