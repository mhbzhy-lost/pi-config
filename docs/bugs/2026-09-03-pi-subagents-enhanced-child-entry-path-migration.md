# pi-subagents-enhanced 迁移后旧 Executor child entry 冲突

> 最终处置（2026-09-03）：旧 entry migration/materializer/lock 方案已淘汰。Executor child 现在直接接收 package 内 child extension 的绝对路径；acceptance evidence 由认证 child 通过 Root broker 写入绑定的 `asyncDir/acceptance-evidence/`。runtime 不读取、不写入、不迁移 workspace-local `.pi-subagents`，遗留路径只在 Git status pathname 过滤时被忽略。

## 现象

真实 `taoappuse` Pi Host（PID 23350，cwd `/Users/leshi.zhy/taoappuse`）已经从 `packages/pi-subagents-enhanced` 加载 runtime，Root broker socket 正常。四次 `delegate` 派发均能启动，但四次 `executor` 派发都在 child 注册前失败：

```text
SUBAGENT_RPC_FAILED: existing entry conflicts with requested runtime
```

项目中的 `.pi-subagents/root-session-owner-entry.mjs` 是 2026-08-27 创建的 0600 普通文件，内容精确为迁移前 wrapper：

```js
export { default } from "file:///Users/leshi.zhy/pi-config/pi/child-extensions/root-session-owner.ts";
```

旧 wrapper 当前仍以 default/named re-export 指向 package 实现；新 runtime 期望的 entry 只把绝对 target 改成 `packages/pi-subagents-enhanced/child-extensions/root-session-owner.ts`。

## 数据来源与分类

该异常属于 AGENTS 定义的第 1 类：**预期 production 数据未被正确处理**。

- 实际入口：真实 Host 的 public typed `subagent` executor 派发；
- 权威身份：PID 23350 的 cwd、package runtime、Root broker socket，以及项目内 0600 普通 entry 文件的 lstat 和精确字节；
- 事件与资源顺序：旧 runtime 在 8 月 27 日物化 wrapper entry；仓库迁移到 enhanced package；当前 Host 从新 package 启动；executor 的 `prepareCodingSpawn` 在 RPC 注册前重新物化同名 entry；字节中的绝对 target 改变导致冲突；
- 与 production 事实的差异：旧 entry 不是未知或恶意内容，而是上一个受支持 runtime generation 通过同一正式 materializer 生成的 canonical wrapper。新 runtime 没有声明这一条允许迁移的 predecessor。

`delegate` 不经过 executor child entry 物化，因此正常启动。这同时证明 broker/upstream 整体可用，失败边界位于 executor `prepareCodingSpawn`，不是 generic dispatch 或 Root broker 协议。

## 首个偏离点（历史）

首个偏离点是旧 runtime 在 child 启动前读取 workspace wrapper，并要求它与当前 target 完全同字节。T2 将 child extension 所有权迁入 package 后，合法旧 entry 与任意未知冲突被同样拒绝。

## 完整调用链

```text
真实 typed subagent(agent=executor)
  -> package createTypedSubagentExtension
  -> prepareCodingSpawn
  -> 旧 workspace wrapper 准备步骤
  -> canonical current target = packages/pi-subagents-enhanced/child-extensions/root-session-owner.ts
  -> 读取项目现有 0600 普通 entry
  -> entry 字节指向 pi/child-extensions/root-session-owner.ts
  -> matchingExisting 字节比较失败
  -> existing entry conflicts with requested runtime
  -> SUBAGENT_RPC_FAILED，child 未启动

typed subagent(agent=delegate)
  -> 不进入 executor prepareCodingSpawn
  -> 不物化 root owner / acceptance evidence entry
  -> 正常启动
```

Goal-bound executor 原先还会物化带 `identity` / `criteria` query 的 acceptance wrapper。最终方案同时删除两种 workspace wrapper，避免把 child identity 或 authority 编码进可变 URL。

## 被取代的迁移方案

- 不再生成 wrapper entry，也不再识别 predecessor、query 或 migration lock。
- Root owner 与 acceptance evidence extension 都由 workflow spawn 直接注入 package 内绝对路径。
- acceptance identity、criteria 与 workspace HEAD 只由 Root broker 的 durable authority 绑定，child 不从 URL query 或 cwd 构造权威事实。
- hostile 或陈旧 `.pi-subagents` 的文件类型、权限和内容不得影响 executor；runtime 也不得打开这些内容。
- 不修改或删除真实 `taoappuse` 遗留 entry，不对 PID 23350 或其 children 发信号。

## 验收

1. hostile legacy tree 存在时，真实 executor workflow 仍能启动并完成。
2. workflow child extension 参数只包含 package 内绝对路径，不包含 workspace entry。
3. legacy tree 的 inode、mode、mtime、ctime、大小和字节在派发前后完全不变。
4. acceptance evidence 只允许经认证 broker 写入绑定 `asyncDir`。
5. package verify、非 Goal runtime tests、Doctor 和 diff check 通过；真实 Host 与项目 entry 未变。
