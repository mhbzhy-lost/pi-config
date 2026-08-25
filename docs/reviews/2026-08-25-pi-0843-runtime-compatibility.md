# Pi 0.84.3 候选 Runtime 兼容验收记录

- 验收日期：2026-08-25
- 候选包：`var/test-runtimes/pi-0.84.3/node_modules/@earendil-works/pi-coding-agent`
- 候选 bundled CLI：`dist/bundle/cli.js`；`--version` 输出精确 `0.84.3`。
- Node：`v26.5.0`。
- 所有 Pi Host 命令均设定 `PI_TEST_CODING_AGENT_ROOT` 为上述候选根，`PI_REAL_BIN` 为候选 `dist/bundle/cli.js`。
- 未执行全局 Pi 升级、`npm install -g`、`pi update` 或 `pi install`。

## 结果摘要

| 项目 | 退出码 | 计数/结论 |
| --- | ---: | --- |
| 单元测试 | 0 | 650/650 通过 |
| Doctor | 0 | readiness 通过；无 Pi 版本错误 |
| Pi RPC/Skill integration | 0 | 4/4 通过（含真实 Host provider fallback canary） |
| 三个真实 pi-subagents integration | 0 | 5/5 通过 |
| Goal Engine + worktree lifecycle 回归 | 1 | 1235 通过、9 失败（见下） |
| 全扩展离线 RPC `get_state` | 0 | 4 条 JSONL；`response.success=true`、`extension_error=0`、stderr 0 bytes |

## 实际命令与证据

```bash
CANDIDATE_ROOT="$PWD/var/test-runtimes/pi-0.84.3/node_modules/@earendil-works/pi-coding-agent"
PI_TEST_CODING_AGENT_ROOT="$CANDIDATE_ROOT" \
PI_REAL_BIN="$CANDIDATE_ROOT/dist/bundle/cli.js" \
  npm test
# exit 0；tests 650，pass 650，fail 0

PI_TEST_CODING_AGENT_ROOT="$CANDIDATE_ROOT" \
PI_REAL_BIN="$CANDIDATE_ROOT/dist/bundle/cli.js" \
  npm run doctor
# exit 0；Pi Skill allowlist 与 Root subagent broker ready

PI_TEST_CODING_AGENT_ROOT="$CANDIDATE_ROOT" \
PI_REAL_BIN="$CANDIDATE_ROOT/dist/bundle/cli.js" \
  npm run test:integration
# exit 0；tests 4，pass 4，fail 0

env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_FANOUT_CHILD \
PI_TEST_CODING_AGENT_ROOT="$CANDIDATE_ROOT" \
PI_REAL_BIN="$CANDIDATE_ROOT/dist/bundle/cli.js" \
  node --test test/pi-subagents-runtime.integration.mjs \
    test/pi-subagents-045-workflow.integration.mjs \
    test/pi-subagents-project-workflow.integration.mjs
# exit 0；tests 5，pass 5，fail 0

env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_FANOUT_CHILD \
PI_TEST_CODING_AGENT_ROOT="$CANDIDATE_ROOT" \
PI_REAL_BIN="$CANDIDATE_ROOT/dist/bundle/cli.js" \
  npm run test:goal-engine
# exit 1；tests 1244，pass 1235，fail 9
```

Subagent 首次按下列命令运行（exit 1；5 项中 2 通过、3 项被 `PI_SUBAGENT_CHILD` 顶层门禁阻断）：

```bash
PI_TEST_CODING_AGENT_ROOT="$CANDIDATE_ROOT" \
PI_REAL_BIN="$CANDIDATE_ROOT/dist/bundle/cli.js" \
  node --test test/pi-subagents-runtime.integration.mjs \
    test/pi-subagents-045-workflow.integration.mjs \
    test/pi-subagents-project-workflow.integration.mjs
```

父执行环境遗留的 `PI_SUBAGENT_CHILD` 是顶层 runtime 的 fail-closed 防嵌套标记，属于**测试制造的环境污染**，不是 0.84.3 兼容失败。仅在验收子进程中清除 `PI_SUBAGENT_CHILD` 与 `PI_SUBAGENT_FANOUT_CHILD` 后重跑，5/5 通过；未修改 production fallback。

Goal Engine 的 9 项失败均集中在 R10B amendment fixture：调用 `scripts/lib/goal-engine/extension.mjs:2275` 时被“需要 fully closed suspended runtime 且无 pending proposal”门禁拒绝。该路径由当前 worktree 中的并发 Goal Engine 改动触发，fixture 的前置状态与现行门禁不一致。按数据来源门禁分类为**测试制造/并发变更未集成**，尚无证据将其归因于 Pi 0.84.3；本任务不在该生产路径增加 fallback，也不将失败伪装为通过。用户已于 2026-08-25 明确授权本次 Pi 0.84.3 适配忽略这 9 个并发 Goal Engine 改造的既有失败；该范围例外保留全量结果 1235/1244，不将其归因为 0.84.3，也不宣称 Goal Engine 全绿。

```bash
printf '%s\n' '{"id":"state","type":"get_state"}' | \
PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 \
PI_CODING_AGENT_DIR="$PWD/pi" \
PI_CODING_AGENT_SESSION_DIR="$PWD/var/test-runtimes/pi-0.84.3/sessions" \
OPENAI_API_KEY=integration-test-not-used \
  "$CANDIDATE_ROOT/dist/bundle/cli.js" \
    --mode rpc --no-session --offline --provider openai --model gpt-4o \
    > var/test-runtimes/pi-0.84.3/rpc-smoke.jsonl \
    2> var/test-runtimes/pi-0.84.3/rpc-smoke.stderr
# exit 0；未发送 prompt
```

随后以本地 JSONL 解析断言：4 条记录、目标 response `success=true`、`extension_error=0`、stderr 为空（0 bytes）。占位值仅用于离线启动；未读取或记录凭据、完整 header 或 session 内容。

## 独立 fallback 评审与已确认语义

独立 fallback review 无 Critical、发现两项 Important：原 `session_compact_failed` mock 没有经过真实 Pi Host 事件派发；原 model mutation canary 没有经过真实 provider fallback 调用链。前者是测试制造的弱证据而非 production 缺陷，已移除该 mock 注入及其 checkpoint/recovery 断言，保留原有 compaction checkpoint 测试；不为 Goal Engine 增加 handler。

新增真实 Pi 0.84.3 Host provider fallback canary：以临时 `agentDir`/`configRoot`、真实 `DefaultResourceLoader`、`AgentSession` 与 `ExtensionAPI` 加载 production `createProviderFallbackExtension`。`session_start` 对不可达的 loopback primary 进行探测，并以本地 ephemeral loopback HTTP server 的 HEAD 204 响应证明固定 fallback `openai-codex/gpt-5.6-sol` 可达；真实 `pi.setModel` 后当前 session 模型切换到 fallback。`settingsManager.flush()` 后临时 `settings.json` 的 `defaultProvider/defaultModel` 仍为 primary，证明该 fallback 未持久化。测试仅使用 `not-used` 占位 auth，finally 关闭 server、dispose session 和删除临时目录；不访问外部网络。原 direct `AgentSession.setModel` persist canary 继续保留。

外部 idealab-anthropic 与 idealab-openai 均因 provider configuration `RuntimeError` 不可用；因此没有将内部独立 review 冒充 external review。

内部 Round 2 复核确认真实 provider fallback canary 已解决 Round 1 的调用链证据缺口，未发现 Critical；唯一 Important 是实现计划仍残留已撤销的 Goal mock canary。计划现已同步收窄为真实 provider fallback canary，并明确 `session_compact_failed` 不属于本次门槛。按两轮上限不再发起第三轮，协调 agent 已对该文档修正确认。

- Provider fallback 保持**仅当前 session**；不修改 production，也不持久化改写全局默认模型。
- Goal Engine 的 9 个既有失败与 `session_compact_failed` 的真实 production 事件派发链均不在本次 Pi 0.84.3 适配门槛；保留 1235/1244 和 9 失败事实，不将其伪装为通过。
- PowerShell 继续禁用，属于非目标；未来启用前须覆盖 Security Gates 与 Goal mutation gate。
- Doctor 的 worktree lifecycle warning 是既有工作树状态告警，虽然本次 Doctor 退出 0，但不是 0.84.3 通过证据，也不等同于兼容失败。

## 全局升级与 fresh Host 验收

2026-08-25 已通过官方 registry 执行精确全局安装：

```bash
npm install -g --ignore-scripts --registry=https://registry.npmjs.org \
  @earendil-works/pi-coding-agent@0.84.3
```

fresh `zsh -f` 与全局 npm 均报告 `0.84.3`，package bin 为 `dist/bundle/cli.js`。全局 Host 验收结果：

- `npm test`：650/650 通过。
- Doctor：退出 0；只有既有 worktree lifecycle warning，无版本错误。
- `test:integration`：4/4 通过，包含真实 provider fallback canary。
- 三个真实 Subagent integration：5/5 通过。
- 全扩展离线 RPC `get_state`：6 条记录，目标响应成功，`extension_error=0`，stderr 0 bytes。
- 当前默认 `openai-codex/gpt-5.6-sol` 以 `--no-session --no-tools` 执行低成本请求并精确返回 `OK`，未出现 `User-Agent` 拒绝。
- fresh PTY fullscreen smoke：进程退出 0，`DECSET 1049` 与 `DECRST 1049` 各精确一次。
- `pi/settings.json` 的 staged diff 只包含 `lastChangelogVersion: 0.84.2 → 0.84.3`；本机 `enabledModels` 保持 skip-worktree 且未进入 diff。

精确回滚命令：

```bash
npm install -g --ignore-scripts --registry=https://registry.npmjs.org \
  @earendil-works/pi-coding-agent@0.84.2
pi --version
```

## 残余风险与后续门槛

1. Goal Engine 全量套件尚有 9 个 fixture/并发变更失败；用户已明确批准其不阻塞本次升级。并发改动稳定后仍需以相同候选环境重跑，只有 exit 0 才可单独宣称 Goal Engine 全量 GREEN。
2. 当前默认 OpenAI Codex provider 已通过真实低成本请求；其他自定义 gateway 对 Pi `User-Agent` 的接受性未逐一验证。
3. 官方 external review 的 idealab-anthropic 与 idealab-openai 均因 provider configuration `RuntimeError` 不可用；已完成两轮内部独立 fallback review，并明确标注其不能替代外部 provider 评审。
4. 未读取或记录真实 `auth.json`、`models.json`、环境凭据或 session 内容；canary 仅创建并使用临时 `not-used` 占位 auth/models，未修改 `pi/models.json`，也未提交 `enabledModels` 变更。
