结论：**计划方向可保留，但建议修订后再执行：1 项 blocker、2 项 high、4 项 medium。** sidecar、公开 child extension 与 native renderer 能构成本仓闭环，无需引入 socket 或修改上游；当前主要缺口是身份合同与最终对账尚未真正闭合。

1. **blocker｜把 parent sessionId 当成 child sessionId，会拒绝合法快照。**

   **路径：** [计划:26](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-subagent-detail-live-partial.md:26)。

   **证据：** [session-browser.ts:230](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/tui/session-browser.ts:230) 从 async-started 保存 `sessionId`，`:294` 又将 `run.sessionId` 放入 BrowserChild；上游 [async-execution.js:2095](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/background/async-execution.js:2095) 发出的值是 `ctx.currentSessionId`，即 parent 身份。child 的 `ctx.sessionManager.getSessionId()` 是另一个 UUID。typed root/leaf 也用这个 parent 身份确认关联。

   **影响：** 按计划要求直接匹配 browser sessionId，普通与 typed/Goal 都可能完全看不到 partial。

   **最小修正：** 明确分开 parent 所属关系与 child session 身份：browser 负责确定目标 `sessionFile`，child UUID 从该受信 native session 的 header 校验，不能覆盖 BrowserChild 原有 `sessionId`。当前 [session-manager.js:785](/Users/leshi.zhy/pi-config/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:785) 已在 user 消息出现时落盘，因此首条 assistant 流式期间通常已有 header；缺 header 时明确暂缓接受。

2. **high｜“message_start 序号 + timestamp”没有对应的持久身份，最终去重仍是未解决项。**

   **路径：** [计划:43](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-subagent-detail-live-partial.md:43)、[计划:78](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-subagent-detail-live-partial.md:78)。

   **证据：** [session-manager.js:827](/Users/leshi.zhy/pi-config/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:827) 在 append 时另行生成 entry ID，未保存 extension 本地序号；[native-conversation.ts:143](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/tui/native-conversation.ts:143) 又将 entry 转为 context message，丢失普通消息的 entry 身份。与此同时，[runner.js:864](/Users/leshi.zhy/pi-config/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:864) 允许后续 message_end handler 替换同 role 消息，timestamp、正文均不能作为强身份保证。

   **影响：** fork 历史、retry/context omission、扩展 replacement 下，可能重复显示 final 与 ended，或错误抑制消息。T0 先冻结 codec、T2 才解决对应关系，会造成返工。

   **最小修正：** 将持久对账合同前移到 T0：使用公开 `getLeafId/getBranch/getEntry` 建立可核验的 entry 关联，并保留 native entry 元数据。公开 [TurnEndEvent:827](/Users/leshi.zhy/pi-config/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:827) 已有 `messageEntryId`，可以补证；但工具执行期间不能仅等待 turn_end 才去重。明确只处理 assistant 生命周期，冻结跨 retry、replacement 的规则后再开始 T1。

3. **high｜两个文件分别原子，并不保证组合视图一致；计划缺少读取顺序。**

   **路径：** [计划:29](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-subagent-detail-live-partial.md:29)、[计划:78](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-subagent-detail-live-partial.md:78)。

   **证据：** 当前 [footer-runtime.ts:535](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/tui/footer-runtime.ts:535) 先读取 native。上游 [agent-session.js:752](/Users/leshi.zhy/pi-config/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:752) 按 extension → subscriber → appendMessage 执行；计划允许下一条 message_start 覆盖旧 ended。

   **影响：** 若 parent 先取得尚无消息 A 的 native 快照，随后 child 落盘 A 并发布消息 B 的 partial，parent 再读 sidecar，会组合成“旧历史 + B”，此前可见的 A 短暂消失。仅按身份去重不能修复这一空洞。

   **最小修正：** 明确“先捕获 sidecar，再读取/检查 native”的组合协议，并用上一条持久 entry 锚点验证衔接；明确最终消息已经存在时也必须抑制滞后的 **streaming** 快照，不能只处理 ended。在既有测试中加入跨文件读取期间 A→B 切换的受控 barrier。

4. **medium｜50ms/25ms 可实现，但目前只约束队列，没有约束实际刷新成本。**

   **路径：** [计划:42](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-subagent-detail-live-partial.md:42)、[计划:60](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-subagent-detail-live-partial.md:60)。

   **证据：** [presenter.ts:245](/Users/leshi.zhy/pi-config/src/background-activity/presenter.ts:245) 将任意 source invalidation 送入详情；[detail-controller.ts:394](/Users/leshi.zhy/pi-config/src/background-activity/detail-controller.ts:394) 即使所选 key 未变，也重取当前详情。native 的 [invalidate():112](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/tui/native-conversation.ts:112) 会清空整个 session 缓存。

   **影响：** 多 child 可放大全局刷新，连当前选中的 bash/scheduler 详情也会重取；若 partial 更新调用现有 `invalidateNative()`，长历史将反复复制、解析。异步文件 IO 本身也不能消除完整 JSON 序列化的同步 CPU 成本。

   **最小修正：** 冻结单个在途写入、一个最新待写值、固定窗口而非 trailing debounce；watch 过滤目标文件并在 runtime 层统一合并。partial 更新只失效 partial/详情行缓存，保留 native 历史指纹缓存。T3 补充长历史下 session open/snapshot 次数、写入次数及非选中 child 的刷新计数；暂不改通用 controller。

5. **medium｜支持范围还应包含 trusted roots 条件，不能等同于“本地且有 sessionFile”。**

   **路径：** [计划:17](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-subagent-detail-live-partial.md:17)。

   **证据：** [footer-runtime.ts:324](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/tui/footer-runtime.ts:324) 的 native roots 仅来自 parent session 目录和 `PI_CODING_AGENT_SESSION_DIR`；上游允许独立 `sessionDir/defaultSessionDir`，见 [subagent-executor.js:7233](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/foreground/subagent-executor.js:7233)。parent 无持久 session 时，上游还会另建临时 child session 根。

   **影响：** 部分合法的本地持久 child 仍不在现有受信根内，无法获得所承诺的实时显示。

   **最小修正：** 首版范围写为“browser 已定位且处于现有 native trusted roots 的本地持久 child”，其余沿既有行为回退。不要因为 sidecar 自报路径或 status 路径而扩大信任根。

6. **medium｜T3 的测试文件真实，但现有 fixture 不能直接提供要求的分时流式证据。**

   **路径：** [计划:90](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-subagent-detail-live-partial.md:90)。

   **证据：** [subagent-activity-provider.test.mjs:66](/Users/leshi.zhy/pi-config/test/subagent-activity-provider.test.mjs:66) 使用 fake Host 和手动 interval；native 测试主要读取已完成 session。现有 [joint-upgrade-session.mjs:43](/Users/leshi.zhy/pi-config/test/helpers/joint-upgrade-session.mjs:43) provider 同步推送 start、delta、done，没有三次间隔更新。

   **影响：** 只手调 extension handler 或手写 sidecar，可能通过测试却遗漏真实 SDK 的替换/持久化顺序；同步一次性 provider 也无法证明至少两次 end 前显示。

   **最小修正：** 指定在一个现有测试文件内建立带 barrier 的内存 provider，通过真实 SDK 驱动 extension，保持 `parent UUID ≠ child UUID`，并接上真实 fs.watch 与详情组件。明确 detached 边界由哪个既有文件承担。raw 不变的验证应比较“观察器有无引入额外修改”，不能把正常 message_end 落盘误判为违规。

7. **medium｜T0 声明追加调查文档，但该文档未列入 WritePaths。**

   **路径：** [计划:34](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-subagent-detail-live-partial.md:34)。

   **证据与影响：** 下一行明确要求调查报告“追加章节”，而 T0 写路径只有两个新增实现文件、extension 和测试文件。按当前边界执行会遇到越界阻塞。

   **最小修正：** 删除追加要求，把调查报告作为只读依据，验证结论集中写入 T3 summary；或者明确补入 T0 WritePaths。前者更省收尾成本。

已核实：required 注入确实可复用 [extension.ts:2591](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:2591) 的同一注册数组；external 不强制加载的边界成立。两个新增实现路径及 summary 尚不存在，但父目录均存在，属于合理待建产物；四个测试文件均真实。T0→T1→T2→T3 串行 DAG 无环，主要应前移身份与对账决策。现有组件替换已经能打破 source width 缓存，因此首版不必再引入组件长期保留机制。

本次仅只读审阅，未修改文件、未启动 provider、未运行测试或性能测量。工作树存在其他工作的未提交变更，Git index 为空；延迟、跨进程资源清理和故障回退仍需实施后的实测。