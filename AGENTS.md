# Agent Configuration

Pi config root is `pi/` (not `~/.pi`). Agent 规范入口：`pi/AGENTS_SHARED.md` 对主 agent 与全部 subagent 生效；`pi/AGENTS_MAIN.md` 由 runtime 仅加载进父/main 会话，root 不会要求 child 再读 MAIN。角色限定只影响 pi/ 规范文件的适用范围，不改变本根目录工程规范对所有 agent（含 subagent）的适用。

## 目录职责与依赖边界

- `scripts/` 只放可直接执行的 CLI、初始化脚本和诊断探针；可复用实现不得新增到 `scripts/`，production 模块不得新增对 `scripts/**` 的 import。CLI 应从所属 feature 或 package 的公开入口消费能力。
- Node 原生可执行的 production/CLI 代码统一使用 `.ts`；`scripts/*.ts`、`scripts/probes/*.ts` 和 package 内直接由 Node 调用的 `scripts/*.ts` 仍可通过 shebang/npm script 直接运行。`.mjs` 仅用于 `test/` 下的测试、fixture、测试辅助模块，以及第三方入口或尚未迁移的外部兼容文件；不得为新的 production/CLI 实现选择 `.mjs`。
- 仓库和 package 的最低 Node 版本固定为 `>=22.19.0`，依赖其原生 TypeScript type-stripping 能力；type-stripping 不等于类型检查，新增或迁移 TypeScript 实现应由 `tsc --noEmit` 或等价静态检查覆盖。
- `scripts/lib/` 是待迁移的历史目录，不是共享基础库。禁止在其中新增文件、扩大依赖或把新调用方接入其中；修改存量模块时，应优先将实现迁到所属 `src/<feature>/` 或 `packages/<name>/src/`，并在调用方清零后删除旧路径，不保留一行 re-export facade。
- 本仓扩展统一放在 `src/<feature>/`，每个扩展以 `<feature>.ts` 负责 Host API 绑定、依赖注入和资源注册，由 `pi/settings.template.json` 显式声明加载。实现与入口同目录，不在 `pi/extensions/` 保留转发壳或本仓配置文件。
- 根 `src/<feature>/` 存放尚未独立发行的 feature-owned 实现；代码、状态机、codec 和 renderer 按领域归属，不建立根级 `lib/`、`common/`、`utils/` 通用收容目录。
- `packages/<name>/extensions/` 只放该 package manifest 声明的主 Host 入口，`packages/<name>/child-extensions/` 只放显式注入 child 的入口，实际实现放在 `packages/<name>/src/`。主 Host 与 child 入口不得因复用方便混用发现边界。
- 跨 feature 依赖只能通过对方明确的公开入口或 package `exports`；禁止深层引用其他 feature 的内部文件，不得把其他 feature 的 `<feature>.ts` 作为实现库，也禁止从 `src/**` 或 `packages/**/src/**` 反向依赖 `scripts/**` 等宿主入口。
- 只有具备稳定领域边界、明确 owner 和独立发行/版本价值的能力才可抽为共享 package；不得仅为消除少量重复创建新的通用库。

## 外部工具接入规范

本仓禁止通过 MCP 接入、注册或直接使用任何工具，包括运行 MCP server 和调用其暴露的 tools。外部工具能力统一通过仓库内受控 custom tool 封装调用；不得把 MCP client 藏在 custom tool 内绕过本规范。custom tool 必须消费受支持的 CLI、SDK、HTTP 等非 MCP 入口。本规范仅约束 MCP 接入形态，不泛化禁止 web browser 等非 MCP 普通工具。

## npm 源规范

npm 只能使用官方源 `https://registry.npmjs.org/`；禁止使用淘宝、阿里或其他第三方 registry。

## Git 操作规范

执行 Git 操作时，优先使用 `git1` 命令；只有在确认当前环境不存在 `git1` 命令后，才使用 `git`。

## Pi settings 配置边界

- `pi/settings.json` 是仓库共享配置，必须保持可提交、可同步；只放实际由 Pi 或已启用扩展消费的共享设置、package 和 extension 声明。
- `pi/settings.local.json` 是被 `.gitignore` 忽略的本机覆盖文件，不得提交。可从 `pi/settings.local.example.json` 复制，维护本机 `packages`、`enabledModels`、`defaultProvider`、`defaultModel`、`defaultThinkingLevel` 和 `theme`。
- `scripts/pi-launcher.zsh` 启动时通过 `scripts/pi-local-settings.ts` 将 local 配置转换为本次 CLI 参数；显式命令行参数优先，不要把本机值回填到 tracked `pi/settings.json`。
- `theme` 未设置时应交给 Pi 的 `system` 默认值，自动根据终端明暗外观选择；不要在共享 settings 中写死 `dark` 或 `light`。
- `deviceId`、`lastChangelogVersion` 是 Pi 运行时/机器状态，不应放入共享 settings；`goalEngine` 和空的 `src/test-payload/test-payload.ts` 曾是未被当前运行链路消费的残留，已从共享 settings 移除。`subagents` 配置由 `pi-subagents` 消费，不能据此删除。
- 本机 package 例如 `../../.r2c/integrations/pi-adapter` 不得写入共享 `packages`；`ensure-pi-settings.ts` 不再自动把它挂载到 tracked settings，launcher 会从 local `packages` 生成本次启动的 `--extension` 参数。不存在的可选 local package 会被跳过。
- `/scoped-models` 命令产生的 diff 不应写入共享 settings；若它修改了 `pi/settings.json`，应恢复该机器专用字段到 `pi/settings.local.json`。

## `pi/models.json` 本机配置

`pi/models.json` 已整体加入 .gitignore 并移出版本控制：本机专用 provider/model 定义直接维护在工作区文件中，无提交与同步流程，不再使用 skip-worktree。其他机器拉取到移除跟踪的提交时，若本地文件被 git 删除或根提示冲突，从本机备份恢复即可。

## TUI 精简边界

所有面向用户的精简、折叠、摘要、截断和换行只能发生在 TUI renderer 层。不得为改善 TUI 展示而改写 agent 实际收到的消息、tool result、event payload、session 内容或其结构化 details；TUI renderer 必须消费原始数据并生成独立的显示文本。

## Deferred Tool 维护规范

本仓 deferred tool 遵循 Pi 官方 `Dynamic Tool Loading` / `Tool Exposure` 约定（当前基线为 `@earendil-works/pi-coding-agent@1.5.2`）：

- **选择 exposure**：高频、每轮都需要的能力使用 `direct`；领域专用、低频或声明较大的能力使用 `exposure: "deferred"`，让 `tool_search` 按需发现并在下一次模型请求中激活。deferred tool 仍应通过 `pi.registerTool()` 注册，不能在调用时临时绕过注册表。
- **保持初始上下文轻量**：deferred tool 默认不进入模型初始工具声明；显式设置 `defaultActive: false`，loader（通常是 `tool_search`）保持 active。不要为 deferred tool 另写自定义发现/加载机制。
- **分层写文案**：`description` 必须完整说明能力、适用场景、主要副作用和关键限制；`parameters` 的字段名、description、枚举值必须足够让 tool search 发现和区分能力。Pi 的 tool search 索引 description 与参数 schema，不索引 `promptSnippet` / `promptGuidelines`。
- **加载后文案**：`promptSnippet` 只写一行简短的使用提示，进入 active tool 的 system prompt `<tools>` 区域；`promptGuidelines` 只写模型执行时的规则，进入 active tool 的 `<rules>` 区域。guideline 会扁平追加，必须显式写工具名，不能使用没有指代对象的“使用本工具”。
- **标准协议入口**：工具的全部模型可用能力必须通过 Pi custom tool 的 `parameters`、`execute()` 和标准 tool result 暴露。不得把 production tool 能力只放在独立 CLI、shell 命令或隐式脚本入口；CLI 只能是经用户明确需要的诊断/维护入口，并复用 tool-owned 实现。
- **加载后契约**：tool_search 返回匹配工具后，工具完整声明在下一次模型请求生效；工具执行结果必须返回 `content`，结构化数据使用 `details` / `structuredContent`，不要通过改写 prompt 或拼接不可验证文本传递结果。
- **审计要求**：新增或修改 deferred tool 时，必须检查初始不可见性、tool_search 可检索性、加载后完整声明、参数 schema、prompt 文案和实际执行入口；至少运行 typecheck 与对应 tool contract 测试。工具名、description、参数 schema 发生变化时，补充真实 loader/激活路径验证。

## 缺陷数据来源分类门禁

测试、恢复或实际运行发现异常时，在增加任何 production 兼容、防御或 fallback 逻辑前，必须先记录数据来源、首个偏离点和完整生成调用链，并完成以下分类：

1. **预期 production 数据未被正确处理**：数据可由合法 public/typed 入口、权威 Host/Store 与正常事件顺序产生，且身份、时间和资源事实均有效。按生产缺陷处理：中文问题记录、精确复现证据、最小修复。
2. **测试制造的非预期数据**：数据来自手工拼 projection/event、绕过 public 入口的直接 append、非法或倒退时间、缺字段 mock、过期 fixture，或设计中不可达的状态组合。只修测试、fixture 或 harness；禁止为其增加 production 兼容分支。
3. **来源尚未证实**：无法证明 production 可达，也无法证明仅为 fixture 污染。必须 fail closed、保留现场并补充 provenance 证据；在完成分类前禁止预防性兼容。

分类证据必须覆盖实际入口、权威身份、事件/资源顺序和与 production 事实的差异。仅有测试失败、标题矩阵、模拟对象或“理论上可能”均不足以证明 production 可达。不得将三类异常一视同仁。
