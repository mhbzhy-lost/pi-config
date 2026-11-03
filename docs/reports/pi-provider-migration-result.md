# Pi provider 刷新与 codex-pool 参数迁移结果

执行范围：仅更新本机忽略配置 `pi/models.json`、`pi/models-store.json`，并生成本文；未修改受管 production 代码、测试、`pi/settings.json` 或 agent 定义。没有读取、解析或输出任何凭据，也没有发送真实模型推理请求。

> **更正说明**：本轮迁移把 `codex-pool/gpt-6.1-sol` 的 `contextWindow` 定为 `272000` 的口径有误，已按官方文档更正为 `500000`。详见下文「后续更正：Sol contextWindow 272000 → 500000」，本文下方保留原始迁移记录作为历史。

## 在线目录与缓存

通过无认证公开 GET 获取目录：

`https://pi.dev/api/models/providers/openai?types=chat,image,classifier`

响应为 HTTP 200，`Content-Type` 为 JSON，`Last-Modified` 为 `Mon, 02 Nov 2026 13:48:32 GMT`，目录解析得到 45 个支持的 `chat`、`image` 或 `classifier` 模型；`gpt-6.1-sol` 与 `gpt-6-astra` 均存在且类型为 `chat`。该时间晚于本机内置目录生成时间 `2026-10-21T22:33:24.994Z`，因此按 `remote-catalog-provider` 的时间合并规则采用远端目录覆盖项。

缓存只替换了 `models-store.json` 的 `openai` 条目，未触碰其他 provider。更新前后证据如下：

| 项目 | 更新前 | 更新后 |
|---|---:|---:|
| `openai.models` 数量 | 45 | 45 |
| `checkedAt` | `1792650332904` | `1793675857705` |
| `lastModified` | `1792068059000` | `1793627312000` |
| ETag | 存在 | 存在 |
| 更新后文件 SHA-256 | — | `eaa0abf97a8af198bf7a69aa5e77e3d7d5d4cd8e961d99762107035e2011d61b` |

缓存正文来自公开目录并在内存中加入 `provider: "openai"`，没有通过 `ModelRuntime`、认证解析或可用性检查路径。写入在同目录锁内完成，写临时文件、flush/fsync、原子 rename，并同步目录；写入前对两个目标文件做 SHA-256 与大小并发重检。临时锁与临时文件在操作结束后均已清理。

## 两个 codex-pool 模型的迁移

保留了 provider 标识、现有 `openai-responses` API、模型顺序、所有未列入迁移范围的未知字段和连接/认证相关字段。只对白名单字段同步公开目录：`name`、`reasoning`、`input`、`contextWindow`、`maxTokens`、`thinkingLevelMap`、`cost`。

| 模型 | 字段差异 | 结果 |
|---|---|---|
| `gpt-6.1-sol` | `contextWindow`: `700000` → `272000` | 已同步（**该值后被更正为 `500000`，见下文**） |
| `gpt-6.1-sol` | `thinkingLevelMap.minimal`: `low` → `null`；其余目录值一致 | 已同步 |
| `gpt-6.1-sol` | `name`、`reasoning`、`input`、`maxTokens`、`cost` | 与目录一致，无数值变化 |
| `gpt-6-astra` | `thinkingLevelMap`: 缺失 → `off:null`、`minimal:null`、`low:low`、`medium:medium`、`high:high`、`xhigh:xhigh`、`max:max` | 已同步 |
| `gpt-6-astra` | `name`、`reasoning`、`input`、`contextWindow`、`maxTokens`、`cost` | 与目录一致，无数值变化 |

Sol 的现有 `samplingParamsByThinkingLevel` 完整保留，其中包含网关使用的各档 `reasoning.effort` 与 `summary: "detailed"`。Sol 的既有四项 compat（`supportsOpenAIGrammarTools`、`supportsAdditionalTools`、`supportsToolSearch`、`supportsMidConvoSystemMessages`）也保留。没有把目录新增的 `supportsStrictMode`、`supportsExplicitPromptCacheMode` 或 `supportsMidConvoEffort` 写入任一网关模型，避免未经网关证据改变 wire 行为；没有向 `models.json` 新增目录 `inputLimits`，因为它们的网关适用性未被确认。公开目录缓存本身保留其原始非敏感 metadata。

## 档位纯函数验证

使用现有 `ModelConfig.load()` 解析最终配置，并使用 `getSupportedThinkingLevels()` 与 `clampThinkingLevel()` 验证，没有创建 `ModelRuntime`：

| 模型 | 支持档位 | 请求档位到有效档位 |
|---|---|---|
| `gpt-6.1-sol` | `low, medium, high, xhigh, max` | `off→low`、`minimal→low`、`low→low`、`medium→medium`、`high→high`、`xhigh→xhigh`、`max→max` |
| `gpt-6-astra` | `low, medium, high, xhigh, max` | `off→low`、`minimal→low`、`low→low`、`medium→medium`、`high→high`、`xhigh→xhigh`、`max→max` |

这验证了 Pi 档位映射和折算结果；它不证明私有网关实际接受每个 effort 值，也不证明网关计费、真实上下文上限或 wire compat 行为。`contextWindow` 当时误取公开 `openai` 目录的 `272000`（**后已更正为 `500000`，见下文**）；目录价格 tiers 是 Pi 的估算 metadata，不是付费结算证明。

## 后续更正：Sol contextWindow 272000 → 500000

**更正原因**：原先取 `272000` 只依据 Pi 的 `openai` provider 目录项，把不同产品与连接方式的配置值混用，论证不充分。用户指出 Sol 上下文为 500K，核查官方文档后确认用户口径有据。

**官方依据**（OpenAI 官方模型页 <https://developers.openai.com/api/docs/models/gpt-6.1-sol.md>，无认证读取全文）：

| 口径 | 官方原文数值 | 含义 |
|---|---:|---|
| API 总上下文 | 1,050,000 | 模型 API 的总上下文窗口 |
| API 最大输入 | 922,000 | 单请求最大输入，不能与总上下文混用 |
| API 最大输出 | 128,000 | 对应 `maxTokens` |
| Codex / ChatGPT Work 默认窗口 | 500,000 | “GPT-6.1 Sol uses a default context window of 500K tokens in Codex and ChatGPT Work.” |
| API 长上下文计费阈值 | 272,000 | 输入超过 272K 后费率上调，**不是模型容量上限** |

**Pi 侧依据**：内置目录与线上公开目录的 `openai-codex/gpt-6.1-sol` 均为 `contextWindow: 500000`、`maxTokens: 128000`；而 `openai/gpt-6.1-sol` 为 `272000`。安装包 `CHANGELOG.md` 亦记录过修复 `openai-codex/gpt-6.1-sol` 使用 272K 而非 Codex 已提供的 500K 窗口。本机 `codex-pool` 沿用 Codex 产品窗口，因此最终值取 `500000`，`272000`（`openai` 目录值）不作为 Sol 的硬上限。

**本次改动范围**：仅把 `pi/models.json` 中 `providers.codex-pool.models[0]`（`gpt-6.1-sol`）的 `contextWindow` 由 `272000` 改为 `500000`；其余字段、模型顺序、`openai-responses` API、连接与认证相关字段全部保持原样（认证信息未读取、未输出）。`gpt-6-astra` 及 `qoder-pool` 未改动。

**现场证据**：

| 项目 | 值 |
|---|---|
| 修改前文件 SHA-256 / 大小 / 权限 | `8b1aabea666e9b8a0352703e7df1eff22a1086483d7f5ff7defb4599595f7c78` / 13243 / `0600` |
| 修改后文件 SHA-256 / 大小 / 权限 | `6adcd38a94fa74f527309dd5b0bd2b21ac8290be150e80dd724728bc058518a2` / 13243 / `0600` |
| 语义差异 | 仅 `providers.codex-pool.models[0].contextWindow`: `272000` → `500000` |
| 文本差异 | 仅该行数值 `272000` → `500000` |
| 写入方式 | 同目录排他 flock、临时文件 `flush`+`fsync`、原子 `rename`、目录 `fsync`，`rename` 前对目标文件做 SHA-256/大小/mtime 并发重检 |
| 写后清理 | 无 `.models*.lock`、无临时文件残留 |
| 既有解析器校验 | `ModelConfig.load('pi/models.json')` 返回 `parseError: none`，providers 仍为 `codex-pool`、`qoder-pool` |
| 解析后 Sol 字段 | `contextWindow=500000`、`maxTokens=128000`、`reasoning=true`、`input=[text,image]` |

**边界**：`1,050,000` 是官方 API 总上下文，`922,000` 是官方最大输入；本机 `codex-pool` 走 Codex 产品默认窗口，未取得网关映射与实测限额证据，因此不能据此宣称该网关支持 1.05M 上下文。本次未发起真实模型请求，也未新增测试或提交 Git。详细核查过程见只读核查产物 `.pi/subagents/artifacts/410bb0f7-9646-4b91-bba1-65b84828f56d_delegate_output.md`。

其余旧报告（如 `docs/reports/pi-provider-update-diagnosis.md`）保留历史原文，不追溯改写。

## 验证与边界

- 公开目录 HTTP GET：HTTP 200、时间合法、目标模型数量为 2、支持模型数量为 45。
- 最终配置解析：`ModelConfig.load('pi/models.json')` 无 schema 错误。
- 纯函数档位验证：两模型均得到上述七档折算结果。
- 最终缓存检查：`openai` 条目存在、45 个模型、目标模型 metadata 与在线目录一致、ETag 存在。
- 锁检查：写后 `pi` 目录没有 `.models*.lock` 残留。
- 未新增或修改测试，未提交 Git；`pi/models.json` 与 `pi/models-store.json` 是本机忽略配置。
- 一次写入脚本在两文件成功原子替换后，组装回执时因脚本遗漏回读辅助函数退出；随后独立白名单检查、解析和纯函数验证确认写入结果完整。该回执错误不影响已释放的锁或已完成的原子替换。
- 当前工作区另有既存未跟踪诊断报告 `docs/reports/pi-provider-update-diagnosis.md`；本任务未改写它。
