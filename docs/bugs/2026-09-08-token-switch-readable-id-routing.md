# Token Switch 可读 ID 未覆盖请求体路由

## 现象与用户影响

Pi 的 TUI 已将 Token Switch 模型显示为可读 ID，例如 `Qwen3.8-Max-DogFooding`、`高级` 和 `旗舰`。用户在 Token Switch UI 中看到对应 mode 有可用额度且计费系数为 `0.0x`，但 Pi 使用这些可读 ID 发起请求时返回 HTTP 429 `insufficient_quota`。

## 前后因果与根因

旧配置将 `mode-*` 哈希直接作为 Pi `model.id`，Pi 请求体中的 `model` 因此恰好是 Token Switch 的内部 mode ID，历史 smoke 可成功。改为可读 `model.id` 后，Pi 默认将该 ID 写入请求体的 `model`，例如 `Qwen3.8-Max-DogFooding`；Token Switch 无法按预期内部 mode 路由，最终以 429 表现，不能将其归因为真实余额耗尽。

同步脚本已经根据经验证的 OpenCode provider `baseURL` 提取每个 `mode-*`，并用它生成 provider 的 `baseUrl` 与动态凭据 helper 参数，但没有将同一个 mode 写入 Pi 模型的请求参数覆盖。Pi 的 `samplingParams` 会在 OpenAI-compatible 请求中最后合并，因此可用于精确覆盖 body 的 `model` 字段，同时保留可读 TUI ID。

## 修复

对每个生成的 Pi Token Switch 模型，写入 `samplingParams.model`，值直接使用与其 OpenCode provider `baseURL` 验证关联的内部 `mode-*`。显示用 `id` 和 `name` 保持可读；重复或冲突的可读名称仍按现有稳定后缀规则处理，不从显示名推导路由 mode。真实同步会迁移既有受管模型，其他 provider/model 的 `samplingParams` 保持不变。

## 验证

回归测试覆盖 Qwen3.8-Max-DogFooding、`高级`、`旗舰` 与重复可读名称，断言显示 ID 不变且每项 `samplingParams.model` 精确等于相应 provider 的内部 mode。随后运行类型检查、真实同步、模型列表，并仅用 Pi 对 Qwen3.8-Max-DogFooding 发送一次无工具、全新会话、无重试的固定最小 prompt，记录非敏感结果。

本文不包含 Key、令牌、Cookie、Authorization 或其他凭据。
