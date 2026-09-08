# Pi Token Switch 模型 ID 显示为 mode 哈希

## 现象与用户影响

Pi 的 TUI/footer 将 `model.id` 作为主显示标识，`name` 只用于匹配和次级详情。此前 Token Switch 同步把 `mode-*` 哈希同时写入生成模型的 `id`，使用户在模型列表和主界面无法区分 `Qwen3.8-Max-DogFooding`、`高级` 与 `旗舰`。

## 路由与额度证据

对 `Qwen3.8-Max-DogFooding` 和 `高级` 的 mode，将请求体 `model` 改为可读名称后，Token Switch 都返回 HTTP 429 `insufficient_quota`。结合用户确认对应 mode 有额度及旧 hash ID smoke 成功，该状态不能证明真实余额耗尽；可读 ID 被 Pi 直接写入请求体，导致内部 mode 路由没有被保留。完整因果、修复与验证见 [Token Switch 可读 ID 未覆盖请求体路由](2026-09-08-token-switch-readable-id-routing.md)。

## 修复方案

同步脚本从 OpenCode model `name` 确定性生成可读 slug 作为 Pi `model.id`：保留 Unicode 字母、数字以及安全字符，统一空白、斜杠等分隔符为连字符，并去除首尾分隔符。若同次同步的名称归一化冲突，则附加短 mode 后缀以保持可读且稳定的唯一性。空或无法生成 ID 的名称会在写入前失败。

生成 provider 的 ID、`baseUrl` 和动态 `apiKey` helper 参数仍使用完整 `mode-*` 值。生成模型必须额外通过 `samplingParams.model` 覆盖请求体 mode；该值来自经过验证的 provider/baseURL 关联，不能由显示 ID 推导。同步会同时替换受管 settings 引用，移除旧的 hash model ID。

## 残余风险

可读 ID 与请求体 mode 是两个独立字段；之后新增或重命名显示 ID 时，必须保留 `samplingParams.model` 覆盖。本文不包含 Key、令牌、Cookie 或 Authorization 信息。
