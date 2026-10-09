# resume 后展示标题丢失

## 来源分类：预期 production 数据未被正确处理（分类 1）

用户反馈 resume 后标题丢失。以下证据来自本仓公开入口与已安装的 `pi-subagents@0.75.0` 源码读取；未执行真实 resume、模型请求或读取真实 session。本文不记录业务 message 正文。

### 实际入口与生成调用链

1. 本仓 typed `subagent` 接受 `action: "resume"`、完整旧 runId（通过 `id` 或 `runId`）和非空 `message`。`src/subagent-dispatch/extension.ts` 的 `executeControl` 校验 message 后调用 `rpc.resume(params)`。
2. 本仓 `rpc-client.ts` 使用公开 `subagents:rpc:v1:request` / requestId 对应 reply 通道，不替换旧身份、不查询额外 status。
3. 上游 `src/extension/rpc.js` 的 `resumeParams`（约 423 行）校验并规范化合法 resume 请求；恢复入口进入 `src/runs/foreground/subagent-executor.js` 的 `resumeAsyncRun`（约 1535 行）。
4. 上游约 1821 行以 `randomUUID()` 创建新的 runId，交给 `executeAsyncSingle`。成功恢复回复保留其结构化 `details`，其中 `runId` / `asyncId` 为权威新身份。旧 runId 并不保证继续充当新执行的身份。

### 身份与事件顺序

- `executeAsyncSingle` 启动的新 run 可先发出 `subagent:async-started`，公开 resume RPC 的回复随后才到达。
- 该 started payload 不提供可用的旧 source runId/title 映射，不能按 agent 名或 pending 队列猜测并发 resume 的对应关系。
- display registry 是进程内全局、容量 256 的有界 Map，只服务展示，不是 lease、owner 或授权账本。

### 首个缺失点

原 `executeControl` 在 await 后直接 `rpcResult(reply)`，没有把旧 runId 已有标题延续到回复中的新 runId。现有 registry 标题关联主要发生在 spawn，resume 产生新身份后，后续 status、通知及 footer 按新 id 查询时丢失标题。当次 tool card 偶尔仍以旧输入 id 查到标题，不能证明新执行的映射完整。合法公开入口、有效身份与正常事件顺序即可触发，不是测试拼造数据。

## 最小修复边界

把闭包中已有 `titleRegistry` 传入 `executeControl`。仅在 resume 公开 RPC 非 error 回复后，从结构化 `details.runId`（优先）/ `details.asyncId` 获取非空新 id；旧输入按 `id ?? runId` 查询同一个 registry。只有旧标题存在且新 id 尚无标题时才 remember，新 id 已有标题不得覆盖；agent 优先沿用旧关联，其次采用结构化返回的 agent。

不修改 RPC 参数、原始 content/details/roles、模型 profile、权限或返回包装；不增加 status 请求、文件 I/O、事件、sender、自动恢复或身份账本。失败、缺少新 id、旧标题缺失均不绑定。前缀、别名及目录输入没有明确旧映射时继续使用既有展示 fallback，不推断身份。

提前 started 的短暂缺标题不通过伪造事件补偿；后续展示刷新查询 live registry 后可见映射。本修复不恢复跨进程重启、缓存淘汰后的标题，也不提供模型 fallback。代码需 fresh Host 加载后生效。

## 验证范围

只运行既有纯测试与 enhanced package 的一次 `tsc --noEmit`；不新增或修改测试，不采用 TDD/伪 RED，不运行真实恢复、Host/TUI/PTY、provider 请求或集成流程。具体命令、计数与退出码保存于 `/tmp/resume-title-final` 并在任务回执中列出。现有 dispatch 文件含两项 deep-import 上游 resolver 的 characterization，执行时通过 `--test-skip-pattern` 排除这两项，仅运行 fake API / fake RPC 用例。

实际验证使用 Node 26.8.1、`env -i`、自有合成 HOME/agent/XDG 与显式 `PI_TEST_CODING_AGENT_ROOT`（根 SDK 1.0.4）。dispatch 注册 36 项，排除 2 项后执行 34 项；title registry 执行 3 项。合计 37 项通过，0 失败，退出码 0；Node 26 的 TAP 不计入被 pattern 排除的两项，输出 `skipped 0`，不能将其视为两项通过。enhanced package `tsc --noEmit` 执行一次，真实退出码 0。未新增 resume 专项测试，未验证真实恢复与界面时序。
