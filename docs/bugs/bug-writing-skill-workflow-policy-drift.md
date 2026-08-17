# 写作 Skill 工作流与策略漂移

## 一句话描述
writing-plans 的加载描述遗漏计划、DAG 和 Wave 等触发词并误称会产出计划；writing-skills 未将 fresh-context 压力测试的 subagent-dispatch 标为必需子 Skill，且部署清单默认要求 commit/push。

## 复现流程
1. 用户提及多步骤实施、DAG/Wave 或计划/规划时检查 writing-plans 的 description。
2. 阅读 writing-plans 的执行交接，观察其依赖具体的“提问工具”。
3. 阅读 writing-skills 的 RED/GREEN 流程和 Deployment 清单。
4. 观察 subagent-dispatch 并非显式 REQUIRED SUB-SKILL，且 Deployment 强制 commit/push。

## 修复方案
保持 writing-plans description 的宽加载触发，但不把加载当作计划产出授权；正文继续要求用户明确授权。以“向用户提问并结束当前轮次”描述交接能力，不假设工具名。将 subagent-dispatch 标为 fresh-context 压力测试必需的子 Skill。Deployment 仅在用户明确授权时提交或推送，否则以已验证文件结束。

## RED 验证摘要
新增策略测试后，在修改 Skill 前运行测试，断言会因缺少宽触发描述、能力式提问措辞、显式 REQUIRED SUB-SKILL 和受授权的部署规则而失败。
