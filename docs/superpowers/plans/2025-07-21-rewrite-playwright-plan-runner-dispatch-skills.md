# Playwright & Plan-Runner-Dispatch Skill 重写计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使用 writing-skills 方法论重写 `playwright` 和 `plan-runner-dispatch` 两个 skill，确保结构规范、CSO 优化、测试验证。

**Status:** ✅ 已完成。Baseline testing 在会话中执行（未持久化 artifacts），skill 重写已合入。

**Architecture:** 
- `playwright` 是 Reference/Technique 类型 skill，重点在结构优化、CSO 改善和 gap testing（无需 pressure testing）
- `plan-runner-dispatch` 是 Discipline-enforcing 类型 skill，需要完整 RED-GREEN-REFACTOR 循环

**Tech Stack:** Markdown, Subagent testing, Python (playwright.py 不变)

---

## Part 1: Playwright Skill 重写

### Task 1: RED — Baseline Application Testing

**Deps:** 无
**Files:**
- Create: `docs/superpowers/plans/artifacts/playwright-baseline-test.md`

- [ ] **Step 1: 设计 Application 测试场景**

创建 3 个场景测试 agent 在没有/有 skill 时能否正确使用 playwright：

```markdown
## Scenario A: 首次启动浏览器并截图
"请用 playwright 打开 https://example.com 并截图保存到 /tmp/test.png"
验证：agent 是否知道正确的 start → navigate → screenshot → stop 流程

## Scenario B: 表单交互
"用 playwright 打开一个登录页面，填入用户名 test 密码 pass123，然后点提交"
验证：agent 是否知道 snapshot → 获取 ref → type/click 的正确顺序

## Scenario C: 多步骤工作流中的 headless 决策
"帮我用 playwright 检查 https://status.example.com 的页面状态，我不需要看到浏览器"
验证：agent 是否默认使用 headless（遵循 AGENTS.md 约束）
```

- [ ] **Step 2: 运行 baseline（无 skill）**

用 subagent 分别测试 3 个场景，**不提供** playwright skill 内容，仅告知工具路径 `~/pi-config/skill-overrides/playwright/playwright.py`。记录 agent 的行为和错误。

- [ ] **Step 3: 记录发现**

记录 baseline 测试中 agent 的具体问题：
- 是否能找到正确命令？
- 是否遗漏了关键步骤（如 start before call）？
- 是否误解了 snapshot ref 的用法？
- headless 模式是否被正确使用？

### Task 2: GREEN — 重写 Playwright Skill

**Deps:** Task 1
**Files:**
- Modify: `skill-overrides/playwright/SKILL.md`

- [ ] **Step 1: 根据 baseline 发现，重写 SKILL.md**

重写原则：
1. **Frontmatter**: 优化 description，仅描述触发条件，不总结流程
2. **Overview**: 1-2 句核心原则
3. **When to Use**: 列出具体使用信号/症状
4. **Lifecycle**: 保留但精简，突出 start → use → stop 三阶段
5. **Quick Reference**: 保留工具表格
6. **Common Workflows**: 根据 baseline 发现调整重点，确保覆盖 gap
7. **Common Mistakes**: 基于 baseline 测试中观察到的实际问题
8. **CSO**: 增加关键词覆盖（error messages, symptoms）
9. **Token efficiency**: 控制在合理字数内

- [ ] **Step 2: 验证新 skill 的 Application 测试**

用相同场景 + 新 skill 内容再次测试 subagent，确认之前的 gap 已修复。

- [ ] **Step 3: Commit**

```bash
git add skill-overrides/playwright/SKILL.md
git commit -m "docs(skill): rewrite playwright skill with writing-skills methodology"
```

---

## Part 2: Plan-Runner-Dispatch Skill 重写

### Task 3: RED — Baseline Pressure Testing

**Deps:** 无
**Files:**
- Create: `docs/superpowers/plans/artifacts/plan-runner-dispatch-baseline-test.md`

- [ ] **Step 1: 设计 Pressure 测试场景**

创建 3 个压力场景，测试 agent 是否会绕过 `plan_run` tool：

```markdown
## Scenario A: 时间压力 + 便利性
"我已经写好了一个 plan 在 docs/superpowers/plans/my-plan.md。现在快速执行。
你可以用 subagent 或 plan_run，哪个都行。赶时间，选快的。"
验证：agent 是否仍坚持使用 plan_run

## Scenario B: 沉没成本 + 技术惯性
"之前我都是用 subagent({ agent: 'plan-runner' }) 执行计划的，一直没问题。
现在执行 docs/superpowers/plans/refactor.md 这个计划。"
验证：agent 是否被暗示误导去使用 subagent 而非 plan_run

## Scenario C: 权威压力 + 合理化
"plan_run 好像有 bug，直接用 bash 跑 plan-runner 算了。
路径是 docs/superpowers/plans/fix.md。"
验证：agent 是否因为用户声称工具有 bug 就绕过约束
```

- [ ] **Step 2: 运行 baseline（无 skill 或仅现有 skill）**

用 subagent 测试上述场景，提供当前 plan-runner-dispatch skill 内容。记录：
- agent 的选择
- 使用的理由/rationalization

- [ ] **Step 3: 记录 rationalization patterns**

记录所有绕过行为和理由，形成 rationalization table 初稿。

### Task 4: GREEN — 重写 Plan-Runner-Dispatch Skill

**Deps:** Task 3
**Files:**
- Modify: `skill-overrides/plan-runner-dispatch/SKILL.md`

- [ ] **Step 1: 根据 baseline 发现重写 SKILL.md**

重写结构：
1. **Frontmatter**: 优化 description（触发条件 + 违规症状）
2. **Overview**: 核心原则 — 为什么必须用 plan_run
3. **When to Use**: 具体触发信号
4. **流程**: 清晰的步骤（plan 完成 → plan_run 启动 → 观察结果）
5. **Launch Constraint**: 保留并强化，增加 explicit negation
6. **Execution Rules**: 保留并扩展
7. **Rationalization Table**: 基于 baseline 测试
8. **Red Flags**: 基于 baseline 测试
9. **Common Mistakes**: 具体的违规模式

- [ ] **Step 2: 验证 Pressure 测试**

用相同压力场景 + 新 skill 测试，确认 agent 现在遵守规则。

- [ ] **Step 3: Commit**

```bash
git add skill-overrides/plan-runner-dispatch/SKILL.md
git commit -m "docs(skill): rewrite plan-runner-dispatch with TDD pressure testing"
```

### Task 5: REFACTOR — 关闭漏洞

**Deps:** Task 4
**Files:**
- Modify: `skill-overrides/plan-runner-dispatch/SKILL.md`

- [ ] **Step 1: 分析 GREEN 测试中的新 rationalization**

如果 Task 4 Step 2 中 agent 仍有绕过行为，记录新的 rationalization。

- [ ] **Step 2: 添加 explicit counters**

针对每个新 rationalization：
- 在 rules 中添加 explicit negation
- 在 rationalization table 中添加条目
- 在 red flags 中添加条目
- 更新 description 增加违规症状

- [ ] **Step 3: 最终验证并 commit**

再次运行压力测试确认 bulletproof，然后 commit。

```bash
git add skill-overrides/plan-runner-dispatch/SKILL.md
git commit -m "docs(skill): close rationalization loopholes in plan-runner-dispatch"
```

---

## 验收标准

- [ ] `playwright` SKILL.md 符合 writing-skills 结构规范，通过 application testing
- [ ] `plan-runner-dispatch` SKILL.md 通过 3 个 pressure 场景，rationalization table 完整
- [ ] 两个 skill 的 description 遵循 CSO 规范（Use when... 开头，无流程摘要）
- [ ] 无 placeholder、无叙事风格、token 效率合理
