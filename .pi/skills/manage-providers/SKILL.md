---
name: manage-providers
description: Use only to add, delete, update, or diagnose missing/invalid/rejected non-sensitive pi provider and model definitions. Do not inspect, retrieve, rotate, request, read, record, or repeat credentials.
---

# Manage Providers

管理 `models.json` 中不敏感的 provider 与 model 定义。base URL、模型 metadata 和自定义 header 在进入 Git 前必须脱敏；header 名和 header 值都会经过敏感检测，不得保存 `Authorization`、`Proxy-Authorization`、`Cookie`、`Set-Cookie`、`X-API-Key` 或 `API-Key`，也不得以 Bearer/Basic、secret/token/key 前缀或明显长 token 形式保存认证值。

凭据检查、检索和轮换不在本 Skill 的自动处理范围。任何认证值都必须使用安全凭据入口，而不得进入 `models.json`、模型 prompt、命令行、环境变量、stdin 文本、命令模板或对话记录。

## Commands

```bash
SCRIPT=.pi/skills/manage-providers/manage-providers.py

# 查看非敏感定义（不检查凭据）
python3 $SCRIPT list

# 添加 provider 的非敏感定义
python3 $SCRIPT add-provider <name> \
  --api <type> \
  --base-url <url> \
  [--auth-header] \
  [--header "non-sensitive-key:value"] \
  [--metadata-user-id <id>] \
  [--compat "key=value"]

# 删除 provider；确认值必须与名称完全相同
python3 $SCRIPT remove-provider <name> --confirm <name>

# 添加 model；删除 model 的确认值必须与 model ID 完全相同
python3 $SCRIPT add-model <provider> --id <id> --context <tokens> --max-tokens <tokens>
python3 $SCRIPT remove-model <provider> <model-id> --confirm <model-id>

# 仅启动安全交互入口；人类在 /dev/tty 无回显输入凭据
python3 $SCRIPT set-key <provider>
```

代理可以启动最后一条安全交互命令，但不能请求、读取、记录或复述凭据；必须由人类直接完成终端提示。

## Examples

```bash
python3 $SCRIPT add-provider deepseek-example \
  --api openai-completions \
  --base-url "https://provider.example/v1"

python3 $SCRIPT add-model deepseek-example \
  --id example-model \
  --context 128000 \
  --max-tokens 8192

python3 $SCRIPT remove-model deepseek-example example-model --confirm example-model

python3 $SCRIPT remove-provider deepseek-example --confirm deepseek-example
```

## API Types

| `--api` value | Protocol |
|---|---|
| `anthropic-messages` | Anthropic Messages |
| `openai-completions` | OpenAI Chat Completions |

## Storage guarantees

- `auth.json` is written with mode `0600` via a same-directory temporary file, fsync, and atomic replacement.
- `models.json` uses a lock and atomic replacement to avoid silent concurrent-write loss.
- Provider deletion reports failure and restores the credential entry if the subsequent definition update fails.
