# Bug：Root private revival 恢复 bootstrap tool ceiling

## 1. 现象

真实 flat Harness 的 task63w 在 HEAD `c9a73a2` 上一次完整 Root private revival 链后仍为 RED。初代
Plan Runner 与 revived Plan Runner 共两代，两个 generation 的输出均为
`PLAN_RUNNER_WAITING_LIFECYCLE`；`plan_open` 恰为 1，`plan_continue` 为 0，Executor 为 0，且没有
`status`、`validated` 或结果工件。持久化诊断依次记录一次 `followup.accepted`、`proof.accepted`、
`revival.started`、`resume.invoked`、`resume.succeeded`、`grant.issued` 与 `revival.succeeded`；第二代仅有
一次 `proof.accepted` 后因 `wake-missing` 被阻止，没有 generation storm。

因此 revival transport、授权 grant 与进程结束均已成功，业务 Plan 却没有在 revived generation 前进。
Harness 命令为 `PLAN_HARNESS_PRESERVE=1 PI_REAL_BIN=/opt/homebrew/bin/pi node --test
test/plan-flat-runtime-harness.integration.mjs`，因 Plan lifecycle 未进入 `validated`、`blocked` 或
`cancelled` 超时失败。task63w 已清理唯一 root，两个记录 PID 的 death probe 均为 `ESRCH`。

## 2. 触发条件与证据

初代 `plan-runner` frontmatter 明确只声明 `tools: plan_open,read,grep`。pinned
`async-execution.ts` 在启动 single async run 时，将 `agentConfig.tools` 写入
`recovery-descriptor.json`，同时以该配置创建 runner 的 launch tool plan。pinned
`async-resume.ts` 的 `applySteeringRecoveryAgentConfig()` 又将 descriptor 的 `tools` 原样恢复到 revived
agent 配置。

Capsule 在 `before_agent_start` 已执行 `setActiveTools(PLAN_ACTIVE_TOOLS)`，其中包含
`plan_continue` 等完整 Plan active tools；但这发生在 revived 进程已按 descriptor.tools 启动之后。进程
launch capability ceiling 仍只含 bootstrap 工具，provider 所见上下文因而有 bootstrap/history，却在
`toolNames` 中没有 `plan_continue`，再次返回 `PLAN_RUNNER_WAITING_LIFECYCLE`。

`c9a73a2` 只增强 deterministic provider 对 Root private wake 的识别。真实 Harness 仍 RED，证明这不是
私有 wake 消息文本未被识别或文本阻断。`7f64ce8` 已消除 consumed wake 导致的重装和 generation storm；
task63w 的两代单链证据也将该已修复问题与本 ceiling 缺陷区分开。

## 3. 根因

根因是 pinned async recovery descriptor 将启动时的 bootstrap `agentConfig.tools` 当作 revival 的完整
agent 配置持久化，并由 `applySteeringRecoveryAgentConfig()` 恢复。Plan Runner 的 bootstrap frontmatter
有意保持最小权限，待 Capsule 的授权边界激活完整 `PLAN_ACTIVE_TOOLS`；但是恢复路径错误地把这份
bootstrap 列表重新用作进程 launch capability ceiling。

Root Broker 当前调用 upstream `resume({ id, message })`，而 pinned RPC 的 `resumeParams` 仅转发
`id/message`。因此不能依赖 provider-visible message 或透传 RPC 参数传递提权信息；Root upstream facade
必须在调用 pinned `rpc.resume` 前消费可信的私有恢复信息，才能修改将被 resume 读取的 descriptor。

## 4. 修复边界

仅对 Root private upstream resume 增加 broker-trusted、模型不可见的 recovery metadata：`role`、`runId`
与 `asyncDir`。Root upstream facade 在调用 pinned `rpc.resume` 前，仅当 metadata 指向可信 Plan Runner
recovery descriptor 时，原子地将 descriptor 的 `tools` 设置为完整 `PLAN_ACTIVE_TOOLS`；随后从 RPC
params 剥离 metadata，并仍只以 `id/message` 调用 pinned rpc.resume。不得修改 `node_modules`，不得扩大
初代模型 active tools，且 `plan-runner.md` frontmatter 必须保持 exact bootstrap 列表。

安全校验必须 fail closed：`asyncDir` 的 realpath 必须是 `ASYNC_DIR` 的直属子目录且 basename 等于
`runId`；descriptor 必须是非 symlink 的普通小文件，且 `version`、`sourceRunId`、`agent` 均匹配。使用
private atomic JSON writer 重写。任一 realpath、文件、内容、匹配或写入校验失败时，不调用 `rpc.resume`
并保留 wake debt，不能把不可信路径、descriptor 或 metadata 作为恢复提权依据。

## 5. TDD 拆分

先建立三个独立 RED：RootBroker resume metadata 的 exact contract；Root upstream 对真实 descriptor 的
rewrite 且向 pinned RPC strip metadata；不可信 asyncDir、非直属路径、symlink/非普通文件或
version/sourceRunId/agent mismatch 时 fail closed。之后以最小实现使这些 focused suites GREEN，再执行
相关 Root Broker、upstream facade 与 Plan Capsule suites。

最后重跑真实 Harness，预期 private revival 在完整 launch ceiling 下调用 `plan_continue`，继续 Executor
调度并到达 `validated`，同时保持单次完整 revival 链且无 generation storm。文档记录的是生产修复前的
门禁，不包含 production、provider、Harness 或 migration 改动。

## 6. 验证与提交

本次为 docs-only 豁免，没有新增测试或 GREEN 产品实现；RED 证据为 task63w 的一次真实 Harness，退出
码 1、TAP 1 fail，原因是 lifecycle 未终态且上述六项业务计数未前进。提交仅包含本文件，提交信息为
`docs(bug): 记录 revival bootstrap ceiling`。

提交后必须执行 `git diff-tree --no-commit-id --name-only -r HEAD`，确认 HEAD 仅变更
`docs/bugs/bug-root-private-revival-restores-bootstrap-tool-ceiling.md`；执行 `git diff --check HEAD^ HEAD`
确认无空白错误；执行 `git diff --cached --quiet` 确认 index 为空。真实 Harness 在最小 GREEN 后仍须作为
最终验收运行；在此之前，残余风险是该已证实的 revival capability ceiling 继续阻断 Plan progression。
