# OpenAI Codex GPT-5.6 上下文范围错误

## Bug 描述
`openai-codex` 将 GPT-5.6 Terra 和 Luna 也错误覆盖为 1.05M 上下文，实际只有 Sol 支持该范围。

## 复现流程
1. 查看 `pi/models.json` 中 `openai-codex.modelOverrides`。
2. 发现 `gpt-5.6-sol`、`gpt-5.6-terra` 和 `gpt-5.6-luna` 都设置了 `contextWindow: 1050000`。
3. 运行 `pi --list-models openai-codex`，三个模型都会显示约 1.1M 上下文。

## 修复方案
仅保留 `gpt-5.6-sol` 的 `contextWindow: 1050000` 覆盖；删除 Terra 和 Luna 的覆盖条目，使它们回退到 Pi 内置的 272K 上下文。
