# Agent Configuration

Pi config root is `pi/` (not `~/.pi`). See `pi/AGENTS.md` for constraints.

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

## Goal 改造执行方式

在 `docs/superpowers/plans/2026-08-13-goal-obligation-runtime.md` 的 R0–R13 全部完成并通过 R13 验收前，禁止使用 Goal Engine 执行、编排或验收该改造计划；所有任务必须按计划 DAG 采用 Subagent-Driven 执行。既有 `planned-goal` 仅作为冻结的历史账本，不得阻塞 R1–R13；待 R13 通过并启动 fresh Host 后再通过 typed 工具收尾。

## `pi/settings.json` 提交规则

`enabledModels` 字段为 per-machine 配置（各机器可用模型不同），禁止提交其变更。
`/scoped-models` 命令产生的 diff 应丢弃（interactive discard hunk 或 `git checkout -- pi/settings.json`）。
其他字段（如 `defaultThinkingLevel`、`goalEngine`、`compaction` 等）有变更时正常提交。

## `pi/models.json` 本机配置

本机专用 provider/model 定义可通过 `git update-index --skip-worktree pi/models.json` 仅保留在本地，禁止提交。上游修改 `pi/models.json` 时，必须先执行 `git update-index --no-skip-worktree pi/models.json`，再进行同步；同步完成并恢复本机定义后，如仍需隐藏本地差异，再重新设置 `--skip-worktree`。

## TUI 精简边界

所有面向用户的精简、折叠、摘要、截断和换行只能发生在 TUI renderer 层。不得为改善 TUI 展示而改写 agent 实际收到的消息、tool result、event payload、session 内容或其结构化 details；TUI renderer 必须消费原始数据并生成独立的显示文本。

## 缺陷数据来源分类门禁

测试、恢复或实际运行发现异常时，在增加任何 production 兼容、防御或 fallback 逻辑前，必须先记录数据来源、首个偏离点和完整生成调用链，并完成以下分类：

1. **预期 production 数据未被正确处理**：数据可由合法 public/typed 入口、权威 Host/Store 与正常事件顺序产生，且身份、时间和资源事实均有效。按生产缺陷处理：中文问题记录、精确 RED、最小修复。
2. **测试制造的非预期数据**：数据来自手工拼 projection/event、绕过 public 入口的直接 append、非法或倒退时间、缺字段 mock、过期 fixture，或设计中不可达的状态组合。只修测试、fixture 或 harness；禁止为其增加 production 兼容分支。
3. **来源尚未证实**：无法证明 production 可达，也无法证明仅为 fixture 污染。必须 fail closed、保留现场并补充 provenance 证据；在完成分类前禁止预防性兼容。

分类证据必须覆盖实际入口、权威身份、事件/资源顺序和与 production 事实的差异。仅有测试失败、标题矩阵、模拟对象或“理论上可能”均不足以证明 production 可达。不得将三类异常一视同仁。
