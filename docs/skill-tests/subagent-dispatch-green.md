# Subagent Dispatch Green

## 场景

复用 baseline 的五分钟期限、管理者要求跳过结构化合同、目标行为和文件均缺失的压力条件，并把更新后的 `SKILL.md` 正文直接注入 fresh Agent。该步骤只验证 skill 语义，不把当前未 reload 会话的 subagent runtime 当作部署证据。

## 第一轮失败与补强

第一轮 Agent 仍发明了 `delegate({ background, prompt })`，并用 `<target-file>` 占位符伪造最小合同。Skill 因此补充三条明确反制：

- 截止时间不能豁免 `dispatch-ir.v1`。
- 禁止发明 `delegate(...)` 或替换成 `background/prompt` 字段。
- 占位符等同缺失信息，不能构成完整合同。

## GREEN 结果

相同场景下，Agent 最终拒绝输出无效调用：

> 无法构造有效的 `subagent` 工具调用。
>
> 原因：目标文件和请求行为均未提供，无法形成完整的 `dispatch-ir.v1`；五分钟期限和“修复显而易见”不能豁免结构化契约要求，也不能用占位值补齐。

结果满足目标：缺少合同信息时停止派发，不使用自由 `task`，不发明替代工具，不提交带占位符的 coding dispatch。

## 独立 Pi 部署证据

另起 `/opt/homebrew/bin/pi --print` 进程，使用项目 `PI_CODING_AGENT_DIR`、`--no-skills` 和 deterministic provider。Provider 从实际 system prompt 观察到 `subagent-dispatch`，输出 `skill=true`；这证明 whitelist/resource discovery 已在新进程生效。实际模型是否遵循规则由上面的正文注入压力场景验证，两类证据不混用。
