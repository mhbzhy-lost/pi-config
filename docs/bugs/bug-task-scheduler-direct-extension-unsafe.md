# 问题：直接加载 `@amaster.ai/pi-task-scheduler` extension 不安全

- 状态：阻断直接接入
- 影响版本：`@amaster.ai/pi-task-scheduler@0.1.9`
- 依据：[精确 tarball 审查](../reviews/2026-08-17-pi-task-scheduler-cleanliness.md)

## 风险记录

直接由 Pi 加载上游 extension 会让第三方注册完整的 `/cron` 命令和 create/update/delete/run-now 工具；这些写入或执行入口没有 `ctx.ui.confirm`，也没有把批准人、任务、prompt hash、周期、工作区、工具策略和有效期绑定为可验证授权。已创建任务不能被视为永久授权。

上游设置可决定 `dataDir`，缺少 canonical containment、符号链接拒绝和仓库外状态根保证。任务状态含 prompt、历史及错误，目录和文件权限依赖 umask，不能保证 `0700/0600`。因此 prompt 可能进入仓库或被不应访问的同机用户读取。

上游 PID lock 先检查再无条件删除，且同 PID 可并存；没有随机 owner token、租约续期或 fencing generation。缓存式 JSON store 不会在跨进程读改写前重读，两个 Pi 进程可双活、丢写或重复派发。原子 rename 也没有 file/directory fsync，临时文件、合法但损坏的 JSON shape 与崩溃中间状态不能可靠恢复。

完成语义同样不安全：`sendUserMessage` 返回 void，上游却在消息提交后立即记录 success，未等待 `agent_settled`。崩溃、Agent 忙、工具失败和重试可造成已执行却标 interrupted、未执行却标 success，或重复执行。`run_now` 是 fire-and-forget，inactive、disabled 或后续失败时仍可能显示 “Triggered”。错误还可能被包装为普通文本，而非 tool error。

持久化 prompt 是延迟、不可信输入；上游没有敏感信息、prompt injection 或隐形 Unicode 扫描，也没有来源头。scheduled turn 未被限制为只读 allowlist，仍可能请求完整当前工具集。`/cron` 不经过现有 `tool_call` 门禁，构成旁路。

## 处置

不得直接加载上游 extension，也不得暴露其 `/cron`、update 或 run-now。仅在上游 package 全资源禁用后，由项目自有同进程 adapter 实现最小工具面、授权、受控存储、lease/fencing 和 `agent_settled` 状态。详见[架构契约](../architecture/task-scheduler-adapter-contract.md)。

## RED 摘要（待实现）

在未安装或声明 scheduler 依赖、且本地 adapter/store 尚不存在时，以下分片应有意失败：

| 分片 | 命令 | 预期 RED 原因 |
|---|---|---|
| package isolation | `node --test test/task-scheduler-package-isolation.test.mjs` | scheduler package 未在 settings/直接依赖中精确声明 |
| secure store | `node --test test/task-scheduler-secure-store.test.mjs` | 本地 `scripts/lib/task-scheduler/secure-store.mjs` 缺失或未实现契约 |
| adapter | `node --test test/task-scheduler-adapter.test.mjs` | 本地 `scripts/lib/task-scheduler/adapter.mjs` 缺失或未实现契约 |

这些测试只导入未来的本地模块、使用假 Pi 和临时目录；不会加载或执行第三方 extension。

### 已执行 RED（2026-08-17）

三条命令均由 Node test runner 成功加载测试文件（退出码 1 是预期 RED，而不是语法错误）：package isolation 报 `actual: undefined`，即 settings 尚未声明精确 scheduler package；secure store 报 `ERR_MODULE_NOT_FOUND` 指向本地 `scripts/lib/task-scheduler/secure-store.mjs`；adapter 报同一错误类别并指向本地 `scripts/lib/task-scheduler/adapter.mjs`。未安装、import 或执行任何第三方 scheduler extension。
