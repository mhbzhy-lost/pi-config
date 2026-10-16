# Runtime 引导边界评估：skill / AGENTS markdown / tool description 的归属划分

- **日期：** 2026-10-15
- **性质：** 只读评估报告。非计划编写、非迁移授权、非 review。本文不修改任何实现、规则文件或既有文档。
- **范围：** 本仓 agent 编排与工具使用面。聚焦 `subagent`（单工具、无 `action` 的 start 路径 vs `action` 控制路径）、`subagent_supervisor`、`subagent_worktree`、`bash_async` 的两类 sleep 误用；`apply_patch` / `security-gates` / `task-scheduler` 仅作少量代表对比，不做全库宽扫。
- **并发说明：** bash_async 的详细文本评估由并行任务 `e99feb57` 承担。**本文收口时它已落盘**：`docs/research/2026-10-15-bash-async-agent-guidance.md`（标题自述为「bash 等待 sleep 与 bash_async 执行 sleep 两种误用」），与本文 §7 的 BA-02（等待型）/ BA-03（载荷型）分类一致。本文只记录 bash_async 在「引导分层」维度上的归属判断与源码坐标，**不重复接管其详细文本结论**；BA-02/BA-03 的具体文案修改建议以该报告为准。另两份同期只读调研可按需交叉参考：`docs/research/2026-10-15-markdown-guidance-inventory.md`（dispatch-b26d22d9，MD 指引归属盘点）与 `docs/research/2026-10-15-upstream-subagent-tool-exposure.md`（dispatch-8ff9faf0，上游 `pi-subagents@0.75.0` 管理工具曝光目录）。本文未等待它们，结论均基于自己的源码读取。
- **runtime-closeout Wave1 F1/P0/D0/N1：** 本文只读其源码，未写入任何相关文件。

---

## 0. 证据规则与本文的自限

1. 每条结论都给出仓库内文件路径与行号，或 upstream `node_modules` / `var/upstream/pi` 的只读坐标。未读到源码支撑的判断一律标注 **unknown** 或 **未验证**，不以推断冒充事实。
2. 本文**不声称任何 prompt 文本构成强制执行**。凡属 `description` / `promptSnippet` / `promptGuidelines` / 回执 / MD 的内容，一律归类为「模型可见引导」，与「代码强制」分列。
3. 凡已由 runtime 承担的 `parameters` schema、typed validation、permission、identity、CAS、action token、terminal proof，本文**不重复设计**，只标注其现有权威位置。
4. 本文不提出实施计划、不改实现、不改 `pi/AGENTS_*.md`、不改 skill、不改任何计划任务文件。
5. 敏感面遵守合同：未读取 `pi/settings.json`、`pi/models.json`、`pi/auth.json`、`pi/trust.json`、session/run-history/authority/state/artifact 正文。读取过的 `pi/extensions/subagent/config.json` 与 `pi/agents/*.md` frontmatter 均为 **git 跟踪的仓库源文件**（`git ls-files` 已确认 `pi/extensions/subagent/config.json` 在版本控制内；`pi/settings.json`、`pi/models.json` 已被 `.gitignore:51-52` 排除，本文未读）。
6. 未运行任何测试、未联网、未调用 provider、未提交、未清理。

---

## 1. 分层模型：五类文本/代码的权威差异

本仓实际存在五层彼此独立、权威不同的「引导面」。混淆它们是当前多数文案冲突的根因。

| 层 | 载体 | 谁消费 | 是否代码强制 | 失败后果 |
|---|---|---|---|---|
| L1 代码强制 | `execute()` 内校验、schema、identity/owner/CAS/token、extension 注册与 early-return、frontmatter `tools` 白名单 | runtime | **是** | 调用被拒（typed error code） |
| L2 模型可见工具引导 | tool `description`、`promptSnippet`、`promptGuidelines`、`parameters` 结构本身 | 模型 | **否** | 模型可能不读、误读、被更长上下文稀释 |
| L3 回执（tool result / followUp message） | `execute()` 返回的 `content[].text`、`pi.sendMessage` 的 `content` | 模型（且写入 session 正文） | **否**（但其内容常被误当作事实权威） | 与 L1/L2 冲突时模型会以最近回执为准 |
| L4 TUI 显示 | `renderCall` / `renderResult` / `registerEntryRenderer` / `registerMessageRenderer` / footer source | 人类 | 不适用 | 仅显示；根 `AGENTS.md`「TUI 精简边界」禁止其反向改写 raw |
| L5 MD 规范 | `pi/AGENTS_SHARED.md`、`pi/AGENTS_GLOBAL.md`、`pi/agents/*.md` 正文、skill 正文、`docs/**` | 模型（经 system prompt 注入）与人类 | **否** | 同上；且注入路径本身可被 host 配置整体丢弃（见 §2.2） |

**关键区分：L2/L3/L5 都是「模型可见文本」，不是代码保证。** 本文所有归属建议都以此为前提。

### 1.1 「双层短索引」的含义

本文用「双层短索引」指：L1 保持权威，L2 只保留**一句指向权威来源的短提示**（例如「以本次 `status` 返回的 `allowed_dispositions` 与 `action_token` 为准」），详细状态机/流程留在 L5 的单一位置，不在 L2 复制。这样 L2 的体积不随状态机增长，L5 只有一份可维护正文。

---

## 2. 追踪链：来源 → 构建 → 加载 → 曝光 → 模型 vs TUI

### 2.1 `description` → provider tool schema（模型每请求可见）

- 本仓定义点：
  - `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:117`（`TYPED_SUBAGENT_DESCRIPTION`）、`:1580`（挂到 tool）。
  - `packages/pi-subagents-enhanced/src/workspace/tool.ts:29-35`（`SUBAGENT_WORKSPACE_DESCRIPTION`）、`:64`（挂载）。
  - `packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-adapter.ts:13`（`SUPERVISOR_DESCRIPTION`）、`:59`（挂载）。
  - `packages/pi-subagents-enhanced/child-extensions/integration-queue.ts:22`（`SUBAGENT_INTEGRATION_DESCRIPTION`）、`:139`（挂载）。
  - `src/bash-async/index.ts:53`（`description`）。
- upstream 语义：`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:456-458`——`description` 注释为 “Description for LLM”。它进入 provider 的 tool schema，**每个请求都发送**，与 system prompt 是两条独立通道。

### 2.2 `promptSnippet` / `promptGuidelines` → system prompt sections（可被整体丢弃）

这是本次评估最重要的机制事实：

- upstream 类型定义：`types.d.ts:459`（`promptSnippet`：“Optional one-line snippet for the Available tools section in the default system prompt. **Custom tools are omitted from that section when this is not provided.**”）、`:461`（`promptGuidelines`：“Optional guideline bullets appended to the default system prompt Guidelines section **when this tool is active**.”）。
- 收集点：`var/upstream/pi/packages/coding-agent/src/core/agent-session.ts:2698-2715`（`_refreshToolRegistry` 构建 `_toolPromptSnippets` / `_toolPromptGuidelines`），`:1067-1101`（`_rebuildSystemPrompt` 只遍历 **active** 工具名，并在 `:1090-1099` 组装 `customPrompt` / `toolSnippets` / `promptGuidelines` 后交给 `buildSystemPrompt`）。
- 构建点（installed 1.0.4，权威）：`node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js:68-97`（`buildSystemPromptSections`）
  - **若 `customPrompt` 存在**（`:78-79`）：只设置 `promptSections.preamble = customPrompt`，随后 `else` 分支被跳过 → **`tools` 与 `rules` 两个 section 完全不生成** → 全部 `promptSnippet` 与 `promptGuidelines` 静默丢失。
  - 同文件 `:126-128`（`buildSystemPromptState`）：**若 `forceSystemPrompt` 存在**，返回 `{content}` 且**无任何 section** → 同样全部丢失。
  - 只有默认 preamble 路径才会执行 `:84-87`：`visibleTools = declaredTools.filter(name => !!toolSnippets[name])`、`promptSections.tools`、`promptSections.rules = buildRules(...)`。
- 去重语义：`buildRules`（`:31-65`）内 `addRule` 走 `Set` 去重（`:59-62`），upstream `_normalizePromptGuidelines` 亦按 `Set` 去重（`agent-session.ts:1042-1055`）。**完全相同字符串只出现一次；语义相同但措辞不同的会各出现一次。**

**结论 A：`promptGuidelines` 确实是 system prompt 注入，不是 tool schema。** 本会话自身的 system prompt 即为实证：`<tools>` 段含 `bash: Execute bash commands in the current working directory...（可选；命令在此目录执行）`、`apply_patch: ...按描述中的补丁格式提交完整 patch...`，`<rules>` 段含同义 bullet——这些字符串来自本仓 `src/bash-cwd`、`src/apply-patch` 的 `promptSnippet`/`promptGuidelines`（`test/bash-cwd-extension.test.mjs:70` 断言 `["base guideline","可选；命令在此目录执行"]`）。

**结论 B：`promptGuidelines` 与 `AGENTS_*.md` 的重复不是被自动消除的。** 去重只在 guidelines 集合内部按字面串生效；`AGENTS_SHARED.md` 经 `<project_context>` / `pi_shared_instructions` 注入（`src/agents-shared/index.ts:96-125`），与 `<rules>` 是不同 section，字面不同即两份都在。**语义重复必须由人工避免，runtime 不会替我们合并。**

**结论 C：L2 的 `promptGuidelines` 比 `description` 更脆弱**——它在 `customPrompt` / `forceSystemPrompt` 两条合法 host 路径下整体消失，而 `description` 不会。把安全前提写进 `promptGuidelines` 等于把它交给一个可被配置抹掉的通道。

### 2.3 `exposure` → 曝光形态（direct / model-only / codemode / deferred / hidden）

- 权威定义：`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:373-388`
  - `direct`：active 时对模型声明**且**可被其他工具经 `ctx.executeTool()` 调用。
  - `model-only`：active 时对模型声明，**永不**可被工具间调用。注释明写 “Use it for orchestrating or interactive tools.”
  - `codemode`：注册即可被调用；除非显式 activate，否则**不对模型声明**。
  - `deferred`：同 `codemode`，但 codemode 工具列表不列出，tool search 可找到。
  - `hidden`：注册但不可达，activate 无效。
  - `direct` 与 `model-only` **在注册时即 active**；其余不 active。active 集合（`getActiveTools`/`setActiveTools`）才是「对模型声明」的集合。
- 本仓取值（全部 `model-only`）：`extension.ts:1578`（`subagent`）、`workspace/tool.ts:61`（`subagent_worktree`）、`supervisor-adapter.ts:58`（`subagent_supervisor`）、`child-extensions/integration-queue.ts:137`（`subagent_integration`）、`src/bash-async/index.ts:52`（`bash_async`）。
- `var/upstream/pi`（0.84.4）中**不存在** `exposure` 字段；installed 为 **1.0.4**（`node_modules/@earendil-works/pi-coding-agent/package.json`）。凡涉及 `exposure` 的结论一律以 1.0.4 dist 为准。
- **含义：** `model-only` 意味着这些编排工具**不能**被 codemode 脚本间接调用，也**不能**被其他工具经 `ctx.executeTool()` 触发。这是一条真实的 L1 隔离，不是文案。

### 2.4 main vs child：不默认同工具可见（代码强制，非仅隐藏）

这是「不能因工具隐藏假设权限已强制」的正面证据——本仓在这一点上**确实有代码强制**，且不止一层：

1. **extension 级 early-return（L1，最强）**：`packages/pi-subagents-enhanced/extensions/subagent-runtime.ts:208`
   ```ts
   if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_SUBAGENT_FANOUT_CHILD === "1") return;
   ```
   child 进程中整个 typed runtime 扩展不安装 → `subagent`、`subagent_worktree`、`subagent_supervisor` **根本未注册**（不是注册后隐藏）。注册点见 `extension.ts:1657-1658`（`pi.registerTool(tool)` / `pi.registerTool(workspaceTool)`）与 `:1690`（`if (supervisorTool) pi.registerTool(supervisorTool)`）。
2. **agent frontmatter `tools` 白名单（L1）**：`pi/agents/delegate.md`、`executor.md`、`reviewer.md` frontmatter 的 `tools:` 字段。实测三者分别为
   - `delegate`：`read,write,edit,bash,grep,find,ls,apply_patch,contact_supervisor`
   - `executor`：同上
   - `reviewer`：`read,grep,find,ls,bash`（**无 write/edit/apply_patch，也无 contact_supervisor**）
   本 child 会话 system prompt 的 `<tools>` 段与 `delegate` 的 `tools:` 完全一致，构成白名单生效的现场印证。upstream 侧解析见 `pi-subagents/src/agents/agents.js:1915-1917`（`parseFrontmatterList(frontmatter.tools)`），active 集合切换 API 见 `types.d.ts:1246-1256`（`getActiveTools` / `setActiveTools`，`hidden` 工具被忽略）。
3. **capability ceiling（L1，但本仓未启用）**：`packages/pi-subagents-enhanced/src/subagent-dispatch/child-tool-policy.ts:14-26` 从 `<agentDir>/extensions/subagent/config.json` 读 `childToolCeiling`；`:28-33` 注册。实测 `pi/extensions/subagent/config.json` **不含 `childToolCeiling` 字段**（只有 `maxSubagentSpawnsPerSession`、`fleetView`、`asyncWidget`、`providerBlacklist`、`artifactDir`），故 `loadChildToolCeilingConfig` 在 `:20` 返回 `undefined` → **本仓没有配置任何 child 工具天花板**。ceiling 机制本身是代码强制（`pi-subagents/src/runs/shared/capability-ceiling.js` 的 registry + `intersectSubagentCapabilityCeilings` + `assertAgentAllowedByCapabilityCeiling`），但**当前无生效实例**。`subagent-runtime.ts:230-234` 的注释亦自述“Host ceiling是显式opt-in；无配置时不得改变既有frontmatter工具行为”。
   → **不能把「ceiling 存在」当作「child 已被限制」。** 现有 child 限制实际来自 (1) 与 (2)。
4. **child 侧独有工具**：`child-extensions/integration-queue.ts:136-140` 注册 `subagent_integration`（`model-only`，8-action union：`enqueue/await_admission/report_conflict/publish/fail/inspect_integration_state/prepare_auto_integration/inspect_auto_integration`，见 `:1` 的 `ACTIONS`）。`contact_supervisor` 由 upstream 在 child 注册（`pi-subagents/src/intercom/native-supervisor-channel.js:179-192`）。main 侧没有这两个工具。
5. **membrane 对 upstream 工具注册的拦截（L1）**：`src/subagent-dispatch/runtime-membrane.ts:175-186`——经 `createHeadlessSubagentApi` 包装的 `pi.registerTool` **只**接受 `name === "subagent_supervisor"`（并绑定到 adapter，不注册），其余一律 `return undefined`。`bootstrap(createHeadlessSubagentApi(pi, {...}))` 见 `extension.ts:1896`；`bootstrap` = `upstreamSubagentRuntimeForwarder` → `upstreamSubagentRuntime(pi)`（`src/compat/pi-subagents-0.75.ts:4,11-14`）。
   **推论（源码可验证）：** upstream 原生 `subagent` 工具（`pi-subagents/src/extension/index.js:640` 定义、`:672` `pi.registerTool`）与 upstream 的**动态工具激活 loader** `subagents_enable`（`pi-subagents/src/extension/tool-activation.js:3`、`:63-118`）在本仓 main 会话中**均被 membrane 拦截、未注册**（`runtime-membrane.ts:175-186`）。
   → **本仓 main 会话当前没有 upstream 的「按需启用 subagent 工具」节流机制**：`tool-activation.js:36-39` 在 loader 不可用时直接 `return true`，`setSelection`（`:11-17`）从不执行，typed `subagent` 保持常驻 active。这对 §5 的拆分成本评估是决定性的：**新增的每一个工具都会在每个请求被声明给模型，没有 loader 可以折叠它们。**
   （`config.toolActivation` 在本仓 `config.json` 中未设置 → `mode` 为 `undefined` → `tool-activation.js:64` 落到 `"auto"`；但因 loader 未注册（`pi.registerTool(loader)` 在 `:114` 被 membrane 吞掉），该 mode 实际无效果。）

### 2.5 模型可见 vs TUI 显示的分界

- `renderCall` / `renderResult` 只影响 TUI：`extension.ts:1589-1590`（subagent）、`:1645-1646`（workspace，透传自 `renderWorkspaceCall/renderWorkspaceResult` 选项，`:1451-1452`、`:1491-1492`）、`:1651-1652`（supervisor，实现在 `supervisor-adapter.ts:57-70`）。
- **实测缺口：`subagent_worktree` 当前没有任何自定义 renderer。** `grep -rn "renderWorkspaceCall\|renderWorkspaceResult"` 在 `packages/`、`src/`、`pi/` 下只命中 `extension.ts` 的 4 处（选项声明/解构/透传），`extensions/subagent-runtime.ts:311-345` 调用 `installHeadlessTypedSubagentRuntime` 时**未传**这两个选项 → `workspace/tool.ts:71-72` 的条件展开为空 → 该工具走 Host 默认 `ToolExecutionComponent` 外壳。这与 `docs/bugs/2026-10-13-bash-async-launch-renderer.md:5` 记录的「走 Host 通用 fallback、把完整 JSON 当普通文本展示」是同一类现象。
- `createChildConversationRenderers`（child 会话预览）只映射 **`subagent` 与 `subagent_supervisor`**，不含 `subagent_worktree`：`src/tui/tool-renderers.ts:116-119`（`renderSubagentCall` 定义于 `:51`、`renderSupervisorCall` 于 `:83`）。消息级映射见 `:124-129`（含 `subagent-workspace-reminder`），entry 级见 `:130-132`。
- TUI 压缩只改显示：`src/tui/compact-rendering.ts:101-108`（`formatCompactSubagentWorkspaceReminder` 把整条 reminder 压成一行 `↳ workspace <id> · awaiting disposition`），而**模型收到的仍是 `completion-reminder.ts` 的完整 `content` 字符串**。这正是根 `AGENTS.md`「TUI 精简边界」的正确实现形态，也是判断某条文本属于 L3 还是 L4 的判据：**若 TUI 短、模型长，则长文本是 L3。**

---

## 3. `subagent` 单工具：无 `action` 的 start 路径 vs `action` 控制路径

### 3.1 路由是 L1 代码，不是文案

`extension.ts:1612-1618`：

```ts
if (Object.hasOwn(input, "action")) { …executeControl(…) }        // action → control
if (isCodingDispatch(input)) { …executeCoding(…) }                 // writePaths → coding
…executeGeneric(…)                                                 // 其余 → generic
```

- `CONTROL_ACTIONS` 白名单：`extension.ts:29`（`status/steer/interrupt/resume/stop/list`），`executeControl` 首行 `:1176-1178` 以 `UNSUPPORTED_ACTION` fail-closed。
- **`start` 不是现有 action。** 派发路径的判据是「**不含** `action` 键」。任何文档若写「`{action:"start"}`」都是虚构。`TYPED_SUBAGENT_DESCRIPTION` 自述路由（`:117`）与代码一致。
- schema 顶层刻意保持单一 object、不用 `anyOf/oneOf`：`extension.ts:49-52` 注释给出原因——glm/zai 等严格 OpenAI 兼容端对顶层 union 会生成空 arguments，并引用 `docs/bugs/2026-09-14-glm-empty-tool-args-from-root-union-schema.md`。**这条约束对 §5 的拆分方案是关键利好：拆成独立工具后每个工具的顶层 schema 都是单一 object，天然绕开该 bug。**
- 反面代价：单工具 schema 必须放宽容器类型以让畸形输入落到 `compileCodingDispatchIR()` 做精确 keypath 诊断（`:39-44` 的 `runtimeValidated`（`:42`）/ `looseObject`（`:43`）/ `looseArray`（`:44`）；`acceptance` 的 `anyOf` 含 `looseObject`、`{type:"array"}`、`{type:"string"}`，`:65-78`）。**即 schema 层对 `acceptance` 的约束比 description 声称的弱**，真正权威是 `contracts/dispatch-ir.ts` 的 `compileCodingDispatchIR`。这是「schema 引导 + runtime 权威」双层设计的自觉取舍，不是缺陷，但必须在归属表里如实标注。

### 3.2 `additionalProperties:false` 与 upstream 文本的现存冲突（实证）

- 本仓 schema：`extension.ts:54-56`（`TYPED_SUBAGENT_PARAMETERS` 顶层 `type:"object"` + `additionalProperties: false`），`properties` 中**无 `capabilities`**。
- upstream loader 回执文本：`pi-subagents/src/extension/tool-activation.js:109` 指示模型调用 `subagent({action:"list",capabilities:true})`。
- → 若该 loader 生效，其回执会引导模型发出一个被本仓 schema 拒绝的调用。**本仓因 membrane 拦截 loader（§2.4 第 5 条）而侥幸未暴露此冲突**，但这是「upstream 工具文本 ≠ 本仓 runtime 保证」的现成反例，应记入风险，而非视为已解决。

### 3.3 `action:"list"` 返回什么：frontmatter 是否每次重复正文

`extension.ts:1179-1204`：

- 返回 `content[0].text` = `JSON.stringify(roster, null, 2)`，`roster` 每项为 `{name, frontmatter}`（`:1195-1196`）。
- `details.agents` 每项为 `{name, description, model, models, tools, metadata}`（`:1187-1191`），`metadata` 是 `structuredClone(a.metadata)`。
- **不含 profile 正文**：`:1189` 注释明写“已准入 agent 附带完整原始 frontmatter（**不含 systemPrompt 正文**）”。profile 正文（`pi/agents/*.md` 的 markdown body）是在 spawn 时作为 child system prompt 装载的，不经 `list` 回传。
- **但确实每次重复 frontmatter，且 content 与 details 双份**：同一 `metadata` 同时出现在 `content` 文本（模型可见）与 `details`（session 结构化字段）。`:1193-1194` 注释说明这是刻意的——“list 是模型选择入口：agent 实际收到的 content 必须携带 frontmatter 元数据（仅改 TUI renderer 不足够）”。这符合根 `AGENTS.md` TUI 边界（不能靠改 renderer 让模型看到）。
- 实测 frontmatter 规模：`pi/agents/delegate.md` 1150 B、`executor.md` 954 B、`reviewer.md` 1145 B（`wc -c`，含正文）；frontmatter 部分含 `models` 列表（delegate 4 项、executor 3 项、reviewer 5 项）。**每次 `list` 的 content 体积 ≈ 三个 agent 的 frontmatter 之和**，属可测量的重复上下文开销，但**不是正文重复**。
- **发现（dead code）：** `extension.ts:30` 声明 `LIST_EXCLUDED_FIELDS = new Set(["description","frontmatter","file","path"])`，`grep -rn "LIST_EXCLUDED_FIELDS" packages/ test/` **只有这一处命中**——该常量从未被使用。它与 `:1195-1196` 实际返回 `frontmatter` 的行为直接矛盾，疑为早期设计的残留。本文只记录，不建议在本任务内改动。

---

## 4. `subagent_supervisor` 与 `subagent_worktree` 的实际描述加载与可见性

### 4.1 `subagent_supervisor`

- 定义：`supervisor-adapter.ts:1-11`（`SUPERVISOR_PARAMETERS`，`action ∈ {reply,pending,status}`，`required:["action"]`，`additionalProperties:false`）、`:13`（description，英文一句）、`:44-73`（`createSupervisorTool`）。
- 挂载：`extension.ts:1650-1653`（`controlledSupervisorAdapter` 存在时创建，renderer 于 `:1651-1652`）→ `:1690` 注册。**只在 main。**
- adapter 语义：`:20-40`——`bind` 只允许一次（`SUPERVISOR_TARGET_ALREADY_BOUND`），未绑定时 `execute` 抛 `SUPERVISOR_TARGET_UNAVAILABLE`。真实 `execute` 由 membrane 从 upstream 定义劫持后绑定（`runtime-membrane.ts:175-186`）。**所以 `subagent_supervisor` 的行为实现来自 upstream，本仓只拥有 name/label/description/promptSnippet/promptGuidelines/renderer 与 `reply` 串行化包装（`extension.ts:1301-1311`：同一 `replyTo` 串行、不同 `replyTo` 可并行）。**
- `promptGuidelines`（`:63-66`）明确区分「本侧已提交」与「child 已消费」——这是 L2 文本正确表达 L1 边界的正面样例。

### 4.2 `subagent_worktree`

- schema：`workspace/tool.ts:3-23`，四个分支 `list`（`:3-6`）/`status`（`:7-10`）/`dispose`（`:11-19`）/`release`（`:20-23`），合成为 `SUBAGENT_WORKSPACE_PARAMETERS`（`:25-27`）并在顶层用 `anyOf`（`:26`）。**注意与 `subagent` 的取舍相反**：这里用了顶层 union，而 `subagent` 因 glm bug 刻意避免顶层 union。`docs/investigations/2026-09-22-…/F-rebaseline-delta.md:79` 亦记录该 union 无 `reconcile/recover`。
- description（`:28-35`）由 5 段字符串拼接 + **两处运行时插值**：`MANAGED_WORKSPACE_STATES.join(" | ")` 与 `MANAGED_WORKSPACE_STATES.map(state => \`${state}=[${allowedActionsFor(state).join(",")}]\`)`。
  - 状态集合与静态动作表权威：`src/workspace/ledger.ts:49-64`（7 态；`reserved/allocating/released → []`，`active → [status,dispose]`，`disposing → [dispose]`，`preserved/cleanup-debt → [release]`）。
  - **含义：description 长度与内容随 ledger 状态集变化**，属「由代码生成的 L2 文本」。这是好设计（不会与状态机漂移），但它把**静态**动作表放进了模型可见文本，而**运行时权威是 live `status` 返回的 `allowed_dispositions`**（`tool.ts:86-87`：仅当 `state === "active"` 才 `issueOwnedDisposition` 取 `actionToken`；`workspacePublic` 于 `:42-53`，其中 `:46` 的 `activeChallenge` 要求 active + 非空 allowed + 非空 token，`:52` 才输出 `action_token`）。**两者必须继续区分，静态表不得被当作 token 来源。**
- L1 门禁（全部保留、不重复实现）：`tool.ts:75-78`（`resolveRootSessionId` → `ownerScope = {kind:"standalone-subagent", rootSessionId}`（`:77`）→ `scopedService`（`:78`）；`requireWorkspaceService` 在调用点 `extension.ts:1643` 注入）、`service.statusOwned/issueOwnedDisposition/disposeOwned/releaseOwned` 的 owner kind 校验、`CHILD_OWNS_INTEGRATION`（`tool.ts:92-95` 捕获并转为 typed failure）、`action_token` CAS。根 `packages/pi-subagents-enhanced/AGENTS.md`「Workspace 所有权边界」段与 `tool.ts:77` 的 ownerScope 构造一致。
- 可见性：**只在 main**（`subagent-runtime.ts:208` early-return）；child 用 `subagent_integration` 走 coordinator，两者不重叠。
- renderer：**无**（§2.5）。

### 4.3 三处文本互相冲突（现存、可复现）

| 位置 | 层 | 文本 | 与权威的关系 |
|---|---|---|---|
| `extension.ts:972-973` 与 `:1106-1107`（spawn 回执 `workspaceNotice`） | L3 | `… then integrate or discard to finish, or preserve temporarily and later release.` | **对 coding workspace 是错的**：`publication=allowed` 的父层 integrate 会被 `CHILD_OWNS_INTEGRATION` 拒绝 |
| `src/workspace/completion-reminder.ts:54-56`（`subagent-workspace-reminder` followUp） | L3 | 同一句 `then integrate or discard to finish, or preserve temporarily and later release.` | 同上 |
| `workspace/tool.ts:31`（description） | L2 | 明确说明 coding child-owned、父层 integrate 被拒；generic `publication=forbidden` 以状态权威为准 | 正确 |
| `pi/AGENTS_GLOBAL.md:134`（Workspace 处置） | L5 | `coding` 的 publication 由 child integration queue 集成，父会话不可直接 `integrate` | 正确 |

**即：最贴近行动时刻的两条 L3 回执，恰恰是唯一给出错误指引的两处。** 这解释了 `docs/investigations/2026-09-22-managed-worktree-merge-queue-practice/A-session-forensics.md:13` 的现场统计——29 次 `subagent_worktree` 调用中 `status×15、dispose×5（全部 preserve）、release×6、list×3`，**typed integrate 成功 0 次**，agent 最终三次绕过 typed integration 改用 raw `git merge --ff-only`。文本冲突 + 试错成本是可观测的行为后果，不是理论风险。

该错误文案有明确引入来源：`docs/plans/2026-09-28-worktree-tool-self-explaining.md:63`（T1a/T1b 在 spawn 结果文本中主动提示处置义务）。**本文只记录，不改动。**

---

## 5. 用户决策记录：全部拆分为每操作独立工具

### 5.1 决策与本文立场

- **先前提议（已被覆盖）：** 把 `subagent_worktree` 合并进 `subagent`，仅主 agent 可用，只管理与 subagent 绑定的受管 worktree。
- **用户最新明确决策（本文遵循）：**「应该全部拆开比较好，每个操作都变为独立工具。」
- 因此本文**不推荐** resource 大 union、**不推荐** worktree 合并进 `subagent`。§6 给出按 operation 拆分的目录建议与逐项 schema。
- **本次仍只是评估/设计记录：未授权实现，未改变 runtime-closeout 当前工具，未修改任何实现或规则文件。**
- **最终工具命名与范围由父会话/用户确认**，本文提供的名称仅为占位示例。

### 5.2 拆分的正面论据（源码可验证）

1. **绕开顶层 union 的 provider bug**：`extension.ts:48-52` 记录的 glm/zai 空 arguments 问题迫使 `subagent` 放弃顶层 `anyOf`，代价是 schema 表达力下降（`acceptance` 必须放宽到 `looseObject`/`array`/`string`，`:66-84`）。拆分后每个工具顶层都是单一 object，**schema 可以真正收紧**，把「coding 必须有 `writePaths` ⇒ `acceptance`」从 description 文案升级为 schema 级 `required`/`dependentRequired`。
2. **消除跨工具误路由**：当前 `writePaths` 存在即判为 coding（`:1614`），若模型为 workspace 控制误带 `writePaths`，会被路由成一次真实派发。拆分后 workspace 工具**在类型上不可能**接收 `writePaths`。这正是「单工具只消除部分跨工具引用，不能跨 supervisor/workspace 归属错误」的根治方式。
3. **description 体积可按工具分摊且只在 active 时进入 system prompt**：`agent-session.ts:1067-1082` 只遍历 active 工具名。当前 1873 字符的 `TYPED_SUBAGENT_DESCRIPTION` 是**无条件全量**发送的；拆分后 model-selection / resume 语义等只在对应工具的 description 里出现。
4. **回执文案可按操作精确化**：§4.3 的错误 `integrate or discard` 之所以危险，是因为它由**同一条 spawn 回执**面向所有后续动作。拆分后 `…dispose` 的回执只需描述 dispose 语义，不必替 release/integrate 代言。

### 5.3 拆分的成本与风险（不编造收益）

1. **模型可见工具数净增**（当前无 loader 折叠，§2.4 第 5 条）。按下文 §6 目录：`subagent` 家族从 **3** 个工具变为 **14** 个（roster 1 + start 1 + run 控制 5 + workspace 4 + supervisor 3），**净增 11**。main 会话总工具数还包含原生 read/bash/edit/write/grep/find/ls、本仓 `apply_patch`、`context_usage`、`list_available_models`、`memory_*`（5 个，`src/basic-memory/extension.ts:49`）、`bash_async`、`scheduler_*`（4 个，`src/task-scheduler/adapter.ts:325-330`）等；**本文未逐一枚举全部原生/扩展工具，故不给出 main 会话工具总数**（unknown，需按 §7 的测量方案实测）。
2. **description 总 token 不一定下降**。拆分省的是「无关分支的正文」，但每个工具都要重复最小共享前提（身份、权威来源、不要 sleep/poll）。若共享前提按 14 份复制，总量可能**上升**。这是必须在实施前实测的量，本文不预估。
3. **选择歧义**：三个 `status` 语义完全不同——run status（子代理运行态）、workspace status（受管工作区状态 + 签发 action_token）、supervisor status（主管请求登记态）。当前它们靠 `subagent({action:"status"})` / `subagent_worktree({action:"status"})` / `subagent_supervisor({action:"status"})` 的**工具名**区分；拆分后若命名为 `subagent_status` / `subagent_workspace_status` / `subagent_supervisor_status`，三者字面高度相似，**歧义风险高于现状**。命名必须让「操作对象」比「操作动词」更显眼（见 §6.3）。
4. **`promptGuidelines` 通道脆弱**（结论 C）：拆分后 guidelines 分散到 14 个工具，若 host 走 `customPrompt`/`forceSystemPrompt`，14 份全部消失，而 `description` 保留。**安全前提必须落在 `description` 或 L1，不得只落在 `promptGuidelines`。**
5. **upstream 文本冲突面扩大**：§3.2 的 `capabilities` 冲突说明 upstream 回执会指名具体工具/参数。工具改名后，任何 upstream 文本中出现的 `subagent(...)` 字面都将失效（例如 `tool-activation.js:112`、`native-supervisor-channel.js` 系列）。需在兼容期决定中一并处理。
6. **`resume` 语义最易被误读**：description 明写 resume 是「以新 run（新子会话）方式续跑，不承诺在原存活进程内就地继续；stopped 不可 resume」（`extension.ts:119`），`pi/AGENTS_GLOBAL.md:143-152` 另有整节「主管恢复规则」。拆成独立工具后，这段前提**必须留在该工具的 description**，不能只留在 MD——因为 resume 是最容易造成重复副作用的操作。

---

## 6. 按 operation 拆分的目录建议（占位命名，最终由用户确认）

### 6.1 目录总览

| # | 建议工具（占位名） | 对应现有入口 | 是否已存在同名 action | 可见性 |
|---|---|---|---|---|
| 1 | `subagent_roster` | `subagent({action:"list"})` | **是**（`list`，`extension.ts:29`） | main |
| 2 | `subagent_start` | `subagent({agent,task,…})` **无 `action`** 的派发路径 | **否**——`start` 是**新名**，现状判据是「不含 `action` 键」（`:1612-1618`） | main |
| 3 | `subagent_run_status` | `subagent({action:"status"})` | 是 | main |
| 4 | `subagent_run_steer` | `subagent({action:"steer"})` | 是 | main |
| 5 | `subagent_run_interrupt` | `subagent({action:"interrupt"})` | 是 | main |
| 6 | `subagent_run_resume` | `subagent({action:"resume"})` | 是 | main |
| 7 | `subagent_run_stop` | `subagent({action:"stop"})` | 是 | main |
| 8 | `workspace_list` | `subagent_worktree({action:"list"})` | 是（`workspace/tool.ts:3-6`） | main |
| 9 | `workspace_status` | `subagent_worktree({action:"status"})` | 是（`:7-10`） | main |
| 10 | `workspace_dispose` | `subagent_worktree({action:"dispose"})` | 是（`:11-19`） | main |
| 11 | `workspace_release` | `subagent_worktree({action:"release"})` | 是（`:20-23`） | main |
| 12 | `supervisor_pending` | `subagent_supervisor({action:"pending"})` | 是（`supervisor-adapter.ts:1-11`） | main |
| 13 | `supervisor_status` | `subagent_supervisor({action:"status"})` | 是 | main |
| 14 | `supervisor_reply` | `subagent_supervisor({action:"reply"})` | 是 | main |

- **`subagent_start` 不拆成 generic/coding 两个工具**：两者是**同一启动语义**，差异只由 typed 合同（`writePaths` 存在与否）决定，权威仍是 `compileDispatchIR` / `compileCodingDispatchIR`（`contracts/dispatch-ir.ts`）与 `isCodingDispatch`（`extension.ts:1614`）。无故拆成两个功能会让模型先做一次「这算 coding 吗」的判断题，而 runtime 本来就能确定性地判定——**这是把 L1 能力倒退回 L2 猜测**，不应做。
- **不发明 upstream 不存在的动作**：上表 14 项全部对应现有 `action` 或现有无 `action` 派发路径。未列入 `run list`（现状**不存在**该操作：`CONTROL_ACTIONS` 只有 `status/steer/interrupt/resume/stop/list`，且 `list` 是 agent roster）、未列入 `workspace reconcile/recover`（`docs/investigations/…/F-rebaseline-delta.md:79`、`C-workspace-mergequeue-rootcause.md:126` 已确认 `reconcile` 只在 service/admin 面，不在 agent 面）、未列入 `subagent_integration` 的 8 个 child action（属 child 面，本次范围外，仅在 §8 记为后续同源候选）。
- child 面 `subagent_integration`（8-action union，`child-extensions/integration-queue.ts:1`）与 `contact_supervisor`（upstream 拥有）**本次不拆**；若将来拆，须按同一原则单独评估，且不得改变 broker binding 与 trusted child binding（`:145-160`）。

### 6.2 每工具 schema（required / optional / 互斥 / 可见性）

以下只列**引导层** schema 形状。凡已属 L1 的 authority（root session identity、owner kind、`action_token` CAS、terminal proof、`CHILD_OWNS_INTEGRATION`、run authorization、`compileDispatchIR` 字节上限）**一律沿用现有实现，不在 schema 层重复实现**。

**1) `subagent_roster`**（main）
- required：无。optional：无。互斥：不适用。
- 顶层 `{type:"object", additionalProperties:false, properties:{}}`。
- 说明：现 `list` 无参数（`extension.ts:1179-1204` 不读任何 input 字段）。**不得**沿用 upstream `capabilities:true`（§3.2）。
- 返回：保持 `{name, frontmatter}` 的 content + `details.agents`（模型选择入口，不能只改 renderer）。

**2) `subagent_start`**（main）
- required：`agent`、`task`。
- **条件 required（L1 守卫保留）**：`writePaths` 存在 ⇒ `acceptance.criteria` 必填且 `minItems:1`。现状由 `isCodingDispatch` + `compileCodingDispatchIR` 强制（`extension.ts:1614`、`contracts/dispatch-ir.ts`）；拆分后可**额外**在 schema 用 `dependentRequired: {writePaths: ["acceptance"]}` 表达，但**runtime 守卫不得因此削弱或移除**。
- optional：`title`、`model`、`thinkingLevel`、`cwd`、`worktree`、`output`、`outputMode`、`outputSchema`、`artifacts`、`progress`、`skill`、`reads`。
- 互斥：**不得**出现 `action`、`id`、`runId`、`dir`、`index`、`message`（控制面字段）；也**不得**出现 `workspace_id`、`disposition`、`action_token`、`strategy`（workspace 面字段）。`additionalProperties:false` 即可在 schema 层排除。
- 保留：`task` **不声明 `maxLength`**（`extension.ts:81-85` 注释：32 KiB UTF-8 字节上限由 `MAX_TASK_BYTES` 权威裁决，JSON Schema `maxLength` 量的是字符，无法表达字节预算）。
- 保留：`model` 解析与 API guard 全部沿用 `model-selection.ts` 的 `resolveModelCandidates` / `resolveModelSelection`；`providerBlacklist` 沿用 `subagent-runtime.ts:211`（`["deepseek"]`）。description 只需一句「qualified `provider/model-id` 必须精确匹配可用 catalog；解析失败即停止并报告，不是 fallback」，指向 `pi/AGENTS_GLOBAL.md`「模型不可用紧急补救」。

**3) `subagent_run_status`**（main）
- required：run 定位符之一。optional：`id`、`runId`、`index`、`dir`。
- 互斥：`id` 与 `runId` 同时存在且不一致 → 现状已 fail-closed（`canonicalSteerTarget`，`extension.ts:1135` `SUPERVISOR_STEER_TARGET_CONFLICT`）；`dir` 单独定位 → `:1128` `SUPERVISOR_STEER_TARGET_ALIAS` fail-closed。拆分后须沿用同一目标解析器，**不得**新写一套。
- 不得出现：`agent`、`task`、`writePaths`、`acceptance`、`workspace_id`。

**4) `subagent_run_steer`**（main）
- required：`message` + run 定位符。optional：`id`/`runId`/`index`。
- 保留 L1：`canonicalSteerTarget` 全部拒绝码（`:1126-1140`：`ALIAS`/`INVALID`/`CONFLICT`/`UNRESOLVED`/`AMBIGUOUS`，含前缀长度门禁 `STEER_PREFIX_MIN_LENGTH` / `STEER_FULL_RUN_ID_LENGTH`）与 supervisor control plane 的 `identityForRun` 三态 fail-closed（`:1212-1220`，`ownerState` 缺失即 `unavailable`，不默认放行）。
- description 一句：「steer 目标必须唯一可证；前缀/别名/冲突一律拒绝」。细节留 MD。

**5) `subagent_run_interrupt`**（main）
- required：run 定位符。optional：同上。互斥同 status。
- description 一句：「中断当前 turn，不终止 run；不承诺已发生副作用可回滚」。

**6) `subagent_run_resume`**（main）
- required：`message`（非空）+ run 定位符。现状 L1：`extension.ts:1205-1206`，缺 `message` → `INVALID_RESUME_MESSAGE`（keypath `$.message`）。
- optional：`model`（见 `docs/research/2026-10-14-subagent-resume-model-override-design.md`，本次不扩展）。
- description **必须**保留三句硬前提：以新 run（新子会话）续跑、不承诺原 live 进程就地继续、`stopped` 不可 resume。**这三句不得只放 MD**——resume 是重复副作用风险最高的操作，且 §5.3 第 4 条说明 guidelines 通道可能整体丢失。

**7) `subagent_run_stop`**（main）
- required：run 定位符。optional：同上。
- description 一句：「stop 后不可 resume」（与 `pi/AGENTS_GLOBAL.md:143` 一致）。

**8) `workspace_list`**（main）
- required：无。optional：无。顶层 `{type:"object",additionalProperties:false,properties:{}}`（对应 `tool.ts:3-6`）。
- 返回：`workspacePublic` 投影（`tool.ts:41-52`），**不含** path/head/token（token 只在 active 且有 allowed 时出现）。

**9) `workspace_status`**（main）
- required：`workspace_id`（`minLength:1, maxLength:4096`，同 `tool.ts:8-9`）。optional：无。
- 保留 L1：`statusOwned` + 仅 `state==="active"` 时 `issueOwnedDisposition` 签发 `actionToken`（`:89-91`）。**`action_token` 与 `allowed_dispositions` 只能来自本次实时 status，不得由模型猜测或从历史回执复用。**
- description 建议压缩为：「返回 `state`、`allowed_dispositions`、`integrate_blocked_reasons`；仅 `active` 时返回一次性 `action_token`。处置动作以本次返回为准。」**移除**当前 description 中由 `allowedActionsFor` 生成的静态动作表？→ **不建议移除**：它是代码生成、不会漂移，且是模型在不调用 status 前唯一的先验。建议保留但显式标注「静态先验，非 token 来源」。

**10) `workspace_dispose`**（main）
- required：`workspace_id`、`disposition ∈ {integrate,discard,preserve}`、`action_token`。
- optional：`strategy ∈ {cherry-pick,merge}`，且**仅** `disposition==="integrate"` 时合法（现状 `tool.ts:17-18` 的 `allOf/if/then` + `:94-95` 的 `INVALID_WORKSPACE_STRATEGY` 双重守卫，二者都保留）。
- 保留 L1：`disposeOwned` 的 owner kind 校验、token CAS、`CHILD_OWNS_INTEGRATION`（`:96-101`）。
- description **必须**保留：`publication=allowed` 的 coding workspace 由 child integration queue 拥有，父层 integrate 返回 `CHILD_OWNS_INTEGRATION`；`publication=forbidden`（generic）能否 integrate **以状态权威返回为准**。**不得**把「所有 worktree 都禁止父层 integrate」写成规则，也**不得**把 current run 与 worktree 说成一一对应。

**11) `workspace_release`**（main）
- required：`workspace_id`。optional：无。
- 保留 L1：`releaseOwned`；`released` 为终态。
- description 一句：「仅 `preserved` / `cleanup-debt` 走 release；`released` 是终态、无需操作。不是『先 dispose 再 release』的串联步骤。」（对应 `pi/AGENTS_GLOBAL.md:124-127` 的两条独立分支）

**12) `supervisor_pending`**（main）
- required：无。optional：无。
- 说明：实现来自 upstream（§4.1），本仓只拥有文本与 renderer。拆分不得改变 adapter 绑定语义（`bind` 一次性、未绑定抛 `SUPERVISOR_TARGET_UNAVAILABLE`）。

**13) `supervisor_status`**（main）
- required：无。optional：`replyTo`（若 upstream 支持按请求查询——**unknown**，需读 upstream `subagent_supervisor` 实现确认；本文未验证 `status` 是否消费 `replyTo`，不做假设）。

**14) `supervisor_reply`**（main）
- required：`replyTo`、`message`（现状 `extension.ts:1304`：`params?.action !== 'reply' || typeof params.replyTo !== 'string'` 时走非串行路径，说明 `reply` + `replyTo` 是串行化的判据）。
- 保留 L1：同 `replyTo` 串行、control plane 的 `resolveSupervisorControl` 授权、`commitDelivery` 与 `compensateSupervisorDelivery`（`:1275-1300`）。
- description 保留现有两条 guideline 的**语义**（针对实际 request 作答；`writeReply` 本侧提交 ≠ child 已消费），但按结论 C 应放进 `description` 而非仅 `promptGuidelines`。

### 6.3 命名正反例

| 反例 | 问题 | 正例 |
|---|---|---|
| `subagent_status` / `workspace_status` / `supervisor_status` | 三个 `*_status` 字面近似，模型需读 description 才能区分对象；§5.3 第 3 条歧义 | `subagent_run_status` / `managed_workspace_status` / `supervisor_request_status`——**对象名前置且不重名** |
| `subagent_start` + `subagent_coding_start` + `subagent_generic_start` | 把 runtime 已能确定性判定的路由（`isCodingDispatch`）退回模型判断 | 单一 `subagent_start`，由 typed 合同验证 |
| `workspace` / `worktree` | 与 raw `git worktree` 混淆；根 `AGENTS.md`、`pi/AGENTS_GLOBAL.md:158-162` 明令禁止 raw git 操作受管 worktree | `managed_workspace_*`，名称自带「受管」语义 |
| `subagent_list` | 与「run 列表」歧义（现状 `list` 是 agent roster，无 run list） | `subagent_roster` 或 `subagent_agents` |
| `subagent_dispose` | 丢失「dispose 的是 workspace 不是 run」 | `managed_workspace_dispose` |

**brief 正例（description 首句写法）：**「处置一个受管工作区：需要 `workspace_id`、`disposition` 与本次 `workspace_status` 返回的一次性 `action_token`。」——一句说清对象、必填、token 来源。
**brief 反例：**「管理 subagent 工作区生命周期。」——对象模糊、无必填、无 token 来源，等于把判断推给模型。

---

## 7. 归属决策表

**候选归属图例：** `L1 强制代码` / `L2 tooltext`（description，模型每请求可见）/ `L2g guidelines`（promptSnippet/promptGuidelines，可被 host 配置整体丢弃）/ `L3 回执` / `L5 MD` / `双层短索引`（L1 权威 + L2 一句指向）。
**「具体可证实测试」列全部为方案描述，本次未运行任何测试。**

| ruleId | 规则内容 | 现 source（层） | callsite | actual guard（L1 事实） | 候选归属 | 最低安全前提 | 保留与删除边界 | 具体可证实测试（不运行） |
|---|---|---|---|---|---|---|---|---|
| SG-01 | 路由：有 `action`→control，有 `writePaths`→coding，其余→generic | `extension.ts:117`（L2）+ `:1612-1618`（L1） | `tool.execute` | `Object.hasOwn(input,"action")` / `isCodingDispatch` | **L1 保持**；L2 降为一句 | 拆分后每工具类型互斥，路由不再需要文案解释 | 保留 L1；**删除** description 中的路由解释段 | 对每个新工具断言 `additionalProperties:false` 且不包含其它面字段；构造带 `writePaths` 的 workspace 调用应 schema 拒绝 |
| SG-02 | coding 必须 `writePaths` + `acceptance.criteria` | `extension.ts:117`（L2）、`pi/AGENTS_GLOBAL.md:59-70`（L5） | `executeCoding` → `compileCodingDispatchIR` | `contracts/dispatch-ir.ts` typed 合同 + keypath 诊断 | **L1 保持** + L2 schema `dependentRequired` | schema 收紧不得取代 runtime 守卫 | 保留 L1；L2 只留必填提示；MD 保留派发格式示例 | 断言缺 `acceptance` 的 coding 调用返回既有 code 与 `keypath`；断言 schema 亦拒绝（双层都 RED→GREEN） |
| SG-03 | `task` 32 KiB 字节上限 | `extension.ts:81-84` 注释（L2 说明） | `compileDispatchIR` | `MAX_TASK_BYTES`（`:85` 的 `task` 故意不声明 `maxLength`） | **L1 独占** | 不得在 schema 用 `maxLength` 冒充字节预算 | 保留注释；**禁止**新增 `maxLength` | 用 32 KiB 边界±1 的多字节字符串断言 code 与 keypath 不变 |
| SG-04 | `acceptance` 容器放宽（looseObject/array/string） | `extension.ts:39-44,65-78`（L1 schema） | 同上 | `compileCodingDispatchIR` 精确裁决 | **L1 独占** | 拆分后可收紧，但须逐个 provider 验证空 args bug 不复现 | 收紧前保留；收紧后删除 loose 分支 | 对严格 OpenAI 兼容端（glm/zai 类）断言顶层非 union 时 args 非空 |
| SG-05 | spawn ≠ 完成；不得 sleep/poll/`supervisor pending` 等待 | `extension.ts:119`（L2）、`:121` `ASYNC_SPAWN_GUIDANCE`（L3）、`:976`/`:1110`（L3）、`pi/AGENTS_GLOBAL.md:141`（L5） | spawn 回执 | **无 L1**（无法阻止模型 sleep） | **L3 保留一句 + L5 保留** | L2 已含同义句；三处重复 | **删除** description 内重复句，保留 L3 一句（行动时刻最近）+ L5 | 断言 spawn 回执文本恰含一次该指引；断言 description 不再含该句 |
| SG-06 | `resume` 是新 run/新子会话、不承诺原地续跑、`stopped` 不可 resume | `extension.ts:119`（L2）、`pi/AGENTS_GLOBAL.md:143`（L5 生命周期）+ `:146-155`（L5 主管恢复规则） | `executeControl` | `INVALID_RESUME_MESSAGE`（`:1206-1208`）仅校验非空；**可恢复性由 upstream 裁决** | **L2 保留（拆到 `subagent_run_resume`.description）+ L5 保留决策顺序** | 这三句是防重复副作用的唯一前置提示 | 保留；**不得**降级为 guidelines（结论 C） | 断言 `resume` 工具 description 含三要素；断言缺 `message` 返回 `INVALID_RESUME_MESSAGE` + `$.message` |
| SG-07 | steer 目标必须唯一可证（alias/conflict/prefix/absolute 全拒） | `extension.ts:1126-1140`（L1） | `executeControl` steer 分支 | 5 个 typed 拒绝码 + control plane 三态 fail-closed | **L1 独占** + L2 一句 | 拆分后必须复用同一 `canonicalSteerTarget` | 保留 L1；**禁止**新写第二套目标解析 | 对每个拒绝码构造输入断言 code 不变（含前缀长度边界） |
| SG-08 | `list` 是 agent roster，返回 frontmatter（不含正文） | `extension.ts:1179-1204`（L1+L3） | `executeControl` list 分支 | discovery admission 过滤（`:1181-1185`） | **L3 保持** | content 必须含 frontmatter（模型选择入口），不能只改 renderer | 保留；**删除** `LIST_EXCLUDED_FIELDS`（`:30`，未使用且与实际行为矛盾） | 断言 content 与 details 携带同一 `metadata`；断言不含 `systemPrompt` 正文；断言 `LIST_EXCLUDED_FIELDS` 已不存在 |
| SG-09 | 模型选择：qualified 精确匹配、裸名按声明链、失败即停不 fallback | `extension.ts:119`（L2 长段）、`pi/AGENTS_GLOBAL.md:91-103`（L5） | `model-selection.ts` | `resolveModelCandidates`/`resolveModelSelection` + API guard + `providerBlacklist` | **双层短索引**：L1 权威 + L2 一句 + L5 详述 | `requested/resolved` 不得冒充实际模型；权威是 run/status/artifact 的 actual-model | **删除** description 中约 700 字符的模型选择长段，压缩为一句并指向 GLOBAL | 断言 description 字符数下降且仍含「精确匹配/失败即停」；断言 `MODEL_MATCH_USED_GLOBAL_CATALOG` 仍出现在 `details.warnings` |
| SG-10 | child 不得新增委派 | `src/agents-shared/index.ts:33`（L5，runtime 注入的 `<pi_child_execution_boundaries>`） | child system prompt | **L1：`subagent-runtime.ts:208` early-return + frontmatter `tools` 白名单** | **L1 已足**；L5 保留说明 | 文本不得被表述为强制来源 | 保留 L5 一句；文档中明确「强制来自扩展未安装 + 工具白名单」 | 断言 child 进程 `getAllTools()` 不含 `subagent*`；断言 `PI_SUBAGENT_CHILD=1` 时扩展不注册任何工具 |
| WS-01 | workspace 处置以实时 `status` 的 `state`/`allowed_dispositions`/`action_token` 为权威 | `workspace/tool.ts:28-35`（L2）、`pi/AGENTS_GLOBAL.md:111-138`（L5） | `statusOwned`/`issueOwnedDisposition` | owner scope + owner kind + token CAS（`tool.ts:75-91`） | **双层短索引** | token 只能来自本次 status；静态表只是先验 | 保留 L2 短索引 + 代码生成的静态先验；**删除** L5 中与之重复的 JS 示例（`GLOBAL:115-131`）压缩为分支说明 | 断言非 active 状态的响应不含 `action_token`；断言过期 token 被 CAS 拒绝 |
| WS-02 | coding（`publication=allowed`）父层 integrate 被拒（`CHILD_OWNS_INTEGRATION`） | `tool.ts:31`（L2）、`extension.ts:119`（L2）、`GLOBAL:134`（L5） | `disposeOwned` | service 内 publication 判定 + typed error | **L1 独占 + L2 一句** | 不得泛化为「所有 worktree 禁止父层 integrate」 | 保留；**修正** §4.3 两处 L3 错误文案 | 断言 coding workspace 的父层 integrate 返回 `CHILD_OWNS_INTEGRATION`；断言 generic workspace 的判定仍走状态权威 |
| WS-03 | `publication=forbidden`（generic）能否 integrate 以状态权威为准 | `tool.ts:32`（L2）、`extension.ts:119`（L2） | 同上 | 同上 | **L1 独占 + L2 一句** | 不得写死结论 | 保留 | 断言 generic workspace 的 `allowed_dispositions` 由 service 决定，文本不参与判定 |
| WS-04 | 已 `released` 是终态、无需处置 | `tool.ts:30`（L2）、`GLOBAL:132`（L5） | `releaseOwned` | ledger 终态 | **L1 独占**，L2 可删 | 静态表已表达 `released=[]` | **删除** L2 重复句，保留代码生成表 | 断言对 released 的任何动作返回既有 code |
| WS-05 | `strategy` 仅对 `integrate` 合法 | `tool.ts:18`（L1 schema `allOf/if/then`）+ `:89`（L1 runtime） | `disposeOwned` | 双重守卫 | **L1 独占** | 两层都保留（schema 早拒、runtime 权威） | 保留 | 断言 `strategy` + 非 integrate 返回 `INVALID_WORKSPACE_STRATEGY`；断言 schema 亦拒绝 |
| WS-06 | 禁止 raw git worktree 操作受管 workspace；禁止自动 stash/reset | `pi/AGENTS_SHARED.md`「安全边界」（L5）、`GLOBAL:158-162`（L5） | — | **无 L1**（bash 面不受 workspace service 管辖） | **L5 保留**（唯一可表达处） | 不能靠工具文案阻止 bash；如需强制须另设 shell policy（超出本次范围） | 保留 MD；**不得**声称已被强制 | 断言 `security-gates/shell-policy.ts` 现有策略未覆盖该模式（记录为已知缺口，不在本任务修） |
| WS-07 | spawn 回执与 completion reminder 的处置指引 | `extension.ts:972-973`/`:1106-1107`（L3）、`completion-reminder.ts:54-56`（L3） | spawn / `subagent:async-complete` | 无 | **L3 保留但必须修正** | 当前文本对 coding 错误（§4.3） | 保留机制；**修正**文案为「按 `workspace_status` 返回处置；coding 集成由 child 拥有」 | 断言两处文本一致且不含无条件 `integrate or discard`；断言 TUI 仍压缩为一行（`compact-rendering.ts:101-108`） |
| WS-08 | `subagent_worktree` 无自定义 renderer | `subagent-runtime.ts:311-345` 未传 renderer（L4 缺口） | Host 默认外壳 | 无 | **L4 补齐**（拆分后每工具各一） | 不得为显示改写 details | 记为独立缺陷候选 | 断言每个新工具的 `renderCall/renderResult` 存在且消费原始 details |
| SV-01 | `reply` 针对实际 request；本侧提交 ≠ child 已消费 | `supervisor-adapter.ts:63-66`（L2g） | `executeReply` | control plane `resolveSupervisorControl` + `commitDelivery` + 补偿（`extension.ts:1283-1300`） | **L2 保留（从 guidelines 上移到 description）** | guidelines 通道可被 host 丢弃 | 保留语义，改载体 | 断言 `customPrompt` 路径下该语义仍在 description 中可见 |
| SV-02 | 同 `replyTo` 串行、不同 `replyTo` 可并行 | `extension.ts:1301-1311`（L1） | `controlledSupervisorAdapter.execute` | flight map 串行化 | **L1 独占**，无需文案 | — | 保留；**不新增** description 说明（避免噪声） | 断言同 `replyTo` 两次并发调用的执行顺序；断言不同 `replyTo` 可交错 |
| SV-03 | supervisor 注册失败必须显式告知「reply 不可用，需 interrupt+resume」 | `extension.ts:1681`（L3） | `message_end` hook | `registrationFailures` map | **L3 保留** | 这是恢复路径的唯一提示 | 保留 | 断言注册失败时发出 `subagent_supervisor_registration_failed` 且文本含恢复指引 |
| SV-04 | membrane 拦截 upstream `subagent_supervisor` 注册并绑定 adapter | `runtime-membrane.ts:175-189`（L1） | bootstrap | `bind` 一次性 / `SUPERVISOR_TARGET_UNAVAILABLE` | **L1 独占** | 不得暴露给模型 | **不出现在任何文案** | 断言 `getAllTools()` 恰含一个 `subagent_supervisor`；断言未绑定时 execute 抛 `SUPERVISOR_TARGET_UNAVAILABLE` |
| BA-01 | 启动成功只代表接受任务；结果以 completion 的 `outcome/exitCode` 为准 | `src/bash-async/index.ts:56`（L2g）、`controller.ts:71`/`:74`（L1 typed outcome） | `bash_async.execute` | `BashAsyncTerminalReceipt.outcome` | **L3 已表达**（`controller.ts:83` header 明写「启动回执不代表命令成功」）+ L2g 一句 | header 是不可信数据边界的一部分 | 保留；**不重复**进 description | 断言 completion header 含该句；断言 launch receipt 不含成功语义 |
| BA-02 | **sleep 误用类型一（等待型）**：启动后不得 `sleep`/轮询等待 | `index.ts:53`（L2 description）、`:57`（L2g）、`docs/architecture/bash-async.md:16`（L5） | — | **无 L1** | **L2 一句 + L5** | 无法代码强制（模型可自由调 `bash sleep`） | 保留一处 L2 短句；**删除** L2g 重复 | 断言 description 与 guidelines 不同时含同义句（去重后恰一处） |
| BA-03 | **sleep 误用类型二（载荷型）**：不得把 `sleep`/daemon/`nohup`/长服务当作 `bash_async` 载荷 | `index.ts:58`（L2g「不要用于自建 daemon」）、`docs/architecture/bash-async.md:18`（L5） | `controller.launch` | **部分 L1**：`ctx.mode` 限 tui/rpc（`controller.ts:50`）、timeout 上限 `2_147_483_647ms`（`:53`）、`invalidateBranch`/`shutdown` 取消（`:97-98`）；**但不检查命令内容** | **L2 短索引 + L5**；若要强制须在 `security-gates/shell-policy.ts` 增设策略（**超出本次范围，仅记录**） | 真实用户曾以 `{"command":"sleep 5"}` 调用（`docs/bugs/2026-10-13-bash-async-launch-renderer.md:5`、`…-completion-renderer.md:10`）——说明该载荷**合法且被支持**，不应被描述为错误 | **保留 L5**；L2 只保留「不用于自建 daemon」；**不得**把 `sleep` 载荷本身写成违规（会与该 bug 记录的合法调用矛盾） | 断言 `sleep 5` 载荷仍成功启动并投递 completion（回归保护）；断言 description 未把 sleep 载荷列为禁止 |
| BA-04 | 回执投递事实 ≠ 模型已消费（`attempted`/`accepted`/`suppressed-*`/`delivery-error`） | `controller.ts:76-88`（L1）、`index.ts:136-141`+`:185-200`（L4，其中 `:196` 明写「accepted 仅代表发送调用被接受，不代表模型已消费」） | 唯一 terminal 出口 | `completionDelivery` typed 枚举 | **L1 独占 + L4 显示** | 根 `AGENTS.md` TUI 边界 | 保留；**不新增**模型可见长文 | 断言各 `completionDelivery` 取值下的行状态标签（`terminalStateLabel`）与 details 一致 |
| BA-05 | 不得用后台任务绕过命令门禁/凭据/网络/提交授权 | `index.ts:58`（L2g） | `security-gates/extension.ts` | `docs/architecture/bash-async.md:12`：“对 `bash`、`bash_async` 调同一策略” | **L1 已有**（同策略）+ L2 一句 | 同策略是前提 | 保留一句；**删除**与 `AGENTS_SHARED` 重复的授权叙述 | 断言同一命令经 `bash` 与 `bash_async` 得到相同 policy 判定 |
| BA-06 | `clear_queue` 的模型可见描述存在层级歧义 | `src/bash-async/index.ts:59`（L2g：“clear_queue 可清除已提交的回执且不自动重发”） | — | **`clear_queue` 不是 `bash_async` 参数**：实测 `grep -rn "clear_queue" src/ packages/pi-subagents-enhanced/src pi/extensions` 仅命中 `index.ts:59` 这一处文本；原生 Bash schema 只有 `{command, timeout}`（`node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js:28-31`）+ 本仓 `cwd`；`clear_queue` 实际是 **Host 队列/RPC 命令类型**（`dist/modes/rpc/rpc-types.d.ts:35,194`） | **L2 重写为一句，指明它不是本工具参数** | 不得让模型误估可以 `bash_async({clear_queue:true})` 或 `bash({command:"clear_queue"})` | 保留语义（回执可被清除且不重发）；**删除**裸工具名写法，改为「Host 队列清除（非本工具参数）」 | 断言 `bash_async` 的 `parameters` 中不存在 `clear_queue`（回归保护）；断言 guideline 文本含「非本工具参数」限定 |
| MD-01 | 派发格式/适合性/粒度/预算/reviewer 次数/恢复规则 | `pi/AGENTS_GLOBAL.md:46-155`（L5，仅 main 加载） | main system prompt | 无 L1（治理策略） | **L5 独占** | 不得下沉到每个工具的 description（会造成 §5.3 第 2 条的重复膨胀） | **保留 MD**；L2 只留指向 | 断言各工具 description 不含粒度/预算/reviewer 次数正文 |
| MD-02 | 通用安全与工程约束（TDD 禁用、敏感信息、commit、输出语言、工单、辅助脚本、安全边界、停止条件） | `pi/AGENTS_SHARED.md`（L5，main+child 同源注入） | `src/agents-shared/index.ts:96-125` | 部分 L1（`providerBlacklist`、`interactive-stderr-guard`、`security-gates`） | **L5 独占**（跨工具、跨角色） | 注入通道本身可失败：`agents-shared/index.ts:103-105` 明写「Host 会 catch before hook 异常，throw 不构成拦截」 | **保留 MD**；**不得**复制进工具文案 | 断言 main/child 注入同一份源文字（`SHARED_BLOCK_OPEN` 去重）；断言文件缺失时 `input` 门禁 `handled` 且通知 |
| MD-03 | 角色方法论 | `pi/agents/*.md` 正文（L5，child system） | spawn 时装载 | frontmatter `tools` 白名单（L1） | **L5 独占** | `reviewer` 无 `contact_supervisor`（§2.4 第 2 条），但 child boundaries 文本指示使用它 → **文本与白名单矛盾** | **保留 MD**；**须裁决**：给 reviewer 加 `contact_supervisor`，或让 child boundaries 文本按白名单条件化（本文不选择，属产品决策） | 断言每个 agent 的 `tools` 与其收到的 boundaries 文本所引用的工具集合一致 |
| XR-01 | upstream loader 回执指示 `subagent({action:"list",capabilities:true})` | `pi-subagents/src/extension/tool-activation.js:109`（L3，upstream） | 被 membrane 拦截未生效 | `additionalProperties:false`（`extension.ts:56`）会拒绝 | **记录为风险**；拆分后须显式决定兼容期是否重新启用 loader | 当前靠「未注册」侥幸规避 | 不改 upstream；拆分方案须写明 loader 取舍 | 断言 main 会话 `getAllTools()` 不含 `subagents_enable`；若将来启用，断言其回执文本与本仓 schema 一致 |

---

## 8. 受管 workspace 的归属（独立工具化，不合并）

### 8.1 归属论证

1. **权威唯一且已在 L1**：`packages/pi-subagents-enhanced/AGENTS.md`「Workspace 所有权边界」规定所有 standalone subagent、Goal task、Goal validation workspace **共用 `src/workspace/` 一套 service/ledger/Git lifecycle**，公开入口只允许 package exports `./workspace` 与 `./workspace/admin`（`packages/pi-subagents-enhanced/package.json` exports 实测为 `./dispatch-ir`、`./host-runtime`、`./tui/background-activity`、`./workspace`、`./workspace/admin`）。**拆分只改工具面，不得改这条边界。**
2. **owner kind 由 service 校验，不由工具参数替代**：`tool.ts:75-78` 构造 `ownerScope = {kind:"standalone-subagent", rootSessionId}`，service 由调用点 `extension.ts:1643` 的 `requireWorkspaceService` 注入；AGENTS.md 明写「不得以工具参数、workspace ID、路径或调用前检查替代该门禁」。→ **`kind` 不能成为工具参数**，拆分成 `workspace_*` 独立工具后仍由调用点固定注入。
3. **generic / Goal 共享 service 的边界必须保留**：`ownerScope.kind` 是 `standalone-subagent`，而 Goal 面另有 kind。工具面按 operation 拆分**不改变** kind 的取值集合，也**不新增** kind。若将来 Goal 需要 agent 面工具，应另起工具而非复用 `workspace_*` 并放宽 kind。
4. **不与 run 一一对应**：`completion-reminder.ts:40-48` 用 `listOwned({ownerScope, runId})` 过滤后仍可能出现 `matches.length !== 1`（`:45`），此时发 `SUBAGENT_WORKSPACE_REMINDER_AMBIGUOUS` 并**不投递**提醒。这证明「一个 run ↔ 一个 workspace」不是不变量，工具与文案都不得假设它。
5. **不禁止所有父层 integrate**：见 WS-02/WS-03。`publication` 的判定权威在 service，不在工具名或文本。

### 8.2 三个示例（拆分后的调用形态）

```js
// 1) 列出本 root session 拥有的受管工作区（无参数）
managed_workspace_list({})
// → [{ workspace_id, state, workspace_state, lease_id, process_terminal, … }]

// 2) 取实时状态；仅 active 时返回一次性 action_token
const s = managed_workspace_status({ workspace_id: id })
// s.state / s.allowed_dispositions / s.action_token? / s.integrate_blocked_reasons?

// 3) 按本次 status 的权威返回处置（不猜 disposition、不复用旧 token）
if (s.state === "active" && s.allowed_dispositions.includes("preserve")) {
  managed_workspace_dispose({
    workspace_id: id, disposition: "preserve", action_token: s.action_token,
  })
}
// 另一条独立分支：preserved / cleanup-debt 才 release；released 是终态
if (s.state === "preserved" || s.state === "cleanup-debt") {
  managed_workspace_release({ workspace_id: id })
}
```

三个示例与现状 `pi/AGENTS_GLOBAL.md:115-131` 的语义**完全等价**，差别只在：动作名从 `action` 值变成工具名，`status`/`dispose`/`release` 的互斥关系从「模型读文档判断」变成「schema 类型上不可能混用」。

### 8.3 上下文节省：不编量化

- 可确定的方向性事实：当前 `SUBAGENT_WORKSPACE_DESCRIPTION` 约 **698 字符 / 1062 UTF-8 字节（CJK 175）**，每请求无条件发送；拆分后 `list`/`release` 的 description 可显著短于它，而 `dispose`/`status` 仍需保留 token 与 child-owned 前提。
- **本文不给出净节省数字。** 原因：(a) 拆分新增 3 个工具各自的共享前提；(b) `TYPED_SUBAGENT_DESCRIPTION`（1873 字符 / 3141 字节 / CJK 594，粗略估算 ~854 token）的分摊结果取决于每工具保留多少；(c) 估算基于字符/CJK 启发式，**非 tokenizer 实测**。测量方法见 §9.3。

### 8.4 迁移与弃用：必须由用户选择

拆分必然涉及旧入口去留。**本文不预设答案**，只列出必须裁决的选项与各自代价：

| 选项 | 代价 |
|---|---|
| A. 硬切换：一次移除 `subagent`/`subagent_worktree`/`subagent_supervisor` | 所有 L5 文本、skill、既有 session 的历史调用示例、`docs/**` 引用同时失效；upstream 文本（如 `tool-activation.js:112`）指向不存在的工具 |
| B. 兼容期双入口：旧 union 工具与新独立工具并存 | **与「全部拆开」的目标冲突**：模型面对 3 + 14 个重叠工具，选择歧义与 description 总量都上升；须额外定义两入口的行为等价性与弃用日 |
| C. 兼容期薄壳：旧工具保留但 description 只写「已拆分，请用 `subagent_*`」并转发 | 工具数仍 +3，但 description 总量可控；须保证转发不绕过任何 L1 门禁 |

**不能既建议保留无限期旧总入口、又声称已完成全部拆分。** 该选择属产品决策，须由父会话/用户确认。

---

## 9. 迁移面清单（若用户确认拆分）

以下只列**必须触达的面**，不构成实施计划。

### 9.1 现有单一 union 工具

- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`：`:54-114`（`TYPED_SUBAGENT_PARAMETERS`）、`:117`（description）、`:1576-1641`（tool 定义与 `execute` 路由，路由体在 `:1612-1618`）、`:1174-1340`（`executeControl`）、`:767-1120`（`executeCoding` 自 `:767`、`executeGeneric` 自 `:982`，两处 `workspaceNotice` 在 `:972-973` 与 `:1106-1107`）。
- `packages/pi-subagents-enhanced/src/workspace/tool.ts`：`:3-26`（四分支 schema + `anyOf`）、`:28-35`（description）、`:57-106`（工具定义与 `execute`）。
- `packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-adapter.ts`：`:1-13`、`:44-73`。
- `packages/pi-subagents-enhanced/src/subagent-dispatch/runtime-membrane.ts:175-189`：`registerTool` 拦截按 **name** 判定（`SUPERVISOR_TOOL_NAME`），`getAllTools` 过滤（`:187-189`）亦按 name。拆分后若 supervisor 变成 3 个工具，**这两处 name 判定必须同步**，否则 upstream 的 supervisor 定义会漏注册或漏过滤。这是拆分中最容易遗漏的 L1 联动点。

### 9.2 `AGENTS_*.md` / skill / description / renderer / SDK 注册 / child ceiling / 调用者

| 面 | 具体坐标 | 拆分后需要做什么 |
|---|---|---|
| L5 main 规范 | `pi/AGENTS_GLOBAL.md:46-58`（组合流程）、`:59-70`（派发格式含 `subagent({...})` 示例）、`:111-138`（Workspace 处置含 `subagent_worktree` 示例）、`:139-145`（生命周期） | 示例改为新工具名；**保留**治理语义，不下沉到工具文案 |
| L5 共享规范 | `pi/AGENTS_SHARED.md`（停止条件引用 `contact_supervisor`） | 无需改（child 面工具不变）；但须裁决 MD-03 的 reviewer 矛盾 |
| L5 包规范 | `packages/pi-subagents-enhanced/AGENTS.md`「Workspace 所有权边界」「TUI 精简边界」 | 无需改；拆分不得违反 |
| agent profile | `pi/agents/delegate.md`、`executor.md`、`reviewer.md` frontmatter `tools:` | **child 不含任何 `subagent*` 工具**，故无需改；若将来 child 面也拆 `subagent_integration`，则三者 `tools:` 必须同步 |
| skill | 本次未逐一枚举 skill 正文（合同允许「不需全部 external」）。已知 `pi/AGENTS_GLOBAL.md:78` 要求 skill 路径显式给出 | 需一次全库 grep `subagent_worktree\|subagent({` 于 skill 目录后再定清单（**未做，标 unknown**） |
| description | §9.1 三处 + `child-extensions/integration-queue.ts:22` | 每工具重写为「对象 + 必填 + 权威来源」一句式（§6.3 brief 正例） |
| renderer | `src/tui/tool-renderers.ts:51-110`（`renderSubagentCall` 定义于 `:51`，按 `action` 分支，`:57` 输出 `subagent ${action}`；`renderSupervisorCall` 定义于 `:83`，`:89` 输出 `subagent_supervisor ${action}`）、`:116-119`（child 预览映射表）、`src/tui/compact-rendering.ts:101-113` | 每工具需独立 renderer 或共享 factory；**同时补齐 WS-08 的 workspace renderer 缺口**；child 预览映射表须加新名 |
| SDK / Host 注册 | `extensions/subagent-runtime.ts:311-345`（`installHeadlessTypedSubagentRuntime` 选项）、`extension.ts:1657-1690`（注册顺序） | 注册数量从 3 增至 14；须确认 `pi.registerTool` 多次调用无 name 冲突、`registrationFailures` map 语义不变 |
| child ceiling | `src/subagent-dispatch/child-tool-policy.ts` + `pi/extensions/subagent/config.json`（当前无 `childToolCeiling`） | 若将来启用 ceiling，`allowedTools` 名单须列新工具名；`TOOL_NAME` 正则 `^[A-Za-z0-9_.:-]+$` 允许下划线，无需改 |
| 调用者适配 | `docs/**` 中大量既有引用（`docs/plans/2026-09-25-pi-stack-isolated-upgrade.md:15,362,383`、`docs/plans/2026-09-12-pi-0851-repository-merge-queue.md:339,610`、`docs/plans/records/2026-10-13-heartbeat-*.md` 多处、`docs/investigations/2026-09-22-*` 多处） | **历史计划/验收记录不应改写**（它们是当时事实）；只在新文档中使用新名，并在 L5 规范中给一次映射表 |
| 测试 | `test/subagent-runtime-membrane.test.mjs:965-975`（断言 `pi.tools[0..2]` 的 `exposure`/`promptSnippet`/`promptGuidelines`，**含 `promptGuidelines.length === 3` 与 `=== 2` 的硬断言**）、`test/task-scheduler-adapter.test.mjs:246-279`（含 `:279` 的 `exposure === "model-only"` 断言）、`test/bash-async.test.mjs:109`（`tool.exposure === 'model-only'`）、`test/bash-cwd-extension.test.mjs:70`（guidelines 追加顺序）。注：`docs/plans/2026-10-03-pi-1.0.0-compatibility-upgrade.md:231-236` 提及的 `test/pi-100-typed-exposure.test.mjs` 与 `test/pi-100-scheduler-exposure.test.mjs` **实测不存在于当前工作区**（`ls test/` 无此二文件），不得作为现有回归网引用 | 拆分必然使 `tools[0..2]` 索引断言失效，需按 name 查找重写。**本次不修改任何测试。** |
| 派发预算 / 状态恢复 | `pi/AGENTS_GLOBAL.md:77`（30 分钟是任务组织预算，**不是** runtime watchdog）；`extension.ts:47`（`HOST_EXECUTION_TIMEOUT_MS = 2_147_000_000`）；`rpc-client.ts` 的 renewable client（`subagent-runtime.ts:21`）；`supervisor-replay.ts` / `replay-barrier.ts` / `durable-*` 系列 | 工具名不参与这些机制的键（run 身份用 `runId`/`toolCallId`/`rootSessionId`），故**拆分不影响恢复语义**；但 `intentId: toolCallId`（`extension.ts:1230` 与 `:1282`）与 `requestId: toolCallId`（`integration-queue.ts:159`）依赖 toolCallId 唯一性，拆分后仍成立 |
| usage metrics | 未在仓库内发现按工具名聚合的 usage metrics 实现（`grep` 未命中）。`docs/investigations/2026-09-22-…/A-session-forensics.md:13,213` 的 29 次统计来自**人工 session 取证**，非 runtime 指标 | **unknown**：拆分后若需对比试错率，须先建立可复现的计数口径，不能沿用人工取证数字做前后对比 |

### 9.3 测量方案（不运行）

实施前后应实测以下四项，本文**不预估**其数值：

1. **每请求 tool schema 总字节**：枚举 main 会话 active 工具，累加 `description` + `JSON.stringify(parameters)` 的 UTF-8 字节；用真实 tokenizer（非字符启发式）折算 token。对比拆分前后。
2. **system prompt `<tools>` + `<rules>` section 字节**：按 `dist/core/system-prompt.js:84-87` 的构造方式离线复现（只喂 `promptSnippet`/`promptGuidelines`），不启动 Host。
3. **选择歧义**：固定同一批真实场景（各 10 例：查 run 状态 / 查 workspace 状态 / 查 supervisor 请求），统计模型首次选对工具的比例与错误类别。**这是行为测量，须用户另行授权后执行，本次不做。**
4. **workspace 处置试错率**：以 `workspace_status`→`dispose/release` 的调用序列为单位，统计「首次即成功」的比例，与 `A-session-forensics.md:13` 的历史取证（status×15/dispose×5/release×6/list×3、integrate 成功 0）作**定性**对照，不作定量等同。

---

## 10. 明确不做的事（合同禁止项自检）

- **不建议**默认删除 MD、不建议自动放宽任何门禁。§7 的「删除」项只针对**已被 L1 强制或被 L3 在行动时刻覆盖的重复文案**，且 MD-01/MD-02/MD-03 明确保留。
- **不建议**把 request 正文、凭据、token 打包进工具参数或回执。`action_token` 只能来自实时 `status`（WS-01）；`pi/AGENTS_SHARED.md`「敏感信息」段继续适用。
- **不建议**为每个工具增加长篇 policy 噪声。§6.3 的 brief 正/反例即为判据：一句说清对象、必填、权威来源。
- **不写实施计划、不改实现、不改规则、不改旧文档、不改测试。** 本文是唯一产物。
- 未读取任何真实 settings/models/auth/session/authority/state/artifact 正文；未联网、未调用 provider、未运行测试、未 npm、未 kill、未通知、未提交、未清理。
- 未 read/load 任何 TDD 类 skill；未使用 deepseek 系列模型。

---

## 11. Unknown / 未验证清单（明确而非猜测）

| # | 事项 | 状态 |
|---|---|---|
| U1 | main 会话模型可见工具**总数** | **unknown**。本文只确认 subagent 家族 3 个 + upstream loader 未注册；原生与其余扩展工具未逐一枚举 |
| U2 | 各 description 的**真实 token 数** | **未验证**。本文只给字符/UTF-8 字节/CJK 计数与启发式估算，非 tokenizer 实测 |
| U3 | `supervisor_status` 是否消费 `replyTo` | **unknown**。upstream `subagent_supervisor` 的 execute 实现未读（经 membrane 绑定，本仓不拥有行为） |
| U4 | skill 正文中对 `subagent*` 字面的引用清单 | **unknown**。未做全库 skill grep（合同允许不全扫） |
| U5 | 按工具名的 usage metrics 是否存在 | **未发现**；历史统计来自人工 session 取证 |
| U6 | `security-gates/shell-policy.ts` 的具体策略集合 | **部分未读**。只确认 `docs/architecture/bash-async.md:12` 声称 `bash` 与 `bash_async` 共用同一策略，未逐条核对策略内容 |
| U7 | `e99feb57` 的 bash_async 详细文本报告 | **已存在**：`docs/research/2026-10-15-bash-async-agent-guidance.md`（本文收口时落盘）。本文只读其标题与自述范围用于对齐分类，**未逐项核对其正文结论**；BA-02/BA-03 的具体文案变更以该报告为权威 |
| U8 | 拆分后各 provider 是否复现顶层 union 空 args bug | **未验证**。已知单一 object 顶层可规避（`extension.ts:48-52`），但逐 provider 验证需实际调用，超出只读范围 |
| U9 | runtime-closeout Wave1 F1/P0/D0/N1 的当前实现细节 | **未读**（合同要求不写冲突即可）。本文引用的 `src/tui/background-activity.ts`、`src/bash-async` activity source 等均为只读观察 |

---

## 12. 结论摘要

1. **五层权威必须分列**：`description`/`promptSnippet`/`promptGuidelines`/回执/MD 全部是模型可见文本，**没有一条构成代码强制**。本仓真正的 L1 强制点是：extension early-return（`subagent-runtime.ts:208`）、frontmatter `tools` 白名单、`exposure:"model-only"` 的不可间接调用、`additionalProperties:false` schema、`canonicalSteerTarget` 的 5 个拒绝码、workspace 的 ownerScope/owner kind/token CAS/`CHILD_OWNS_INTEGRATION`、bash_async 的 mode 与 timeout 门禁、capability ceiling 机制（**当前未配置，故未生效**）。
2. **`promptGuidelines` 是比 `description` 更脆弱的通道**：`customPrompt` 与 `forceSystemPrompt` 两条合法 host 路径会让它连同 `promptSnippet` 整体消失（`dist/core/system-prompt.js:78-96,127-131`）。安全前提不得只放在 guidelines。
3. **`promptGuidelines` 与 `AGENTS_*.md` 的语义重复不会被 runtime 合并**：去重只按字面串、且只在 guidelines 集合内部生效。重复必须人工消除。
4. **main/child 不默认同工具可见，且本仓在这一点上是代码强制**：child 完全没有 `subagent`/`subagent_worktree`/`subagent_supervisor`（扩展未安装），main 完全没有 `subagent_integration`。但 **`reviewer` 的白名单缺 `contact_supervisor`，而 runtime 注入的 child boundaries 文本指示使用它**（MD-03）——这是文本与 L1 的直接矛盾，需产品裁决。
5. **现存最严重的引导缺陷不在 description，而在两条 L3 回执**：spawn `workspaceNotice`（`extension.ts:972-973`/`:1106-1107`）与 completion reminder（`completion-reminder.ts:54-56`）都无条件建议 `integrate or discard`，与 `CHILD_OWNS_INTEGRATION` 的 L1 事实冲突，并已有现场取证（29 次调用、typed integrate 成功 0 次、三次改用 raw git）。
6. **`list` 不重复 profile 正文**，只重复 frontmatter，且 content 与 details 双份——这是刻意的模型选择入口设计，符合 TUI 边界。附带发现 `LIST_EXCLUDED_FIELDS`（`extension.ts:30`）为未使用的 dead code，且与实际返回 `frontmatter` 的行为矛盾。
7. **bash_async 两类 sleep 误用性质不同**：等待型（BA-02）无任何 L1 可强制，只能靠一句 L2 + L5；载荷型（BA-03）中 `sleep` 作为命令载荷是**合法且被真实使用过的**（两份 bug 记录），不得被文案写成违规，真正的边界是「不用于自建 daemon / 长服务 / nohup」。附带发现 BA-06：`index.ts:59` 的 `clear_queue` 字面既非本工具参数、也非原生 Bash 参数（原生只有 `{command, timeout}`），而是 Host/RPC 队列命令类型，当前写法对模型有误导风险。
8. **用户最新决策（全部拆分为每操作独立工具）在源码层面是站得住的**：它绕开顶层 union 的 provider bug、让 `writePaths ⇒ acceptance` 可上升为 schema 级约束、从类型上消除 workspace 控制误带 coding 字段的可能。但代价是 model-visible 工具数从 3 增至 14，且**本仓当前没有 upstream 的 `subagents_enable` loader 可折叠它们**（被 membrane 拦截，§2.4 第 5 条）——所以 description 总量是否下降必须实测，不能假定。
9. **拆分最大的隐性联动点是 `runtime-membrane.ts:175-189` 的按名判定**，以及 `test/subagent-runtime-membrane.test.mjs:965-975` 的按索引断言。二者若漏改，会分别造成 supervisor 定义漏注册/漏过滤与测试静默失效。另需注意：`docs/plans/2026-10-03-pi-1.0.0-compatibility-upgrade.md` 所引用的两个 `pi-100-*-exposure` 测试文件**当前不存在**，因此 `exposure:"model-only"` 的回归保护实际仅由 `subagent-runtime-membrane.test.mjs:965/969/972`、`bash-async.test.mjs:109`、`task-scheduler-adapter.test.mjs:279` 承担。
10. **兼容期去留（硬切换 / 双入口 / 薄壳）属产品决策**，本文不预设；但明确不能既保留无限期旧总入口又声称完成全部拆分。

---

*本文全部结论均可由上文列出的文件路径与行号复核。凡标注 unknown / 未验证者，均未取得源码或实测支撑，不得作为后续实施依据。*
