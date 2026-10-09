# Agent Configuration

Pi config root is `pi/` (not `~/.pi`). Agent 规范入口：`pi/AGENTS_SHARED.md` 对主 agent 与全部 subagent 生效；`pi/AGENTS_GLOBAL.md` 由 runtime 仅加载进父/main 会话，root 不会要求 child 再读 GLOBAL。角色限定只影响 pi/ 规范文件的适用范围，不改变本根目录工程规范对所有 agent（含 subagent）的适用。

## 目录职责与依赖边界

- `scripts/` 只放可直接执行的 CLI、初始化脚本和诊断探针；可复用实现不得新增到 `scripts/`，production 模块不得新增对 `scripts/**` 的 import。CLI 应从所属 feature 或 package 的公开入口消费能力。
- Node 原生可执行的 production/CLI 代码统一使用 `.ts`；`scripts/*.ts`、`scripts/probes/*.ts` 和 package 内直接由 Node 调用的 `scripts/*.ts` 仍可通过 shebang/npm script 直接运行。`.mjs` 仅用于 `test/` 下的测试、fixture、测试辅助模块，以及第三方入口或尚未迁移的外部兼容文件；不得为新的 production/CLI 实现选择 `.mjs`。
- 仓库和 package 的最低 Node 版本固定为 `>=22.19.0`，依赖其原生 TypeScript type-stripping 能力；type-stripping 不等于类型检查，新增或迁移 TypeScript 实现应由 `tsc --noEmit` 或等价静态检查覆盖。
- `scripts/lib/` 是待迁移的历史目录，不是共享基础库。禁止在其中新增文件、扩大依赖或把新调用方接入其中；修改存量模块时，应优先将实现迁到所属 `src/<feature>/` 或 `packages/<name>/src/`，并在调用方清零后删除旧路径，不保留一行 re-export facade。
- `pi/extensions/` 只放 Pi 自动发现入口及其入口级配置。入口负责 Host API 绑定、依赖注入和资源注册；可复用业务逻辑归属根 `src/<feature>/` 或对应 package，其他 feature 不得 import `pi/extensions/**` 作为实现库。
- 根 `src/<feature>/` 存放尚未独立发行的 feature-owned 实现；代码、状态机、codec 和 renderer 按领域归属，不建立根级 `lib/`、`common/`、`utils/` 通用收容目录。
- `packages/<name>/extensions/` 只放该 package manifest 声明的主 Host 入口，`packages/<name>/child-extensions/` 只放显式注入 child 的入口，实际实现放在 `packages/<name>/src/`。主 Host 与 child 入口不得因复用方便混用发现边界。
- 跨 feature 依赖只能通过对方明确的公开入口或 package `exports`；禁止深层引用其他 feature 的内部文件，也禁止从 `src/**` 或 `packages/**/src/**` 反向依赖 `scripts/**`、`pi/extensions/**` 等宿主入口。
- 只有具备稳定领域边界、明确 owner 和独立发行/版本价值的能力才可抽为共享 package；不得仅为消除少量重复创建新的通用库。

## 外部工具接入规范

本仓禁止通过 MCP 接入、注册或直接使用任何工具，包括运行 MCP server 和调用其暴露的 tools。外部工具能力统一通过 skill wrapper 封装调用：任何原 MCP 工具一律改为 skill wrapper 形式使用，不得绕开本规范直接调用 MCP。wrapper 必须消费受支持的 CLI、SDK、HTTP 等非 MCP 入口，不得把 MCP client 藏在 skill 内以 wrapper 名义继续走 MCP。本规范仅约束 MCP 接入形态，不泛化禁止 web browser 等非 MCP 普通工具。

## Goal 改造执行方式

在 `docs/superpowers/plans/2026-08-13-goal-obligation-runtime.md` 的 R0–R13 全部完成并通过 R13 验收前，禁止使用 Goal Engine 执行、编排或验收该改造计划；所有任务必须按计划 DAG 采用 Subagent-Driven 执行。既有 `planned-goal` 仅作为冻结的历史账本，不得阻塞 R1–R13；待 R13 通过并启动 fresh Host 后再通过 typed 工具收尾。

## `pi/settings.json` 提交规则

`enabledModels` 字段为 per-machine 配置（各机器可用模型不同），禁止提交其变更。
`/scoped-models` 命令产生的 diff 应丢弃（interactive discard hunk 或 `git checkout -- pi/settings.json`）。
其他字段（如 `defaultThinkingLevel`、`goalEngine`、`compaction` 等）有变更时正常提交。

## `pi/models.json` 本机配置

`pi/models.json` 已整体加入 .gitignore 并移出版本控制：本机专用 provider/model 定义直接维护在工作区文件中，无提交与同步流程，不再使用 skip-worktree。其他机器拉取到移除跟踪的提交时，若本地文件被 git 删除或根提示冲突，从本机备份恢复即可。

## TUI 精简边界

所有面向用户的精简、折叠、摘要、截断和换行只能发生在 TUI renderer 层。不得为改善 TUI 展示而改写 agent 实际收到的消息、tool result、event payload、session 内容或其结构化 details；TUI renderer 必须消费原始数据并生成独立的显示文本。

## 缺陷数据来源分类门禁

测试、恢复或实际运行发现异常时，在增加任何 production 兼容、防御或 fallback 逻辑前，必须先记录数据来源、首个偏离点和完整生成调用链，并完成以下分类：

1. **预期 production 数据未被正确处理**：数据可由合法 public/typed 入口、权威 Host/Store 与正常事件顺序产生，且身份、时间和资源事实均有效。按生产缺陷处理：中文问题记录、精确复现证据、最小修复。
2. **测试制造的非预期数据**：数据来自手工拼 projection/event、绕过 public 入口的直接 append、非法或倒退时间、缺字段 mock、过期 fixture，或设计中不可达的状态组合。只修测试、fixture 或 harness；禁止为其增加 production 兼容分支。
3. **来源尚未证实**：无法证明 production 可达，也无法证明仅为 fixture 污染。必须 fail closed、保留现场并补充 provenance 证据；在完成分类前禁止预防性兼容。

分类证据必须覆盖实际入口、权威身份、事件/资源顺序和与 production 事实的差异。仅有测试失败、标题矩阵、模拟对象或“理论上可能”均不足以证明 production 可达。不得将三类异常一视同仁。
