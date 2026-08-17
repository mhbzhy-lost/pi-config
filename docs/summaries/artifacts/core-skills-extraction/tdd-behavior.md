# 本地 TDD Skill 行为验收报告（core-skills-t6-tdd-behavior）

## 依据文件
- `skill-overrides/test-driven-development/SKILL.md`
- `skill-overrides/test-driven-development/writing-good-tests.md`
- `docs/bugs/bug-superpowers-skill-source-coupling.md`

## 场景 A（两行生产逻辑 bug 且无问题文档、无失败测试）
- 结论：**不允许直接开始实现**。需按本 Skill 文档执行“红绿灯”前置流程。
- 依据（SKILL.md）：
  - 修改生产/Skill 逻辑前必须先建立 `docs/bugs/bug-*.md`。
  - 且必须先观察测试出现**正确 RED**（失败原因是行为缺失而非测试错误）。
  - 之后才可进入实现。
  - 还要求在实现时先加载 Skill 并遵循 RED-GREEN-REFACTOR。
- 合规要求确认：
  1. 先建问题记录：是（明确要求 `docs/bugs/bug-*.md`）。
  2. 先看正确 RED：是（文档明确“Verify RED – Watch It Fail”且“MANDATORY. Never skip.”）。
  3. 再做最小 GREEN：是（“Green - Minimal Code”）。

## 场景 B（只改一行纯人审文档）
- 结论：**可豁免**。
- 依据（SKILL.md 项目规则）：可豁免情形包含**单行改动**、**纯文档变更**、或已有测试覆盖。
- 豁免必须显式声明：每次豁免均需在工作说明或交付记录中**显式声明豁免理由**，不能仅因“改动很小”省略。

## RED / GREEN / 豁免证据
- RED 要求（bug 场景）：
  - SKILL.md 明确：`NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST`；`RED - Write Failing Test` + `Verify RED - Watch It Fail`。
  - 同时要求：失败应为特性缺失导致、且非测试错误。
- GREEN 要求（bug 场景）：
  - SKILL.md 明确“最小”实现后再 `Verify GREEN`。
- 豁免证据（纯文档）：
  - 直接条款写明纯文档可豁免；但每次需有明确豁免原因声明。

## 执行命令与结果（本次验收）
- `sed -n '1,260p' skill-overrides/test-driven-development/SKILL.md`：成功读取并确认上述规则。
- `sed -n '1,260p' skill-overrides/test-driven-development/writing-good-tests.md`：成功读取并确认测试改写/断言规则要求。
- `sed -n '1,220p' docs/bugs/bug-superpowers-skill-source-coupling.md`：成功读取到历史 RED 迁移证据（未直接影响本次场景 A/B 结论）。

## 约束与范围确认
- 未修改任何代码/测试/SKILL 文件、未运行 Goal Engine 测试。
- 未实际实现逻辑，仅做只读文档验收并输出证据。

## 残余风险
- 当前仅为文档行为验收；未在本次会话重新执行任何 TDD 红绿回归命令（按“docs-only”范围不做实现或验证测试）。
