# writing-plans 本地行为验收报告（core-skills-t6-writing-plans-behavior-retry）

## 依据
- 已完整阅读：`skill-overrides/writing-plans/SKILL.md`
- 审核文件：`skill-overrides/subagent-dispatch/SKILL.md`、`skill-overrides/using-goal-engine/SKILL.md`
- 约束：本次仅文档验收（docs-only），不修改代码/测试/Skill/配置，不运行 Goal Engine，不创建 commit。

## 已知事实核验
- 已确认：`generic delegate` 验收在一次重试中因无活动失败并仅返回开场语（故本次不走运行时闭环）。
- 已确认：本地 `writing-plans` 结构契约为通过状态（仅基于文档结构核验）。
- 已确认：新计划默认目录为 `docs/plans`。
## 目标确认
- 验证本地 writing-plans 在仅读场景下可生成**一致的中文 DAG 计划**。
- 输出中文证据报告，作为本次验收交付物（非可执行计划）。

---

## 精简验收示例：parser 与 formatter 并行、最后集成

### 预置共享契约与 Fixture（由正式 Task T0 产出）
为消除 T1/T2 的隐式产物依赖，本报告将共享契约与 fixture 作为正式 `T0` 的产出，供后续任务显式依赖：
- **共享接口：**`PlanAST`、`ParseOutput`、`RenderContract`
- **共享 Fixture：**`writing-plans-shared.fixture.ts`（`rawPlanSource`、`expectedPlanAST`、`expectedParseOutput`、中文输出锚点）
- **边界：**`PlanAST/ParseOutput/RenderContract` 与 fixture 由 `T0` 明确产出，`T1/T2` 只在 Deps 中消费对应产物，避免伪节点依赖。

#### 共享接口定义（示例）
```ts
interface PlanAST {
  title: string;
  tasks: Array<{ id: string; title: string; rawDeps: string[] }>;
}

interface ParseOutput {
  planTitle: string;
  planAST: PlanAST;
  taskNodes: Array<{ id: string; title: string; deps: string[] }>;
  dagEdges: Array<{ from: string; to: string; reason: string; artifact: string }>;
}

interface RenderContract {
  renderMarkdownCN(plan: ParseOutput, opts: { lang: 'zh-CN' }): string;
}
```

#### 共享 Fixture（示例）
```json
{
  "rawPlanSource": "任务 A -> 任务 B\n",
  "expectedParseOutput": {
    "planTitle": "writing-plans 示例",
    "planAST": {
      "title": "writing-plans 示例",
      "tasks": []
    }
  },
  "renderExpectationSnippets": ["Task", "DAG", "Wave", "Deps", "WritePaths", "Resources", "关键路径"]
}
```

### 文件职责（样例）
- `src/writing-plans/contracts/plan-ast.ts`：定义稳定 `PlanAST`、`ParseOutput`。
- `src/writing-plans/contracts/render.ts`：定义稳定 `RenderContract`。
- `src/writing-plans/__fixtures__/writing-plans-shared.fixture.ts`：集中声明共享 fixture（`rawPlanSource`、`expectedPlanAST`、`expectedParseOutput`、`renderExpectationSnippets`）。
- `src/writing-plans/parser/plan-parser.ts`：解析源文件并输出统一 `ParseOutput`（用于后续排程计算）。
- `src/writing-plans/formatter/plan-formatter.ts`：将 `ParseOutput` 渲染为中文 Markdown。
- `docs/plans/2026-xx-xx-writing-plans-demo.md`：最终交付计划文件（仅示例路径）。

### DAG（示例）
```text
T0(Task0: 接口契约与共享 Fixture)
T0 ──> T1(Parser 契约与产物定义)
T0 ──> T2(Formatter 契约与产物定义)
T1 ──> T3(中文计划集成验收)
T2 ──> T3(中文计划集成验收)
```

### 依赖边与产物理由
- **T0 → T1（边理由）**：T1 依赖 `PlanAST/ParseOutput` 与 `rawPlanSource` 的明确约束，才能独立产出 parser 契约证据。
  - 产物：`PlanAST`、`ParseOutput`、`writing-plans-shared.fixture.ts`
- **T0 → T2（边理由）**：T2 依赖 `RenderContract` 与 fixture 的输出锚点，才能独立产出 formatter 契约证据。
  - 产物：`RenderContract`、`writing-plans-shared.fixture.ts`
- **T1 → T3（边理由）**：T3 需 `ParserContractEvidence`（共享 `ParseOutput` 契约下 `parsePlan(source)` 的签名、稳定性、边字段完整性）确认 parser 合规；不允许只依赖“parser 任务完成”。
  - 产物：`ParserContractEvidence`（签名、fixture 一致性、`dagEdges.reason/artifact` 覆盖）
- **T2 → T3（边理由）**：T3 需 `FormatterContractEvidence`（共享 `RenderContract` 契约下 `renderMarkdownCN(plan, opts)` 的中文输出与章节结构符合性）确认 formatter 合规；不允许只依赖“formatter 任务完成”。
  - 产物：`FormatterContractEvidence`（签名、`Task/DAG/Wave/Deps/WritePaths/Resources` 顺序与中文片段断言）

### Wave 与并行性
- **Wave 1：**`T0`
- **Wave 2：**`T1`, `T2`（并行）
- **Wave 3：**`T3`（依赖 T1、T2）

### 关键路径
- 关键路径为 **T0 → T1 → T3** 与 **T0 → T2 → T3**（两条同长路径）。

### 任务示例（含 Deps/WritePaths/Resources/可观察验收）

#### Task T0：接口契约与共享 fixture 固化
**Deps：**`none`

**WritePaths：**
- `src/writing-plans/contracts/plan-ast.ts`
- `src/writing-plans/contracts/render.ts`
- `src/writing-plans/__fixtures__/writing-plans-shared.fixture.ts`

**Resources：** `none`

**接口契约：**
- 消费：`none`
- 产出：
  - `PlanAST`（含 `title`, `tasks`）
  - `ParseOutput`（含 `planTitle`, `planAST`, `taskNodes`, `dagEdges`）
  - `RenderContract`（`renderMarkdownCN(plan: ParseOutput, opts:{lang:'zh-CN'}) => string`）
  - 共享 `writing-plans-shared.fixture.ts`（含 `rawPlanSource`, `expectedPlanAST`, `expectedParseOutput`, `renderExpectationSnippets`）

**可观察验收：**
- 三份接口定义可独立引用且类型与字段完整。
- fixture 包含固定 `rawPlanSource` 与至少一组 `expected*` 期望值，且用于 parser/formatter 的证据可复用。
- 该任务为正式 T0，不属于非任务/伪节点。

---

#### Task T1：Parser 契约与中文 AST 产出
**Deps：**`T0`（理由：消费 `PlanAST/ParseOutput` 契约与共享 fixture）

**WritePaths：**
- `src/writing-plans/parser/plan-parser.ts`
- `src/writing-plans/parser/__tests__/plan-parser.spec.ts`

**Resources：** `none`

**接口契约：**
- 消费：T0 产出的 `PlanAST`、`ParseOutput`、`writing-plans-shared.fixture.ts`
- 产出：`ParserContractEvidence`（`parsePlan(source: string): ParseOutput` 的签名与 fixture 稳定性证据）

**可观察验收：**
- 可独立检查：基于共享 fixture 的同一 `rawPlanSource` 输入，`parser` 输出的 `taskId/Deps/dagEdges` 稳定；DAG 中每条边都包含 `reason + artifact` 字段。

---

#### Task T2：Formatter 契约与中文渲染
**Deps：**`T0`（理由：消费 `RenderContract` 与共享 fixture）

**WritePaths：**
- `src/writing-plans/formatter/plan-formatter.ts`
- `src/writing-plans/formatter/__tests__/plan-formatter.spec.ts`

**Resources：** `none`

**接口契约：**
- 消费：T0 产出的 `RenderContract` 与 `writing-plans-shared.fixture.ts`
- 产出：`FormatterContractEvidence`（`RenderContract`：`renderMarkdownCN(plan: ParseOutput, opts:{lang:'zh-CN'}) => MarkdownString`）

**可观察验收：**
- 可独立检查：基于共享 fixture 的 `expectedParseOutput` 输入后能生成中文 Markdown；标题、`DAG`、`Wave`、`Deps`、`WritePaths` 均可检索。

---

#### Task T3：集成验收（按接口契约合并）
**Deps：**`T1`（理由：消费 `ParserContractEvidence`）、`T2`（理由：消费 `FormatterContractEvidence`）

**WritePaths：**
- `docs/plans/2026-xx-xx-writing-plans-demo.md`

**Resources：** `none`（如有并发执行上限，交由执行器按资源策略控制）

**接口契约：**
- 消费：`ParserContractEvidence` + `FormatterContractEvidence`
- 产出：中文计划文档，且 `T3` 内容与 T1/T2 的明确符合性证据可追溯对应。

**可观察验收：**
- 计划正文包含：
  1. 文件职责
  2. DAG（与 `T0/T1/T2/T3` 边与明确产物理由一致）
  3. 每条依赖边的产物理由
  4. Wave 分组
  5. 关键路径
  6. 每任务 `Deps`、`WritePaths`、`Resources`
  7. 可观察验收标准
- 结果为 `docs/plans` 下的中文 Markdown（符合写入规则）且无额外代码提交。

## 运行约束（证据）
- 本次仅写中文验收报告（`docs/summaries/artifacts/core-skills-extraction/writing-plans-behavior.md`），不是实际计划，不触发代码改动。
- RED/GREEN 在本任务中豁免：这是纯文档验收，不进行 parser/formatter 实际执行测试。
- 不运行 Goal Engine：本次为 docs-only 说明文档，明确保留执行方式但不触发引擎运行。

## 交接方式（仅声明）
1. **Subagent-Driven**（推荐）：`subagent-dispatch` 按 `Deps` 先派发 `T0`，再并行派发 `T1/T2`，`T3` 等待 `T1/T2` 产物后执行。
2. **Inline Execution**：按 Wave 顺序 `T0 → T1/T2 → T3` 顺序执行，手工遵守任务依赖。
3. **Goal Engine**：按 `using-goal-engine` Skill 的工作流将上述任务持久化为 DAG；本次仅声明不运行。

## 执行命令与结果
- `grep -n "Task T0\|T0(Task0" docs/summaries/artifacts/core-skills-extraction/writing-plans-behavior.md`：确认正式 T0 已声明。
- `git status --short -- docs/summaries/artifacts/core-skills-extraction/writing-plans-behavior.md`：确认本次仅修改目标报告文件（未提交）。
- `grep -n "Wave 与并行性\|关键路径\|Deps：\|WritePaths：" docs/summaries/artifacts/core-skills-extraction/writing-plans-behavior.md`：确认 DAG、Deps、Wave、关键路径与任务声明一致。

## 残余风险
- 本次仅为 docs-only 只读验收，未执行实际 parser/formatter 程序。
- 风险影响小：如果执行层实际实现与文档一致性不足，需在后续非-只读执行中补充红绿环验证。