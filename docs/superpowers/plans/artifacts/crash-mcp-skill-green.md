# Crash MCP Skill Green Verification

## Scenario

查看 Crash MCP 工具并描述实例列表工具，不调用网络、不启动 crash 修复。

## Raw Response

> ```bash
> SKILL_DIR="/Users/leshi.zhy/pi-config/skill-overrides/crash-mcp"
> CLI="$SKILL_DIR/scripts/crash-mcp"
>
> bash "$CLI" list
> bash "$CLI" describe motu_querySimpleReportRecordPage
> bash "$CLI" call motu_querySimpleReportRecordPage /absolute/path/to/request.json
> ```
>
> 登录、BUC SSO、Token、`um whoami` 和 `um tmcp doctor` 由 `tmcp` Skill 独占；Crash 数据读取由
> `crash-mcp` 提供，底层使用 `um tmcp client` 的一次性会话。工具名与字段必须来自
> `list/describe`，不得凭历史记忆猜测。
>
> `crash-mcp` 只读查询元数据、实例、堆栈和趋势，不得启动 AIMI、修改代码或提交修复。用户要求
> “修复”真实 iOS crash 时切换到 `crash-analyzer-usage`，保留其 `worker_job_id`、两阶段人审、
> checkpoint 和 recovery 状态机。

## Review Correction

上面的 Raw Response 使用“一次性会话”但没有披露失败路径限制。wrapper 只保证不保留跨命令状态，
transport lifecycle 委托给 `um tmcp client`：正常成功路径会关闭；部分上游错误路径可能在 protocol
close 前退出，远端等待超时回收。CLI 还会把 raw stdout 放入当前 model context；若 schema 不能排除
PII 或 signed URL，就不得从 Pi 调用该工具，不能依赖模型看到结果后的事后投影。

## Checks

- [x] 加载并遵循外部 `tmcp` Skill
- [x] 使用 bundled `crash-mcp` CLI
- [x] 默认 `pre`，server 固定为 `tiga-ssot-crash`
- [x] 区分数据查询与 `crash-analyzer-usage` 修复
- [x] wrapper 无跨命令状态，lifecycle 委托给 `um tmcp client`
- [x] 无法排除 PII/signed URL 时禁止 model-visible `call`
- [x] 不复制或输出凭据

## Post-review Raw Response

> 已加载本地 `crash-mcp`、`tmcp` 和 `crash-analyzer-usage`。本次只读取本地文件，没有执行 `um`
> 或任何网络调用。
>
> **List / Describe**
>
> ```bash
> SKILL_DIR="/Users/leshi.zhy/pi-config/skill-overrides/crash-mcp"
> CLI="$SKILL_DIR/scripts/crash-mcp"
>
> bash "$CLI" list
> bash "$CLI" describe motu_querySimpleReportRecordPage
> ```
>
> 默认环境是 `pre`；只有用户或任务明确要求时才用 `--env daily|prod`。应先 `list` 获取当前 catalog，
> 再执行 `describe`。参数只能依据实时 `inputSchema` 构造，不能根据历史字段猜测。
>
> **Lifecycle**
>
> 正常路径：wrapper 校验参数、环境和工具名，静默执行 `um whoami`，随后通过 `exec` 启动一个
> `um tmcp client` 进程。当前 `um` 正常完成时关闭 transport 并退出；wrapper 不复用状态、连接或
> session，没有 daemon 或连接池。
>
> 失败路径：参数/环境错误以 `2` 退出；`um` 或鉴权不可用以 `3` 退出，均不启动 transport。上游错误
> 可能让 `um` 在 protocol close 前退出，远端等待超时，因此不能承诺失败路径确定性关闭。401、403
> 或 Token 过期由 `tmcp` Skill 处理，不能创建持久状态、手工 header 或 Cookie fallback。
>
> **模型与敏感信息门禁**
>
> `list/describe/call` raw stdout 会原样进入当前 model context；wrapper 没有 response sanitizer。
> 调用前必须用实时 schema projection 排除 PII、authentication material 和 signed URL。无法排除时禁止
> 从 Pi 调用，改用批准的 non-model consumer。敏感字段若意外出现，立即停止，不持久化、不引用、
> 不转述，并把该 call 视为 policy failure。success-only 且缺少 schema payload 是不完整响应，不是空集。
>
> **职责分工**
>
> `crash-mcp` 只负责真实 Crash locator 的只读证据查询，不得启动 AIMI、修改代码、提交修复或发布。
> `crash-analyzer-usage` 负责真实 Motu URL/`crash_id` 的修复，只能通过 `fix/status/submit/resume`
> 状态机推进并保留两阶段人审；不能用 `crash-mcp` 绕过。

## Verification

- `test/mcp-skill-cli.test.mjs`: 12 passed
- Skill whitelist focused tests: 9 passed
- `bash -n`: passed
- Skill size: 488 words
- Network calls: none
- Independent review: 2 rounds; lifecycle, raw stdout, query/fix split, and PII gates addressed
- Repository-wide gate: `npm test` did not produce a final summary because unrelated `plan-host-runtime.test.mjs` remained active past timeout; isolated run was 62/65 files, with all MCP/Skill files passing
