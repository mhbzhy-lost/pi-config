# Prompt 完整替换默认禁止策略：测试与验收记录

- 日期：2026-10-15
- 任务：dispatch-aba886c8（Contract SHA-256 `aba886c8db5765dbd7efa96055bbf7f47aba21abd0fb8a183b09eac68c794a03`）
- 用户授权原文：「测试集中保留检查，确保 customPrompt/forceSystemPrompt 默认不在本仓使用，例外白名单且逻辑确保 promptGuidelines 保留」
- 前置调研：`docs/research/2026-10-15-prompt-override-test-contract.md`（只 report，不实现）
- 本记录范围：只新增测试、测试自有 helper 与本验收记录；**未修改任何 production / rules / skills / 上游 vendored 包 / 计划文件**。

## 1. 变更清单（严格限定在声明写路径内）

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `test/system-prompt-override-policy.test.mjs` | 新增测试 | 32 个 test：16 个行为矩阵 + 16 个静态策略/扫描器自测 |
| `test/helpers/system-prompt-fixture.mjs` | 新增测试 helper | 真实 SDK 编排 harness + AST 扫描器实现 + profile/SYSTEM.md 探针 |
| `docs/plans/records/2026-10-15-runtime-closeout/prompt-override-policy.md` | 本记录 | 验收事实与能力边界 |

未触碰：`src/**`、`pi/extensions/**`、`pi/agents/**`、`packages/**`、`scripts/**`、`tsconfig.json`、`package.json`、任何 `node_modules`。

## 2. 事实基线（源码为准）

### 2.1 SDK 替换语义（installed `@earendil-works/pi-coding-agent@1.0.4`）

| 事实 | 代码位置 | 后果 |
| --- | --- | --- |
| handler 返回 `{ systemPrompt }` → `currentOptions.forceSystemPrompt = result.systemPrompt` | `dist/core/extensions/runner.js:1146-1148`（`emitBeforeAgentStart`，:1121 起） | 进入 force 分支 |
| `forceSystemPrompt !== undefined` → state 只有不透明 `content`，无 `sections` | `dist/core/system-prompt.js:126-129` `buildSystemPromptState` | 结构化 section 全丢 |
| `customPrompt` 作 preamble，`else` 分支（tools/rules/docs）整体跳过 | `dist/core/system-prompt.js:78-79` | `promptGuidelines`/`toolGuidelines` 所在 `<rules>` 不再渲染 |
| `event.systemPrompt` 是真实 `buildSystemPrompt(currentOptions)` 的 getter | `dist/core/extensions/runner.js:1136-1138` | handler 读到的 base 含当轮已渲染 guidelines |
| `systemPromptOptions` 是同一可变对象 | `dist/core/extensions/runner.js:1140` | 直接改写与 return 等价 |
| `SYSTEM.md` → `customPrompt` 路径；`APPEND_SYSTEM.md` → 合法追加 | `dist/core/resource-loader.js:941-945` | 前者完整替换 |
| `--system-prompt` 是取值型 CLI flag | `dist/cli/args.js:71`、`dist/main.js:639` | 只有 argv 主动注入才构成替换 |

### 2.2 自有生产现场（静态扫描实测，非转述）

扫描 159 个源码文件 + 3 个非源码文本 + 2 个显式忽略（`pi/extensions/.DS_Store`、`scripts/.DS_Store`），
解析器为仓库已安装的 `packages/pi-subagents-enhanced/node_modules/typescript@5.9.3`（根 devDependency
`typescript@7.0.2` 是原生端口，公开入口不暴露 `createSourceFile`/`SyntaxKind`，故不使用；**未执行 npm install**）。

`systemPrompt` 名字出现处的穷尽判类结果：

| kind | 计数 | site |
| --- | --- | --- |
| `handler-return-replacement` | 3 | `src/agents-global/index.ts`（ordinal 1、2）、`src/agents-shared/index.ts`（ordinal 1） |
| `data-dto` | 1 | `packages/pi-subagents-enhanced/src/compat/pi-subagents-0.75.ts` `function parseFrontmatter` |
| `type-declaration` | 2 | 同上文件 `BuiltinAdmissionAgent`、`src/subagent-dispatch/extension.ts` `DiscoveredAgent` |
| `read-access` | 4 | `src/agents-global/index.ts`、`src/agents-shared/index.ts` 各 2 处 `event.systemPrompt` 只读 |
| `flag-classifier-literal` | 2 | `src/session-owner/contract.ts`、`scripts/assert-session-tool-policy.ts` 的 `new Set([...])` |
| `append-flag-literal` | 2 | 同上两处的 `--append-system-prompt` |

`customPrompt` / `forceSystemPrompt` / `systemPromptOverride` 在自有生产范围的**出现次数为 0**（读写均为 0）。

## 3. 默认拒绝规则与精确白名单

### 3.1 默认拒绝（fail closed）

1. `customPrompt` / `forceSystemPrompt` / `systemPromptOverride`：identifier、字符串键字面量**任何出现**都拒绝（当前 0 处；后续即使只读使用也必须显式修订策略，不默认放行）。
2. `before_agent_start` handler 返回体里的 `systemPrompt` 属性：未命中白名单精确 site → `unknown-handler-return-replacement`。**纯追加形状的新 site 同样拒绝**（`return { systemPrompt }` 本身就是 SDK force 入口，与字符串内容无关）。
3. `systemPromptOptions` 上的计算键写入、`Object.assign(options, ...)`、`delete options.*` → `*-unclassified` 拒绝。**不对全 repo 所有 computed property 泛禁**，只针对可识别的 `systemPromptOptions` 目标及其局部别名（含解构别名）。
4. `*.systemPrompt` 直接赋值 → `option-write-systemPrompt` 拒绝。
5. `systemPromptMode: "replace"` 出现在自有代码 → 拒绝；profile frontmatter 缺失该键也拒绝（上游 child-launch 多数路径默认 replace）。
6. `--system-prompt` 字面量：只允许出现在 `new Set([...])` flag 名分类器语境；出现在 `args.push(...)`、argv 数组字面量、launcher 文本 → `launcher-argv-injection` 拒绝。`--append-system-prompt` 是合法追加形态，放行并计数。
7. 扫描范围内未判类的文件类型 → `unhandled-file-kind` 拒绝（只有显式登记的 `.DS_Store` / `Thumbs.db` 可忽略）。
8. 白名单/DTO 豁免死条目（登记了但现场未命中）→ `whitelist-entry-not-found` / `data-dto-entry-not-found` 拒绝。
9. 白名单 shape 指纹漂移 → `whitelist-shape-drift` 拒绝。
10. `SYSTEM.md` 在自有范围出现 → 拒绝；`APPEND_SYSTEM.md` 判为合法追加。

### 3.2 替换 site 白名单（不依赖行号）

定位四元组：`path` + `enclosing`（由外到内具名函数链）+ `ordinal`（同一 handler 内源码序号）+ `shape`（结构化表达式指纹）。
每条必须挂**已执行**的 preservation test id，并由 `policy#whitelist-preservation-tests-actually-executed` 核对执行事实；
未执行或与白名单无关的 preservation id 都会让该守卫红。

| # | path | enclosing | ordinal | shape 指纹 | 理由 | preservation test |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `src/agents-global/index.ts` | `function createAgentsGlobalExtension > arrow` | 1 | `id(base).slice(num,id(ownBlock).start)+id(fresh)+id(base).slice(id(ownBlock).end)` | GLOBAL 自有块最小替换：只替换 `<pi_global_instructions>` open..close 区间，区间外逐字保留 | `behavior#global-block-replace-preserves-base-and-canary`；支持：`behavior#global-block-replace-keeps-foreign-block-outside-own-region` |
| 2 | `src/agents-global/index.ts` | `function createAgentsGlobalExtension > arrow` | 2 | `[id(base),id(globalBlock)(id(loaded).instructions)].join(str)` | GLOBAL 纯追加：base 逐字作前缀，尾部追加自有块 | `behavior#global-append-preserves-base-and-canary`；支持：`behavior#global-then-shared-order-preserves-canary` |
| 3 | `src/agents-shared/index.ts` | `function createAgentsSharedExtension > arrow` | 1 | `[id(base),...id(additions)].join(str)` | SHARED 纯追加：additions 只可能是共享块与 child 边界块，main/child 均在 base 之后追加 | `behavior#shared-append-preserves-base-and-canary`；支持：`behavior#shared-child-append-preserves-base-and-adds-boundaries`、`behavior#shared-then-global-order-preserves-canary` |

白名单条目数 === 现场替换 site 数（3 === 3），由 `policy#replacement-site-count-matches-whitelist-exactly` 断言：
既不允许为绿扩白，也不允许留死条目。

### 3.3 数据 DTO 精确豁免（不是目录级忽略）

| path | enclosing | shape | 理由 |
| --- | --- | --- | --- |
| `packages/pi-subagents-enhanced/src/compat/pi-subagents-0.75.ts` | `function parseFrontmatter` | `id(body)` | `BuiltinAdmissionAgent` 数据 DTO：把 profile frontmatter body 投影给上游 admission/runtime，由上游按 `systemPromptMode` 决定 append/replace；本仓 profile 一律 `append`（见 §3.4）。该 site 不写 SDK `systemPromptOptions`、不是 handler 返回体，因此不构成替换入口。 |

豁免按精确 site 授予：同文件另一处同形状的 `systemPrompt` DTO 仍会被拒（`scanner#data-dto-exemption-is-site-precise` 自测证明）。

### 3.4 profile 与 SYSTEM.md 门禁

- `pi/agents/{delegate,executor,reviewer}.md`：实测 `systemPromptMode` 均为 `append`；名册漂移（新增/改名）会红。
- 分类器自证：`replace` / `inherit` / 其它取值 → `other`（拒绝）；键缺失或空串 → `missing`（拒绝）。
- `SYSTEM.md` 探针实测为空；`APPEND_SYSTEM.md` 实测为空且分类为合法追加。

## 4. 行为验证矩阵（真实 SDK 编排 + 真实生产 handler）

### 4.1 可测边界（不是伪造 base + append 替身）

- 真实 `ExtensionRunner`（SDK 公开导出）+ 真实 `createExtensionRuntime()`；调用真实 `emitBeforeAgentStart` / `emitInput`。
- handler 来自**真实生产 factory**：直接 `import` `src/agents-global/index.ts` 的 `createAgentsGlobalExtension`、
  `src/agents-shared/index.ts` 的 `createAgentsSharedExtension`，用其自身声明的可注入依赖
  `agentsGlobalPath` / `agentsSharedPath` / `readFile` / `scope` 提供 fixture 内容。
- 最小 recorder 只实现生产 factory 实际消费的 `pi.on` / `pi.events.emit`，并把 handler 收进 SDK 公开
  `Extension` 接口形状（`path: string; handlers: Map<string, HandlerFn[]>`）。**不 patch、不替换、不深链任何 SDK 内部模块**。
- canary 走 SDK 正规入口：`toolGuidelines` + `promptGuidelines`，由真实 `buildRules` 渲染进 `<rules>` section。
  断言同时检查 `<rules>` 与 `<docs>` section 仍存在（证明没有降级到 customPrompt/force 的不透明形态）。
- 不启动 Host、不联网、不注册 provider/model、不读写真实会话状态。
- 伪造 handler 只出现在**负 fixture**（证明替换语义确实会丢 canary），不参与任何白名单保留证明。

### 4.2 矩阵

| test id | 覆盖点 |
| --- | --- |
| `behavior#default-prompt-keeps-guideline-canary` | 默认 prompt：canary 在 `<rules>`，无 force/custom |
| `behavior#global-append-preserves-base-and-canary` | 白名单 #2：base 逐字前缀 + GLOBAL 块，canary 保留 |
| `behavior#global-block-replace-preserves-base-and-canary` | 白名单 #1：双真实实例、v1→v2 最小替换、块唯一 |
| `behavior#global-block-replace-keeps-foreign-block-outside-own-region` | 白名单 #1：自有块前后内容逐字相同，块外其它 feature tag 与 guidelines 未被吞 |
| `behavior#shared-append-preserves-base-and-canary` | 白名单 #3：main scope |
| `behavior#shared-child-append-preserves-base-and-adds-boundaries` | 白名单 #3：child scope 追加运行时边界块 |
| `behavior#global-then-shared-order-preserves-canary` | GLOBAL→SHARED 顺序不丢 canary，两块各一个 |
| `behavior#shared-then-global-order-preserves-canary` | SHARED→GLOBAL 顺序不丢 canary，child 边界块不被吞 |
| `behavior#profile-append-addendum-preserves-canary` | 三份**真实** profile 正文经真实 `appendSystemPrompt` → `<addendum>`，canary 保留，不进 force 分支 |
| `behavior#negative-customPrompt-drops-guidelines` | 负：customPrompt 下 `<rules>` 不生成，canary 消失 |
| `behavior#negative-forceSystemPrompt-is-opaque-and-drops-guidelines` | 负：force content 不透明、无 sections |
| `behavior#negative-handler-full-replacement-drops-canary` | 负：handler 返回不含 base 的 systemPrompt → canary 丢失 |
| `behavior#negative-handler-truncated-base-drops-canary` | 负：截断 base → canary 丢失 |
| `behavior#negative-handler-empty-return-leaves-base-untouched` | 负/正：返回 undefined → base 逐字不动，canary 保留 |
| `behavior#negative-real-handlers-unreadable-file-never-fabricate-replacement` | 真实 handler 在规范文件不可读时不伪造替换 prompt；child 边界块仍是追加而非替换 |
| `behavior#input-gate-loads-snapshot-through-real-runner` | 真实 `emitInput` 门禁 + before_agent_start 消费同一快照，全程无 custom/force |

### 4.3 扫描器自测（负 fixture 只写在测试自有临时目录）

`scanner#unknown-handler-return-site-is-rejected`、`scanner#named-handler-function-return-site-is-rejected`、
`scanner#banned-override-writes-are-rejected`、`scanner#computed-key-and-assign-on-options-are-rejected`、
`scanner#legal-append-forms-are-allowed`、`scanner#launcher-argv-injection-is-rejected`、
`scanner#data-dto-exemption-is-site-precise`、`scanner#whitelist-shape-drift-and-dead-entries-are-rejected`、
`scanner#non-source-text-probe-rejects-launcher-flag`。

## 5. 能力边界与未覆盖风险（诚实声明，不宣称形式验证）

静态工具**不是通用 taint engine**。

覆盖：自有生产 TS/JS 的字面属性写入/返回、字面 banned 标识符与字符串键、可识别 `systemPromptOptions`
目标及其局部/解构别名上的计算键写入与 `Object.assign`/`delete`、`--system-prompt` 的 argv 注入语境、
handler 返回体里的 spread/简写、profile frontmatter、`SYSTEM.md` 存在性、非源码 launcher/配置文本的字面探针。

**不覆盖**（登记为扫描外风险，需靠行为测试/人工/上游约束）：

1. `eval`、`new Function`、Proxy 拦截、运行时字符串拼接后的动态属性访问。
2. 跨模块间接别名（把 options 传给另一个模块后在彼处写入）。
3. vendored / Host 层行为：`packages/pi-subagents-enhanced/node_modules/pi-subagents/**`
   （含 `runs/shared/subagent-prompt-runtime.js:549-570` 的 `return { systemPrompt: rewritten }`、
   `runs/shared/child-launch.js:207-229` 的 `systemPromptMode: replace` 分支）在 `node_modules`，属上游，不改不扫。
4. **真实用户 settings**：`subagents.agentOverrides.<name>.systemPrompt` / `systemPromptMode`
   （vendored `agents/agents.js:814-819`）。`pi/settings.json` 按约束**未读取**，该键只能靠行为/人工覆盖。
5. 用户全局 `~/.pi/SYSTEM.md`：属真实用户目录，探针不进入；只有仓库自有范围被探测。
6. 未纳入扫描根的自有目录：`pi/scripts`、`pi/tests`、`pi/bin`、`pi/npm`、`pi/pi-subagents`、
   `packages/pi-subagents-enhanced/scripts`。当前实测这些目录不含 `customPrompt`/`forceSystemPrompt`/
   `systemPromptOverride`/`--system-prompt` 的注入使用，但不在自动门禁内，属登记盲区。
7. SDK 级 fake handler 的证明力 = runner 的 handler 编排、可变 options 与 force 语义；
   **不等于 Host 全部扩展发现与加载链**（那属 `test/helpers/pi-runtime.mjs` integration 域）。
8. profile aliases（`aliases`/`alias`）由 vendored runtime 运行时解析，静态扫描按 `pi/agents/*.md` 文件路径与名册核对，不做别名解析。

## 6. 已执行命令与结果

### 6.1 实现阶段只读探针（非 `node --test`，不占 unit runner；临时文件已删除，无残留）

按主管要求如实登记：实现期间确实运行过 `node` 只读探针脚本（写在仓库根 `.probe-tmp.mjs`，运行后 `rm`），
用于验证 harness 可行性与扫描器判类，未启动 Host、未联网、未调用 provider。

| 命令 | 结果 |
| --- | --- |
| `node .probe-tmp.mjs`（真实 `ExtensionRunner.emitBeforeAgentStart` + 真实 GLOBAL/SHARED factory；canary 观测） | exit 0；base 与 final 均含 toolGuidelines/promptGuidelines canary，`forceSystemPrompt` 被 handler 置位而 `<rules>`/`<docs>` 仍在 |
| `node .probe-tmp.mjs`（GLOBAL 双实例 v1→v2 最小替换） | exit 0；v1 消失、v2 生效、自有块唯一、canary 保留 |
| `node .probe-tmp.mjs`（profile append / customPrompt / forceSystemPrompt 负例、`inspectAgentProfiles`、`probeSystemPromptMarkdown`） | exit 0；append 有 `<addendum>` 且 canary 保留；customPrompt 无 `<rules>`；force 为不透明 content；无 `SYSTEM.md` |
| `node .probe-tmp.mjs`（扫描器判类 dump，空白名单） | exit 0；识别 3 个 handler-return site、1 个 DTO site，产出 4 条 `unknown-*` 违规（证明默认拒绝生效） |
| `node .probe-tmp.mjs`（扫描器 + 本记录 §3.2/§3.3 白名单与豁免） | exit 0；`violations: 0`；counts = `{type-declaration:2, data-dto:1, flag-classifier-literal:2, append-flag-literal:2, read-access:4, handler-return-replacement:3}`；files = 159 源码 / 3 文本 / 2 忽略；profiles 三份均 `append`；`SYSTEM.md` 探针为空 |
| `node --check test/system-prompt-override-policy.test.mjs`、`node --check test/helpers/system-prompt-fixture.mjs` | 均通过（语法校验，非测试运行） |

### 6.2 Inline `node --test` 验证

用户改为 Inline 后，以下两条命令均实际运行：第一条 exit 0、**32 tests / 32 pass / 0 fail**；第二条 exit 0、**33 tests / 32 pass / 0 fail / 1 todo**。TODO 为既有 reviewer admission 公共 API 跟进，不冒称全项完成。

首次运行发现两类测试自有缺陷：GLOBAL 双实例替换 fixture 未先发真实 input 事件，正常生产逻辑无 pending 快照；AST helper 错把 DeleteExpression 判为 PrefixUnaryExpression。调用链分别为自生 fixture→真实 runner→真实 GLOBAL factory，以及自生源码→TypeScript AST→tests-only scanner。仅修 fixture 事件顺序和 helper，不改 production、不扩大白名单。

```
node --test test/system-prompt-override-policy.test.mjs
node --test test/reviewer-agent.test.mjs test/pi-subagents-compat.test.mjs test/subagent-generic-prompt-contract.test.mjs
```

回归文件选择依据（`ls test/` 与 `grep -rl` 实测，不假造）：仓库**没有** `agents-global` / `agents-shared`
专属测试文件；引用它们的生产入口的既有测试只有 `test/reviewer-agent.test.mjs`
（profile frontmatter + `systemPromptMode: append` + tools 面断言）与 `test/helpers/joint-upgrade-session.mjs`（helper，非测试）。
`test/pi-subagents-compat.test.mjs` 覆盖 §3.3 豁免所在的 compat 层，`test/subagent-generic-prompt-contract.test.mjs`
覆盖 dispatch/profile 契约。主管明确**不授权**把 `test/pi-subagents-enhanced-package.test.mjs` 夹进回归
（其 8 项已有 6 项 ENOTCACHED 实证，涉及 npm fixture 安装与 cache writer，与本任务无验收关联），已按指示剔除。

## 7. 现场与并行影响

- 只新增上述 3 个文件；`git status` 中其它 modified/untracked 条目均为本任务之前既有的现场，未触碰、未 stash、未 reset、未 stage、未 commit。
- 未修改生产 tsconfig；本测试为 `.mjs`，由 `node --test "test/**/*.test.mjs"` 既有 glob 自动纳入，无需新增 lint/package 配置。
- 未读取真实用户配置（settings/models/auth/trust/run-history/sessions/logs/authority/state）；`pi/` 只做 depth-1 **文件名**枚举。
- 未启动 Host、未联网、未调用 provider/model、未 kill/notify。

## 8. 后续动作

1. 拿到 unit runner 槽位后执行 §6.2 两条命令，把实际 test count / pass-fail / exit code 回填本记录并回报结构化验收。
2. 若行为测试发现某白名单 site 实际不能保留 guidelines：**不改生产消除 fail、不扩白名单糊弄**，按 fail 证据停并上报主管决策。
3. §5 第 3/4/5/6 项盲区如需收口，需单独授权（涉及读取真实 settings 或改动上游/生产），不在本任务范围内。
