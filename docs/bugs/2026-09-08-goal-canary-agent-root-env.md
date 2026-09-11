# Real canary 丢失 project agent root

## 首偏离

此前真实 RPC canary 在 prompt 前报 `No API key found for openai-codex`，但同一 project 的公开 `--list-models` catalog 显示 `openai-codex/gpt-5.6-luna` 为 available、selected。静态检查确认真实 Pi 的 resolver 只能从 child process 环境解析 agent root；临时 Goal settings 必须仅经 `realCanaryGoalEntry(settingsPath)` 的薄 wrapper 提供，不能把 temporary `agentDir` 当作 `PI_CODING_AGENT_DIR`。

`production-final-review-provider.ts` 接收由 entry 中 `ModelRuntime.create()` 建立的 runtime；该 factory 未传入 auth path、key 或 agentDir。因此它和 real RPC Pi process 共同依赖同一个 process `PI_CODING_AGENT_DIR`/`PI_CONFIG_HOME` resolver，而不是 temporary Goal/workspace/session roots。

## RED

canary 的 child-env contract 现明确断言：

- `PI_CODING_AGENT_DIR` 精确为 `/Users/mhbzhy/pi-config/pi`；
- `PI_CONFIG_HOME` 精确为 `/Users/mhbzhy/pi-config`；
- `HOME` 不被覆盖；
- 只移除继承的 `PI_SUBAGENT_*` fanout markers；Goal/workspace state roots 仍隔离到 temporary agent directory。

测试通过一个无模型 Node child 检查实际传入环境，避免把 parent object 的断言误当作 spawn 证据。

## GREEN 与真实门禁

env-gated real test 在创建 RPC Pi child 前，使用相同 `cwd` 和 child `env` 运行无模型 `/opt/homebrew/bin/pi --list-models`。它只匹配公开 catalog metadata：`openai-codex/gpt-5.6-luna` 的 available、selected 均为 `yes`；不读取 credential 文件、不调用 login/auth、也不注入 auth path/key。随后同一 env 启动固定 provider/model 的唯一 one-task RPC smoke。

失败时测试只保存脱敏的 stderr/event 首个诊断，并且不循环重跑。默认 test 保持 skip，不调用模型。
