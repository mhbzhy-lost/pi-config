---
name: external-llm-review
description: Use after implementation and before merge to review a diff or changeset, or when the user or project requires an independent, external, or cross-model reviewer.
---

# External LLM Cross-Model Code Review

## 用途

外部 LLM 代码评审用于补充同族模型可能遗漏的库 API 兼容、并发、安全和错误处理风险。所有模型家族统一首选 `idealab-anthropic`；它不可用时，使用异源 fallback `idealab-openai`。

## Provider 选择规则

当前运行时只支持两个 provider，按固定顺序选择：

| Provider | 模型 | 协议 | 凭据 |
| --- | --- | --- | --- |
| `idealab-anthropic` | `claude-opus-4-6` | Anthropic Messages API | `ANTHROPIC_API_KEY` |
| `idealab-openai` | `qwen3.8-max` | OpenAI-compatible streaming chat completions | `_config.py` 内部优先 Pi auth；不可用时使用非空的 `IDEALAB_OPENAI_API_KEY` |

Qwen 3.8 必须使用 streaming 请求，发送 `stream: true` 与 `stream_options.include_usage: true`。每个 SSE `data:` 负载是 JSON，`data: [DONE]` 结束流；分别聚合 `choices[].delta.content` 与 `choices[].delta.reasoning_content`，最终优先 content，仅在其为空时回退 reasoning_content。usage-only chunk 和空 `choices` 可忽略；error JSON 必须转为仅含白名单字段的脱敏异常。不要发送 `enable_thinking`，该参数对当前网关无效。保留 `max_tokens` 是网关兼容要求，但它不能关闭或严格限制 reasoning。

`pi auth print-api-key --provider openai-idealab` 只允许由 `_config.py` 以 `capture_output` 内部调用。该 resolver 优先使用 `PI_REAL_BIN`，未设置时 fallback 到 `pi`；代理和用户不得直接执行此命令排障。Pi auth 超时、不可执行、非零退出或空输出时，resolver 才回退非空 `IDEALAB_OPENAI_API_KEY`；两者都不可用时，仅报告 `idealab-openai Pi auth lookup <timeout|could-not-execute|nonzero-exit|empty-output>; IDEALAB_OPENAI_API_KEY fallback unavailable`，绝不包含 stdout、stderr、原始异常或凭据。

每个 provider 由 `providers/<name>.yaml`（非敏感配置）和可选环境变量组成。YAML 中以 `${VAR}` 引用环境变量，由 `_config.py` 在运行时插值；不得读取、打印或提交 `.env`、`auth.json` 或 API key。

## 配置与 Healthcheck

skill 位于 `${PI_CONFIG_HOME}/skill-overrides/external-llm-review/`。`PI_CONFIG_HOME` 是本项目的配置仓库根变量；Pi 官方配置根变量是 `PI_CODING_AGENT_DIR`。

首次使用或怀疑配置有问题时，可在已获授权访问 endpoint 的前提下运行：

```bash
cd ${PI_CONFIG_HOME}/skill-overrides/external-llm-review
uv run --script _healthcheck.py
```

healthcheck 只检查 `idealab-anthropic` 和 `idealab-openai`。成功固定输出 `[OK] <name>: reachable`，不得回显模型原文；配置无法加载时输出 `config load failed: <ExceptionType>`。无凭据导致当前配置加载失败时输出 `config load failed: RuntimeError`，内部 Pi auth reason 不对外显示。失败输出脱敏的失败类别或受限诊断字段，不得转发任意原始响应、stdout、stderr、原始异常或凭据。

## 用法

```bash
cd <repo-root>
uv run --no-project \
    --with httpx --with python-dotenv --with pyyaml \
    python ${PI_CONFIG_HOME}/skill-overrides/external-llm-review/reviewer.py \
    <BASE_SHA> <HEAD_SHA> \
    [--worktree PATH] \
    [--provider idealab-anthropic|idealab-openai] \
    [--spec docs/superpowers/specs/foo.md] \
    [--max-diff 80000] \
    [--review-depth standard|exhaustive] \
    [--review-round 1|2] \
    [--max-issues 25] \
    [--max-output-tokens 32768] \
    [--api-timeout-seconds 600]
```

**参数：**
- `BASE_SHA`：同族评审看的同一个 base。
- `HEAD_SHA`：实施后的 HEAD；传 `WORKTREE` 时审查 `git diff <BASE_SHA>`，包含当前未提交工作区改动。
- `--worktree`：默认 `.`；评 worktree 时填 `.worktrees/<task>`。
- `--provider`：默认从 `EXTERNAL_LLM_REVIEW_PROVIDER` 读；未设置时为 `idealab-anthropic`。
- `--spec`：把 spec 文件附给模型做对契约评审。
- `--max-diff`：diff 字符上限，默认 `80000`，避免网关 `413`。
- `--review-depth`：默认 `exhaustive`；快速 smoke review 才设 `standard`。
- `--review-round`：当前 diff 的评审轮次，只允许 `1` 或 `2`，默认 `1`。
- `--max-issues`：单轮最多报告的问题数，默认 `25`；同类问题归并为模式级 issue。
- `--max-output-tokens`：模型输出 token 上限，默认 `32768`。
- `--api-timeout-seconds`：provider API 调用外层硬超时，默认 `600`；设为 `<=0` 时使用底层默认超时。exhaustive review 可能需要数分钟，调用方外层 timeout 应高于 API hard timeout。

stdout 输出 review markdown（Strengths / Critical / Important / Minor / Checklist Coverage / Assessment），stderr 是诊断信息。

未提交工作区评审：

```bash
uv run --no-project \
  --with httpx --with python-dotenv --with pyyaml \
  python ${PI_CONFIG_HOME}/skill-overrides/external-llm-review/reviewer.py \
  HEAD WORKTREE --worktree . --review-depth exhaustive --review-round 1
```

## Fallback（仅限 Push Gate）

Push gate（`scripts/lib/review-invoker.mjs`）按 `idealab-anthropic -> idealab-openai` 依次尝试。超时、配置错误或请求异常都会尝试下一个；全部失败时 fail-open，不阻断 push。直接调用 `reviewer.py` 不走 fallback，单 provider 失败即非零退出。

有效 Git 仓库根目录可放置 `.push-gate.json`，内容为 `{ "bypassReview": true }` 时仅跳过异源评审，其他安全门禁仍会执行。Push gate 从有效执行 cwd 通过 Git 解析所属仓库根，只读取该根的配置；非 Git 目录、Git 解析失败、文件缺失、读取失败、JSON 非法或结构不符时均按 fail-closed 继续评审。`bypassReview` 必须是严格布尔值 `true`。该文件可随仓库分发，因此只应在自己信任的 Git 仓库中使用。

## 轮次上限与穷举机制

同一 diff 的外源 review 最多两轮，不得为了追求 `Ready to merge: Yes` 无限循环。

### Round 1：穷举式横扫

默认调用即 Round 1：

```bash
uv run --no-project --with httpx --with python-dotenv --with pyyaml \
  python ${PI_CONFIG_HOME}/skill-overrides/external-llm-review/reviewer.py \
  main HEAD --review-depth exhaustive --review-round 1 --max-issues 25 \
  --spec docs/superpowers/specs/foo.md
```

Round 1 必须：
- 不只报告 top 3，先枚举候选风险、归并同类项、再分级。
- 按 checklist 扫参数/help 副作用、stdin/trap/cleanup、shell 兼容、错误诊断、幂等/回滚、输入边界、并发/缓存、测试覆盖。
- 输出 `Checklist Coverage`，明确哪些维度已检查但未发现问题。

### Round 2：只验修复与新增风险

仅当 Round 1 发现需要修改的 Critical 或 Important，且修复后验证全部通过，才运行 Round 2：

```bash
python ${PI_CONFIG_HOME}/skill-overrides/external-llm-review/reviewer.py \
  <BASE_SHA> <NEW_HEAD_SHA> --review-depth exhaustive --review-round 2 \
  --max-issues 25 --spec bug-analysis.md
```

Round 2 只检查 Round 1 项是否真正修复、修复新增的 diff 是否引入新失败模式，以及仍直接阻断合并的 Critical 或 Important。Round 2 后的 Important 或 Minor 由主代理结合证据和项目上下文 triage；不得默认运行第三轮。

## 综合判断规则

外源评审不能直接采信。主代理须按四步消化：

1. 逐条比对，列出双方都抓到、只外源抓到、只同族抓到三组。
2. 对只外源抓到的项做 threat-model 校验。常见误报包括把本机 CLI 输入当作不可信用户输入、把单 task 的 subprocess 阻塞标为 Critical、误读累积 diff 中已修复代码、把 spec 中未来任务的代码当作本次范围，以及只看 diff 未看完整源码就断言集合漏项。
3. 对只同族抓到的项反思是否为同族盲点，例如生态版本兼容或库 API 名的训练偏好。
4. 综合产出 fix dispatch：双方认可的项，以及任一方有真实 evidence 的项，才打包交给修复任务。

严重度由证据决定，不由任何一方的结论决定。

## Sandbox 与许可

代理 sandbox 可能拦截 `reviewer.py`，因为源码 diff 会 POST 到外部 endpoint。可由用户在终端直接运行上述命令并提供输出，或在授权配置中精确允许 reviewer 调用。例如 Claude Code 可在 `~/.claude/settings.local.json` 或项目级配置中加入：

```json
{
  "permissions": {
    "allow": [
      "Bash(uv run --no-project * python ${PI_CONFIG_HOME}/skill-overrides/external-llm-review/reviewer.py:*)"
    ]
  }
}
```

只有当项目合规要求允许将当前 diff 发往获授权 endpoint 时，才可授予该权限。

## 安全调用形态

允许的 reviewer 路径形态：
- `${PI_CONFIG_HOME}/skill-overrides/external-llm-review/reviewer.py`
- `$PI_CONFIG_HOME/skill-overrides/external-llm-review/reviewer.py`
- `/Users/<user>/.../pi-config/skill-overrides/external-llm-review/reviewer.py` 等绝对路径。
- 当 workdir 是 `pi-config` 根目录时，`skill-overrides/external-llm-review/reviewer.py` 相对路径。

不要使用 `;`、`&&`、`||`、`|`、`&`、重定向、heredoc、`$()`、反引号、`eval`、`source` 或 `.` 组合 reviewer 命令。这些形态可能被 hook 视为不安全。需要 wrapper 时，只允许将完整 reviewer 调用作为单个 quoted 参数，例如：

```bash
/bin/zsh -lc 'uv run --no-project --with httpx --with python-dotenv --with pyyaml python ${PI_CONFIG_HOME}/skill-overrides/external-llm-review/reviewer.py main HEAD --worktree .'
```

## 实现要点

- 两个 provider 统一通过 `_config.py` 加载，返回一致的 `BaseProvider` 实例。
- `send_chat(client, messages, spec)` 封装协议差异：Anthropic 使用 `/v1/messages`，Qwen 3.8 使用 `/chat/completions` streaming。
- 统一由 `asyncio.timeout` 与 `api_timeout_seconds` 控制外层硬超时。
- 依赖为 `httpx`、`python-dotenv` 与 `pyyaml`。
- 系统提示固化在 `reviewer.py`，要求输出 Strengths、Critical、Important、Minor、Checklist Coverage 与 Assessment。
- 用户提示由 git diff 与可选 `--spec` 文本组成；失败时 stderr 只输出稳定异常类型、合法 HTTP 状态和严格字符、长度白名单内的 `code`、`type`、`param`、`request_id`，随后非零退出。
