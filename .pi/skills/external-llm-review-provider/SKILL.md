---
name: external-llm-review-provider
description: "Use when adding a new provider to the external-llm-review skill, when the review command reports provider validation errors, or when _healthcheck.py shows [FAIL] for an existing provider."
---

# 给 external-llm-review 增加 provider

skill 位置：`skill-overrides/external-llm-review/`
本 skill（触发用）：`.pi/skills/external-llm-review-provider/SKILL.md`

## 决策树：要先建独立 Provider 类吗？

| 新 vendor 的 wire protocol | 处理方式 | 例子 |
|---|---|---|
| 标准 OpenAI-compatible chat completions（`/chat/completions`，`messages` 数组，`choices[].message.content`）| **不需要**新类，直接注册到 `IdealabOpenAIProvider` | DeepSeek、OpenAI、大部分国产 |
| 有非标准扩展：thinking/reasoning_content、强制 streaming、自定义 header、独立的 system 字段 | **需要**新类（继承 `BaseProvider`） | Bailian（`enable_thinking` + streaming）、Anthropic（独立 `system` 字段 + `x-api-key` header） |

判断方法：翻 vendor 官方 API 文档，看是否要求任何超出标准 OpenAI 协议的特性。

## 8 个触碰点（按顺序执行）

### 1. `providers/<name>.yaml`（新建）

```yaml
provider: <name>                              # 必须等于 yaml 文件名（无扩展）
base_url: https://api.<vendor>.com/v1
api_key: ${<NAME>_API_KEY}                    # 占位符，引用 .env 变量
model: <default-model-id>
max_tokens: 16384
# provider-specific 字段放最后，仅当需要新增 Provider 类时才用
# enable_thinking: false
```

**规则**：
- `base_url` 不带 path（OpenAI 路径 `/chat/completions`、Anthropic 路径 `/v1/messages` 由 Provider 类追加）
- 敏感字段一律用 `${ENV_VAR}` 占位符，`_config.py` 会插值
- 不要硬编码 API key 进 yaml

### 2. `_config.py`（修改）

```python
from _provider import (
    BailianProvider,
    BaseProvider,
    IdealabAnthropicProvider,
    IdealabOpenAIProvider,
    # NewProvider,  # ← 仅当新增独立 Provider 类时
)

_PROVIDER_CLS: dict[str, type[BaseProvider]] = {
    "idealab-anthropic": IdealabAnthropicProvider,
    "idealab-openai":    IdealabOpenAIProvider,
    "bailian":           BailianProvider,
    "deepseek":          IdealabOpenAIProvider,
    "<name>":            IdealabOpenAIProvider,  # ← 标准 OpenAI-compatible 用这里
    # "<name>":          NewProvider,            # ← 独立类用这里
}
```

**注意**：若新 provider 有 provider-specific 字段（yaml 里除 `provider` / `base_url` / `api_key` / `model` / `max_tokens` 外的字段），还要在 `get_provider()` 函数里为对应 class 添加 kwargs 注入分支（参考 Bailian 的 `enable_thinking` 处理）。

### 3. `reviewer.py`（修改 3 处）

全部搜索旧白名单并逐一扩展，**不要漏任一**：

```python
# 位置 A：resolve_provider() 里的 tuple
if provider not in ("idealab-anthropic", "idealab-openai", "bailian", "deepseek", "<name>"):
    raise ValueError(
        f"EXTERNAL_LLM_REVIEW_PROVIDER/--provider must be one of "
        f"('idealab-anthropic', 'idealab-openai', 'bailian', 'deepseek', '<name>'), got {provider!r}"
    )

# 位置 B：build_arg_parser() 里 --provider choices
parser.add_argument(
    "--provider",
    choices=("idealab-anthropic", "idealab-openai", "bailian", "deepseek", "<name>"),
    ...
)

# 位置 C：legacy error message 里的 one of 列表
"... EXTERNAL_LLM_REVIEW_PROVIDER (one of: idealab-anthropic, idealab-openai, bailian, deepseek, <name>). ..."
```

以及头部 docstring 的 `--provider` 示例和 `SKILL.md` 正文中的 CLI 示例——搜 `--provider` 全部扩展。

### 4. `_healthcheck.py`（修改 1 处）

```python
PROVIDERS = ["idealab-anthropic", "idealab-openai", "bailian", "deepseek", "<name>"]
```

漏加 healthcheck 不会报错但 `uv run _healthcheck.py` 不会验证新 provider。

### 5. `.env.example`（追加 1 行）

```ini
# <Vendor> <protocol-type> gateway (providers/<name>.yaml)
# Get a key at <vendor-dashboard-url>
<NAME>_API_KEY=
```

**禁止**把真实 key 写进 `.env.example`（git-tracked）。

### 6. `SKILL.md`（3 处扩展）

- "预置 Provider" 表格 → 新增一行并更新数量
- "Provider 选择规则" 表格 → 在对应 agent 模型行追加新 provider
- CLI 用法示例的 `--provider` 枚举 → 加新值

### 7. TDD 测试（至少 2 个）

在 `tests/test_reviewer.py`：

**测试 A：YAML 加载返回正确 provider 类**

```python
def test_get_provider_returns_<name>(self):
    from _config import get_provider
    from _provider import IdealabOpenAIProvider  # 或新 class
    self.write_provider(
        "<name>",
        "provider: <name>\n"
        "base_url: https://api.<vendor>.com/v1\n"
        "api_key: ${<NAME>_API_KEY}\n"
        "model: <model>\n"
        "max_tokens: 16384\n",
    )
    provider = get_provider(
        "<name>",
        providers_dir=self.providers_dir,
        env={"<NAME>_API_KEY": "sk-test"},
    )
    self.assertIsInstance(provider, IdealabOpenAIProvider)
    self.assertEqual(provider.api_key, "sk-test")
    self.assertEqual(provider.model, "<model>")
```

**测试 B：resolve_provider 白名单接受**

```python
args = Namespace(provider="<name>")
self.assertEqual(reviewer.resolve_provider(args, env={}), "<name>")
```

流程：
1. 写测试 → 跑 → 看到 `ValueError: Unknown provider type '<name>'` 和 `resolve_provider` 返回错误 → **RED 通过**
2. 改实现 → 跑 → 两个测试都 pass → **GREEN 通过**

### 8. Healthcheck 验证

```bash
cd skill-overrides/external-llm-review
uv run --no-project --with httpx --with python-dotenv --with pyyaml python _healthcheck.py
# 期望：[OK] <name>: OK
```

失败常见原因见下方。

## 全量回归

```bash
uv run --no-project --with httpx --with python-dotenv --with pyyaml \
    python -m unittest discover -s tests -v
# 期望：Ran N tests in ... OK（无失败）
```

## 常见失败

| 现象 | 原因 | 处置 |
|---|---|---|
| `_healthcheck.py` 输出 `[FAIL] <name>: 401 invalid_api_key` | `.env` 里 key 没填或格式错 | 检查 `.env`（vendor dashboard 给的完整 key，不要复制截断） |
| `[FAIL] <name>: 404 Not Found` | yaml 里 `base_url` 带多余 path | 通常 vendor 文档给的是完整 URL，但 Provider 类会追加 `/chat/completions`；yaml 里 `base_url` 只到 `/v1` |
| `[FAIL] <name>: 400 invalid model` | yaml 里 model id vendor 不支持 | 翻 vendor 文档核对 model 名（拼写 + 版本后缀） |
| `_PROVIDER_CLS` 注册后仍报 `Unknown provider type` | yaml 里的 `provider:` 字段和 yaml 文件名不一致 | yaml 文件名 `X.yaml` 与 yaml 内 `provider: X` 必须完全相同 |
| reviewer.py 报错 `argument --provider: invalid choice` | 漏改了 build_arg_parser 的 choices tuple | 用 grep `choices=.*idealab` 定位第二处白名单 |
| IDEALAB_ANTHROPIC 月度 400 IRC-001 | 配额耗尽 | 不影响新 provider；换 provider 跑 |
| `unresolved env var(s)` 启动报错 | `.env` 未加载 / dotenv 找不到文件 | `load_dotenv(SKILL_DIR / ".env")` 应已自动加载，确认 `.env` 在 skill 目录 |

## 相关资料

- Skill 本体（provider 架构）：`skill-overrides/external-llm-review/`
- Provider 类抽象：`skill-overrides/external-llm-review/_provider.py`
- YAML 加载与注册：`skill-overrides/external-llm-review/_config.py`
- 行为测试：`skill-overrides/external-llm-review/tests/test_reviewer.py`

## Commit 模板

```
feat(external-llm-review): 增加 <vendor> provider（异源评审第 N 链路）

<vendor> 提供 <protocol> API，<复用/新增> Provider 类：
- _config.py: _PROVIDER_CLS 注册 <name> → <Class>
- reviewer.py: resolve_provider / --provider choices / help 文案加入 <name>
- _healthcheck.py: PROVIDERS 列表加入 <name>
- providers/<name>.yaml: 新建（base_url=...）
- .env.example: 追加 <NAME>_API_KEY 占位说明
- SKILL.md: provider 表、选型表、CLI 示例均更新

TDD: 先写 2 个新测试（YAML 加载返回 <Class> 类；白名单接受 <name>），
RED 后实现 GREEN。N/N 通过。

Agent 模型族选型补充：
- <vendor> 系 agent → 用 <异源 provider>（异源对照）
- <现有> 系 agent → 可选用 <vendor>（作为新异源选项）
```
