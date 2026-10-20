> 2026-10-17 规划输入归档。来源：reviewer run `16a20771-4a38-4636-be92-55bd31a4925a`；以下保留其只读报告原文。严重度、建议和权限判断属于审阅意见；实际执行范围由用户指令及实施计划裁决。本归档不代表已修改规则或通过行为验收。

# 只读文本审计报告

审计结论：仓库中存在多处可影响 agent 行为的强制 TDD、先写测试、运行测试和计划测试要求。其中最直接的冲突是：

- `pi/AGENTS_SHARED.md` 当前禁止 TDD，并把用户授权限定为 TDD 豁免。
- `skill-overrides/writing-skills/SKILL.md` 把 Skill 编写定义成 TDD，并要求先运行失败测试。
- `skill-overrides/writing-plans/SKILL.md` 要求计划任务携带测试周期，并给出 RED/GREEN 强制步骤。
- `.pi/skills/external-llm-review-provider/SKILL.md` 对 provider 改动要求至少两个 TDD 测试。
- 外部全局 Skill 中仍有多个 `REQUIRED ... test-driven-development` 或测试结果硬门禁。

本次未执行 TDD、未编写或修改测试、未修改任何文件、未运行 Host/provider/网络/真实业务测试。

## 1. Runtime 入口与扫描边界

### 已确认的 system prompt 注入入口

| 入口 | 证据 | 影响范围 |
|---|---|---|
| `pi/extensions/agents-global.ts:8-14` | 调用 `createAgentsGlobalExtension(pi)`；child 进程直接 return | main/root 会话 |
| `src/agents-global/index.ts:61-110` | 在 `before_agent_start` 将 `pi/AGENTS_GLOBAL.md` 包装为 `<pi_global_instructions>` 追加到 `systemPrompt` | main/root 会话 |
| `pi/extensions/agents-shared.ts:6-14` | 调用 `createAgentsSharedExtension`，按 child 标记传入 `scope` | main 和 child |
| `src/agents-shared/index.ts:96-123` | 在 `before_agent_start` 注入 `pi/AGENTS_SHARED.md`，child 额外注入 `CHILD_EXECUTION_BOUNDARIES` | main 和 child |
| `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts:218-232,315` | child 通过 `PI_CODING_AGENT_DIR/extensions/agents-shared.ts` 注册共享扩展；builtin agent 从 `PI_CODING_AGENT_DIR/agents/*.md` 读取 | subagent child |

`src/agents-global/index.ts:83-110` 和 `src/agents-shared/index.ts:96-123` 证明这些文案具备进入 system prompt 的代码路径。main 不加载 GLOBAL 到 child 的边界由 `pi/extensions/agents-global.ts:3-14` 实现。

### agent profile 入口

`packages/pi-subagents-enhanced/src/compat/pi-subagents-0.75.ts`：

- `:65-106` 解析 agent profile frontmatter 和正文。
- `:106` 将正文保存为 `systemPrompt: body`。
- `:117-131` 从 `agentDir/agents/{delegate,executor,reviewer}.md` 读取 profile。
- `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts:225-232` 注册这些 builtin agent。

因此 `pi/agents/*.md` 的正文可进入 child agent runtime。当前三个 profile 中没有强制 TDD 或先写测试文案，只有 `delegate.md:19` 的泛化“运行聚焦验证”要求，未达到测试强制命中标准。

### Skill 发现与同步入口

- `scripts/pi-shell.zsh:11-12`：普通入口不传 `--no-skills`，使用 Pi 原生 Skill discovery。
- `scripts/pi-shell.zsh:36-42`：`pi-lite` 禁用自动 Skill discovery，仅显式挂载 `exa-search` 和 `playwright`。
- `skill-overrides/README.md:3-5`：声明 `skill-overrides/<name>/SKILL.md` 是 Git 管理的共享 Skill 来源，并同步到 `~/.agents/skills`。
- `src/skill-whitelist/skill.ts:64-95`：发现并校验 `skill-overrides` 下的直接子目录 Skill。
- `scripts/sync-skills.ts:6-45`：将本地 Skill 目录同步为 `~/.agents/skills/<name>` 符号链接。

现场确认以下链接均指向本仓本地 override：

```text
~/.agents/skills/test-driven-development
  -> /Users/leshi.zhy/pi-config/skill-overrides/test-driven-development

~/.agents/skills/writing-skills
  -> /Users/leshi.zhy/pi-config/skill-overrides/writing-skills

~/.agents/skills/writing-plans
  -> /Users/leshi.zhy/pi-config/skill-overrides/writing-plans
```

因此这三个 Skill 的本地 override 可被普通 Pi 入口发现；Skill 是否在某轮被模型实际选择，仍由 Pi 的 Skill discovery/选择机制决定。

`.pi/skills/*.md` 是本地项目 Skill 入口。仓库文档明确提到项目 Skill 扫描，但当前仓库源码没有实现 Pi 外部 loader，因此 `.pi/skills` 的确切加载时机需要后续受控 runtime probe 验证，审计中将其标为条件可达。

## 2. A 类：直接 runtime 规则命中

### A-1：共享规范直接禁止 TDD，并以授权作为 TDD 豁免

- **严重性：** 高
- **路径：** `pi/AGENTS_SHARED.md:5-9`
- **证据：**

  ```text
  默认行为：任何情况下不得使用 tdd 开发方式，也不得使用任何 tdd 类型的 skill，包括不得 read/load 此类 skill 文件。
  用户授权：用户明确要求为某项功能点补充测试，或使用 tdd 开发某个需求，此时可在该明确授权范围内豁免。
  ```

- **当前强制性：** 直接 runtime 规则。`agents-shared` 会把全文注入 main 和 child system prompt。
- **影响：** 它禁止整个 TDD 方法和 TDD Skill，语义范围比用户最新要求更宽；用户要求的唯一全局 prompt 约束是“未获明确授权不得主动编写测试”，并没有要求禁止读取或使用所有 TDD 文档。
- **建议改写方向：** 将本节收敛为唯一约束：

  ```text
  未获用户明确授权时，agent 严禁主动编写或新增测试。
  计划可以提出测试任务，但测试任务只能写成建议；执行前必须取得用户明确授权，并将对应任务/步骤回填为“已授权”。
  测试建议、既有测试结果和历史验证事实不得升级为强制测试要求。
  ```

  删除“禁止 TDD”“禁止 read/load TDD Skill”及“授权只是 TDD 豁免”的表述。

### A-2：GLOBAL 规则继续禁止向 child 注入 TDD Skill

- **严重性：** 高
- **路径：** `pi/AGENTS_GLOBAL.md:91`
- **证据：**

  ```text
  默认不得在 task 中注入任何 TDD 类 skill 路径（共享规范默认禁用 TDD，见 `pi/AGENTS_SHARED.md`）。
  ```

- **当前强制性：** 直接进入 main system prompt；main 编排 child 时会受到该规则约束。
- **影响：** 与 `writing-skills` 的“必须理解并使用 TDD”以及本地 `test-driven-development` Skill 的自动发现形成冲突。
- **建议改写方向：** 删除 TDD 专属禁令，只保留一般的 Skill 注入边界；测试相关行为由 `AGENTS_SHARED.md` 唯一授权规则处理。

### A-3：GLOBAL 派发示例把测试结果写成 acceptance 结果

- **严重性：** 中
- **路径：** `pi/AGENTS_GLOBAL.md:68`
- **证据：**

  ```js
  acceptance: { criteria: ["测试通过"] }
  ```

- **当前强制性：** 形式上是示例代码，不是 runtime schema 的测试必填项；由于全文进入 system prompt，模型可能直接复制该模板。
- **影响：** 容易把测试通过误认为所有 coding task 的默认验收标准。
- **建议改写方向：** 使用与具体行为相关的验收标准；若示范验证，可写成“按用户授权执行的验证结果”，不要固定使用“测试通过”。

### A-4：GLOBAL 把“测试”作为独立派发粒度

- **严重性：** 中
- **路径：** `pi/AGENTS_GLOBAL.md:89`
- **证据：**

  ```text
  粒度上限是一次派发一个精确变更：blocker、high、测试分属不同派发。
  ```

- **当前强制性：** 直接 runtime 文案。
- **影响：** 将测试预设为必然存在的独立任务，与“测试任务只能是建议、执行前需授权”冲突。
- **建议改写方向：** 改成“如用户已授权测试，测试任务可作为独立派发”；未授权时仅记录建议，不自动创建任务。

### A-5：GLOBAL 将测试纳入默认任务预算

- **严重性：** 低到中
- **路径：** `pi/AGENTS_GLOBAL.md:90`
- **证据：**

  ```text
  30 分钟是单个派发预计执行时长（含测试）的任务组织预算
  ```

- **当前强制性：** 直接 runtime 文案，但语义是预算说明，不是明确的测试必做命令。
- **影响：** 可能被模型理解为 coding task 默认包含测试。
- **建议改写方向：** 改为“如任务包含经用户授权的测试步骤，预算应包含该步骤”。

### A-6：根 AGENTS 在测试发现异常后强制增加 provenance 分类

- **严重性：** 中
- **路径：** `AGENTS.md:45-51`
- **证据：**

  ```text
  测试、恢复或实际运行发现异常时，在增加任何 production 兼容、防御或 fallback 逻辑前，必须先记录数据来源……
  ```

- **当前强制性：** 根项目规范；本仓源码没有实现根 `AGENTS.md` 注入器，因而具体由 Host project-context loader 加载的事实未在本仓源码中证明。文件本身是直接项目规则。
- **影响：** 它没有要求 agent 主动运行或编写测试，但会在测试发生后触发强制 provenance 流程。
- **建议改写方向：** 保留“发现异常后的 provenance 门禁”本身，但明确“测试执行必须遵守全局授权规则；不得由本条推导出必须编写或运行测试”。

### A-7：package AGENTS 强制先运行验收测试

- **严重性：** 高，范围限定在 `packages/pi-subagents-enhanced`
- **路径：** `packages/pi-subagents-enhanced/AGENTS.md:27`
- **证据：**

  ```text
  合同验证先运行 `node --test test/repository-merge-queue-acceptance-probe.test.mjs`；
  ```

- **当前强制性：** package-scoped agent 规范，具有直接命令式语气。
- **影响：** 强制运行测试，且没有用户授权条件；违反“测试任务执行前必须明确授权”的最新约束方向。
- **建议改写方向：** 改成“建议运行……；若用户授权测试任务，则在验收前执行；未授权时记录为待授权验证项”。

## 3. B 类：Skill/agent 引用后可进入 runtime

### B-1：本地 `test-driven-development` Skill

- **严重性：** 阻断级冲突
- **路径：** `skill-overrides/test-driven-development/SKILL.md`
- **关键行：** `:3,6,8,20,22,30-45,124-126,181,299-328`
- **证据：**

  ```text
  :3 description: Use when changing production code, configuration, or Skill behavior...
  :8 Write the test first. Watch it fail. Write minimal code to pass.
  :22 ...必须加载并遵循本 Skill 的 RED-GREEN-REFACTOR 流程。
  :30 **Always:** New features / Bug fixes / Refactoring / Behavior changes
  :45 NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
  :126 **MANDATORY. Never skip.**
  :181 **MANDATORY.**
  :320 Bug found? Write failing test reproducing it.
  :327 Production code → test exists and failed first
  ```

- **当前强制性：** Skill 正文为强制流程，description 又覆盖 production、configuration、Skill behavior 等大范围场景。通过 `sync-skills.ts` 和现场 symlink 可进入全局 Skill discovery。
- **影响：** 直接要求先写测试、观察 RED、运行 GREEN；与 `AGENTS_SHARED.md` 当前禁 TDD 和用户最新唯一约束同时冲突。
- **建议改写方向：** 在用户未授权前，不得作为默认 Skill 使用；最终清理方向应删除 TDD 强制流程，或把它改为明确的“仅在用户授权采用 TDD 时参考的历史/可选方法”，不得保留 `Always`、`MANDATORY`、`NO PRODUCTION CODE WITHOUT...` 等字样。

### B-2：`test-driven-development` supporting reference

- **严重性：** 高
- **路径：** `skill-overrides/test-driven-development/writing-good-tests.md:3,16,47,150-152`
- **证据：**

  ```text
  Load this reference when: writing or changing tests...
  Strict TDD produces both naturally...
  Behavior, not text...
  The TDD cycle — failing test, minimal implementation, refactor...
  ```

- **当前强制性：** 本文件由 TDD Skill 正文引用，可随 Skill 一并进入 runtime。
- **影响：** 即使主 Skill 的强制段落被清理，supporting reference 仍可能继续强化先写测试语义。
- **建议改写方向：** 只保留测试质量原则；将“Strict TDD”改为“若用户已授权采用 TDD，可参考”，删除默认流程语气。

### B-3：`writing-plans` 把计划任务定义为测试周期

- **严重性：** 高
- **路径：** `skill-overrides/writing-plans/SKILL.md:10,17,46,48,54,56,62,135-148,165`
- **证据：**

  ```text
  :10 ...需要的代码与测试，如何验证……遵循 DRY、YAGNI 和 TDD
  :46 每个任务都必须有独立可测试的交付物。
  :48 每一步应是……编写失败测试、运行确认 RED、实现、运行确认 GREEN
  :135 步骤 2：运行测试确认 RED
  :148 步骤 4：运行测试确认 GREEN
  ```

- **当前强制性：** Skill 正文为强制计划模板，且 Skill description 允许多步骤任务自动触发。
- **影响：** 计划阶段会把测试任务、RED/GREEN 命令和“独立可测试交付物”写成必备项，直接违反“测试只能是建议，执行前需授权并回填已授权”。
- **建议改写方向：**

  - 计划可以列出“建议测试任务”。
  - 建议任务必须显式标注“待用户授权”。
  - 用户授权后才把任务/步骤改成“已授权”。
  - 删除每个任务都必须测试、RED/GREEN 必须执行、最终回归必须执行等无条件措辞。
  - 历史测试结果只能作为证据，不得自动变成当前任务的强制验收条件。

### B-4：`writing-skills` 将 Skill 编写定义为 TDD

- **严重性：** 阻断级冲突
- **路径：** `skill-overrides/writing-skills/SKILL.md:10,16-20,34-43,169,287-290,378-381,397,405,545,558-567,620-631`
- **证据：**

  ```text
  :10 Writing skills IS Test-Driven Development applied to process documentation.
  :18 REQUIRED BACKGROUND: You MUST understand test-driven-development...
  :20 REQUIRED SUB-SKILL: Use subagent-dispatch for fresh-context pressure tests.
  :43 Write test first | Run baseline scenario BEFORE writing skill
  :381 NO SKILL WITHOUT A FAILING TEST FIRST
  :558 Follow the TDD cycle
  :567 ...must see what agents naturally do before writing the skill.
  :620 After writing ANY skill, you MUST STOP and complete the deployment process.
  :627 The deployment checklist below is MANDATORY for EACH skill.
  :631 Skill Creation Checklist (TDD Adapted)
  ```

- **当前强制性：** Skill description 命中创建、编辑和部署前验证 Skill 的全部场景；正文把 RED/GREEN/REFACTOR、压力测试和失败测试写成硬流程。
- **影响：** 这是用户明确指出的“writing-skills skill 仍把 TDD 写成强制流程”，并且它通过本地 override 进入普通 Skill discovery。
- **建议改写方向：** 仅保留 Skill 内容设计、人工审阅和可选验证建议。所有测试相关步骤改为：

  ```text
  如用户明确授权验证任务，可建议压力场景或行为验证；
  未获授权时不得创建测试、派发测试子任务或运行测试；
  历史验证结果仅作为背景事实。
  ```

### B-5：`writing-skills` 引用的 testing reference

- **严重性：** 高
- **路径：** `skill-overrides/writing-skills/testing-skills-with-subagents.md:7,13,20,30-55,67-80,308-371`
- **证据：**

  ```text
  :7 Testing skills is just TDD applied to process documentation.
  :13 REQUIRED BACKGROUND: You MUST understand test-driven-development...
  :20 Enforce discipline (TDD, testing requirements)
  :47 ...you MUST see what agents naturally do before writing the skill.
  :51-55 Run WITHOUT Skill ... Run with Skill ...
  :371 Skill creation IS TDD.
  ```

- **当前强制性：** supporting reference 被 `writing-skills/SKILL.md` 明确用于完整测试方法，属于可被 Skill 正文进一步加载的 runtime 文案。
- **影响：** 仅修改主 `SKILL.md` 而保留该文件，会留下可再次加载的强制 TDD 来源。
- **建议改写方向：** 与主 Skill 同步清理，保留为可选人工验证方法，并增加明确的用户授权条件。

### B-6：本地 `.pi/skills/external-llm-review-provider`

- **严重性：** 高，触发范围限定为 external-llm-review provider 工作
- **路径：** `.pi/skills/external-llm-review-provider/SKILL.md:83-93,165`
- **证据：**

  ```text
  :83 ### 7. TDD 测试（至少 2 个）
  :85 先写两个测试……先运行并确认 RED，再实现……最后运行确认 GREEN。
  :87-93 测试必须覆盖多类 provider/auth/fallback 行为。
  :165 TDD: 先写 YAML 构造与白名单接受测试，确认 RED 后实现 GREEN。
  ```

- **当前强制性：** Skill 正文明确要求至少两个测试和 RED/GREEN。`.pi/skills` 的项目 Skill 扫描由本地 README 声明，但当前仓库源码没有完整证明 Host 对该目录的实际解析，因此属于“项目 Skill 条件可达”。
- **影响：** 即使根规范清理，provider 任务仍可能从本地 Skill 入口重新引入 TDD。
- **建议改写方向：** 改成“可建议针对 provider 行为进行验证”；测试创建、运行和回填都须先取得用户授权。另有路径一致性问题：文件自身引用 `skill-overrides/external-llm-review/`，但该目录不在当前仓库扫描结果中，需要后续单独核对，不能据此猜测同步关系。

### B-7：外部全局 Skill 中的 TDD 前置条件

- **严重性：** 高，范围限定为对应外部产品任务
- **路径：**

  - `~/.agents/skills/managing-megability-ability-idl/SKILL.md:12,19`
  - `~/.agents/skills/managing-taobao-ios-whale-modules/SKILL.md:26`
  - `~/.agents/skills/mtl-taobao-ios-dependency-debugging/SKILL.md:99,120`

- **证据：**

  ```text
  managing-megability-ability-idl:12
  REQUIRED SUB-SKILL: 修改 IDL、Config、generator 或模板前使用 test-driven-development。

  managing-megability-ability-idl:19
  先写 contract，观察 RED，再最小修改并验证 parser/compiler GREEN。

  managing-taobao-ios-whale-modules:26
  REQUIRED: 生产代码或配置变更前使用 test-driven-development。

  mtl-taobao-ios-dependency-debugging:99
  ...再执行 application-hosted device test……非零真实执行数、zero failures、zero skips。

  mtl-taobao-ios-dependency-debugging:120
  最终门禁必须是非零真实 device 执行且 zero failures/skips。
  ```

- **当前强制性：** 这些是 `~/.agents/skills` 中独立外部 Skill；目录可被普通 Pi global Skill discovery 发现。它们不是本仓的 Git source。
- **影响：** 相关外部任务可能再次把 TDD 或真实测试硬门禁注入 agent。
- **建议改写方向：** 本仓不能直接修改这些外部文件。需要由其 owner/upstream 清理，或在本仓建立明确优先级和授权边界的本地 override；在未确认 Skill precedence 前，不应声称本地 override 一定覆盖外部版本。

## 4. D 类：生产 runtime/tool description 或 runtime contract 命中

### D-1：coding acceptance evidence 固定包含 `tests-added`

- **严重性：** 中到高
- **路径：** `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:591-598,626-628`
- **证据：**

  ```ts
  const CODING_ACCEPTANCE_EVIDENCE = Object.freeze([
    "changed-files",
    "tests-added",
    "commands-run",
    "validation-output",
    "residual-risks",
    "no-staged-files",
  ]);
  ...
  evidence: CODING_ACCEPTANCE_EVIDENCE,
  ```

- **当前强制性：** 这是 coding workflow 的 runtime acceptance evidence 列表，不是普通文案。它会随 coding 派发进入 checked acceptance contract。
- **影响：** 它把 `tests-added` 作为所有 coding workflow 的固定证据类别，可能让 agent 认为每个 coding 任务都必须新增测试或至少提供测试证据。
- **实际门禁边界：** `packages/pi-subagents-enhanced/child-extensions/acceptance-evidence.ts:34-45` 的 tool schema 要求 `outcome`、`criteria`、`commandsRun`、`changedFiles`，没有直接要求 `tests-added`；`workflow-spawn.ts:40-48` 也只检查 `criteria` 和 `evidence` 是数组。因此当前代码显示出“结构性压力”，但没有证明它会硬拒绝没有新增测试的任务。
- **建议改写方向：** 删除固定 `tests-added`，或改成不暗示新增测试的中性证据项，例如 `validation-notes`；如果保留测试证据，应明确允许 `tests-not-added`、`not-applicable` 或用户未授权状态，并确保不会将其解释为测试任务授权。

### D-2：bash_async tool description 只把测试列为可运行工作

- **严重性：** 不构成强制命中
- **路径：** `src/bash-async/index.ts:53,57-58`
- **证据：**

  ```text
  仅用于测试套件、类型检查、产物构建……
  正例：启动 e2e 测试后……
  ```

- **当前强制性：** 这是 tool description 中的允许用法和示例，不要求 agent 必须写或运行测试。
- **审计结论：** 归入 D 类扫描范围，但不属于需要清理的强制 TDD/强制测试命中。若全局唯一约束要求严格，建议把“测试套件”与“e2e 测试”改成“经用户授权的测试或其他长耗时验证”，避免示例被复制成默认动作。

### D-3：subagent tool description 没有直接测试要求

- **路径：** `packages/pi-subagents-enhanced/src/subagent-dispatch/operation-tools.ts:204-207`
- **证据：**

  ```text
  writePaths 存在时为 coding 派发，acceptance.criteria 必填
  ```

- **审计结论：** `acceptance.criteria` 是通用 coding 合同，不等于测试要求；当前没有发现该 tool description 强制编写或运行测试。

## 5. C 类命中汇总

以下命中存在测试/TDD词汇，但按当前证据不属于直接 runtime 规则、可执行 Skill 规则或生产 tool description 强制要求：

| 路径 | 命中类型 | 不需按强制规则清理的原因 |
|---|---|---|
| `scripts/probes/zai-tool-stream-diagnostic.ts:68,149,241,249,265,273` | probe payload 中使用 `workflow.mode: "tdd"` | 诊断脚本的固定输入样本，不是 agent system prompt 或生产 runtime guidance |
| `scripts/probes/subagent-schema-provider-regression.ts:38` | regression prompt 使用旧 `dispatch-ir.v1` TDD 样例 | 回归探针文本，属于测试/诊断输入 |
| `scripts/probes/repository-merge-queue-acceptance.ts:90,95` | 验收探针带 `workflow.mode: "tdd"` 和测试文件断言 | 验收/测试 CLI，不是常规 agent prompt 注入 |
| `skill-overrides/git-commit-convention/SKILL.md:46` | “修复 + 测试可放一个 commit” | 允许测试与修复合并，不要求必须写或运行测试 |
| `skill-overrides/playwright/SKILL.md:44` | 维护表中列出“运行测试” | 条件性维护说明，不是所有 Playwright 任务的测试前置条件 |
| `skill-overrides/writing-skills/graphviz-conventions.dot:29` | Graphviz 示例节点 `"Write test first"` | 图示标签/示例，当前未发现它被独立作为 runtime 规则加载 |
| `skill-overrides/writing-skills/examples/CLAUDE_MD_TESTING.md` | Skill 测试示例和历史流程 | 示例文档；如果主 Skill 主动加载它，需随 writing-skills 一并清理，但自身不是独立 frontmatter Skill |
| `packages/pi-subagents-enhanced/src/host-runtime/index.ts:42` | probe details 中有 `category: 'test-gap'` | 诊断分类字段，不是 agent 行为规则 |
| `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:527,593` | `test doubles`、`tests-added` 等内部字段 | `tests-added` 已在 D-1 单独报告；其他命中是实现注释/诊断字段 |
| `src/bash-async/index.ts:53,57` | 测试套件和 e2e 测试示例 | 允许用法，不是强制要求，已在 D-2 说明 |
| `pi/agents/delegate.md:19` | “运行聚焦验证” | 泛化验证要求，没有要求测试 |
| `.pi/skills/external-llm-review-provider` 的 commit 模板 `:165` | 历史/交付模板中的 TDD 文字 | 该文件主体已在 B-6 报告；commit 模板是同一 Skill 内的历史格式，也需同步清理但不构成独立入口 |

`pi/logs/interactive-stderr.log` 和 `.pi` 下的 handoff/session/artifact 内容出现过相关词汇，但它们属于日志、session 或历史产物。本次没有读取其完整内容，也没有将其作为 runtime 规则证据。

## 6. 全局规范应收敛的位置

唯一全局 prompt 约束应放在：

- `pi/AGENTS_SHARED.md` 的“测试与逻辑变更”小节，作为 main 和 child 共同注入的单一来源。

建议的语义是：

```text
未获用户明确授权时，agent 严禁主动编写或新增测试。
计划可以提出测试任务，但测试任务只能写成建议；执行前必须取得用户明确授权，并将对应任务/步骤回填为“已授权”。
测试建议、既有测试结果和历史验证事实不得升级为强制测试要求。
```

`pi/AGENTS_GLOBAL.md` 应删除或改写以下重复/冲突内容：

- `:68` 的“测试通过” acceptance 示例；
- `:89` 的“测试分属不同派发”；
- `:90` 的默认预算“含测试”；
- `:91` 的 TDD Skill 禁止注入。

GLOBAL 可以保留编排、派发、验收的一般机制，但不应再定义测试是否必须、TDD 是否禁止或 Skill 是否可读。

根 `AGENTS.md:45-51` 与 package `AGENTS.md:27` 是额外作用域规范。它们目前分别包含“测试发现异常后的 provenance 门禁”和“先运行验收测试”，需要在后续清理中明确受唯一共享授权规则约束，避免作用域规则重新引入强制测试。

## 7. writing-skills 正文、本地 override 与外部文件

`skill-overrides/writing-skills/SKILL.md` 是本仓 Git 管理的源文件，并通过 `scripts/sync-skills.ts` 同步到 `~/.agents/skills/writing-skills`。现场符号链接指向本仓，因此：

- 应先清理本地 `skill-overrides/writing-skills/SKILL.md`；
- 同步检查其 supporting files，尤其是 `testing-skills-with-subagents.md`；
- 若保留 `writing-good-tests.md` 或其他 TDD reference，应明确它们只在用户授权测试任务后加载；
- 不需要直接修改 `~/.agents/skills/writing-skills/SKILL.md`，因为它是本地 override 的符号链接目标。

以下外部文件位于独立的 `~/.agents/skills` 内容中，当前不属于本仓可直接修改的文件：

- `~/.agents/skills/managing-megability-ability-idl/SKILL.md`
- `~/.agents/skills/managing-taobao-ios-whale-modules/SKILL.md`
- `~/.agents/skills/mtl-taobao-ios-dependency-debugging/SKILL.md`

它们需要由各自 owner/upstream 发布清理，或通过明确的本地 override/Skill precedence 机制处理。当前没有足够证据证明本地同名 Skill 一定覆盖这些不同名称的外部 Skill，因此不能把本地修改效果扩展到外部文件。

## 8. 遗漏风险与后续真实验证

1. 本次没有读取 `pi/settings.json`、`pi/models.json`、auth、session、state 或完整日志；因此没有确认当前 settings 中哪些 extension/package 已实际启用。这是遵守用户敏感边界后的未验证项。
2. `pi/AGENTS_GLOBAL.md` 和 `pi/AGENTS_SHARED.md` 的注入路径由本仓源码直接证明；根 `AGENTS.md` 和 package `AGENTS.md` 的 Host project-context 加载机制不在本仓源码中，应以后续受控 runtime probe 验证。
3. `.pi/skills` 的项目 Skill 扫描由本地文档声称，但 Pi Host loader 的确切目录解析和优先级未在本仓源码中证明；不能把 `.pi/skills/external-llm-review-provider` 说成已被每个 runtime 默认加载。
4. `CODING_ACCEPTANCE_EVIDENCE` 中 `tests-added` 的实际拒绝条件尚未通过 runtime contract probe 验证；静态代码显示它是固定 evidence 名称，但 child acceptance tool schema 没有把它列为 required 字段。
5. 外部 Skill 的同名解析、覆盖优先级和全局目录与项目目录的合并顺序需要真实 Host 验证；本次未运行 Host。
6. 当前 worktree 已有 dirty 现场：`.pi/handoff/context-handoff.md` 有修改，`pi/crashes.json` 和 `pi/models.json.bak-qoder-thinking-20261016161901` 未跟踪。本次未读取或覆盖这些文件，也未将其内容作为审计证据。
