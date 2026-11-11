---
name: manage-providers
description: Use only to add, delete, update, or diagnose missing/invalid/rejected non-sensitive pi provider and model definitions. Do not inspect, retrieve, rotate, request, read, record, or repeat credentials.
---

# 管理 Pi Provider 与 Model

本仓使用 Pi 1.5.0，配置根是仓库内的 `pi/`，不是 `~/.pi/agent/`。脚本默认根据自身真实路径定位本仓 `pi/`；显式设置 `PI_CODING_AGENT_DIR` 时，以该目录为准，包括通过共享 Skill 软链调用的情况。

只管理 `models.json` 中不敏感的 provider/model 定义，不检查凭据，不调用真实 provider。`pi/models.json` 整体 Git 忽略，是本机配置，不提交、不跨机器同步；`pi/settings.json` 的 `enabledModels` 同样是本机选择，不因新增定义自动改写。

## 操作

从仓库根目录运行；从其他目录调用时使用脚本的真实绝对路径：

```bash
SCRIPT=.agents/skills/manage-providers/manage-providers.py

# 查看定义，不读取 auth.json，也不判断认证是否可用
python3 "$SCRIPT" list

# 添加非敏感 provider 定义；不会设置凭据
python3 "$SCRIPT" add-provider deepseek-example \
  --api openai-completions \
  --base-url https://provider.example/v1 \
  --compat supportsDeveloperRole=false \
  --compat maxTokensField=max_tokens

# --id 是实际发送给 API 的模型 ID，--name 只是显示名称
python3 "$SCRIPT" add-model deepseek-example \
  --id example-model \
  --name "Example Model" \
  --context 128000 \
  --max-tokens 8192

# 删除前确认对象；provider 删除还会删除同名凭据条目，须先取得这一副作用的授权
python3 "$SCRIPT" remove-model deepseek-example example-model --confirm example-model
python3 "$SCRIPT" remove-provider deepseek-example --confirm deepseek-example
```

- `add-provider` 支持 `--auth-header` 和可重复的 `--header "non-sensitive-key:value"`。`--auth-header` 只设置请求行为，不读取或写入 key。
- `--compat key=value` 可重复使用：JSON 布尔、数字、对象和数组保留类型，普通未加引号的字符串仍按字符串保存。`true/false/yes/no` 表示布尔，`1/0` 表示数字。例如 `--compat vllmPriority=1` 和 `--compat 'chatTemplateKwargs={"enable_thinking":true}'`。字段必须符合实际 API 的配置 schema，不凭“兼容 OpenAI”猜测开关。
- `add-model` 还支持 `--reasoning`、`--input text,image`。context 和 max-tokens 必须是正数，input 仅使用 `text`、`image`。
- 脚本只处理标准 JSON；不要用它自动重写带注释的配置。已有 provider/model 不自动覆盖，复杂修改按当前公开 schema 做明确、最小的字段编辑，不通过“先删再加”隐式清除认证。

## 当前字段与旧用法

常见 `--api` 值：

| 值 | 协议 |
|---|---|
| `openai-completions` | OpenAI Chat Completions |
| `openai-responses` | OpenAI Responses |
| `anthropic-messages` | Anthropic Messages |
| `google-generative-ai` | Google Generative AI |

这不是完整白名单；其他 API 必须由当前 Pi 或已安装扩展实际支持。`openai` 本身不是这里的通用 API 类型。

- `actualModelId` 和 `--actual-model-id` 已不适用于当前配置。使用真实 `--id` 和显示 `--name`；不要创建一个 alias ID 再指望 `actualModelId` 转发。
- provider 级 `metadataUserId` / `--metadata-user-id` 不在当前支持字段中，不再生成或作为生效配置展示。
- 本次适配不自动改写已有本机定义中的旧字段。遇到旧字段，先核对实际模型身份，再按用户授权修改。
- 当前高级模型字段包括 `thinkingLevelMap`、`inputLimits`、`promptCache`、`samplingParams`、`samplingParamsByThinkingLevel`；已有模型的局部调整可用 `modelOverrides`。脚本未为这些字段另造 CLI，按官方字段说明操作。
- 打开 Pi 的 `/model` 会重新加载定义。能加载不等于认证可用；缺少凭据或认证被拒时，不读取 `auth.json`、不打印环境变量，也不尝试调用 provider 验证。

## 凭据边界

Base URL、metadata 与自定义 header 都必须是非敏感内容。脚本拒绝 `Authorization`、`Proxy-Authorization`、`Cookie`、`Set-Cookie`、`X-API-Key`、`API-Key`，也拒绝 Bearer/Basic、secret/token/key 前缀或明显长 token 形式的 header 值。不要把认证值放进模型 prompt、命令参数、环境变量、stdin、命令模板或对话。

凭据设置和轮换不属于自动管理定义的授权。只有用户明确要求设置凭据时，才可启动下面的安全交互入口，由人类在 `/dev/tty` 无回显输入；代理不能请求、读取、记录或复述输入值：

```bash
python3 "$SCRIPT" set-key <provider>
```

没有交互终端时停止，不能回退到命令行、环境变量或 stdin 传 key。Pi 自身的 `/login` 也是人类可用的认证入口。

## 存储与检查

- `models.json` 使用锁及原子替换，避免脚本自身并发更新丢失；不把该锁描述为所有编辑器或 Pi 进程共享的锁。
- `auth.json` 写入使用同目录临时文件、fsync、原子替换和 `0600` 权限。
- 删除 provider 时若后续定义更新失败，脚本恢复原凭据内容并报告失败。
- 维护脚本时使用既有 `test/manage-providers-security.test.mjs`；只在隔离临时目录使用假数据，不能以校验为由读取本机真实凭据或请求真实服务。

## 本机权威资料

- `node_modules/@earendil-works/pi-coding-agent/docs/models.md`
- `node_modules/@earendil-works/pi-coding-agent/docs/models-configuration.md`
- `node_modules/@earendil-works/pi-coding-agent/dist/core/model-config.js`：当前模型配置 schema
- `node_modules/@earendil-works/pi-ai/dist/auth/types.d.ts`：当前凭据结构，不是凭据数据
