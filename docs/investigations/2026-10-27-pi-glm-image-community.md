# Pi 支持 GLM 读图的社区调查与本机建议

## 结论

**对本机 `zai-coding-cn/glm-5.3`，没有找到靠 `input: ["text","image"]` 或 extension 改写请求即可直接读图的可靠方案。智谱官方明确写明：GLM-5.3“目前仅支持处理文本模态信息”。当前应撤回该模型的 image override；需要读图时切换具体视觉型号，或另外调用视觉模型取得文本分析。**

不能把这个结论扩大为“中国 Coding Plan 端点完全不支持图片”。联网找到两条重要证据：

- `earendil-works/pi` issue [#8220](https://github.com/earendil-works/pi/issues/8220) 的作者报告，在中国 Coding Plan 上，给 Pi 补入 **`glm-4.6v`** 后实际读图成功。对应提交已加入该型号的视觉目录声明。
- 智谱将 **`glm-5.3-flash`** 明确列为原生多模态模型，支持 `image_url` 和 Base64 Data URL，并说明已上线 Coding Plan。它与 `glm-5.3` 是不同型号。本机安装包也已将 `glm-5.3-flash` 和 `glm-4.6v` 声明为图像输入模型。

因此，本机首选方向是**选择已声明支持图像的具体型号并实测**，不是修改 Pi 通用 adapter，也不需要先等待 Pi 增加基础读图能力。普通端点加视觉型号也是有官方协议依据的备选；仅把 `glm-5.3` 的地址改成普通端点，仍不能使文本模型看图。

补充的 extension 方向在工程上有公开 API 支持，但只适合修复**已支持视觉的服务与客户端之间已证实的协议差异**。本次没有发现当前 `glm-5.3` 存在这种差异；Pi 已生成官方视觉 Chat Completions 使用的 `image_url`，真正不匹配的是型号能力。

## 调查范围与证据等级

文件名沿用任务指定日期。网页内容是本次调用时的在线快照，不是对该日期的历史归档恢复。搜索服务部分 GitHub 提交结果显示异常日期（例如关联 2026 年讨论的提交却标成 2025 年），本报告不以搜索结果日期证明发布时间，以明确 URL、提交 SHA、原文内容及本机版本为依据。

全部网页检索和正文抓取均通过 `/Users/leshi.zhy/.agents/skills/deepseek-search/deepseek.py search/fetch`，已先完整阅读该 skill。没有使用 MCP、Exa、浏览器或其他 HTTP 抓取方式，没有调用 GLM provider，没有读取 Pi 凭据或任何用户配置文件。搜索 key 仅由 wrapper 间接使用。

本机安装包 `@earendil-works/pi-ai` 和 `@earendil-works/pi-coding-agent` 均为 **1.4.0**。本次直接核对的是安装包文档、公开类型、实现、示例及内置目录。用户配置和故障反馈仅引用既有[本地诊断](2026-10-27-zai-glm-image-400.md)，不声称重新验证了活动会话或当前有效配置。

证据分级：

| 等级 | 含义 | 本报告的使用方式 |
| --- | --- | --- |
| A | 官方协议/型号文档，或直接读取的本机实现 | 证明文档承诺与客户端行为；不等于账号端到端成功 |
| B | 社区作者明确给出实测对象、过程或结果 | 作为作者报告的成功证据；本次未独立重跑 |
| C | README 功能宣称、目录声明或单元测试 | 证明设计/配置存在；不能单独证明图像确实被解码 |

## 检索词与来源索引

实际执行了以下 10 次搜索；参数中的数字为请求结果数。搜索成功不代表每个返回项都适用于本机。

| 编号 | 检索词 | 数量 | 主要结果 |
| --- | --- | --- | --- |
| Q1 | `GLM-5.3 site:docs.bigmodel.cn 视觉 coding image` | 5 | GLM-5.3、5.3-Flash 官方型号页及视觉工具页 |
| Q2 | `site:github.com pi-mono GLM image vision modelOverrides` | 6 | 历史 modelOverrides 提交及其他 fork |
| Q3 | `site:github.com earendil-works pi coding glm image` | 5 | 中国目录修复提交、其他代理与无关推理问题 |
| Q4 | `"pi" "GLM" "vision" "image_url"` | 6 | pi-multivision、视觉转交扩展等 |
| Q5 | `site:docs.bigmodel.cn "coding/paas/v4" "图片"` | 6 | Coding Plan 接入、Cline 及协议文档 |
| Q6 | `site:docs.bigmodel.cn "GLM-4.6V" "Base64" "5M"` | 4 | Chat Completion schema、OpenAI 兼容文档 |
| Q7 | `site:github.com "pi" "glm-5.3" "image"` | 6 | OMP #9835、第三方 provider 和目录修正 |
| Q8 | `site:docs.bigmodel.cn "image_url" "6000"` | 4 | Chat Completion schema；同时出现不适用的托管 Agent 协议 |
| Q9 | `site:docs.bigmodel.cn "GLM-4.6V" "图像" 模型` | 3 | GLM-4.6V 官方示例 |
| Q10 | `site:github.com/badlogic/pi-mono "GLM" "image"` | 4 | 返回 `results: []`；不据此断言旧仓库从无相关记录 |

对关键摘要继续执行了 16 次 `fetch`，以下来源均取得正文。Chat Completion schema 和远端 extensions 文档较长，工具输出生成临时完整日志后，从该日志解析相关原文；没有另行绕过 wrapper 联网。

| 编号 | 来源 URL | 证据用途与可信度 |
| --- | --- | --- |
| S1 | https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3 | 精确型号仅文本，A |
| S2 | https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash.md | Flash/FlashX 模态、image_url、Data URL、套餐开放差异，A |
| S3 | https://docs.bigmodel.cn/cn/guide/develop/openai/introduction.md | 普通 paas 地址和 Flash 的 Data URL 示例，A |
| S4 | https://docs.bigmodel.cn/api-reference/%E6%A8%A1%E5%9E%8B-api/%E5%AF%B9%E8%AF%9D%E8%A1%A5%E5%85%A8.md | Chat Completion schema 与图片限制，A |
| S5 | https://docs.bigmodel.cn/cn/guide/models/vlm/glm-4.6v | `glm-4.6v`、`image_url` 的官方调用示例，A；抓取只返回示例代码 |
| S6 | https://docs.bigmodel.cn/cn/coding-plan/quick-start?lang=zh-CN | Coding Plan 接入端点，A；抓取正文表格信息不完整，结合搜索原始字段和 S7 核对 |
| S7 | https://docs.bigmodel.cn/cn/coding-plan/tool/cline | 中国 coding 地址、示例型号与取消 Support Images，A |
| S8 | https://docs.bigmodel.cn/cn/coding-plan/mcp/vision-mcp-server | 工具式视觉与 Claude Code 特例，A；仅阅读，没有安装或调用 MCP |
| P1 | https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md | models.json、能力和兼容配置规则，A |
| P2 | https://github.com/earendil-works/pi/issues/8220 | Pi 中国 coding/4.6v 读图实测报告，B |
| P3 | https://github.com/earendil-works/pi/commit/87205484bf749c2140fef5d1bea68995d57e739c | 中国目录修复、具体端点与测试中的型号声明，A/C |
| P4 | https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md | provider 注册与复用 adapter 的官方建议，A |
| P5 | https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md | before_provider_request 等公开生命周期，A |
| P6 | https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/provider-payload.ts | 公开 payload hook 示例，A |
| C1 | https://github.com/can1357/oh-my-pi/pull/9835 | OMP、国际 Anthropic 端点、Flash 图像成功及地域边界，B |
| C2 | https://github.com/like-attract/pi-multivision | 用另一个视觉模型返回文本的扩展方案，C |

## 官方模型与端点：必须分开判断

### GLM-5.3 与 GLM-5.3-Flash 不是同一能力声明

S1 原文：

> GLM-5.3 目前仅支持处理文本模态信息，支持 1M 上下文窗口，最大输出 Tokens 为 128K。

S2 原文：

> GLM-5.3-Flash/GLM-5.3-FlashX 是 GLM-5 系列首个原生多模态模型。

> 图片参数：在 `messages[].content[]` 中添加 `type: image_url` 内容块，通过 `image_url.url` 传入图片 URL（推荐）或 Base64 Data URL；多图可添加多个 `image_url`。

同页区分套餐可用性：`glm-5.3-flash` 已全面放开，**套餐当前暂未开放 GLM-5.3-FlashX**。所以不能把 FlashX 在普通模型 API 的能力与可用性套到 Coding Plan。

S1、S2 还说明 5.3 与 5.3-Flash 的思考不能关闭；Flash 推荐使用 low/high/max 中的相应强度。这不是此次图片错误的直接原因，但自定义模型时不能丢失思考兼容元数据，否则可能引入另一种 400。

### 中国普通端点与 coding 端点

| 组合 | API 形态与具体地址 | 图片结论 |
| --- | --- | --- |
| 中国 Coding Plan + `glm-5.3` | `openai-completions`；base `https://open.bigmodel.cn/api/coding/paas/v4`；POST `/chat/completions` | S1 明确仅文本；本地错误 `取值范围 ['text']` 与此一致 |
| 中国普通模型 API + `glm-5.3` | base `https://open.bigmodel.cn/api/paas/v4`；Chat Completions | S1 的型号限制仍然成立；只换地址无视觉依据 |
| 中国普通模型 API + `glm-5.3-flash` | 同上，`messages[].content[]` 使用 `image_url` | S2/S3 有明确协议与 Data URL 示例，是有依据的候选 |
| 中国 Coding Plan + `glm-5.3-flash` | 中国 coding base；Pi 内置 `openai-completions` | S2 承诺套餐开放及视觉；本机目录支持。此次未找到与本机完全相同组合的独立端到端图片成功记录，需账号实测 |
| 中国 Coding Plan + `glm-4.6v` | 中国 coding base；`openai-completions` | P2 报告 Pi 里实际读图成功；P3 固定该组合的目录声明 |
| 国际 Coding Plan + `glm-5.3-flash`，OMP | base `https://api.z.ai/api/anthropic`；POST `/v1/messages` | C1 有图片实测，但域名、协议和客户端均不同 |

S7 的 Cline 文档使用中国 coding base，示例型号为 `glm-5.2`，并要求“取消勾选 Support Images”。这支持文本型号的接入方式，**不能覆盖 S2 对新视觉型号的明确说明，也不能反证 P2 的 4.6v 实测**。

两种中国 Chat 端点的路径、套餐与计费用途不同。普通 API 示例不能证明可沿用用户的套餐额度或现有凭据；本次没有核对账号权益。若另建普通端点，应保留独立 provider ID，避免把原有 coding provider 下所有型号一起改路由。

### image_url 与 Base64 限制

S3 的官方普通端点示例使用以下结构（省略其他参数，提示词作缩写）：

```json
{
  "model": "glm-5.3-flash",
  "messages": [{
    "role": "user",
    "content": [
      {"type": "text", "text": "请描述这张图片"},
      {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,<图片数据>"}}
    ]
  }]
}
```

S4 在 `VisionMultimodalContentItem` 的图片分支规定 `type: image_url`，`image_url` 必须含 `url`。忠实摘录：

> 图片的 URL 地址或 Base64 编码。图像大小上传限制为每张图像 5M 以下，且像素不超过 6000*6000。支持 jpg、png、jpeg 格式。GLM-5.3-Flash 系列、GLM-5V-Turbo、GLM4.6V、GLM4.5V 系列限制 50 张。GLM-4V-Plus-0111 限制 5 张。GLM-4V-Flash 限制 1 张图像且不支持 Base64 编码。

这里的 `GLM-4V-Flash` **不等于** `GLM-4.6V-Flash`，更不等于 `GLM-5.3-Flash`。不能由前者的 Base64 禁令推导后两者也禁止。S4 没有在该段澄清“5M”指原文件还是编码后字节，后续按小图保守验证；不擅自赋予精确字节定义。

S5 的 `glm-4.6v` 示例使用 `role:user`、`type:image_url` 和 HTTPS PNG 链接，证明该具体型号的官方视觉 schema。S2/S3 则对 `glm-5.3-flash` 的 Data URL 证据最直接。

C1 国际 Anthropic 端点虽然报告 WebP 成功，中国 Chat schema 在 S4 只列 jpg/png/jpeg。不能据此保证本机中国端点也接收 WebP。托管 Agent 的 `image/source`、Responses 的图片格式、视觉工具的参数均属另一协议，不应替换本机 Chat Completions 的 `image_url`。

## Pi 官方与版本差异

### 本机已经有视觉型号，无需把 glm-5.3 强行声明为视觉

直接读取安装包 JSON 的白名单字段，结果如下；没有实例化 runtime、刷新目录或解析用户 models.json。

| 本机内置型号 | input | contextWindow / maxTokens | 说明 |
| --- | --- | --- | --- |
| `zai-coding-cn/glm-5.3` | `["text"]` | 1000000 / 131072 | 与 S1 一致 |
| `zai-coding-cn/glm-5.3-flash` | `["text","image"]` | 1000000 / 131072 | 有 low/high/max 映射，其他档位为 null |
| `zai-coding-cn/glm-4.6v` | `["text","image"]` | 128000 / 32768 | 使用 zai 思考格式及 max_tokens |

来源：`node_modules/@earendil-works/pi-ai/dist/providers/data/zai-coding-cn.json:1`，该文件为单行 JSON。共同 provider 的 base、API 定义见 `dist/providers/zai-coding-cn.js:7`、`:9`、`:12`，分别为 `zai-coding-cn`、中国 coding base、`openAICompletionsApi()`。

这是**内置目录**，不等于当前进程经远端缓存、用户 override 和扩展组合后的有效模型。旧诊断已经说明 `modelOverrides` 是最上层用户覆盖，本次也核对到 `provider-composer.js:62` 的 `input: override.input ?? model.input` 以及 `:354`、`:366` 的应用位置。

### modelOverrides 的正确用途

P1 与本机 `docs/models.md:67` 明确说明：

- `/model` 打开时重新加载 `models.json`。
- `models` 条目添加型号，或替换相同 ID 的型号。
- `modelOverrides` 只修改已有内置/扩展型号的元数据；未知 ID 被忽略。

本机 `docs/models-configuration.md` 的 `input` 默认值是 `["text"]`。对已证实支持视觉但元数据漏报的型号，补 `image` 合理；对官方仅文本的 `glm-5.3`，它只会使 Pi 把图片送到不支持的模型。

P1 还要求兼容开关描述已验证的协议差异，不应仅因服务宣称 OpenAI 兼容就猜测开启。`inputLimits.images.resize` 可以控制新图片编码尺寸，默认 2000×2000、编码后 4.5 MiB；改变模型不会重编码历史图片，声明的每请求图片上限也不意味着 Pi 已自动裁剪历史。因此历史图片仍需单独验证。

### earendil-works、历史 pi-mono 与 fork

本机 README 指向 `earendil-works/pi`，安装名是 `@earendil-works/pi-coding-agent`。Q2 返回的历史提交 [6f897c3](https://github.com/earendil-works/pi/commit/6f897c36734a75119d97878c3757ea84e51aca21#1) 仍链接 `badlogic/pi-mono` 的 PR #1332，说明搜索会混合历史命名。该搜索摘要中的旧文档把 `models` 描述为 provider 全量替换；本机 1.4.0 的 **models.json** 文档是按型号添加/替换，不能套用旧语义。该历史提交仅作版本差异提示，没有用它证明当前运行行为。

`CloudEngineHub/pi-mono`、`CoeusInstitute/pi-mono` 等 fork 的包名、目录、能力表不作为本机权威依据。`can1357/oh-my-pi`（OMP）使用 `models.yml`、独立 provider mapper，本报告单列其成功案例。另一方面，本机 **legacy `registerProvider(..., {models})` 扩展 API** 仍是 provider 模型列表替换，不能与 models.json 的增量语义混淆。

远端 `main` 文档可能比本机更早或更新；例如本次抓取的远端 extensions 文档结构与安装版不同。下文 API 行号全部以本机 1.4.0 为准，URL 用于公开交叉核对。

## 社区真正做了什么

### 中国 Coding Plan：补入 glm-4.6v，再由 Pi 原生传图

P2 标题是“Add GLM-4.6V (vision) to built-in zai-coding-cn model catalog”。作者写明 Pi **0.84.2** 缺少视觉型号，并报告：

> chat completions with glm-4.6v and glm-4.6v-flash succeed (HTTP 200, verified with an active Coding Plan key).

> Merging via user ~/.pi/agent/models.json works — verified both text chat and actual image reading in pi with zai-coding-cn/glm-4.6v.

这两句证据强度不同：第一句只确认两型号 Chat 请求成功；第二句才明确 **Pi + glm-4.6v 实际读图**。不能把 `glm-4.6v-flash` 的 HTTP 200 也写成已证明 Pi 图像成功。

P2 本身没有展示完整图片 payload、base64/URL 形式及逐字模型回答。端点与 API 由 P3 对应修复提交交叉固定：

- provider：`zai-coding-cn`。
- base URL：`https://open.bigmodel.cn/api/coding/paas/v4`。
- model：`glm-4.6v`。
- API：`openai-completions`，图片能力 `["text","image"]`。
- P3 测试声明：`thinkingFormat: "zai"`、`maxTokensField: "max_tokens"`，128000/32768。

P3 解决中国 provider 错用国际目录源的问题，将源改为 `zhipuai-coding-plan`，并写入“including GLM-4.6V vision support”。这是目录适配，不是把文本 GLM-5.3 的请求格式改成某种隐藏视觉协议。提交中的单元测试是目录断言，不是本次运行的网络测试。

### OMP：glm-5.3-flash 在国际 Anthropic 协议下成功

C1 为已合并 PR。作者明确给出真实请求：

```text
POST https://api.z.ai/api/anthropic/v1/messages
model: glm-5.3-flash
provider: zai（OMP）
```

作者报告 Base64 PNG、JPEG、WebP 都获 HTTP 200；320×160 左蓝右绿 PNG 的端到端回答为 **“Blue green”**，比“请求未报错”更能支持图像已被解码。

同一 PR 的 reviewer 特别追问：中国 `zhipu-coding-plan` 使用 `open.bigmodel.cn` 的 OpenAI Chat 路径，而该验证表只测试国际 Anthropic 路径，中国端是否实测还是按同系列推断？本次抓取正文未见回答消除此疑问。这正是不能将成功无条件搬到本机的原因。

因此该记录证明的是 **OMP + 国际端点 + Flash + Anthropic 图片块**，不是 `@earendil-works` 本机中国 Chat + `glm-5.3`。该 PR 不代表本机需等待同一修复。

### 文本主模型通过另一个视觉模型取得描述

C2 的 README 原文核心是：

> The extension hands the image to a vision-capable model and returns the text description as the tool result.

其当前配置示例给出本地名称 `glm`、base `https://open.bigmodel.cn/api/paas/v4`、model `glm-4.6v-flash`，使用 OpenAI-compatible 视觉脚本；README 宣称可开箱工作，但未给固定图片、原始响应或可复查请求日志，列为 **C 级方案宣称**，不冒充与 P2/C1 同等级的成功实测。

搜索到的 npm 0.2.2 摘要要求外部脚本与 JSON 配置，而 GitHub 当前 README 已改为打包脚本及 `.env`（列出 0.3.0 变更）。不能复制旧摘要当当前安装说明。本次没有安装或审计该包，也不推荐原样接入其自动 fallback 链。若以后采用此架构，可以只使用显式、受控的视觉模型，通过非 MCP wrapper 返回独立工具文本，并明确注明描述来源；这使工作流具备读图能力，但不会改变 GLM-5.3 的原生模态。

S8 同样说明官方视觉 MCP 或 Claude Code 内置 `image_analysis` 是工具式视觉渠道。它不证明任意客户端对任意 GLM Chat 模型直接发送图片都能成功。本仓禁止 MCP 接入，因此这里只把它作为解释社区现象的文献，不作为实施建议。

## 追加评估：仅对 GLM 官方 provider 生效的 extension

### 公开入口确实存在，onPayload 不只是不可及的内部变量

以下文件均位于本机 `node_modules/@earendil-works/`，行号来自本次直接读取与 `rg -n`。公开 URL 对照 P4/P5/P6，以及 [extensions/types.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts)、[sdk.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/sdk.ts)、[openai-completions.ts](https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/openai-completions.ts)。后三个 URL 为本机路径对应的公开源码入口，本次未另抓取其正文；结论依据下表本机文件，不假称已核对远端行号。

| 本机位置 | 事实 | 可用边界 |
| --- | --- | --- |
| `pi-coding-agent/docs/extensions.md:99`、`:157`、`:209` | 请求生命周期包含 `before_provider_request`；支持替换串行化 payload，返回值按 handler 顺序传递 | 是官方扩展接口 |
| `pi-coding-agent/dist/core/extensions/types.d.ts:693`、`:1203` | 公开 `BeforeProviderRequestEvent` 与 `pi.on("before_provider_request", handler)` | 事件只有 `type`、`payload: unknown`，没有请求 model/provider 字段 |
| 同文件 `:227` | `ExtensionContext.model: Model<any> \| undefined` | 能取得当前模型定义，须考虑它是不是本次实际路由模型 |
| `pi-coding-agent/examples/extensions/provider-payload.ts:6`、`:10` | 官方示例注册事件，注释演示返回替换 payload | 本次只阅读；没有执行示例中的日志写入 |
| `pi-coding-agent/dist/core/sdk.js:224`、`:273` | `transformProviderPayload` 调用 runner，并作为 Agent 的 `onPayload` | 证明公开扩展 hook 的真实接入链 |
| `pi-coding-agent/dist/core/extensions/runner.js:1066` | 执行所有该事件 handler，非 undefined 返回值成为下一 payload | 返回的是 payload 本身，不是 `{payload: ...}` 包装；异常被报告后继续 |
| `pi-ai/dist/types.d.ts:48`、`:69` | 公开 `ProviderRequestOptions.onPayload(payload, model)`，允许异步返回替换值 | provider/adapter 层能取得实际传入 model |
| `pi-ai/dist/api/openai-completions.js:187`、`:188`、`:197` | buildParams 后调用 `options.onPayload(params, model)`，再执行 Chat 请求 | 请求体改写发生在发送前；不会因此改换 SDK 已选 endpoint |
| `pi-coding-agent/dist/core/extensions/types.d.ts:1358`、`:1359`、`:1433` | registerProvider 的 native/legacy 两种签名；legacy 可提供 streamSimple | 可实现限定 provider 的流式包装 |

所以“Pi 没有公开改请求 hook”不成立；但“有 onPayload 就能无条件精确限定所有调用”也不成立。

### 如何限定 provider、型号、官方端点

对普通直接选中的会话模型，小型 `before_provider_request` handler 可以检查 `ctx.model.provider`、`id`、`api`、规范化后的 `baseUrl`，并再次核对 payload 中的 `model`。必须用**精确白名单**，例如中国 `zai-coding-cn`、中国官方 coding URL、`openai-completions`、已证明视觉支持的某个模型；不能仅用 `model.id.startsWith("glm")`，因为第三方代理也可能使用相同 ID。

但它有严格限制：`runner.js:613`、`:642` 的 `ctx.model` 来自 `getModel()`，SDK 的 payload 桥接没有把 adapter 回调的实际 model 参数传入事件。故不能仅凭这条 hook 证明虚拟模型路由、其他扩展重定向、嵌套调用或并发路径都被精确区分。事件 handler 抛异常也不是可靠的阻断策略：`runner.js:1081` 附近捕获后报告错误，再继续处理。

若要求“只允许某个 GLM 官方 provider 的真实请求发生转换，其他 provider 完全不受影响”，更稳妥的设计是**provider 自身的 stream/streamSimple 包装**：

1. 在包装函数拿到实际 `model` 后，同时检查 provider ID、model ID、API、HTTPS origin 与具体 base path。对非目标型号原样委托；对需要严格限制但身份不符的请求，在 provider 内拒绝，不能靠全局 hook 吞异常。
2. 不全局覆盖名为 `openai-completions` 的共享 adapter。可注册独立的视觉 provider，或在明确维护原 provider 认证和目录的条件下包装指定 provider。独立 provider 最易限定影响面；新 provider 不会自动获得旧 provider 的凭据，不能假设名字相近就会复用认证。
3. 注册 native provider 或 legacy provider 时，保留它不拥有的目录、认证及兼容行为。legacy 的 `models` 会替换整个 provider 列表，不能为加一个型号无意删掉其余型号。用户 models.json override 仍会盖在 native provider 上，需在实际请求前核对有效定义。
4. 若包装 `options.onPayload`，应明确调用既有回调并消费它返回的 payload，再做必要的局部转换与校验；不能抹掉原 hook。保留 `onResponse`、`onProviderStreamEvent`、signal、headers、env 等请求选项，防止破坏主机观察和取消语义。

### 最小责任边界：优先复用 Pi adapter

P4 明确建议“协议已支持时用 models.json”，并要求优先复用现有 streaming API。已有公开范例 [GitLab Duo 扩展](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/custom-provider-gitlab-duo/)；本机 `examples/extensions/custom-provider-gitlab-duo/index.ts:305` 起定义包装流，`:325` 保留 options，`:329`/`:340` 委托内置 adapter，`:383`/`:403` 注册 provider 与 streamSimple。

本机 `pi-ai/package.json` 明确导出 `./api/*`，所以可以从公开入口 `@earendil-works/pi-ai/api/openai-completions` 复用 `streamSimple`；本机实现位于 `dist/api/openai-completions.js:520`。`openAICompletionsApi()` 也在公开 `@earendil-works/pi-ai/compat` 中导出（`dist/compat.d.ts:19`），但该文件自述为暂时兼容入口，新实现不宜依赖其长期不变。

最小实现应承担以下责任，而不是复制整套 provider：

| 责任 | 最小范围 |
| --- | --- |
| 模型能力声明 | 只对官方确认且目标端点开放的型号声明 image；保持 reasoning、thinkingLevelMap、maxTokens 与 compat |
| 请求转换 | 仅转换已证实不兼容的图片字段/角色/格式；保留其他 content、工具 ID、顺序和系统信息；不为了界面展示改写原始历史 |
| 流式响应 | 使用已有 Chat adapter 处理文本、思考、tool call、usage、stopReason、取消及终止事件 |
| 错误 | 维持原服务错误语义；text-only、限流、权限错误不伪装成成功或上下文溢出；转换错误清楚终止 |
| 生命周期 | 保留原 onPayload/onResponse/stream-event 回调，透传 abort 与请求选项 |

只有目标协议确实无法由现有 adapter 表达时，才自己实现流；那时须承担 P4 列出的完整契约：start、成对内容事件、合法工具参数、usage/cost、恰好一次 done/error、取消为 aborted。仅为 `image_url` 不需要这一级重写。

### 对当前故障的判断

本机 `pi-ai/dist/api/openai-completions.js:952`、`:954` 已将用户图像转成 `image_url.url = data:<mime>;base64,<data>`；工具图片在 `:1101`、`:1103` 也是同一结构。S2/S3 官方视觉模型要求的正是这类结构。

**因此当前没有需要 extension 修补的已证实 wire schema 差异。** 改成 `type:image`、`input_image`、把 Base64 塞进 text、或者仅改 URL 而保留 `glm-5.3` 都不是有证据的修复。hook 阶段再偷偷把 `model` 换成 Flash 也不是“glm-5.3 获得视觉”，还会导致会话标识、能力、思考参数和计费元数据失真，应通过正常模型选择或明确 provider 注册完成换型。

若未来实测某个**视觉型号**只接受远程 URL、特定 MIME 或另一协议形态，再考虑限定其 provider 的转换；远程 URL 还涉及图片托管与访问权限，不能在 extension 里未经设计就自动上传。本次仅评估，不实现 extension，不加载任何扩展或发出模型请求。

## 对本机 zai-coding-cn/glm-5.3 的可执行建议

以下是后续操作建议，**本报告未修改或执行配置**。

1. **撤回错误能力声明。** 在本机 `pi/models.json` 的 `providers["zai-coding-cn"].modelOverrides["glm-5.3"].input` 删除 `image`，可删除 input 字段继承内置 `["text"]`；若该 override 仅有 input，可删除整条 override。保留其余有意设置。打开 `/model` 重载或重启 Host，确认实际有效 input；不要手改 models-store 缓存。
2. **需要直接看图时先选已有视觉型号。** 通过 `/model` 选 `zai-coding-cn/glm-4.6v`，它有同 provider/端点的社区 Pi 读图记录；或选 `zai-coding-cn/glm-5.3-flash`，它有官方原生视觉及套餐承诺且本机已内置。先确认最终生效 base、API、ID、input，避免其他 override 覆盖它们。对 Flash 保留已内置的 low/high/max 思考映射。
3. **不以本地列表缺失直接断言服务不可用。** 本机已有相关目录条目；若运行时仍不显示，先核对所用安装版、进程及目录层。P1 提供 `pi update --models` 刷新方法，但本任务未执行。P2 还报告 `/models` 曾漏掉可调用视觉型号，目录响应不是唯一判据。
4. **普通 API 作为独立备选。** 若账号普通端点权益已明确，可另设如 `bigmodel-vision` 的自定义 provider：base `https://open.bigmodel.cn/api/paas/v4`、api `openai-completions`、精确 model `glm-5.3-flash`、input `["text","image"]`，复用经核对的思考/流式/输出上限元数据。该方案有 S2/S3 协议依据，但未完成本机端到端验证；不要为它重定向整个 `zai-coding-cn`。
5. **若必须保留 GLM-5.3 为主模型，采用显式视觉工具是另一个设计。** 另一个视觉模型读图后返回文字，GLM-5.3 处理这份文字；报告来源与失败需可见。这是额外模型调用，不是纯请求格式修补，也不等于主模型原生看图。当前没有安装社区包、实现 wrapper 或启用 fallback。
6. **不以“等待 Pi 适配”作为当前主修复。** Pi 1.4.0 已有图片序列化与相关视觉型号。只有具体视觉型号在官方端点能够接受图片、而 Pi 的同等请求仍失败且首个偏离已定位时，才提出局部 hook/provider 修复或目录更新。

## 仍需实测与验证边界

- 原故障的活动 provider/model、实际生效配置、payload hook、原始 HTTP 请求仍未还原；本报告不声称已复现或修复服务端 400。
- 在用户授权的后续验证中，用不含敏感内容的小 PNG/JPEG，先分别测试 `glm-4.6v` 与 `glm-5.3-flash` 的中国 coding 端点；问只有图像才能回答的内容，避免把 HTTP 200 当读图成功。
- 分别验证用户附件和 `read` 工具图片、多轮图片历史、Data URL 与 HTTPS URL、必要的工具调用/流式结束。对 MIME、数量与体积按 S4 保守设置，不用国际 Anthropic WebP 结果替代中国 Chat 验证。
- 若验证 extension，应先证明实际 provider/model/base 的隔离，尤其是虚拟路由、嵌套调用、模型切换；同时验证既有 hook 组合、abort、错误、usage，不能只测一次文本回复。本次没有新增测试或声称这些路径通过。
- Coding Plan 的模型可用性、资源通道、区域、套餐、计费和账号权限随时间变化；P2 的 `glm-4.6v-flashx` 429 报告以及 S2 的 FlashX 套餐限制不能推成所有接口永久不可用。
- 搜索覆盖了官方文档与 GitHub 社区，但不是完整互联网枚举；“没有找到当前组合成功案例”是本次检索结论，不是证明从来不存在。

## 本次执行与文件验证

- 联网：指定 wrapper 10 次 search、16 次 fetch 均返回成功；Q10 合法返回空结果。没有真实 GLM 调用。
- 本地：完整阅读本地诊断与相关安装版 models、models-configuration、custom-provider、extensions 文档，读取公开类型、SDK 桥接、runner、adapter、官方示例；通过只读脚本投影内置目录和 package 版本/exports。
- 一个定位命令尝试了不存在的 `dist/providers/index.d.ts` 与 `dist/api/index.d.ts`，`rg` 报路径不存在；随后由真实 `package.json` exports、`dist/compat.d.ts` 和 API 模块定位到公开入口，不以缺失文件推断 API 不存在。
- 仅新增本报告；未修改配置、production、测试或其他文档，未读取用户配置/凭据，未 stage/commit。工作区开始时已有其他修改，未覆盖或回退。
- 本次是资料调查与代码路径核对，不需要也未新增测试；完成前检查报告内容、无跟踪新文件的 whitespace diff 和暂存区，确认文档完整性与无暂存变更。上述检查不构成服务端功能验收。
