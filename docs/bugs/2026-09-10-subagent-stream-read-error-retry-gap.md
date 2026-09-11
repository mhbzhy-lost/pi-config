# T14：`stream_read_error` provider stream 安全重试缺口

- 日期：2026-09-10
- 生产 provenance：pinned `pi-subagents@0.62.0` 的 detached background runner 启动 provider streaming child；provider stream reader 的具体产生位置尚未确认（unknown provider origin），现有 runner 收到精确 `stream_read_error` 后进入 terminal failure。
- 首个偏离点：只读确认首个偏离点在 model-fallback classifier/runner loop：`stream_read_error` 不属于 pinned `model-fallback.ts` 的 retryable patterns，runner loop 因而直接 terminal failure；不是 dispatch wrapper。整任务重派会重复 workspace/tool side effects，明确禁止。
- 根因边界：不能把未知来源的其他 stream 错误纳入宽泛 model fallback，也不能切换模型；恢复必须在 provider stream episode 内、同一候选模型上进行，并以首 token 前且无任何可见输出/usage/tool/mutation/control evidence 为门禁。
- 期望修复：最多三次 provider attempt（初次+两次），250ms/750ms abortable backoff；成功仅产出一次 logical completion，三次失败仅一次 terminal result。
