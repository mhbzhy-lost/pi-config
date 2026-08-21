---
name: external-llm-review-provider
description: "Use when adding, upgrading, retiring, or diagnosing an external-llm-review provider."
---

# 管理 external-llm-review provider

skill 位置：`skill-overrides/external-llm-review/`。本 skill 位于 `.pi/skills/external-llm-review-provider/SKILL.md`。

当前已注册的 provider 只有：

| Provider | 模型 | 协议 |
| --- | --- | --- |
| `idealab-anthropic` | `claude-opus-4-6` | Anthropic Messages API |
| `idealab-openai` | `qwen3.8-max` | OpenAI-compatible streaming chat completions |

新增 provider 必须按以下通用流程扩展当前白名单，不能把当前双 provider 限制误写成永久禁令。

## 决策树：要先建独立 Provider 类吗？

| 新 vendor 的 wire protocol | 处理方式 |
| --- | --- |
| wire protocol 和运行时行为与某现有类完全一致 | 可以复用该类。 |
| 协议或行为有任一差异：reasoning 字段、强制 streaming、自定义 header、独立 `system` 字段、不同 endpoint 或错误语义 | 新建继承 `BaseProvider` 的类，并在类内封装协议差异。 |

判断方法：先核对 vendor 官方 API 文档和现有类的请求、响应、流式及错误行为。`IdealabOpenAIProvider` 是 `qwen3.8-max` 的强制 streaming 专用类，不是通用 OpenAI-compatible provider 的默认复用类。

## 8 个触碰点（按顺序执行）

核心实现触点是 `_provider.py` 和 fail-closed 的 `build_provider()` 工厂：工厂只能显式映射已批准 endpoint，未知、通用或其他 endpoint 必须拒绝，错误不得回显完整 URL。

### 1. `providers/<name>.yaml`

```yaml
provider: <name>
base_url: https://api.<vendor>.com/v1
api_key: ${<NAME>_API_KEY}
model: <default-model-id>
max_tokens: 16384
# 仅在独立 Provider 类需要时添加 provider-specific 字段
```

`provider` 必须等于 YAML 文件名。`base_url` 不带 provider 类会追加的 path；敏感值只能使用 `${ENV_VAR}`，不得硬编码 API key。

### 2. `_config.py`

在 `_PROVIDER_CLS` 注册 `<name>`：仅当 wire protocol 和行为完全一致时才复用现有类；否则注册新类。不得把通用 OpenAI-compatible provider 默认注册为 `IdealabOpenAIProvider`。若 YAML 含 `provider`、`base_url`、`api_key`、`model`、`max_tokens` 之外的字段，在 `get_provider()` 中仅为对应类注入这些 kwargs。

当前注册示例：

```python
_PROVIDER_CLS: dict[str, type[BaseProvider]] = {
    "idealab-anthropic": IdealabAnthropicProvider,
    "idealab-openai": IdealabOpenAIProvider,
    # "<name>": ExistingProvider,  # 仅协议和行为完全一致时
    # "<name>": NewProvider,       # 有任一差异时
}
```

当前 `idealab-openai` 的凭据解析由 `_config.py` 内部执行：优先以 `PI_REAL_BIN`，未设置时以 `pi`，通过 `capture_output` 调用 `auth print-api-key --provider openai-idealab`。仅当该调用超时、不可执行、非零退出或输出为空时，才回退到非空 `IDEALAB_OPENAI_API_KEY`。两者都不可用时，诊断必须是 `idealab-openai Pi auth lookup <timeout|could-not-execute|nonzero-exit|empty-output>; IDEALAB_OPENAI_API_KEY fallback unavailable`；不得包含 stdout、stderr、原始异常或凭据。不得直接读取 `auth.json`，代理和用户不得直接执行该命令。

### 3. `reviewer.py`

搜索所有白名单并逐一扩展：`resolve_provider()`、`build_arg_parser()` 的 `--provider` choices、legacy 错误文案、头部 docstring 和主 Skill 的 CLI 示例。不得只改其中一个位置。

### 4. `_healthcheck.py`

按注册顺序把 `<name>` 加到 `PROVIDERS`。遗漏不会直接报错，但 healthcheck 不会验证新 provider。

### 5. `.env.example`

```ini
# <Vendor> gateway (providers/<name>.yaml)
<NAME>_API_KEY=
```

只提交占位说明，绝不提交真实 key。

### 6. 主 `SKILL.md`

更新当前 provider 表、provider 选择规则、CLI 枚举与必要的协议说明；当前表格中的运行时事实必须与 YAML、白名单和 push gate 一致。

### 7. TDD 测试（至少 2 个）

先写两个测试：YAML 加载能构造正确 provider 类并插值测试 key；`resolve_provider()` 接受 `<name>`。先运行并确认 RED，再实现注册和协议代码，最后运行确认 GREEN。

对 streaming provider，测试必须覆盖请求含 `stream: true` 与 `stream_options.include_usage: true`；SSE 同时有 content/reasoning 时最终取 content、content 为空时回退 reasoning；usage-only chunk；以及 error JSON 仅输出白名单字段的脱敏错误。

标准非流式 OpenAI provider 必须单独测试 `/chat/completions`、Bearer header、`client.post`，且请求不含 `stream` 或 Qwen 扩展字段；测试 `message.content`、空/畸形响应和脱敏错误。不得默认复用 `IdealabOpenAIProvider`。

对 Pi auth，测试必须覆盖成功结果优先于环境变量、超时/不可执行/非零退出/空输出四类失败均回退到环境变量，以及双来源不可用时仅报告 `Pi auth lookup <reason>; IDEALAB_OPENAI_API_KEY fallback unavailable`，不包含原始输出。

对 provider 退役，测试必须覆盖旧 provider 被 `resolve_provider()` 和 CLI choices 拒绝，以及 push gate 仅按现役 provider 的既定顺序尝试 fallback。

### 8. Healthcheck 验证

```bash
cd skill-overrides/external-llm-review
uv run --no-project --with httpx --with python-dotenv --with pyyaml python _healthcheck.py
```

仅在获授权访问真实 endpoint 时运行；期望新增项固定输出 `[OK] <name>: reachable`，不得回显模型原文。

## Qwen 3.8 SSE 契约

`idealab-openai` 使用 `qwen3.8-max`，必须 streaming，发送 `stream: true` 与 `stream_options.include_usage: true`。每个 SSE `data:` 负载是 JSON；`data: [DONE]` 结束流。分别聚合 `choices[].delta.content` 和 `choices[].delta.reasoning_content`，最终优先非空的 content，仅在其为空时回退 reasoning_content。usage-only chunk 和空 `choices` 可忽略。error JSON 必须转为仅含白名单字段的脱敏异常，不得暴露响应体、原始异常或凭据。不要发送无效的 `enable_thinking`；`max_tokens` 为网关兼容字段，不严格限制 reasoning。

## 既有 Provider 升级或退役清单

升级或退役必须逐项核对：

- YAML；provider 类及 `_config.py` 注册；`reviewer.py` 的全部白名单、choices、帮助和错误文案。
- `_healthcheck.py`；`.env.example`；主 `SKILL.md` 的 provider 表、选择规则和 CLI 枚举。
- `scripts/lib/review-invoker.mjs` 的 push gate 顺序和 fallback；相关单元测试与 push gate 测试。
- 全仓搜索旧 provider 标识，确认现役 YAML、类、注册、白名单、help、主文档和 gate 没有残留。明确标注的负向测试、迁移说明、历史计划和审计记录允许保留退役名称。

本次 `bailian` 和 `deepseek` 为硬删除：必须从现役 YAML、类、注册、白名单、help、主文档和 gate 移除，不保留兼容别名、fallback 或退役后配置；明确标注的负向测试、迁移说明、历史计划和审计记录可以保留名称。

是否把 provider 变更加入 push gate 必须作出显式决策，并在变更说明中记录加入或不加入及原因；不得由注册或 YAML 变更隐式推导。

## 全量回归

```bash
cd skill-overrides/external-llm-review
uv run --no-project --with httpx --with python-dotenv --with pyyaml \
  python -m unittest discover -s tests -v

cd <repo-root>
node --test test/review-invoker.test.mjs
npm test
```

## 常见失败

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| healthcheck 返回 `401` | 凭据缺失、失效或格式错误 | 检查授权来源，但不要打印 key。 |
| healthcheck 返回 `404` | `base_url` 含多余 path，或 provider 类追加的 path 不匹配 | 对照 vendor 文档确认 URL 组成。 |
| healthcheck 返回模型错误 | YAML 的 model ID 不受网关支持 | 核对模型拼写与版本。 |
| 注册后仍报 `Unknown provider type` | YAML 的 `provider:` 与文件名或 `_PROVIDER_CLS` 不一致 | 三者保持完全一致。 |
| `--provider` 是 invalid choice | 漏改 argparse choices | 搜索所有白名单位置。 |
| `idealab-openai Pi auth lookup <timeout\|could-not-execute\|nonzero-exit\|empty-output>; IDEALAB_OPENAI_API_KEY fallback unavailable` | Pi auth 与环境变量 fallback 都不可用 | 确认授权配置；不要读取凭据文件、不要记录原始输出。 |

## 相关资料

- Skill 本体：`skill-overrides/external-llm-review/`
- Provider 抽象：`skill-overrides/external-llm-review/_provider.py`
- YAML 加载与注册：`skill-overrides/external-llm-review/_config.py`
- 行为测试：`skill-overrides/external-llm-review/tests/test_reviewer.py`
- Push gate：`scripts/lib/review-invoker.mjs`

## Commit 模板

```text
feat(external-llm-review): 增加 <vendor> provider（异源评审第 N 链路）

<vendor> 提供 <protocol> API，<复用/新增> Provider 类：
- _config.py: _PROVIDER_CLS 注册 <name> -> <Class>
- reviewer.py: resolve_provider / --provider choices / help 文案加入 <name>
- _healthcheck.py: PROVIDERS 列表加入 <name>
- providers/<name>.yaml: 新建（base_url=...）
- .env.example: 追加 <NAME>_API_KEY 占位说明
- SKILL.md: provider 表、选型表、CLI 示例均更新

TDD: 先写 YAML 构造与白名单接受测试，确认 RED 后实现 GREEN。N/N 通过。
```
