---
name: writing-skills
description: Use when creating new skills, editing existing skills, or verifying skills work before deployment. 创建、编写、修改、维护 skill / SKILL.md / 操作说明，调整 frontmatter 或 description，或验证 skill 是否被正确触发时使用。
---

# 编写与维护 Skill

## 概述

Skill 是可复用的领域规则、技术方法或参考资料，帮助后续 agent 找到并应用有效做法。编写 skill 的核心是：**只针对已观察到的问题写规则**，让指导形式匹配失败类型，并把长资料与可执行工具按职责拆分。

可以借鉴 TDD（测试驱动开发）的思路验证 skill：先观察没有 skill 时 agent 的真实行为，再写 skill 弥补缺口，最后复核。但**是否运行这类验证由用户授权决定**，不是编写或修改 skill 的默认前置门禁（见「测试与授权」）。

**官方指南：** Anthropic 官方 skill 编写最佳实践见 [references/anthropic-best-practices.md](references/anthropic-best-practices.md)，与本 skill 的方法互补。

## 什么是 Skill

**是：** 可复用的技术、模式、工具、参考指南。
**不是：** 一次性问题的解决叙事。

## 何时创建

**创建：** 技术非显而易见、会跨项目复用、模式普适、他人能受益。
**不创建：** 一次性方案、已有完善文档的标准做法、项目专属约定（放指令文件）、可用正则/校验自动执行的机械约束（自动化它，文档留给需要判断的地方）。

## Skill 类型

- **Technique（技术）**：有步骤的具体方法。
- **Pattern（模式）**：思考问题的方式。
- **Reference（参考）**：API 文档、语法指南、工具说明。

## 目录结构

Skill 存放位置：项目级 `.agents/skills/<skill-name>/`（按 cwd 向上回溯自动发现）、用户级 `~/.agents/skills/`（全局），或用 `settings.skills` 显式加载。本仓 writing-skills 由 `src/skill-loader/` extension 经 `resources_discover` 注入，本体在 `src/skill-loader/skills/writing-skills/`，跨 cwd 常驻可见、不与目录发现形成双来源。

```
skill-name/
  SKILL.md              # 主参考（必需）
  supporting-file.*     # 仅在需要时
```

扁平命名空间，所有 skill 在一个可搜索命名空间里。

**单独成文件：** 重参考（100+ 行，如 API 文档）、可复用工具（脚本/模板）。
**保留内联：** 原则与概念、代码模式（<50 行）、其余内容。

## 编写 SKILL.md

`description` 只说明**何时使用**：触发条件与症状，以 "Use when..." 开头，第三人称；**绝不概括 skill 的流程**——否则 agent 会照着 description 做而跳过正文。

编写或修改 frontmatter、name、description，或需要压缩体积时，先读 [references/discovery.md](references/discovery.md)：SKILL.md 模板、description 与关键词、命名、token 预算、跨 skill 引用。

## 流程图

新增或修改流程图前，先读 [references/flowcharts.md](references/flowcharts.md)：何时值得用流程图、graphviz 约定、如何渲染。渲染用本 skill 自带的 `render-graphs.js`（经 `node` 调用，需系统安装 graphviz/dot）：

```bash
node src/skill-loader/skills/writing-skills/render-graphs.js <skill-dir> [--combine]
```

## 代码示例

**一个优秀示例胜过多个平庸示例。** 选最相关的语言；示例要完整可运行、注释解释 WHY、来自真实场景、清晰展示模式、便于改编。不要用 5+ 种语言实现、不要填空模板、不要造作示例。

## 文件组织

- **自包含**：内容都能内联时，全部放 SKILL.md。
- **带可复用工具**：SKILL.md 概述 + 独立的可运行示例文件。
- **带重参考**：SKILL.md 概述 + 独立的大参考文件 + scripts/。

正文中通过解释器调用附带脚本（`bash scripts/tool.sh`、`node scripts/tool.js`），不要裸路径——某些打包器会去掉可执行位，裸路径会 Permission denied。

## 让指导形式匹配失败类型

写指导前，先归类基线失败。对一种失败有效的形式，对另一种可能适得其反。

| 基线失败 | 正确形式 | 错误形式 |
|---|---|---|
| 压力下跳过/违反规则（明知故犯） | 禁令 + 合理化对照表 + 红旗清单（见 references/bulletproofing.md） | 软指导（"尽量…"、"考虑…"） |
| 遵守了，但输出形状错（冗长、结论被埋、复述规格） | 正向配方/契约：说明输出**是什么**——各部分及顺序 | 禁令清单（"不要复述"、"别叙述"） |
| 已产出的内容漏了必需要素 | 结构化：在模板里设 REQUIRED 字段/槽位 | 模板旁的 prose 提醒 |
| 行为应依赖某条件 | 以可观察谓词为键的条件句（"若 brief 存在则引用它"） | 无条件规则 + 豁免条款 |

**为什么禁令对"塑形问题"适得其反：** 在竞争性激励下，agent 会与"不要 X"讨价还价。措辞对照实验显示，禁令组产生的目标外内容明显多于配方组。配方无可谈判：输出要么符合声明的形状，要么不符合。请对自己的案例做 micro-test，而非默认用禁令。

**无论选哪种形式：**
- **不加 nuance 从句。** "除非重要否则不要 X" 会重新打开谈判。真实例外写成独立的可观察条件句。
- **豁免条款不限定作用域。** "本限制不适用于代码块" 仍会压制代码块。若某部分必须豁免，重构规则使其触及不到该部分。

## 防合理化

当基线失败是纪律失败时，写指导前先读 [references/bulletproofing.md](references/bulletproofing.md)：堵漏洞、spirit-vs-letter 界线、合理化对照表、红旗清单。

## 测试与授权

**测试是可选方法，不是默认门禁。** 本仓规则：未经用户明确授权，严禁主动新增测试、全新 fixture 或压力场景。不得因为正在写 skill 就默认创建测试、启动 fresh-context subagent、调用真实 provider 或执行压力实验。

可以**提出**检索场景、应用场景、压力场景或措辞对照（micro-test）评估，但这些都是**建议（待用户授权）**。用户明确授权具体范围后，在任务记录中回填「已授权（范围）」再执行。读取已有测试、既有检查通过、发布意图、本 skill 被加载，均不构成编写测试的授权。

**TDD 要点（获授权或用户选择 TDD 时参考）：** 把 TDD 的 RED-GREEN-REFACTOR 映射到文档——

| TDD | Skill 验证 |
|---|---|
| 测试用例 | 带压力的场景 |
| 生产代码 | SKILL.md |
| RED（测试失败） | 无 skill 时 agent 违反规则（基线） |
| GREEN（测试通过） | 有 skill 时 agent 遵守 |
| REFACTOR | 堵住新漏洞并保持遵守 |

先跑基线看 agent 自然怎么做（记录原话合理化），再写针对这些具体失败的 skill，再复核、堵漏。完整方法（压力类型、场景编写、micro-test、meta-testing）见 [references/testing-skills-with-subagents.md](references/testing-skills-with-subagents.md)。

未执行写成未执行；静态审阅不冒充行为验证；不要求删除先写的实现来补做 RED/GREEN 仪式。

## 反模式

- ❌ 叙事示例（"在 2025-10-03 的会话里我们发现…"）——太具体，不可复用。
- ❌ 多语言稀释（example-js.js / example-py.py / example-go.go）——平庸、维护负担。
- ❌ 流程图里放代码——无法复制粘贴、难读。
- ❌ 无语义标签（helper1、step3）——标签应有语义。

## Skill 创建清单

**编写：**
- [ ] name 仅字母/数字/连字符；YAML frontmatter 含 name、description（≤1024 字符）。
- [ ] description 以 "Use when..." 开头，含具体触发/症状，第三人称，不概括流程。
- [ ] 全文布关键词（错误、症状、工具）便于搜索。
- [ ] 概述清晰、有核心原则；针对已观察的基线失败。
- [ ] 指导形式匹配失败类型（见上表）。
- [ ] 代码内联或链接独立文件；一个优秀示例。

**质量：**
- [ ] 仅在决策非显而易见时用小流程图；有快速参考表、常见错误节。
- [ ] 无叙事故事；supporting files 仅用于工具或重参考。

**验证（授权门禁）：**
- [ ] 已提出可选评估建议；仅在用户授权范围内执行，并记录「已授权（范围）」。
- [ ] 未授权时只做静态核对与既有检查，不宣称未经观察的效果。

**交付：**
- [ ] 有用户明确提交/发布授权才提交、推送或贡献上游；遵循 `pi/AGENTS_SHARED.md` 的 Git Commit 规范。
- [ ] 交付说明实际修改、已有检查结果、未执行验证与剩余限制。

## 发现流程

后续 agent 如何找到你的 skill：遇到问题 → 搜索 skill（grep description）→ 匹配 → 扫概述 → 读模式（快速参考表）→ 需要时才加载示例。**为此优化**：可搜索词放前面、放多处。
