# Agent profile frontmatter 漂移与待决冲突

## 现场事实

`pi/agents/{delegate,executor,reviewer}.md` 相对 HEAD 有未提交改动，本记录只引用非敏感 frontmatter 事实，不读凭据、settings、models.json 或 auth 正文。

| 文件 | mtime | 改动 |
| --- | --- | --- |
| `pi/agents/reviewer.md` | 2026-10-19 11:34:30 | `models` 去掉 `openai-codex/gpt-6-astra`、`qoder-pool/GLM-5.3`，加入 `qoder-pool/Qwen3.8-Max`；`tools` 未变（仍 `read,grep,find,ls,bash`，无 `contact_supervisor`） |
| `pi/agents/executor.md` | 2026-10-19 11:34:53 | `models` 去掉 `qoder-pool/GLM-5.3-Flash`、`qoder-pool/Qwen3.8-Flash`，首位改为 `qoder-pool/DeepSeek-Flash`；`tools` 去掉 `contact_supervisor` |
| `pi/agents/delegate.md` | 2026-10-19 11:35:48 | `models` 首位加入 `qoder-pool/DeepSeek-Flash`，去掉 `qoder-pool/GLM-5.3`；`tools` 去掉 `contact_supervisor` |

时间线对照：本批 Inline 基线记录写于 2026-10-18 13:35，`pi/AGENTS_GLOBAL.md` 的模型规则修改在 2026-10-19 13:59，三份 profile 的改动发生在 2026-10-19 11:34–11:35，即基线之后、本批文档修改之前。

本批辅助脚本未触及这些文件：`/tmp/runtime-policy-authorization-update.py`、`/tmp/runtime-existing-caller-migration.py`、`/tmp/runtime-existing-worktree-migration.py`、`/tmp/runtime-migrate-existing-fixtures.py` 中均无 `pi/agents`、`contact_supervisor`、`models`、`DeepSeek` 相关写入。因此不能把它们归因为本批 policy 清理产物，也不能排除是本机配置侧（用户或 Host 命令）的编辑。

## 两处冲突

### 1. `contact_supervisor` 从 executor/delegate 白名单消失

- `pi/AGENTS_GLOBAL.md` 仍写明：「某 agent 能否调用 `contact_supervisor` 以其 profile 的 `tools` 白名单为事实（例如 `reviewer` 未列入该工具，`executor`/`delegate` 已列入）」。
- `pi/agents/executor.md` 正文仍要求：「决策阻塞时使用 `contact_supervisor`，`reason: "need_decision"`」，但 frontmatter 已不含该工具；`delegate.md` 同类。
- 既有合同检查 `test/operation-guidance-contract.test.mjs`「不给 reviewer 追加工具权限；executor/delegate 白名单保持原样」因此失败：`executor 仍保留 contact_supervisor`。当前该文件 11/12 通过、1 项失败，exit 1，日志 `/tmp/rc-guidance-contract.log`。
- 影响：按当前白名单，child 侧 escalation 工具不可用，而父侧规范与 child 正文仍指示使用它。这属于规范与配置不一致，不是单侧笔误可判定。

### 2. `DeepSeek-Flash` 成为 delegate/executor 首位候选

- `pi/AGENTS_SHARED.md:43` 明确：「不得使用 deepseek 系列模型。」
- `pi/agents/executor.md:5`、`pi/agents/delegate.md:5` 首位候选为 `qoder-pool/DeepSeek-Flash`。
- 与新的模型分级规则叠加后，默认省略 `model` 时 runtime 会选「候选顺序中首个当前可用模型」，即可能默认选中被禁模型；这不是理论风险，而是当前配置的直接后果。

## 分类与本轮处置

按缺陷数据来源门禁，这两项**来源尚未证实**：无法证明是本批 production/policy 修改造成（辅助脚本与 diff 均不支持），也无法证明是本机有意配置（无授权记录）。因此 fail closed：

- 未改写任何 profile frontmatter，未恢复 `contact_supervisor`，未调整 `models` 顺序，未删除或替换 DeepSeek 候选。
- 未放宽 `test/operation-guidance-contract.test.mjs` 的白名单断言去适配缺失；该断言保留红色，作为冲突的活证据。
- 本轮只修改了同一文件中**已获用户授权**的模型政策断言：旧 needle「不得把 provider 请求失败当作自动换模的触发条件」对应已被用户明确要求删除的“模型不可用紧急补救”段落，改为断言现行权威句「默认省略 `subagent_start` 的 `model`」与「不自主换模或显式指定其他模型重派」。修改后该用例通过。
- 未读取 `pi/settings.json`、`pi/models.json`、`pi/models.json.bak-*` 或任何凭据正文。

## 用户裁决与落地（2026-10-19）

两项漂移确认为**用户手动修改**，不是本批产物；按裁决落地如下。

### 裁决 1：`contact_supervisor` 不再写进 profile

用户判断：runtime 本来就会注册，因此不如不写。上游源码核实后与该判断一致：

- `node_modules/pi-subagents/src/intercom/native-supervisor-channel.js:179-193`：`registerNativeSupervisorClient(pi, metadata)` 在 child 运行时按 supervisor channel metadata 注册 `contact_supervisor`，已存在则不重复注册，与 profile `tools` 无关。
- `runs/shared/permissions.js:3,24-25,55-58`：`contact_supervisor` 属 `INTERNAL_TOOLS`，permission 规则不得 gate 它（写了直接报错），且 `permissionDecision` 对它恒返回 `allow`。
- `runs/shared/child-tool-plan.js:242-256`：注释明确“Upward contact stays in the --tools allowlist but is not a strict requirement: children register contact_supervisor at runtime”，并从 `requiredChildTools` 中过滤掉 `contact_supervisor`。
- 因此 `pi/agents/{delegate,executor,reviewer}.md` 正文保留“阻塞时用 `contact_supervisor`”的指示是自洽的；delegate/executor 不再声明它也不影响可用性。

据此修改：

1. `pi/AGENTS_GLOBAL.md` 的 escalation 段删除“以其 profile 的 `tools` 白名单为事实（reviewer 未列入、executor/delegate 已列入）”这一已不成立的断言，改为记录上游 runtime 注册机制与三个源码依据；保留保守措辞规则（没有 metadata 的 child 不会注册，仍不得假设一定可用）与“不得为绕过这一点给 reviewer 追加工具权限”。
2. `test/operation-guidance-contract.test.mjs`（既有测试，按授权迁移断言）：新增 `delegateMd()` helper；将“GLOBAL 必须声明白名单为事实”的断言改为断言新机制文本；将“executor 仍保留 contact_supervisor”改为“三个档位都不在 profile 声明它”。
3. 结果：`node --test test/operation-guidance-contract.test.mjs` → **12/12 exit 0**（`/tmp/rc-guidance-after-decision.log`）；与 model-selection、real-git 合并快照 **39/39 exit 0**（`/tmp/rc-round-final2.log`）。

未修改：`src/agents-shared/index.ts` 注入的 child 边界文本（仍无条件提及 `contact_supervisor`，与新事实一致）；reviewer 的只读角色方法论；任何生产工具注册或 capability ceiling。

### 裁决 2：启用 `qoder-pool/DeepSeek-Flash`

- 用户已自行删除 `pi/AGENTS_SHARED.md` 中的“不得使用 deepseek 系列模型。”（当前未提交 diff 可见该删除，文件 mtime 2026-10-19 15:04:11），禁令已不存在，无需再改。
- 生产侧 `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts` 原有 `providerBlacklist = ["deepseek"]`；用户随后明确要求去掉硬编码黑名单，已删除该常量与 `installHeadlessTypedSubagentRuntime` 的注入点（extension 的 `providerBlacklist` option 默认 `[]`，仍可由调用方显式传入），并删除 `pi/extensions/subagent/config.json` 中无任何消费方的同名死键（上游 `pi-subagents` 与本仓 runtime 都不读它）。原“保留不变”的判断已被该裁决取代；保留在此仅为记录当时的匹配语义分析：`model-selection.ts:93-99,113` 的匹配语义是取 qualified model 的 **provider 段**（首个 `/` 之前）小写后比对，因此它只拦 provider 为 `deepseek` 的模型，`qoder-pool/DeepSeek-Flash` 的 provider 是 `qoder-pool`，不在拦截范围。即用户启用的 pool 别名无需修改生产黑名单即可选用。
- `.pi/skills/external-llm-review-provider/SKILL.md:119` 的 `deepseek` 硬删除记录属 **external-llm-review provider** 领域，与 chat 模型选用不同域，保留不改；`.pi/skills/manage-providers/SKILL.md` 中的 `deepseek-example` 只是命令示例，不构成禁令。
- 本会话仍遵守 GLOBAL 的选模规则：默认省略 `model`，由 runtime 按 profile 候选顺序选首个当前可用模型；不自行指定或重复填写候选。

### 裁决 3：reviewer 只读属性必须对派发方可见

实操中出现把“落盘任务”派给 `reviewer` 的误用，而 reviewer 工具面只有 `read,grep,find,ls,bash`，没有写入能力。据此：

- `pi/agents/reviewer.md` 的 frontmatter `description` 改为明写只读属性与禁止用途：「只读审阅代理：对照计划、源码、diff 与产物识别实现偏差并提出改进建议；工具集无写入/派发能力，不得用于落盘、改文件或提交类任务」。description 是 roster 与派发决策的可见入口，正文 alone 不足以阻止误派。
- `pi/AGENTS_GLOBAL.md`「模型分级」新增一条：reviewer 是只读档，不得派发落盘/改文件/新建记录/提交类任务，需要产出文件时改用 `executor`/`delegate`。
- `test/reviewer-agent.test.mjs` 增加对该 description 的断言，并把 executor/delegate 的 `tools` 断言迁移为不含 `contact_supervisor`、三档位都不得在 profile 声明它；同时删除已失效的「候选链不得包含 deepseek」断言（禁令已由用户删除），改为断言 `config.json` 不再含 `providerBlacklist` 死键。
- 实跑：`test/reviewer-agent.test.mjs` + `subagent-model-selection.integration.mjs` + `operation-guidance-contract.test.mjs` + `joint-upgrade-host-ceiling.test.mjs` → 40 tests / 39 pass / 0 fail / 1 todo，exit 0（`/tmp/rc-blacklist-removal.log`）；再加 membrane/root-upstream/model-selection 单测的组合 → 161 tests / 160 pass / 0 fail / 1 todo，exit 0（`/tmp/rc-post-blacklist-focused.log`）；root+package typecheck exit 0（`/tmp/rc-typecheck-final-blacklist.log`）。
- `test/subagent-model-selection.integration.mjs` 中显式传入 `providerBlacklist: ["deepseek"]` 的用例保留：它验证的是 option 合同（显式传入仍生效），不是本仓默认策略。

