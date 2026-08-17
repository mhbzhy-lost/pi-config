# writing-plans 缺少用户授权门禁

## 一句话描述
writing-plans Skill 会因任务多步骤而直接进入计划编写流程，未先取得用户明确授权。

## 复现流程
1. 提交一个复杂或多步骤的实现任务，但不说“写计划”、"先规划"，也不回复授权询问。
2. 触发 writing-plans Skill。
3. 观察 Skill 会声明开始编写计划并默认写入 `docs/plans/`。

## 修复方案
在开始声明、文件结构分析和写入 `docs/plans/` 前设置授权门禁：仅用户明确要求写计划/先规划或明确同意时才产出计划；否则不创建计划文件，直接按适用的 TDD、subagent-dispatch、安全和项目规则执行，且不因沉默或复杂度反复阻塞。

## RED 验证摘要
执行 `node --test test/writing-plans-authorization.test.mjs` 后，1 个测试失败、0 个通过；失败为 `AssertionError: Skill must define an Authorization Gate`，来自 Skill 缺少授权门禁，而非测试语法错误。
