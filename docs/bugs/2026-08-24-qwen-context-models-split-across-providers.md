# Qwen 上下文模型被拆分到独立 provider

## 正常入口

本机使用者从 `pi/settings.json` 的 `enabledModels` 选择 `provider/model` 路径；Pi 随后从本机 model registry 解析该路径并暴露为可选模型。

## 首个偏离点

128K 配置被建成了独立的 `qwen-home-128k` 与 `qwen-hangzhou-128k` provider，而不是分别作为 `qwen-home`、`qwen-hangzhou` 的第二个模型 alias。这使同一 location 的不同上下文窗口分散在不同 provider 名称下。

## production 可达调用链与分类

调用链为：`pi/models.json` 的 provider/model 定义 → Pi model registry 的注册与可见性筛选 → `pi/settings.json` 的 `enabledModels` 本机白名单 → `pi --list-models qwen` 的可观察可用路径。

分类：

- **production 可达**：同时在 registry 中存在且被 `enabledModels` 引用的路径。
- **registry 可达但未启用**：registry 存在、但不在本机白名单中的路径。
- **不可达**：provider 或 model 定义不存在，或路径无法被 registry 解析。

上述均为本机配置行为；本文不记录服务地址、header、凭据或机器标识。

## RED（修改前）

`pi --list-models qwen` 仅显示三个可用路径：

- `qwen-home/qwen38-nvfp4`（204.8K）
- `qwen-home-128k/qwen38-nvfp4`（131.1K）
- `qwen-hangzhou/qwen38-nvfp4`（204.8K）

其中 `qwen-hangzhou` 的 128K 配置未作为可用路径暴露。目标状态应为两个 provider，每个 provider 同时暴露 204800 与 131072 上下文窗口的模型；128K 使用公开 alias `qwen38-nvfp4-128k` 并映射到既有实际模型 ID。

## GREEN（修改后）

- `manage-providers.py list` 仅显示 `qwen-home` 与 `qwen-hangzhou` 两个 Qwen provider；两者均包含 204800 的 `qwen38-nvfp4` 和 131072 的 `qwen38-nvfp4-128k → qwen38-nvfp4`。
- `pi --list-models qwen` 显示四个可用路径：两个 provider 各有普通与 128K alias，context 分别为 204.8K 与 131.1K。
- 本机 `enabledModels` 已切换到上述四条路径；未执行真实推理、网络连通性或凭据检查。
