# writing-plans description 触发范围过窄

## 问题

`writing-plans` 的 frontmatter description 以“当用户提及计划/规划、多步骤实施、DAG 或 Wave 时使用”为触发条件。这会让 Skill 自动发现依赖用户显式说出计划相关关键词；当任务实际包含多个协调步骤、跨模块依赖或关键不确定性时，Agent 可能因用户未使用这些词而漏加载 Skill。

## 影响

漏加载会失去在复杂任务中由 Agent 主动判断书面实施计划是否有助于安全执行的机会。该问题只涉及 Skill 加载启发式，不代表已获授权编写计划。

## 修复

将 description 放宽为基于任务复杂度和 Agent 判断的加载条件，并明确无需用户显式提及计划、规划、DAG 或 Wave。

## 授权门禁

正文中的用户授权门禁本身无问题，继续保持原样：加载 Skill 不等于授权产出计划；未获用户明确授权时直接执行适用任务流程，不创建计划文件。

## TDD 豁免

本任务只修改 `SKILL.md` frontmatter 的一行 description 并新增本问题记录，不修改正文、代码或测试，符合 TDD Skill 的单行逻辑变更豁免。
