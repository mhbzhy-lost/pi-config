# DeepSeek external review 无法复用 Pi 凭据

## 问题

external-llm-review 已注册 `deepseek` provider，YAML 仅引用 `DEEPSEEK_API_KEY`。本地 reviewer 的 `.env` 未配置该变量时，即使 Pi 的 DeepSeek auth check 已为 ready，配置加载仍报 `unresolved DEEPSEEK_API_KEY`。

writing-skills RED 基线（主会话已完成）：fresh delegate 仅能从当前 `SKILL.md` 建议填写 `.env`，无法发现复用 Pi 凭据的方法。

## 修复方案

保持现有 YAML 与 provider 注册不变。加载环境副本后，仅在请求的 provider 是 `deepseek` 且 `DEEPSEEK_API_KEY` 缺失或为空时，子进程调用官方 Pi CLI：`[PI_REAL_BIN or "pi", "auth", "print-api-key", "--provider", "deepseek"]`。捕获的非空 stdout 只注入该次内存环境副本，再由既有 YAML 插值和 provider 构造流程使用。

## 泄露边界

不读取 `auth.json`，不修改 `.env` 或进程全局环境，不以 shell 执行命令，也不打印 key。Pi CLI 的 stdout/stderr 仅在 resolver 子进程中捕获；非零退出、超时、执行失败和空 stdout 均只抛出说明 provider 与失败类别（或退出码）的脱敏 `RuntimeError`，绝不包含命令输出、stderr 或 credential。显式非空 `DEEPSEEK_API_KEY` 始终优先，且不会启动子进程；其他 provider 不触发此 fallback。
