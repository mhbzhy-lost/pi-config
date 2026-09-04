# pi-subagents 热升级导致禁用 profile 阻断正常派发

## 现象

执行 `init-pi.sh` 将 `pi-subagents` 从 `0.45.2` 原地升级到 `0.62.0` 后，升级前已经启动的长生命周期 Host 中，合法的 typed subagent 派发在 child 启动前失败：

```text
Agent 'claude-code-writer' external-cli runner has unsupported fields: adapter.
```

失败并不表示模型选择了 `claude-code-writer`。两份 production session 中的实际 typed 调用分别显式指定 `agent="executor"` 和 `agent="delegate"`：

- `var/sessions/2026-08-26T09-44-44-844Z_01a03d75-2e2c-768a-a9ed-a7f16d39ddde.jsonl` 约第 3773-3800 行；
- `var/sessions/2026-08-20T03-52-55-175Z_01a01d4c-ea87-776a-9bbc-c77638df98a6.jsonl` 约第 2585-2589 行。

这两个 session 分别在 8 月 26 日和 8 月 20 日启动，在 9 月 2 日升级后派发时失败，且没有 child start 事实。失败集中在 11:22-11:25；用户随后终止旧 Pi，当前 PID 16319 启动于 11:38:13，11:43 和 11:48 的派发已经成功。因此没有“fresh Host 仍故障”的证据。

## 数据来源与分类

该异常属于 AGENTS 定义的第 1 类：**预期 production 数据未被正确处理**。

- 实际入口：项目 typed `subagent` 工具的公开 `executor` / `delegate` 派发入口；
- 权威身份：模型调用参数和 session transcript 均保留了请求 agent，错误发生前没有生成其他 child identity；
- 事件与资源顺序：旧 Host 已加载 `0.45.2` runtime，初始化脚本原地替换 package 后，该 Host 的正常 workflow start 创建 `[worker eval]:163`；终止旧进程并 `pi -c` 后，新 Host 创建当前 `[worker eval]:847` 并正常派发；
- 与 production 事实的差异：请求 agent 是 `executor` / `delegate`，报错中的 `claude-code-writer` 只是同一 package generation 中被扫描的另一个 profile，不能据此推断发生了选择或派发。

这些数据均来自正常 public/typed 入口、真实 package discovery 和正常 workflow 启动顺序，不是手工 projection、直接 append、缺字段 mock 或不可达 fixture。

## 首个偏离点

首个偏离点是初始化脚本允许在使用同一配置目录的旧 Host 存活时原地替换 runtime package。

`pi-subagents@0.45.2` 的 `parseAgentRunnerFrontmatter` 只接受 `type`、`command`、`args` 和 `promptDelivery`；`0.62.0` 的 `agents/claude-code-writer.md` 合法增加了 `runner.adapter`。旧 Host 保留 `0.45.2` parser，但 `init-pi.sh` 的 `pi install` / `npm install` 已把同一路径的 profiles 替换为 `0.62.0`，因此旧 parser 把当前 profile 的 `adapter` 误判为 unsupported field。

稍后的 `[worker eval]:847` 对 `codex-exec-writer` 返回当前 generation 的完整 discovery 报告：builtin 目录有 12 个候选，但 `disableBuiltins: true` 后可发现集合只有 `delegate` 和用户 `executor` 等 profile。这证明当前 parser/profile generation 已正常工作，也证明前面的错误不是当前 `0.62.0` parser 缺少 `adapter` 支持。

`0.62.0` 已在模块加载时缓存 builtin definition files；新 PID 的成功派发证明 fresh generation 自洽。当前没有证据支持重启后存在双 RPC bridge、stale worker 恢复或 `0.62.0` parser 缺陷，不能据此修改 RPC 协议。

## 完整生成调用链

```text
init-pi.sh
  -> pi install npm:pi-subagents@0.62.0
  -> npm run setup:subagent-runtime
  -> npm install --prefix pi/npm pi-subagents@0.62.0
  -> 原地替换 pi/npm/node_modules/pi-subagents

仍存活的旧 Host
  -> public typed subagent(agent=executor|delegate)
  -> 创建旧 [worker eval]:163 workflow worker
  -> workflow start preflight / agent registry discovery
  -> 0.45.2 parseAgentRunnerFrontmatter
  -> 读取 0.62.0 agents/claude-code-writer.md（磁盘）
  -> runner.adapter 被误送入旧 unsupported-fields 校验
  -> child start 前整体失败

终止旧进程并 pi -c 后
  -> 当前 generation [worker eval]:847 消费请求
  -> 正常解析 12 个 builtin candidates
  -> disableBuiltins 过滤后仅暴露 delegate 等允许项
```

## 修复边界

- 初始化入口在 `PI_ROOT_SUBAGENT_BROKER_ENABLED=1` 证明当前 root subagent runtime 活跃、且 installed/target package 跨版本时，必须在任何安装动作前 fail closed，避免制造 parser/profile 混代；`PI_CODING_AGENT_SESSION_DIR` 只是常驻路径配置，不能作为 active 证据；
- 错误必须明确说明需要从该 Host 外执行升级并在升级后使用 fresh Host；同版本的幂等初始化和 fresh installation 不受影响；
- 当前 Host 继续加载完整 `0.62.0` profiles，不能删除、隐藏或降级 `claude-code-writer`，也不能为旧 parser 增加宽松 fallback；
- 不修改 `pi/models.json`，不提交 `pi/settings.json` 的 `enabledModels` 变化，不使用 Goal Engine。

### 剩余边界

脚本可以权威识别当前 Pi root runtime 派生的 shell，因为 broker-ready marker 会被子进程继承；但 macOS/Linux 上没有可移植且能证明“某个任意进程正在使用同一 `PI_CODING_AGENT_DIR`”的全局进程查询接口。若从普通外部 shell 执行更新，同时另一个独立 Pi Host 仍在使用该配置目录，preflight 无法可靠识别它。此路径必须由操作者先结束其他 Host；不能用进程名、session 文件时间或 PID 猜测代替权威身份。

## 验收

1. RED 证明：session 内从 installed `0.45.2` 升级到 target `0.62.0` 时，当前 setup 仍会执行 uninstall/install。
2. GREEN 后跨版本 session 内升级在第一个 package mutation 前拒绝；同版本幂等初始化仍执行。
3. fresh `0.62.0` Host 可发现正常 agent，且不会出现 `claude-code-writer ... unsupported fields: adapter`。
4. 聚焦测试、相关 integration 和 Doctor 通过。
