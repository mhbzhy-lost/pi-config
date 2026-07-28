# DP3 MCP Skill Green Verification

## Scenario

查询 Event 155 的 inputSchema，并准备一次只读调用；不执行网络。

## Raw Response

> CLI 脚本已确认。以下是完整的只读调用准备方案，不执行任何网络操作。
>
> ```bash
> SKILL_DIR="/Users/leshi.zhy/pi-config/skill-overrides/dp3-mcp"
> CLI="$SKILL_DIR/scripts/dp3-mcp"
>
> bash "$CLI" list
> bash "$CLI" describe dp3-event-data-search
> # 根据 inputSchema 写入 /tmp/dp3-event-155.json
> bash "$CLI" call dp3-event-data-search /tmp/dp3-event-155.json
> ```
>
> 鉴权完全由 `tmcp` Skill 管辖。`dp3-mcp` 每次操作前静默执行 `um whoami`，失败时停止并指向
> `tmcp`；不接触 Token，不传自定义 header，不实现 fallback 登录。
>
> 每条命令独立打开并关闭一个 TMCP Streamable HTTP 连接，无常驻 daemon、连接池或跨调用状态。
> 默认环境为 `pre`，分页与时间窗在每次 JSON 请求中显式提供。

## Review Correction

上面的 Raw Response 是 Skill GREEN 场景原始输出，其中“独立打开并关闭”被后续源码审查判定为
过度声明。wrapper 只保证不保留跨命令状态，并把 transport lifecycle 委托给 `um tmcp client`：
正常成功路径会关闭；部分上游错误路径可能在 protocol close 前退出，远端等待超时回收。CLI 还会把
raw stdout 放入当前 model context，因此只能在请求侧排除敏感字段；无法排除时不得从 Pi 调用。

## Checks

- [x] 加载并遵循外部 `tmcp` Skill
- [x] 使用 bundled `dp3-mcp` CLI
- [x] 默认 `pre`，server 固定为 `tiga-ssot-dp3`
- [x] 输入来自绝对 JSON 文件
- [x] wrapper 无跨命令状态，lifecycle 委托给 `um tmcp client`
- [x] 明示 raw stdout 的 model-context 边界
- [x] 不复制或输出凭据

## Post-review Raw Response

> 已加载本地 `dp3-mcp` 和外部依赖 `tmcp`。本轮仅读取了本地文件，没有执行 `um`、
> `describe` 或 `call`，也没有发起网络请求。
>
> **查询 InputSchema**
>
> `inputSchema` 属于 `dp3-event-data-search` 工具，不是 Event `155` 单独拥有的 schema。因此不能把
> `155` 传给 `describe`。
>
> ```bash
> SKILL_DIR="/Users/leshi.zhy/pi-config/skill-overrides/dp3-mcp"
> CLI="$SKILL_DIR/scripts/dp3-mcp"
>
> # 默认查询 pre 环境
> bash "$CLI" describe dp3-event-data-search
> ```
>
> 只有明确需要其他注册环境时才指定：
>
> ```bash
> bash "$CLI" --env daily describe dp3-event-data-search
> bash "$CLI" --env prod describe dp3-event-data-search
> ```
>
> wrapper 会先静默执行 `um whoami`，再等价执行固定 server、`pre`、Streamable HTTP、
> `--describe --buc auto -f json --no-trace-id` 的 `um tmcp client call-tool`。
>
> **准备只读 Call**
>
> 在实际 `describe` 输出可用之前，禁止猜测 Event 标识字段是 `id`、`eventId` 或其他名称，也不能先
> 起草请求 JSON。拿到 `inputSchema` 后：
>
> 1. 按 schema 返回的准确字段表示 Event `155`。
> 2. 设置明确的分页和最小可用时间范围。
> 3. 使用 schema 支持的 projection 排除敏感字段。
> 4. 将参数写入不含凭据的绝对路径 JSON 文件。
> 5. 执行：
>
> ```bash
> REQUEST="/absolute/path/to/dp3-event-155-request.json"
> bash "$CLI" call dp3-event-data-search "$REQUEST"
> ```
>
> 不能使用 inline JSON，也不能自行传 headers、endpoint、stdio command 或 transport override。
>
> **Transport Lifecycle**
>
> 正常路径：wrapper 先做参数、工具名和绝对文件路径校验，静默运行 `um whoami`，随后使用 `exec`
> 启动唯一一个 `um tmcp client` 进程。每次命令新建独立 transport；当前 `um` 正常完成时关闭
> transport，然后退出。wrapper 不保存跨命令状态，不复用连接，也不增加 daemon 或连接池。
>
> 失败路径：transport 启动后的网络、协议或上游 provider 错误中，某些路径会在协议级 close 前直接
> 退出。本地进程结束，但远端资源可能等待超时，不能承诺失败路径确定性 close。401、403 或 Token
> 过期时停止调用并按 `tmcp` Skill 处理，不自行读取 cache、复制凭据或构造认证 header。
>
> **Raw Stdout**
>
> `um tmcp client` raw stdout 由 wrapper 原样转发；由 Pi 执行时会直接进入当前 model context，没有
> response sanitizer。schema projection 无法排除 `userId`、`utdid`、设备标识、IP/位置、session 或
> signed URL 时禁止 `call`，改用批准的 non-model consumer。
>
> success-only 且缺少 `data` 应报告为 provider 响应不完整，不能解释为空结果；也不能自动改用
> `dp3-event-data-sql` 查询 DP2 `wireless_mcap` view。

## Verification

- `test/mcp-skill-cli.test.mjs`: 12 passed
- Skill whitelist focused tests: 9 passed
- `bash -n`: passed
- Skill size: 472 words
- Network calls: none
- Independent review: 2 rounds; lifecycle, raw stdout, schema-guessing, and PII gates addressed
- Repository-wide gate: `npm test` did not produce a final summary because unrelated `plan-host-runtime.test.mjs` remained active past timeout; isolated run was 62/65 files, with all MCP/Skill files passing
