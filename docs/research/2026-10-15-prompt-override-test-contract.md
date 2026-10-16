# Prompt 完整替换测试合同调研（customPrompt / forceSystemPrompt 默认拒绝）

- 日期：2026-10-15
- 任务：只 report 不实现。先探索冻结入口，给出下一独立测试任务可执行的最小合同。
- 依据：源码为准（installed Pi 1.0.4 dist、本仓自有文件），不读真实用户配置（settings.json / models.json / auth.json / trust.json / run-history / sessions / authority / state 均未读）。
- 约束遵守：未改生产、计划、测试；未运行 tests / npm / tsc / Host / 网络；只读探索。

## 1. 完整 prompt 替换入口清单（criterion-1）

### 1.1 SDK 侧替换语义（installed @earendil-works/pi-coding-agent 1.0.4，源码事实）

| # | 入口 | 代码位置 | 后果 | 自有使用 |
| --- | --- | --- | --- | --- |
| S1 | `before_agent_start` handler `return { systemPrompt }` | `dist/core/extensions/runner.js:1147-1149`：`currentOptions.forceSystemPrompt = result.systemPrompt` | `buildSystemPromptState` 走 force 分支，`{content}` 不透明、无 sections（`dist/core/system-prompt.js`） | **3 处**（见 1.2） |
| S2 | 直接改写 `event.systemPromptOptions.forceSystemPrompt` | runner.js:1140 `systemPromptOptions: currentOptions` 是同一可变对象 | 同 S1 | **0 处** |
| S3 | 直接改写 `event.systemPromptOptions.customPrompt` | `system-prompt.js:78-79`：customPrompt 作 preamble，else 分支（tools/rules/docs）被跳过，**promptGuidelines 所在 rules section 不再渲染** | 结构化降级替换 | **0 处** |
| S4 | `resourceLoaderOptions.systemPrompt`（DefaultResourceLoader options.systemPrompt）→ `_rebuildSystemPrompt` 里 `customPrompt: loaderSystemPrompt` | `dist/core/agent-session.js:1281`、`core/agent-session-services.js:64` | 同 S3 | 生产代码 **0 处**；仅 vendored runtime 在 profile `systemPromptMode: replace` 时产生（见 S7） |
| S5 | `SYSTEM.md` 发现（项目 `.pi/SYSTEM.md`、全局 `~/.pi/SYSTEM.md`）→ 同 customPrompt 路径 | `dist/core/resource-loader.js:941-945` | 同 S3 | 本仓**无**该文件；策略：本仓自有目录内出现即拒绝 |
| S6 | `systemPromptOverride`（loader 函数选项）、CLI `--system-prompt` | `dist/core/resource-loader.d.ts:122`、`dist/cli/args.js:71`、`dist/main.js:639` | 同 S3/S4 | `--system-prompt` 仅在 `src/session-owner/contract.ts:38` 与 `scripts/assert-session-tool-policy.ts:4` 作为**取值型 flag 形状校验**出现，不生成 prompt 内容；`systemPromptOverride` 0 处 |
| S7 | profile frontmatter `systemPromptMode: replace` → vendored child-launch 以 `{ systemPrompt: taggedPrompt }` 启动 child | `packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/shared/child-launch.js:207-229`、`agents/agents.js:1932-1936` | S4 路径，完整替换 | 当前 **0 个** profile 用 replace（见 1.3） |
| S8 | settings `subagents.agentOverrides.<name>.systemPrompt / systemPromptMode` | vendored `agents/agents.js:814-819` | replace 时同 S4 | 模板 `pi/settings.template.json` 只有 `delegate.disabled`；**真实 settings.json 未读、不进静态扫描**，此键属静态扫描外风险，只能靠行为/人工覆盖 |
| S9 | Host/vendored runtime 自身 `return { systemPrompt: rewritten }`（inherit 标志的 section 重写） | vendored `runs/shared/subagent-prompt-runtime.js:549-570` | 同 S1，但位于 node_modules vendored 包 | 扫描范围外；本合同只约束自有文件，报告在此如实标注 |

合法追加形态（不是替换，不需白名单）：`--append-system-prompt` / `APPEND_SYSTEM.md` / session `appendSystemPrompt`（S1 之外独立 addendum section）；profile `systemPromptMode: append` → child-launch `appendSystemPrompt` 分支；handler 内 push `event.systemPromptOptions.promptGuidelines`；tool 定义 `promptGuidelines`（如 `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:1660`）。**不得全禁字符串 systemPrompt 以免误伤 tool 可读 getter `event.systemPrompt`**。

### 1.2 自有 `return { systemPrompt }` 精确 site（候选，行为验证背书）

全部位于 before_agent_start handler，均为「保留 base 原文 + 追加自有 tag 块」形态；`base` 取自 `event.systemPrompt`（含当时已渲染的 toolGuidelines/promptGuidelines）：

| path | site（行号为当前工作区） | 形态 | 状态 |
| --- | --- | --- | --- |
| `src/agents-global/index.ts` | :84 读 base；:96 自有块最小替换分支；:110 纯追加分支 | `base.slice(0,start)+fresh+base.slice(end)` / `[base, globalBlock].join("\n\n")` | 候选例外：由行为测试验证 guidelines 保留后才入白名单，**不为让绿添加未证例外** |
| `src/agents-shared/index.ts` | :97 读 base；:123 纯追加分支（shared 块 + child 边界块） | `[base, ...additions].join("\n\n")` | 同上 |
| `packages/pi-subagents-enhanced/src/compat/pi-subagents-0.75.ts` | :106 `systemPrompt: body` | admission 数据对象（frontmatter body 投影给 runtime），非 SDK options 写入 | 非替换点，无需白名单；扫描器按「数据流非 event/SDK options」判类 |

### 1.3 profile 现状（仓库自有、可版本化扫描）

`pi/agents/executor.md:9`、`pi/agents/reviewer.md:11`、`pi/agents/delegate.md:10` 均 `systemPromptMode: append` → child-launch append 分支 → addendum section，guidelines 保留。任一改为 `replace` 即触发 S7 完整替换，必须被测试拒绝。profile aliases（`normalizeAgentAliases(frontmatter.aliases ?? frontmatter.alias)`）由 vendored runtime 运行时解析，静态扫描按文件路径扫 `pi/agents/*.md`，不依赖别名解析。

当前核查结论（以源码为准，不依赖 run5f3c4935 报告）：本仓自有 src/pi/extensions/packages/extensions/src/scripts 范围内 **customPrompt 与 forceSystemPrompt 的写入使用为 0**；仓库无 customPrompt 相关文档，本记录即为首个事实清单。

## 2. 最小可执行测试合同（criterion-2）

### 2.1 文件与范围

- 建议测试文件：`test/system-prompt-override-policy.test.mjs`；仅当 fixture 复用确需时加 `test/helpers/system-prompt-fixture.mjs`。负 fixture 只存在于测试内，绝不写入生产路径。
- 扫描根（精确枚举，非 glob 泛化）：`src/**`、`pi/extensions/**`、`pi/agents/*.md`、`packages/pi-subagents-enhanced/extensions/**`、`packages/pi-subagents-enhanced/src/**`、`scripts/**`。排除 `node_modules`（含 vendored pi-subagents）、`var`、`state`、`history`、`pi/sessions`、`pi/logs`、用户真实 settings/models/auth/trust/run-history。
- 解析器：复用已存在 typescript（root `typescript@7.0.2` devDependency，`ts.createSourceFile` 做 AST；package 内 5.9.3 亦可），不用多层 regex；regex 仅可作预筛且必须 AST 确认。

### 2.2 默认拒绝规则（fail-closed）

1. 自有文件出现 `customPrompt` / `forceSystemPrompt` 标识符**写入**（赋值、属性字面量传入 SDK options、update）→ 拒绝。
2. before_agent_start handler 内 `return { systemPrompt: <expr> }` → 仅当命中白名单精确 site 放行。
3. `systemPromptOptions` 上的计算键 / 别名成员访问（`obj[expr]`、动态 key）→ 无法静态分析 → **unclassified = fail**，输出人工明确清单，不造 lint engine。
4. `pi/agents/*.md` frontmatter `systemPromptMode: replace` → 拒绝。
5. 自有目录内创建/存在 `SYSTEM.md` / `APPEND_SYSTEM.md` → 前者拒绝，后者为合法 append 放行。
6. 任何未在上表枚举的新 site → 默认拒绝；白名单拒用 glob/目录级忽略。

### 2.3 白名单（精确 path + site + 原因 + preservation-test-id）

| path:site | 原因 | 保留验证 |
| --- | --- | --- |
| `src/agents-global/index.ts:96` | 自有块最小替换：非自有内容逐字保留，仅替换 `<pi_global_instructions>` 区间 | `behavior#global-block-replace-preserves-base` |
| `src/agents-global/index.ts:110` | 纯追加：`base + "\n\n" + globalBlock` | `behavior#global-append-preserves-base` |
| `src/agents-shared/index.ts:123` | 纯追加：`base + shared 块（+ child 边界块）` | `behavior#shared-append-preserves-base` |

白名单生效条件：对应 behavior 测试通过。behavior 红 → 白名单条目即失效（测试内断言绑定，非文档约定）。前置说明：三处当前只是候选，行为测试先证 guidelines 保留，再写入白名单；不预先豁免。

### 2.4 guidelines 行为验证（真实 SDK、禁网络）

- 用导出的 `ExtensionRunner`（`@earendil-works/pi-coding-agent` dist `index.js` 导出，构造 `(extensions, runtime, cwd, sessionManager, modelRegistry)`，仅 emit 路径需要 extensions/cwd）+ 记录型 fake extension handlers，进程内跑 `emitBeforeAgentStart(prompt, images, options)`，无 provider/model/网络参与。
- canary：向初始 options 注入 `promptGuidelines`（或经 tool 注册注入 `toolGuidelines`），断言：
  1. 默认 prompt（无 handler）rules section 含 canary；
  2. GLOBAL 单独、SHARED 单独、GLOBAL+SHARED 组合下，最终 systemPrompt 逐字保留 base（含 canary）+ 自有 tag 块；
  3. profile append 分支（模拟 child-launch `appendSystemPrompt`）addendum 含角色正文且 canary 保留；
  4. 负 fixture：handler 设 `customPrompt` / `forceSystemPrompt` / `return {systemPrompt: "仅新文"}` → canary 丢失或 content 不透明 → 证明检测语义与替换危害，反向支撑默认拒绝；
  5. handler 返回 `undefined` / 空 → base 不动；
  6. 扫描器自测：新增未知 `return {systemPrompt}` site 的 fixture → 拒绝；纯 append site → 放行。
- 覆盖矩阵（全部必测）：默认 prompt；GLOBAL 单独；SHARED 单独；GLOBAL+SHARED 组合；profile append；return empty；truncate/替换 base 的拒绝；新增未知 site 拒绝；纯 append 允许。

### 2.5 能力边界（如实声明，不宣称形式验证）

- 静态 AST 只覆盖自有文件的字面写入；不能覆盖动态恶意写入（Proxy、eval、间接别名、vendored/Host 层行为、真实用户配置）。S8 settings 键、S9 vendored return 均在静态扫描外。
- SDK 级 fake handler 证明力 = runner 的 handler 编排/可变 options/force 语义；**不等于 Host 全部扩展发现与加载链**（那属 `test/helpers/pi-runtime.mjs` integration 域，超出本合同）。
- aliases 与计算键：运行时解析，静态不可达即 unclassified fail-closed，转人工明确。

## 3. 并行不受影响声明（criterion-3）

本任务仅新增本文档（write scope 内）；未改 src/pi/packages/scripts/test 计划文件；未运行任何 tests/npm/tsc/node/Host/网络命令；未读取或触碰真实配置与 state；unit-runner P0 占用期间保持只读。下一独立测试任务按 §2 合同实现时，可与现有实施并行，不共享任何未提交现场。

## 4. 下一任务交接要点

1. 按 §2.1 建测试文件；先写 behavior（§2.4）验证三 site guidelines 保留，再把 §2.3 白名单落进测试常量。
2. 扫描器单文件实现，AST 判类 + unclassified fail-closed；§1.1 表作为规则注释的事实来源。
3. 若 behavior 测试发现某候选 site 不能证明 guidelines 保留（例如 handler 次序导致 base 读取晚于 guideline 变更），**不改生产消除 fail**，走 contact_supervisor 决策。
