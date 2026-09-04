# Dogfooding thinking 开关被忽略

## 现象

`openai-idealab-dogfooding/Peach-07-17-DogFooding` 使用 Pi 的
`openai-completions` provider 时，TUI 提供 thinking 档位，且请求会携带
Qwen 的 `enable_thinking` 参数。Idealab 服务端没有遵循该开关：即使明确请求
关闭思考，响应仍包含 `reasoning_content`。

## 探测证据

对 Idealab 服务端分别进行了以下探测：

- 省略 thinking 参数时，响应仍返回 `reasoning_content`。
- `enable_thinking=false` 时，不能关闭思考。
- `chat_template_kwargs.enable_thinking=false` 时，不能关闭思考。
- `thinking_budget=0` 时，不能关闭思考。

因此，服务端实际忽略了可用于关闭 Qwen thinking 的请求参数；继续暴露档位会给出
无法兑现的控制承诺。

## 根因

Pi 0.84.4 的 `openai-completions` Qwen 兼容分支仅在模型配置
`model.reasoning === true` 时构造并写入 `enable_thinking`。该 Dogfooding 模型此前
配置为 `reasoning: true`，所以 Pi 会发送一个已被服务端忽略的开关，同时 TUI 将其视为
支持 thinking 的模型。

## 修复方案

仅将 `openai-idealab-dogfooding/Peach-07-17-DogFooding` 的
`reasoning` 改为 `false`，不修改 provider 级 `compat.thinkingFormat`，以免影响同一
provider 的其他潜在模型。

在当前 Pi 运行时，`getSupportedThinkingLevels` 对 `reasoning=false` 只返回
`["off"]`。因此 TUI 只保留 off，无需提供档位切换；同时 Qwen 分支的
`model.reasoning === true` 条件不成立，Pi 不再构造或发送 `enable_thinking`。

## 验证标准

1. `pi/models.json` 可由 JSON 解析器读取，且目标模型的 `reasoning` 为 `false`。
2. 设置 `PI_CODING_AGENT_DIR=/Users/leshi.zhy/pi-config/pi` 后执行
   `pi --list-models Peach`，目标模型显示 `thinking: no`。
3. 运行时对该模型的可用 thinking levels 仅为 `["off"]`，并且请求构造不会进入
   OpenAI Completions 的 Qwen `enable_thinking` 分支。
