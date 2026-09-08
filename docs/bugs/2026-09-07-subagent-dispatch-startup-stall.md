# Subagent 同步派发停留在 starting 的问题记录

## 当前分类

来源尚未证实。用户曾在手动取消前约五分钟只看到 `starting`，但这不是 production dispatch 故障的充分证据。

## 实际入口与权威身份

同步 tool call 的可见 starting 文案来自 `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts` 的 `spawnStartingSummary()`。实际派发入口是 `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts` 的 `createTypedSubagentExtension().tool.execute()`；本次 trace 以该调用的 `toolCallId` 为权威关联身份，并由 RPC 请求的 `requestId` 显式关联，不从标题或时间邻近推断。

## 事件与资源顺序

入口先发现 agent，再执行 RPC ping。`spawnWorkflowLeaf()` 创建 leaf-start collector 后先 `await rpc.spawn()`，仅在 root handle 回复后才 `await collector.waitFor(root)`。RPC 默认超时是 5000ms；collector 默认最长等待是 120000ms（且受 execution timeout 约束）。首个可观测边界是 `tool-entered`，随后是 agent discovery、RPC ping/spawn、leaf wait 和 tool return/failure 的 phase trace。

此前一次取证 run 的超时来自调查过程进行无界 artifact 枚举；它不能作为 production dispatch 故障证据。本记录不引入 retry、fallback、伪造 started handle 或吞掉 timeout。后续仅使用调用方预先创建的 0600 regular trace file 与有界 probe 继续归因。

## T13 复核分类

手工通过 `pi.events.emit(agent_settled)` 制造的 lifecycle 是测试不可达数据：ExtensionRunner 不会把 lifecycle 投递到该 event bus，因此已只从测试/harness 移除，不增加 production 兼容。按路径 append 的 trace 文件替换和全文件 probe 读取则是 production 可达缺陷：sink 持有 `O_NOFOLLOW` fd，open 或 fstat 任一失败均关闭已取得的 fd；每次写入同时核对 fd 与路径 identity，替换、轮转或校验失败即停止。sink 属于 runtime owner scope，session shutdown、reload 和安装回滚都经真实 lifecycle dispose，且重复 dispose 幂等。startup probe 只尾读固定字节/记录/时间与输出预算，且必须匹配实际 `parentSessionId` 与 `toolCallId`；从中间开始的首行和末尾追加中的 partial line 均被报告并忽略，版本、phase、identity 与单调安全时间不合法时返回结构化 `unproven`。

## Host Smoke 分类

先前 smoke 的“未加载 subagent tools”由 test harness 环境污染造成：继承的 `PI_SUBAGENT_CHILD=1` 触发主 Host extension 的既有 child 早退语义。移除 `PI_SUBAGENT_CHILD` 和 `PI_SUBAGENT_FANOUT_CHILD` 后，受控真实 Host smoke 在项目配置目录下通过 5/5；package、trust 和 discovery 均正常。此结论不改变 child marker 的 production 语义，也不修改 settings、package 或 discovery 配置。
