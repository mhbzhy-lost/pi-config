# Qwen 128K alias 丢失二态思考映射

## 正常入口

使用者通过 `provider/model` 路径选择已启用的 Qwen 模型；Pi 从本机 model registry 读取模型定义，并通过 RPC `get_available_thinking_levels` 暴露该路径可选的思考级别。

## 首个偏离点

新增 `qwen38-nvfp4-128k` alias 时使用的管理入口只接受 `reasoning` 布尔开关，不会写入 `thinkingLevelMap`。因此 alias 虽仍启用思考，却丢失了同一 provider 内普通 204.8K model 已有的二态映射。

## 完整调用链

模型管理入口新增 alias → `pi/models.json` 中 provider 的 model 定义 → Pi model registry 解析 `reasoning` 与 `thinkingLevelMap` → RPC `get_available_thinking_levels` 计算可见等级 → 客户端按返回等级显示思考开关。

## production 可达分类

- **production 可达**：model registry 中存在，且被本机 `enabledModels` 引用的 `provider/model` 路径。
- **registry 可达但未启用**：registry 中存在，但不在本机白名单的路径。
- **不可达**：provider 或 model 不存在，或路径无法被 registry 解析。

本文只描述本机配置的可观察行为；不记录服务地址、header、凭据或机器标识。

## RPC RED（修改前）

- `qwen-home/qwen38-nvfp4` 与 `qwen-hangzhou/qwen38-nvfp4` 的 `get_available_thinking_levels` 均返回 `["off", "xhigh"]`。
- `qwen-home/qwen38-nvfp4-128k` 与 `qwen-hangzhou/qwen38-nvfp4-128k` 均返回 `["off", "minimal", "low", "medium", "high"]`。

这与用户期望不符：四个 Qwen model 都支持思考关闭/开启，但不支持强度调节。修复应仅令两个 128K alias 继承各自 provider 内普通 model 的二态 `thinkingLevelMap`，其中开启使用既有 `xhigh: on`。

## RPC GREEN（修改后）

- 四个 Qwen `provider/model` 路径的 `get_available_thinking_levels` 均精确返回 `["off", "xhigh"]`。
- `pi --list-models qwen` 仍显示两个 provider 各有 204.8K 与 131.1K 两个 model，四项的 thinking 均为 `yes`。
- 未执行真实推理、网络连通性或凭据检查。
