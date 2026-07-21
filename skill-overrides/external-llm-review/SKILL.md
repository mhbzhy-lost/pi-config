---
name: external-llm-review
description: Use when performing code review on a diff or changeset — after implementation, before merge, or on push. Covers cross-model external review requests and independent reviewer dispatch.
---

# External LLM Cross-Model Code Review

## 用途

外部 LLM 代码评审。接入独立 reviewer 抓盲点（库 API deprecation / cross-cutting 并发风险 / 版本兼容 / 安全等）。首选 idealab-anthropic (Claude Opus) 作为 reviewer，不可用时按 agent 模型家族选异源 fallback。

## Provider 选择规则

所有模型家族统一首选 `idealab-anthropic`（Claude Opus）。当 idealab-anthropic 不可用（配额耗尽、网关故障等）时，按 agent 自身模型家族选异源 fallback：

| Agent 自身模型家族 | 首选 provider | Fallback（idealab-anthropic 不可用时） |
| --- | --- | --- |
| Claude（claude-opus / claude-sonnet / claude-haiku） | `idealab-anthropic` | `bailian` 或 `idealab-openai` 或 `deepseek` |
| Qwen（qwen3.x / Qwen3.x-Max-DogFooding） | `idealab-anthropic` | `bailian` 或 `deepseek` |
| DeepSeek（deepseek-chat / deepseek-reasoner） | `idealab-anthropic` | `bailian` 或 `idealab-openai` |
| 其他模型 | `idealab-anthropic` | 随意，哪个能用用哪个 |

判断方法：系统提示中形如 `model named claude-opus-4-6` 或 `model named Qwen3.7-Max-DogFooding`。取 model id 前缀匹配 `claude` / `qwen`（不区分大小写）。

## 三个预置 Provider

每个 provider 由两个文件组成：`providers/<name>.yaml`（非敏感配置，git-track） + `.env` 里的对应 secret 变量（gitignored）。

| Provider | YAML | 用途 | `.env` 变量 |
|---|---|---|---|
| `idealab-anthropic` | `providers/idealab-anthropic.yaml` | Idealab Anthropic gateway，Claude 系列模型（Opus/Sonnet） | `ANTHROPIC_API_KEY` |
| `idealab-openai` | `providers/idealab-openai.yaml` | Idealab OpenAI-compatible gateway，Qwen 系列模型（`Qwen3.7-Max-DogFooding` 等） | `IDEALAB_OPENAI_API_KEY` |
| `bailian` | `providers/bailian.yaml` | DashScope 百炼网关，Qwen 系列模型（`qwen3.7-max` 等，带 thinking 支持） | `BAILIAN_API_KEY` |
| `deepseek` | `providers/deepseek.yaml` | DeepSeek OpenAI-compatible gateway（`deepseek-chat` / `deepseek-reasoner`） | `DEEPSEEK_API_KEY` |

YAML 里用 `${VAR}` 占位符引用 `.env` 变量，运行时由 `_config.py` 插值。`.env` 只存 secret，base_url/model/max_tokens 等配置留在 YAML。

## 配置

skill 位于 `${PI_CONFIG_HOME}/skill-overrides/external-llm-review/`。

### .env（gitignored）

```bash
cp ${PI_CONFIG_HOME}/skill-overrides/external-llm-review/.env.example \
   ${PI_CONFIG_HOME}/skill-overrides/external-llm-review/.env
```

然后填写每个 provider 对应的 API key。三个 provider 都配或任选其一均可，互不干扰。

### Healthcheck

首次使用或怀疑配置有问题时，用 healthcheck 脚本验证三个 provider 的可达性：

```bash
cd ${PI_CONFIG_HOME}/skill-overrides/external-llm-review
uv run --script _healthcheck.py
```

输出 `[OK]` / `[FAIL]` + 每个 provider 的诊断信息。常见失败：

- idealab-anthropic 返回 `400 IRC-001`：月度配额耗尽，下月自动恢复，不需要改 key
- idealab-openai 返回 `400 CE-001 模型不存在`：`providers/idealab-openai.yaml` 里的 `model` 与网关实际支持模型名不匹配
- bailian 返回 `401 invalid_api_key`：`.env` 中 `BAILIAN_API_KEY` 格式错误（百炼 key 通常以 `sk-` 开头）

## 用法

主代理 Bash 调用：

```bash
cd <repo-root>   # 工作树根
uv run --no-project \
    --with httpx --with python-dotenv --with pyyaml \
    python ${PI_CONFIG_HOME}/skill-overrides/external-llm-review/reviewer.py \
    <BASE_SHA> <HEAD_SHA> \
    [--worktree PATH] \
    [--provider idealab-anthropic|idealab-openai|bailian|deepseek] \
    [--spec docs/superpowers/specs/foo.md] \
    [--max-diff 80000] \
    [--review-depth standard|exhaustive] \
    [--review-round 1|2] \
    [--max-issues 25] \
    [--max-output-tokens 16000] \
    [--api-timeout-seconds 180]
```

**参数：**
- `BASE_SHA` —— 同族评审看的同一个 base
- `HEAD_SHA` —— subagent 实施后的 HEAD；传 `WORKTREE` 时审查 `git diff <BASE_SHA>`，包含当前未提交工作区改动
- `--worktree` —— 默认 `.`；评 worktree 时填 `.worktrees/<task>`
- `--provider` —— 默认从 `EXTERNAL_LLM_REVIEW_PROVIDER` 读，不设时退到 `idealab-anthropic`
- `--spec` —— 把 spec 文件附给模型做"对契约"评审
- `--max-diff` —— diff 字符上限（默认 80000，防网关 413）
- `--review-depth` —— 评审深度；默认 `exhaustive`，要求单轮尽量暴露完整问题面；快速 smoke review 才设 `standard`
- `--review-round` —— 当前 diff 的评审轮次，只允许 `1` 或 `2`；默认 `1`
- `--max-issues` —— 单轮最多报告的问题数，默认 `25`；同类问题归并为模式级 issue
- `--max-output-tokens` —— 模型输出 token 上限，默认 `16000`，支撑 reasoning 模型和穷举式报告
- `--api-timeout-seconds` —— provider API 调用外层硬超时，默认 `180`。设 `<=0` 时不关闭超时，而是退回底层默认（约 600s）

**stdout 输出**：模型返回的 review markdown（Strengths / Critical / Important / Minor / Checklist Coverage / Assessment）。**stderr** 是诊断信息。

未提交工作区评审（plan-runner harness 使用）：

```bash
uv run --no-project \
  --with httpx --with python-dotenv --with pyyaml \
   python ${PI_CONFIG_HOME}/skill-overrides/external-llm-review/reviewer.py \
  HEAD WORKTREE \
  --worktree . \
  --review-depth exhaustive \
  --review-round 1
```

## Fallback（仅限 push gate）

Push gate（`scripts/lib/review-invoker.mjs`）在拦截 `git push` 时自动尝试 3 个 provider：`idealab-anthropic → bailian → idealab-openai`，按序 fallback：超时/异常都会跳到下一个。全部失败则 fail-open（不阻断 push）。

直接 CLI 调用 reviewer.py 不走 fallback，单 provider 失败即报错退出。

## 轮次上限与穷举机制

外源 review **同一 diff 最多 2 轮**，不得为了追求 `Ready to merge: Yes` 无限循环。

### Round 1：穷举式横扫

默认调用即 Round 1：

```bash
uv run --no-project \
  --with httpx --with python-dotenv --with pyyaml \
   python ${PI_CONFIG_HOME}/skill-overrides/external-llm-review/reviewer.py \
  main HEAD \
  --review-depth exhaustive \
  --review-round 1 \
  --max-issues 25 \
  --spec docs/superpowers/specs/foo.md
```

Round 1 prompt 强制 reviewer：

- 不只报告 top 3，先枚举候选风险、归并同类项、再分级
- 按 checklist 扫参数/help 副作用、stdin/trap/cleanup、shell 兼容、错误诊断、幂等/回滚、输入边界、并发/缓存、测试覆盖
- 输出 `Checklist Coverage`，明确哪些维度已检查但未发现问题

### Round 2：只验修复与新增风险

只有当 Round 1 发现需要修改的 Critical / Important，且修复后验证全部通过，才跑 Round 2：

```bash
python ${PI_CONFIG_HOME}/skill-overrides/external-llm-review/reviewer.py \
  <BASE_SHA> <NEW_HEAD_SHA> \
  --review-depth exhaustive \
  --review-round 2 \
  --max-issues 25 \
  --spec bug-analysis.md
```

Round 2 只检查：

- Round 1 已修复项是否真正修好
- 修复本身新增的 diff 是否引入新失败模式
- 仍然直接阻断合并的 Critical / Important

Round 2 后如果仍有非 Critical 的 Important / Minor，由主代理按证据和项目上下文 triage；**不得默认跑第 3 轮**。只有用户明确要求继续外源 review 才允许第 3 次调用。

## 综合判断规则（拿到外源输出后必须做的）

外源评审**不能直接采信**。主代理须按下面 4 步消化：

1. **逐条比对**，列出三组：
   - (A) 双方都抓到
   - (B) 只外源抓到
   - (C) 只同族抓到

2. **对 (B) 外源独有项做 threat-model 校验**。外源倾向机械套用通用规则，常见误报：
   - 把开发者本机 CLI 工具的输入也当作不可信用户输入（路径校验 / 注入告警过严）
   - 一次性脚本的 subprocess 阻塞标 Critical（事件循环只有单 task 时无影响）
   - 误读累积 diff 把已修复的旧代码再标一次（要看 HEAD 实际状态）
   - 读 spec 后把未来 task 的代码（spec 提到但本 diff 没改）当成本 commit 范围问题打分
   - **只看 diff 没看完整源码**——看到 diff 里某集合"漏了"某项，就误报为 Critical

3. **对 (C) 同族独有项做"是不是同族盲点"反思**：是否涉及该模型族训练偏好（生态版本兼容、库 API 名）？

4. **综合后产出 fix dispatch**：把"双方都认可" + "任一方有真实 evidence" 的项打包给 fix subagent。

**严重度由证据决定，不由谁说了算**。不接受"仅外源说 Critical 就降级到 Important"或反之。

## Sandbox 与许可

⚠️ 代理 sandbox 可能拦截 `reviewer.py` 的执行——**理由是源码被 POST 到外部 endpoint 属于潜在 data exfiltration**。绕过方式：

### Claude Code

**A. 用户在终端直接跑**（最稳）：

```bash
uv run --no-project \
    --with httpx --with python-dotenv --with pyyaml \
    python ${PI_CONFIG_HOME}/skill-overrides/external-llm-review/reviewer.py main HEAD
```

把输出粘回主代理。

**B. 给 sandbox 显式授权**：在 `~/.claude/settings.local.json`（或项目级 `.claude/settings.local.json`）加：

```json
{
  "permissions": {
    "allow": [
      "Bash(uv run --no-project * python ${PI_CONFIG_HOME}/skill-overrides/external-llm-review/reviewer.py:*)"
    ]
  }
}
```

之后主代理可直接调用。

**只有当评审上下文允许把代码 diff 送出网关时才授权 B**。把这个 skill 用到任何新项目前，请确认目标 endpoint 与项目合规要求一致。

## 调用形态

```bash
uv run --no-project \
    --with httpx --with python-dotenv --with pyyaml \
    python ${PI_CONFIG_HOME}/skill-overrides/external-llm-review/reviewer.py \
    <BASE_SHA> <HEAD_SHA> \
    --worktree .
```

允许的 reviewer 路径形态：

- `${PI_CONFIG_HOME}/skill-overrides/external-llm-review/reviewer.py`
- `$PI_CONFIG_HOME/skill-overrides/external-llm-review/reviewer.py`
- `/Users/<user>/.../pi-config/skill-overrides/external-llm-review/reviewer.py` 这类绝对路径
- 在 `workdir` 为 `pi-config` 仓库根时，`skill-overrides/external-llm-review/reviewer.py` 相对路径

不要使用这些 shell 组合：`;`、`&&`、`||`、`|`、`&`、重定向、heredoc、`$()`、反引号、`eval`、`source`、`.`。这些形态会被 Codex hook 视为不安全命令，回落到普通审批或被拒。

如果确实需要一层 shell wrapper，只允许把完整 reviewer 调用作为单个 quoted 参数传入，例如：

```bash
/bin/zsh -lc 'uv run --no-project --with httpx --with python-dotenv --with pyyaml python ${PI_CONFIG_HOME}/skill-overrides/external-llm-review/reviewer.py main HEAD --worktree .'
```

## 实现要点

- 三个 provider 统一通过 `_config.py` 加载，返回一致的 `BaseProvider` 实例
- 每个 provider 的 `send_chat(client, messages, spec)` 封装协议差异（Anthropic 走 `/v1/messages`，其余走 `/chat/completions`；Bailian 强制 streaming 规避 300s 非流式硬超时）
- 统一 `asyncio.timeout` + `api_timeout_seconds` 硬超时
- 依赖：`httpx` + `python-dotenv` + `pyyaml`
- 系统提示固化在 `reviewer.py`：要求输出 Strengths / Critical / Important / Minor / Assessment
- 用户提示 = git diff + 可选 `--spec` 文本
- 失败时 stderr 打印诊断并退出非零
- Chat Completions 返回空 `message.content` 时退出非零，并打印 `finish_reason` / `reasoning_tokens` / `reasoning_content_len`，避免 reasoning 模型把 token 预算耗在推理区被误判为 review 成功
