# Pi 社区 Subagent 方案对比

> 调研日期：2026-07-15
> 目标版本：Pi `0.80.6`
> 调研目标：迁移 OpenCode 中已有的 `executor`、`spark` Agent 配置，不自行维护 Subagent 调度运行时。

## 1. 结论摘要

Pi 官方明确选择不内置唯一的 Subagent 实现，而是通过 Extension 和社区包提供不同工作方式。当前社区已经有多种可用方案，自研 `task`、`task_status`、后台队列和子进程生命周期没有必要。

建议按以下顺序做短期 PoC：

1. `@tintinweb/pi-subagents@0.14.0`：与 Pi `0.80.6`、现有 Agent 文件路径和 OpenCode 使用习惯最匹配。
2. `pi-subagents@0.34.0`：社区采用度最高、安全和编排能力完整，作为首选备选；需先验证其 Pi `0.80.6` 兼容性。
3. `@mjakl/pi-subagent@2.1.0`：如果最终只需要简单委派而不强调后台任务，优先选择该轻量方案。

不建议继续当前自研 Task 7。现有自研文件应在选型后删除，不能与社区实现同时注册同类工具。

## 2. 我们实际需要什么

本次迁移不是重建 OpenCode 的 Agent 平台，只要求社区运行时能够承载已有配置：

- 全局读取 `$PI_CODING_AGENT_DIR/agents/executor.md` 和 `spark.md`。
- 每个 Agent 可配置固定 `provider/model`、thinking 等级、工具白名单和 system prompt。
- 子 Agent 默认不再派生其他 Subagent，避免无限递归。
- 最好支持后台执行、并发上限、取消和完成通知。
- 子 Agent 不自动继承不可信项目级 Agent 配置。
- 不复制 OpenCode 凭据；继续使用 Pi 自己的 Provider/Auth。
- 安装方式可锁定版本，可在 `init-pi.sh` 中复现。
- 不削弱现有 shell/security gate。

OpenCode 配置中的 per-agent `temperature` 是已知兼容缺口：本报告覆盖的主流方案均公开支持 `model`、`thinking`、`tools`，但没有一致、明确的 `temperature` frontmatter 契约。PoC 前不能声称该字段已迁移。

## 3. 核心方案对比

| 方案 | 运行方式 | 后台/并行 | Agent 配置兼容 | Pi 0.80.6 证据 | 成熟度 | 主要代价 |
|---|---|---|---|---|---|---|
| `@tintinweb/pi-subagents` | 独立子会话，支持 worktree | 完整支持 | 明确读取 `$PI_CODING_AGENT_DIR/agents/*.md`；支持 model/thinking/tools | peer dependency `>=0.80.0` | 高 | 功能面大，默认扩展/Skill 继承需收紧 |
| `pi-subagents` | Pi SDK/子会话，支持异步状态 | 完整支持，含 chain | 支持自定义 Agent 和 settings override | peer 为 `*`；发布包开发依赖仍为 `0.74.0` | 最高 | 需额外做 0.80.6 兼容验证；配置面最复杂 |
| `@mjakl/pi-subagent` | 独立 Pi 进程 | 支持并行；后台能力较弱 | 明确读取 `$PI_CODING_AGENT_DIR/agents/*.md` | README 明确要求 `0.80.5+` | 中低 | 社区规模小，缺少完整后台生命周期 |
| Pi 官方示例 | 独立 Pi 进程 | single/parallel/chain；无持久后台管理 | 使用 `~/.pi/agent/agents` 与项目 Agent | 随 Pi 主仓维护 | 官方示例 | 不是可锁定社区包，复制后仍需自行维护 |
| `@johnnywu/pi-subagents` | 独立 Pi 进程，fresh/fork | 支持委派，后台能力不突出 | model/thinking/tools/skills/systemPrompt 模式完整 | peer 为 `*` | 新兴 | 项目年轻，真实采用度和升级稳定性待观察 |
| `@agwab/pi-subagent` | 独立运行时，支持 sandbox/worktree | 支持 async 和持久产物 | 支持全局/项目 Markdown Agent | Node `>=22.19`，Pi peer 为 `*` | 新兴 | 引入 sandbox runtime，超出当前最小需求 |
| `@bytetrue/pi-subagent` | 工具驱动的隔离会话 | 以同步委派为主 | Claude Code 风格 Agent，支持 model/thinking/tools | peer 为 `*` | 早期 | `0.2.x`，能力和社区验证都不足 |
| `pi-fast-subagent` | 同进程 `createAgentSession()` | 支持后台和并行 | Markdown Agent | 仍依赖旧 `@mariozechner/* 0.68` 命名空间 | 中 | 与当前 `@earendil-works/* 0.80.6` 存在明显兼容风险 |
| `code-yeongyu/pi-task` | 子任务后台运行时 | 支持 | 支持 Markdown Agent | 未验证 | 低 | 仓库已归档，不应作为新迁移基座 |

## 4. 重点候选详评

### 4.1 `@tintinweb/pi-subagents@0.14.0`

匹配点：

- npm peer dependency 明确要求 `@earendil-works/pi-* >=0.80.0`，覆盖当前 Pi `0.80.6`。
- 明确读取 `$PI_CODING_AGENT_DIR/agents/*.md`；现有 `pi/agents/executor.md`、`spark.md` 无需另建发现层。
- 使用 `Agent({ subagent_type, prompt, description, run_in_background })`，与 OpenCode 的 Agent 调用习惯接近。
- 支持 model、thinking、工具白名单、独立 system prompt、后台队列、取消、完成通知、上下文继承和递归限制。
- 约 616 GitHub stars、10.1K npm 周下载、20 位贡献者；截至调研日仍活跃发布。

风险：

- 功能很多，包含调度、记忆、定时任务、worktree、Extension/Skill 继承；默认面大于本次需求。
- 自定义 Agent 默认 `extensions: true`、`skills: true`。PoC 必须确认 executor/spark 实际可见工具没有超出白名单，并确认 security gate 是否在子会话中生效。
- 支持模糊模型匹配和 Provider fallback；我们应固定完整 `provider/model`，验证不会跨 Provider 静默回退。
- 未见 per-agent `temperature` 的公开契约。

适用判断：最接近“只迁移已有 Agent 配置，同时获得现成运行能力”的目标。

### 4.2 `pi-subagents@0.34.0`

匹配点：

- 社区采用度最高：约 2.5K GitHub stars、34.5K npm 周下载、30 位贡献者、持续发布。
- foreground/background、并行、chain、状态、取消、恢复、成本统计和完成通知均完整。
- 子 Agent 默认不获得 `subagent` 工具，带深度限制和上下文过滤，运行边界设计较成熟。
- 支持 `subagents.agentOverrides`，可按 Agent 固定 model、thinking、tools、skills 和 prompt。
- 提供 `/subagents-doctor`、模型范围限制和机器可读生命周期产物，便于验收和故障诊断。

风险：

- 最新包 peer dependency 使用 `*`，而 npm 包的开发依赖仍是 Pi `0.74.0`；不能仅凭安装成功判断与 `0.80.6` 完全兼容。
- 内置 Agent、Skill、workflow 和 watchdog 较多，配置模型与现有 `executor`、`spark` 文件的优先级需要实测。
- 工具协议为 `subagent`，不是原 OpenCode 的 `task`；迁移 Skill 必须改写，不能保留旧调用示例。
- 未见 per-agent `temperature` 的公开契约。

适用判断：如果更重视成熟度、安全边界和长期社区支持，可在通过 Pi `0.80.6` PoC 后反超为首选。

### 4.3 `@mjakl/pi-subagent@2.1.0`

匹配点：

- README 明确要求 Pi `0.80.5+`。
- 零运行依赖，包约 94 KiB，代码和配置面较小。
- 明确支持 `$PI_CODING_AGENT_DIR/agents/*.md`、model、thinking、tools 和独立 Pi 子进程。
- 支持 fresh/fork、并行、递归深度和循环保护。

风险：

- 约 69 GitHub stars、51 npm 周下载，主要由单维护者维护。
- 不以完整后台 job 生命周期为核心，无法等价替代原 OpenCode 的 background task/status 体验。
- Project Agent 支持和工具继承仍需验证不会扩大权限。
- 未见 per-agent `temperature` 的公开契约。

适用判断：适合“先迁移配置、只做简单同步或并行委派”的最小方案。

## 5. 其他方案为何不进入首轮 PoC

### Pi 官方示例

官方示例是判断接口设计和安全模型的重要参考，但它不是稳定发布的独立包。直接复制后，Pi API 变化、后台状态、错误恢复和测试都由本仓库承担，与“不要自研能力”的目标冲突。

### `@johnnywu/pi-subagents`

配置表达能力不错，支持 fresh/fork、system prompt 模式、skills 和递归控制，包也较小。但项目创建和发布较新，当前没有足够采用度证明优于前三项。

### `@agwab/pi-subagent`

测试矩阵和 sandbox/worktree 能力较完整，也支持 async 状态与持久产物。但它引入 `@anthropic-ai/sandbox-runtime`，安全和隔离目标明显重于本次配置迁移，增加了部署与排障面。

### `@bytetrue/pi-subagent`

工具协议和 Agent 类型接近 Claude Code，适合无 TUI/RPC 场景，但当前版本仅 `0.2.1`，包和生态验证都处于早期。

### `pi-fast-subagent`

同进程运行的启动速度有优势，但当前包仍面向旧 `@mariozechner/pi-* 0.68` 依赖命名空间。我们的 Pi 已是 `@earendil-works/* 0.80.6`，没有必要为性能优势承担明显兼容风险。

### `code-yeongyu/pi-task`

能力与之前自研 Task 7 很接近，但仓库已经归档。归档项目不适合作为新环境的长期基础。

### `@pi-archimedes/subagent`

它更适合作为 `pi-archimedes` 整套 UI、成本统计和 Agent 管理生态的一部分。单独引入会带来 core 耦合，而我们的目标只是迁移两个 Agent 配置。

## 6. 安全与迁移关注点

无论选择哪个社区包，都必须在真实 Pi 中验证以下事项：

- **工具授权**：executor/spark 的实际工具集合不得超过 frontmatter 白名单。
- **Extension 继承**：子 Agent 使用 bash 时，现有 security gate 必须继续生效；若社区包不继承，应明确补配置而不是自建调度器。
- **Agent 来源**：默认只加载 `$PI_CODING_AGENT_DIR/agents`；项目级 `.pi/agents` 必须关闭或要求显式信任。
- **递归边界**：executor/spark 不得获得 `Agent`、`subagent`、`task` 等派生工具。
- **模型确定性**：必须使用完整 `openai/...` model ID；Provider 不可静默切换到 Qwen 或其他账号。
- **凭据边界**：只复用 Pi auth，不复制 OpenCode auth，不把 token 写入日志或状态文件。
- **后台清理**：父会话退出、取消和异常时不能遗留 Pi 子进程。
- **输出边界**：状态和 transcript 不进入 Git，且日志必须有容量或保留策略。
- **temperature**：若扩展不支持，需明确记录为“不迁移”，不能用未公开字段假装生效。

## 7. 建议的 PoC 顺序与验收门槛

### PoC A：`@tintinweb/pi-subagents@0.14.0`

1. 在临时 `PI_CODING_AGENT_DIR` 安装锁定版本，不修改正式配置。
2. 仅放入 `executor.md`、`spark.md`，确认 `/agents` 或等价接口只发现预期 Agent。
3. 分别运行只读 smoke，核对实际 provider/model、thinking 和 tools。
4. 运行一个受控后台任务，验证完成通知、取消、会话退出和无孤儿进程。
5. 用 bash 安全场景确认现有 security gate 在子 Agent 中生效。
6. 验证 Agent 无法再次派生子 Agent。

### PoC B：`pi-subagents@0.34.0`

只有 PoC A 出现真实阻断时，或团队更重视成熟生态时执行。除上述门槛外，额外验证：

- 在 Pi `0.80.6` 下无 API deprecation/error。
- 自定义 Agent 与内置 Agent 的命名和优先级不冲突。
- 禁用不需要的 workflow、watchdog 和内置 Agent 后仍可正常运行。

### 通过标准

- 安装、发现、前台、后台、取消、安全门禁、退出清理全部通过。
- 不修改或复制任何凭据。
- `executor`、`spark` 的固定模型真实命中，失败时不得回退 Qwen。
- init/doctor 能检查锁定版本和 Agent 可见性。
- 删除全部自研 Task 7 runtime 后，完整测试仍通过。

## 8. 推荐决策

- **[首轮 PoC]**：选择 `@tintinweb/pi-subagents@0.14.0`，因为它明确兼容 Pi `0.80.x`，直接读取现有 Agent 目录，且后台调用方式最接近 OpenCode。
- **推荐**：只做临时目录 PoC，通过后再接入 `init-pi.sh`；先验证权限和模型，不先迁移高级功能。
- **不选原因**：不直接选 `pi-subagents` 是因为其发布包开发基线仍为 Pi `0.74.0`；不直接选轻量版是因为后台能力不足。
- **选错代价**：在模型解析、Extension 继承或后台清理阶段暴露，正式接入前修复代价低；接入后再切换代价中。

## 9. 参考资料

- Pi 官方 Subagent 示例：<https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions/subagent>
- `pi-subagents`：<https://github.com/nicobailon/pi-subagents>
- `@tintinweb/pi-subagents`：<https://github.com/tintinweb/pi-subagents>
- `@mjakl/pi-subagent`：<https://github.com/mjakl/pi-subagent>
- `@johnnywu/pi-subagents`：<https://github.com/jwu/pi-subagents>
- `@agwab/pi-subagent`：<https://github.com/AgwaB/pi-subagent>
- `pi-fast-subagent`：<https://github.com/tuansondinh/pi-fast-subagent>
- npm 元数据：各包对应的 `registry.npmjs.org/<package>/latest`，于调研日期读取。
