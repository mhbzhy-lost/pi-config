# writing-skills 行为验收（本地只读）

## 状态
- status: `completed`

## 依据文件（已完整阅读）
- `skill-overrides/writing-skills/SKILL.md`
- `skill-overrides/writing-skills/testing-skills-with-subagents.md`
- `skill-overrides/subagent-dispatch/SKILL.md`

## 结论
- 按本地文档，writing-skills 的行为验收必须严格走 **RED-GREEN-REFACTOR**；本次任务为 docs-only，未实际派发子代理，仅输出证据与执行方案。
- 已确认：`writing-skills` 明确声明 **Skill 内容允许全英文**（路径仅为 `skill-overrides/writing-skills/SKILL.md`）。

## 强制流程（按顺序）

### RED（基线，WITHOUT Skill）
1. 在 `skill-overrides/writing-skills/testing-skills-with-subagents.md` 指定的流程内，先构造 3+ 压力组合场景（时间/沉没成本/权威/疲惫等）。
2. 使用 `subagent-dispatch` 以 **fresh-context** 调度一次：
   - **WITHOUT Skill**（不加载 writing-skills 相关上下文）
   - 记录代理的选择与合理化语句（逐字）
   - 记录哪些压力组合触发了违反行为
3. 这一轮是“先看失败”证据，目的是确认自然失效点。

### GREEN（WITH Skill）
4. 基于 RED 中出现的具体合理化和缺口，给出最小修订方向（不执行、不修改）。
5. 使用 `subagent-dispatch` 再次开启**独立** fresh-context（与 RED 不共享会话）：
   - **WITH Skill 加载**（以 writing-skills 为目标约束）
   - 复用同一压力场景
   - 预期代理改为正确选项并引用 skill 约束

### REFACTOR（闭环）
6. 若 GREEN 仍出现新合理化：按 `testing-skills-with-subagents.md` 要求逐条补齐：
   - 明确否定/禁止原有借口
   - 更新 rationalization table + red flags + description 中“即将违反”症状
   - 重验：再次做与 GREEN 相同的场景（同样是 fresh-context WITH Skill）
7. 直到无新增合理化为止，形成 **RE-VERIFY**。

## 本次“fresh-context + 不同加载方式”说明（关键证据）
- `subagent-dispatch` 与 `fresh-context`：在不共享上下文的独立会话中先跑 baseline，再在独立会话中跑带 skill 的验证，用于避免跨轮污染。
- 需要清晰分离：
  - 基线会话：`WITHOUT Skill`
  - 验证会话：`WITH Skill`
- 同一场景文本与压力设置必须尽量一致，才可比较差异，判定是否为 skill 效果而非场景差异导致变化。

## 命令与结果（本地只读证据）
- `pwd && ls -la docs/summaries/artifacts`：确认执行路径与 artifacts 目录可写。
- `ls -la docs/summaries/artifacts/core-skills-extraction`：确认目标目录存在。
- `grep -n "fresh-context\\|WITHOUT\\|WITH the Skill loaded\\|REFACTOR\\|Language\\|全英文" skill-overrides/writing-skills/SKILL.md skill-overrides/writing-skills/testing-skills-with-subagents.md`：抓取 RED/GREEN/REFACTOR 与语言声明。
- `nl -ba .../SKILL.md | sed -n '558,590p'` 与 `nl -ba .../testing-skills-with-subagents.md | sed -n '43,100p'`：定位强制流程文本。
- `dot -V 2>&1 || echo "graphviz_not_installed"`：确认当前环境无 Graphviz，符合“可选依赖”已知事实。
- `node --test test/core-skills-local.test.mjs`：确认 writing-skills 结构契约与相关本地规则通过。
- `git diff --cached --name-only`：确认无 staged 文件（本任务仅新增报告）。
- 未运行：真实 `subagent-dispatch` 派发（受任务约束“不要实际派发子代理”）。

## 残余风险
- 未做实测的 baseline/green/refactor 运行，只做文档读取与路径级证据；真正闭环仍需另行在 spark 会话中执行两次 fresh-context 派发。
- 既有已知事实：generic delegate 验收曾因运行时无活动失败，未形成结论；本次不重演该失败路径。
- 当前环境确认 `dot` 不存在，仅说明渲染器可在缺省 Graphviz 时给出可操作提示；不构成流程阻断。

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "在 SKILL 与 testing-skills 文档中明确要求：fresh-context WITHOUT Skill baseline；并在本报告中给出对应 baseline 设计步骤与记录字段（选择、合理化、压力）。"
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "报告写明第二轮为独立 fresh-context WITH Skill，并要求复用同场景重验；同时给出 REFACTOR 新 rationalization 处理与继续 re-verify 的闭环。"
    },
    {
      "id": "criterion-3",
      "status": "satisfied",
      "evidence": "在报告中注明 `Skill 内容允许全英文` 的声明来源仅为 `skill-overrides/writing-skills/SKILL.md`，且明确仅提该路径。"
    }
  ],
  "changedFiles": [
    "docs/summaries/artifacts/core-skills-extraction/writing-skills-behavior.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "pwd && ls -la docs/summaries/artifacts",
      "result": "passed",
      "summary": "确认工作目录与 artifacts 目录可访问。"
    },
    {
      "command": "ls -la docs/summaries/artifacts/core-skills-extraction",
      "result": "passed",
      "summary": "确认目标目录存在。"
    },
    {
      "command": "grep -n \"fresh-context\\|WITHOUT\\|WITH the Skill loaded\\|REFACTOR\\|Language\\|全英文\" skill-overrides/writing-skills/SKILL.md skill-overrides/writing-skills/testing-skills-with-subagents.md",
      "result": "passed",
      "summary": "提取并核对 RED/GREEN/REFACTOR 关键词与语言声明。"
    },
    {
      "command": "dot -V 2>&1 || echo \"graphviz_not_installed\"",
      "result": "passed",
      "summary": "确认 Graphviz 未安装，匹配已知可选依赖事实。"
    },
    {
      "command": "node --test test/core-skills-local.test.mjs",
      "result": "passed",
      "summary": "验证写作技能本地结构契约与文档规则（含 writing-skills local skill 测试）。"
    },
    {
      "command": "git diff --cached --name-only",
      "result": "passed",
      "summary": "确认无 staged 文件。"
    },
    {
      "command": "实际 subagent-dispatch 派发（excluded action）",
      "result": "not-run",
      "summary": "受任务约束禁止实际派发子代理，故 RED/GREEN/REFACTOR 仅做文档验收流程说明。"
    }
  ],
  "validationOutput": [
    "SKILL 文档与 testing-skills 文档均直接给出 fresh-context WITHOUT/WITH 的 RED-GREEN-REFACTOR 要求。",
    "node test/core-skills-local.test.mjs 全部通过（5/5），其中 writing-skills local skill 与相关规则校验通过。",
    "Graphviz `dot` 缺失，已按可选依赖处理（dot -V 失败并回退提示）。",
    "未有 staged 变更；本次只写入 `docs/summaries/artifacts/core-skills-extraction/writing-skills-behavior.md`。"
  ],
  "residualRisks": [
    "未执行真正 fresh-context 派发，不存在实证级 RED/GREEN/REFACTOR 结果，只能作为本地流程审阅证据。",
    "仓库当前存在大量未提交/未暂存改动，需注意与本次报告变更的隔离核对。",
    "generic delegate 历次验收记录为“无活动失败”，若后续继续该线下复测需单独建立新 spark 会话。"
  ],
  "noStagedFiles": true,
  "diffSummary": "新增 writing-skills 行为验收中文报告，记录 RED-GREEN-REFACTOR 强制流程、fresh-context 分离策略、language 声明路径及只读命令证据。",
  "reviewFindings": [
    "no blockers: 文件仅为文档验收产物，未改代码/Skill/测试/配置，遵循 docs-only 约束。"
  ],
  "manualNotes": "本任务为只读复核与 evidence 产出，未实际运行 subagent-dispatch 场景；若需完成闭环采证，请在独立 spark fresh-context 下补跑 WITHOUT/WITH 两轮及新 rationalization 重验。"
}
```