# 子代理派发 `rpc:v1/session` 协商失败：现代化后待查

## 状态与范围

用户报告其它会话派发时出现：

```text
CAPABILITY_NEGOTIATION_FAILED: pi-subagents RPC capability negotiation failed; missing: rpc:v1/session
```

**状态：静态 provenance 已记录；生产 provenance 未补齐，保持 fail-closed，不实施修复。**本次执行计划只完成非敏感静态 provenance；未取得报错会话的字段级启动 metadata，因此不把静态链升级为 production 结论，也不新增预防性兼容或放宽身份门禁。

只读诊断报告：`/tmp/pi104-rpc-session-capability-failure-provenance.md`，run `331934ba-0bd2-4963-9053-70f6bff971df`；本轮结构化记录：`docs/plans/records/2026-10-11-runtime-followups/rpc-provenance.json`。两者均为静态/字段缺失分析，未读取报错会话、真实 settings/session/authority，未运行 Host/RPC/模型/测试。

## 已知数据来源与首偏离

- 输入证据是用户观察到的工具错误字符串，不是本轮生成的 fixture；没有该会话实际 ping payload 或启动首个异常。
- 当前 Pi 四核心 `1.0.4`，pi-subagents `0.75.0`；报错会话实际加载版本与 session_start 结果仍未知。
- 错误字符串定位到 `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts` 的 `assertSpawnCapabilities(result, cwd)`，不是 `rpc-client.ts` 的另一种 negotiation 错误文案。
- 该断言检查 version、spawn 方法、sessionId、lifecycle session identity、session.cwd 及 cwd 相等性。**任意一个或多个条件不成立，都会追加同一个 `rpc:v1/session` 标签**；单标签不等于恰好只有一个条件失败。
- 在正常 typed 发送链中，该错误发生在 `rpc.ping` 返回之后，说明至少走到 session 断言；不等于 child 已启动，也不能仅凭 renderer 的 starting 文案证明整个初始化成功。

生产链：typed subagent execute → coding/generic admission → （可选 workspace 分配）→ rpc.ping → session/能力断言 → 返回 `failure(code, …)`。此次首个可观察偏离在 session 断言，但更早偏离点尚待现场证据定位。

## 静态对照结论

M00 task-before 与当前相关代码对照：

- dispatch `extension.ts` 的本轮变化为 M05B prompt metadata，不修改上述断言与派发逻辑。
- `extensions/subagent-runtime.ts` 的 M06 变化为 renderer 工厂提取，bootstrap/Root Broker/upstream session_start 接线不因该任务更改。
- `runtime-membrane.ts`、`title-registry.ts` 与 M00 副本一致；`rpc-client.ts`、compat 当前没有本轮修改。

**没有证据把这一报错归因为本轮协商逻辑修改或必然的半写入状态。**其它会话的加载时点、初始化错误与配置未知，因此不能绝对排除一切外部加载/世代问题。只读报告中“已确证排除所有中间态”的措辞不作为现场结论采用。

## 需要核实的候选机制

1. **上游 session context 未就绪。**上游 RPC bridge 在 factory 阶段注册；ping 的 session 块取自 `state.lastUiContext`，为空时返回 `{}`。本仓在 ready 流程内先启动自身 broker 等资源，再调用捕获的 upstream session_start。若前段失败，上游 context 可能尚未赋值。是否存在该异常必须取报错会话的启动首个错误证明，不能凭源码可能性当作既成事实。
2. **worktree 的 cwd 判定不一致。**当前断言期望 `workspace.originRoot ?? ctx.cwd`；上游 ping 回的是其保存的会话 cwd。若主会话从仓库子目录启动、originRoot 指向 Git 根目录，可能触发严格不等。须证明该次派发 `worktree:true`、实际两个目录事实及合法身份，才能判为本路径生产缺陷。
3. **运行中的旧 Host / 不同资源世代。**实际加载版本与进程启动时间未核实，只能保留为待查项。

## 现代化后待办

- [ ] 获取报错会话的非敏感首个启动异常、该次工具结果已有的错误 code/stage/missingCapabilities；不需要任务正文、凭据或完整 session。
- [ ] 核对主会话启动 cwd、Git root、该次是否 worktree 派发以及实际使用的 Host/Pi 版本。
- [ ] 按 public 入口、权威身份与事件顺序定位首个偏离，区分初始化失败、cwd 合同缺陷或其它来源；完成三类来源分类后才决定最小修复。
- [ ] 若当前单标签诊断不足，另行定义非敏感诊断字段与验证范围；不得预先替换或放宽 session/cwd/安全能力校验。

## 本轮 provenance 结论

- `sourceClass=unconfirmed`、`evidenceMode=static`；首个可观察偏离仍是 `assertSpawnCapabilities`，但 `rpc:v1/session` 是复合标签，不能确定单一失败条件。
- `ownerComponent` 为本仓断言函数，但 `ownerScope` 仍是“代码包含断言、production 根因未证实”；不能据此进入 production 修复。
- 下一步只有在取得非敏感 `stage/missingCapabilities/cwd/worktree/version/session identity` 投影后，才能区分 context 未就绪、cwd 合同或资源世代；完整 session、authority、凭据仍不需要也不得读取。

## 未执行事项

本轮未修 production、未加 fallback、未触发模型/真实 RPC、未重启其它会话或提交上游工单。现代化 M12 已在其授权范围内收口，本报错未作为真实流程验收载体。当前用户只授权文档化并提交/推送，未授权实际代码修复。
