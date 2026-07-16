---
name: manage-providers
description: Use when adding, removing, or modifying custom providers or models in pi's models.json and auth.json configuration.
---

# Manage Providers

管理 pi 的自定义 provider 和 model 配置（`models.json` + `auth.json`）。

## Commands

```bash
SCRIPT=.pi/skills/manage-providers/manage-providers.py

# 查看所有 provider 和 model
python3 $SCRIPT list

# 添加 provider
python3 $SCRIPT add-provider <name> \
  --api <type> \
  --base-url <url> \
  [--key <api-key>] \
  [--auth-header] \
  [--header "key:value"] \
  [--metadata-user-id <id>] \
  [--compat "key=value"]

# 删除 provider（同时删除 auth key）
python3 $SCRIPT remove-provider <name>

# 添加 model
python3 $SCRIPT add-model <provider> \
  --id <model-id> \
  --context <tokens> \
  --max-tokens <tokens> \
  [--name "Display Name"] \
  [--actual-model-id <real-id>] \
  [--reasoning] \
  [--input "text,image"]

# 删除 model
python3 $SCRIPT remove-model <provider> <model-id>

# 更新 API key
python3 $SCRIPT set-key <provider> <key>
```

## Examples

```bash
# 添加 DeepSeek provider
python3 $SCRIPT add-provider deepseek-idealab \
  --api openai-completions \
  --base-url "https://idealab.alibaba-inc.com/api/deepseek/v1" \
  --key "your-api-key"

# 添加 model 到已有 provider
python3 $SCRIPT add-model anthropic-idealab \
  --id claude-sonnet-4-5 \
  --context 200000 \
  --max-tokens 65536 \
  --reasoning \
  --input "text,image"

# 添加带 actualModelId 的 compact 变体
python3 $SCRIPT add-model anthropic-idealab \
  --id claude-sonnet-4-5-100k \
  --actual-model-id claude-sonnet-4-5 \
  --context 100000 \
  --max-tokens 65536 \
  --reasoning \
  --input "text,image"

# 删除 model
python3 $SCRIPT remove-model anthropic-idealab claude-sonnet-4-5-100k

# 删除整个 provider
python3 $SCRIPT remove-provider deepseek-idealab
```

## API Types

| `--api` value | Protocol | 用途 |
|---------------|----------|------|
| `anthropic-messages` | Anthropic Messages | Claude 系列 |
| `openai-completions` | OpenAI Chat Completions | Qwen, DeepSeek, GPT 等 |

## Notes

- 修改后立即生效（pi 下次请求时重新加载 models.json）
- `--key` 写入 `auth.json`（gitignored），不会泄露到版本控制
- `--actual-model-id` 配合 `anthropic-request-rewriter` extension 使用，发送请求时替换 model ID
