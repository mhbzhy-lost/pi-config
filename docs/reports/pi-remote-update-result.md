# 远端更新结果与风险审查

记录时间：2026-11-03（本机时区 +08:00）  
任务：`dispatch-0a6de23c`  
诊断依据：[pi-provider-update-diagnosis.md](./pi-provider-update-diagnosis.md)

## 拉取与合入状态

本阶段先完整读取诊断报告，再检查工作区和 Git 并发状态。拉取前：

- 分支：`main`，跟踪 `origin/main`。
- `HEAD`：`779d466acbf1c359a6f9bd6c3c2b6085bc1c1190`。
- 本地 `origin/main`：`779d466acbf1c359a6f9bd6c3c2b6085bc1c1190`。
- 工作区没有已跟踪修改或暂存修改；`docs/reports/` 下保留现场的未跟踪诊断/迁移报告，并新增本结果报告，均未暂存。
- 未发现 `MERGE_HEAD`、`CHERRY_PICK_HEAD`、`REVERT_HEAD`、rebase 状态、`.git/index.lock` 或 refs 锁文件。
- 没有执行 stash、reset、clean，也没有读取凭据或模型配置。

实际执行：

```text
git fetch --no-tags origin refs/heads/main:refs/remotes/origin/main
```

fetch 成功，未修改工作区文件。拉取后上游固定为：

- `origin/main`：`b1e9d0fc4bf67c8587cca921aa2f8c3d8e4c0173`。
- `git rev-list --left-right --count HEAD...origin/main`：`0 2`。
- `git merge-base --is-ancestor HEAD origin/main`：退出码 `0`。
- 新增提交范围（按时间顺序）：
  - `bdd5bef9069d99696f04d15c433ca338e87ca4c8` `feat(subagents): coordinator 守护进程化与引用计数生命周期`
  - `b1e9d0fc4bf67c8587cca921aa2f8c3d8e4c0173` `feat(network-recovery): 增加断网兜底自动重连`

实际 diff 为 24 个文件、`1888 insertions(+), 578 deletions(-)`。未发现 `package.json`、`package-lock.json`、`pi/settings.json`、`pi/models.json`、`.gitignore` 或 `AGENTS.md` 的上游改动；未发现依赖版本或 npm registry 改动。由于下述 production 子代理边界风险，未执行 fast-forward 合入。

## 风险审查

### 阻塞：network-recovery 会进入 ambient child Host，可能自动唤醒已结束的子代理

远端新增入口 [pi/extensions/network-recovery.ts](../../pi/extensions/network-recovery.ts) 无 `PI_SUBAGENT_CHILD` 或 `PI_SUBAGENT_FANOUT_CHILD` guard，直接注册 [src/network-recovery/extension.ts](../../src/network-recovery/extension.ts)（远端文件第 43–211 行）。该状态机在 `agent_settled` 检测连接错误后排定 timer，并在第 106–117 行调用 `pi.sendUserMessage()`；第 188–203 行明确从 `agent_settled` 进入排定路径。

这不是仅凭缺少 guard 的推断。现场安装的 `pi-subagents` 代码提供了完整生成链：

1. `packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/background/subagent-runner.js:88` 在 child runner 进程设置 `PI_SUBAGENT_CHILD=1`。
2. `src/runs/shared/child-launch.js:199–225` 对 runner 默认设置 `ambientExtensions=true`，除非 tool plan 禁用 ambient extensions。
3. `src/runs/shared/child-session.js:401` 对 ambient child 使用 `noExtensions: !launch.ambientExtensions`，第 439 行执行 `loader.reload()`；因此 agentDir 下自动发现的 root extension 会加载进 child session。
4. child session 的 `session_start`、`agent_settled` 事件会被加载扩展接收，新增扩展的 `sendUserMessage` 调用没有经过 Root Broker 或 child 生命周期授权。

影响是：一个 managed coding child 或其他 ambient child 在连接错误后，可能在自身任务已经 settled、父级已收到终局或 worktree 生命周期已进入处置阶段时，由 30 分钟 timer 再提交一轮 user message。该行为可能绕过现有 child 结束与 Root Broker 边界，改变已结束 child 的运行语义。当前没有证据证明该入口在 child 中被显式排除；相反，上述 loader 证据证明其 production 可达。因此按任务合同停止合入，不修改远端代码。

### 中风险：detached daemon 继承主 Host 完整环境

远端 [packages/pi-subagents-enhanced/src/workspace/coordinator-spawn.ts](../../packages/pi-subagents-enhanced/src/workspace/coordinator-spawn.ts) 第 197 行使用 `spawn(process.execPath, args, { detached: true, stdio: "ignore", env: process.env })`。这会把主 Host 的所有环境变量复制到 detached coordinator daemon，包括可能存在的 provider 凭据环境变量。

当前证据显示该 daemon 是由主 Host 的 coordinator 路径拉起，直接执行 `coordinator-daemon.ts`，并在 [coordinator-daemon.ts](../../packages/pi-subagents-enhanced/src/workspace/coordinator-daemon.ts) 第 123 行创建内部 coordinator server，没有再次加载 Pi extension loader；因此暂未证明这是跨到更低信任 child 域的泄露。它仍扩大了 daemon 进程可见的敏感环境面，且远端 diff 没有白名单环境验证。该项作为残余风险记录，不单独作为当前阻塞理由。

### 中风险：旧 coordinator registration/lock 迁移依赖人工现场处理

远端 `coordinator-registry.ts` 删除了旧 `claim/release` owner 语义和旧 lock 协议，并把非 daemon metadata 在 audit 中分类为 `coordinator-legacy-registration`。远端新增计划文档明确说明旧机制不能与新 writer 在线混跑，需要停止旧 Host 后人工处理迁移现场。现有诊断报告记录过旧 yugang coordinator 现场，且远端计划自身将 F6 live 复核标为仍待用户重启。

因此即使没有 network-recovery 风险，fresh Host 之前仍不能把静态测试绿色等同于 live 迁移完成。当前没有看到远端自动删除本机 `pi/models.json` 等忽略配置，也没有看到直接覆盖 dirty 诊断报告的路径。

### 测试覆盖变化：既有 dead-daemon admission recovery 测试被删除

远端修改 [test/managed-workspace-coordinator-recovery.test.mjs](../../test/managed-workspace-coordinator-recovery.test.mjs) 时删除了“admission abandoned by a dead daemon is reissued with a new generation and rejects the old lease”测试，改为验证 idle snapshot 和 stale socket。该删除属于实际 diff，不能把远端计划文档声称的全量测试通过当作该具体行为已在本次版本继续覆盖。未自行新增测试或修复远端代码。

## 指令、入口、依赖、配置、TUI 与子代理边界检查

- 指令/进程入口：新增 daemon 使用 `process.execPath`、固定本地 `.ts` 入口和参数数组，没有发现 shell 拼接、`eval`、`sudo`、`rm -rf` 或命令注入；但存在 detached spawn 和完整环境继承，见上方风险。
- 网络入口：新增 `probeEndpointReachability()` 对当前模型 `baseUrl` 发 HEAD 请求，并在失败后调用 `sendUserMessage`；该行为属于新增自动网络/会话副作用，且在 child ambient Host 中可达。
- 依赖/锁文件：实际 diff 未修改 package manifest 或 lockfile。
- 敏感配置：实际 diff 未修改 `pi/settings.json`、`pi/models.json`、认证文件或 provider 配置；daemon metadata/log 代码未直接写 token，但 spawn 继承 env。
- TUI/raw payload：只新增 `ui.notify` 状态提示，没有发现为 TUI 改写 agent message、tool result、event payload 或结构化 details 的代码。
- 子代理边界：coordinator 请求仍通过 Host/Root Broker 连接；但新增 network-recovery 是 root 自动发现的 ambient extension，缺少 child guard，已构成上述阻塞风险。

## 验证证据边界

已运行：

- `git status --porcelain=v2 --untracked-files=all`：仅 `docs/reports/` 下的未跟踪报告文件，包含原有诊断/迁移报告和本结果报告。
- 并发状态标记与锁检查：无未完成 Git 操作或 Git 锁。
- `git fetch --no-tags origin refs/heads/main:refs/remotes/origin/main`：成功。
- `git rev-list --left-right --count HEAD...refs/remotes/origin/main`：`0 2`。
- `git merge-base --is-ancestor HEAD refs/remotes/origin/main`：通过。
- `git diff --stat/name-status/numstat HEAD..refs/remotes/origin/main`：确认 24 个实际变更文件和范围。
- `git diff --check HEAD..refs/remotes/origin/main`：通过。
- 远端 diff 危险模式扫描：未命中新增 shell 执行、eval、凭据字段、依赖变更或危险删除模式；扫描结果为空不能替代上述语义审查。
- 读取现场安装包 `pi-subagents` 的 child runner、child launch 和 child session 代码，确认 ambient extension 发现链和 `PI_SUBAGENT_CHILD` 来源。

未运行：

- 未执行 `git merge --ff-only`，因为 child ambient network-recovery 风险已证实并按合同阻塞。
- 未运行远端新增代码的测试或 typecheck；当前工作树仍是旧 HEAD，不能把旧 HEAD 的环境验证冒充远端版本验证。
- 未运行真实 Pi Host、provider 请求、网络恢复、coordinator daemon 或 live yugang 复核。
- 未读取凭据、未发起 provider 网络请求、未启动远端 daemon。

## 最终状态

- fetch：完成。
- fast-forward：未完成，阻塞事实为新增 root 自动发现 network-recovery 在 ambient child Host 中可达，并能在 `agent_settled` 后调用 `sendUserMessage`。
- 远端固定 SHA：`b1e9d0fc4bf67c8587cca921aa2f8c3d8e4c0173`，未重新拉取或移动。
- dirty 现场：保留；未 stash/reset/clean；诊断报告未被覆盖。
- 本报告及 `docs/reports/` 下既有报告均为未跟踪文件，未暂存。

## 第二轮：固定远端 fast-forward 与 network-recovery 主 Host 边界修复

记录时间：2026-11-03（本机时区 +08:00）  
任务：`dispatch-52b9e8eb`  
用户决策：network-recovery 应仅主 Host 生效；其余已接受的风险本轮不处理。  
本轮结论取代上一节“fast-forward 未完成”的状态；上一节保留为历史现场记录。

### 合入前核对

- `HEAD`：`779d466acbf1c359a6f9bd6c3c2b6085bc1c1190`，与任务预期一致。
- 固定目标 `refs/remotes/origin/main`：`b1e9d0fc4bf67c8587cca921aa2f8c3d8e4c0173`，未重新 fetch、未移动远端引用。
- `git rev-list --left-right --count HEAD...refs/remotes/origin/main`：`0 2`。
- `git merge-base --is-ancestor HEAD refs/remotes/origin/main`：退出码 `0`（严格祖先，可快进）。
- `git status --porcelain=v2 --untracked-files=all`：无已跟踪/暂存修改，仅 `docs/reports/` 下三份未跟踪报告（诊断、迁移结果、本报告）。
- 无 `MERGE_HEAD`/`CHERRY_PICK_HEAD`/`REVERT_HEAD`/rebase 状态/`index.lock`。
- 上游 diff 24 个文件，未触及 `AGENTS.md`、`skills/`、`package.json`、lockfile、`.gitignore`、`pi/settings.json`、`pi/models*.json`；`git diff --check` 干净。
- 忽略配置 `pi/models.json`（12.9K）与 `pi/models-store.json`（69.1K）存在且未被快进触碰。
- 提交规范：`skill-overrides/git-commit-convention/SKILL.md` 已在动手前核对，本轮无提交，规范未变。

### 实际合入

```text
git merge --ff-only b1e9d0fc4bf67c8587cca921aa2f8c3d8e4c0173
更新 779d466..b1e9d0f
Fast-forward
 24 files changed, 1888 insertions(+), 578 deletions(-)
```

合入后 `HEAD` = `b1e9d0fc4bf67c8587cca921aa2f8c3d8e4c0173`，工作区仅剩本轮边界修复的已跟踪修改与原有未跟踪报告；未 stash/reset/clean，未覆盖任何忽略配置。

### 精确修复（单点边界）

只改 [pi/extensions/network-recovery.ts](../../pi/extensions/network-recovery.ts)，`+8 -0`：

```ts
export default function networkRecovery(pi: ExtensionAPI): void {
  const isChildProcess =
    process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_SUBAGENT_FANOUT_CHILD === "1";
  if (isChildProcess) return;
  createNetworkRecoveryExtension(pi);
}
```

判定惯例取自仓库既有 root-only 入口的实际写法，四处同源：`pi/extensions/goal-runtime.ts:9`、`pi/extensions/agents-shared.ts:10`、`pi/extensions/agents-global.ts:12`、`src/session-owner/extension.ts:75`，均为 `=== "1"` 精确匹配两个 child 标记，不使用 cwd 或 prompt 自判。

env 语义只读核对：`packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/shared/child-runtime-config.js` 定义 `SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD"`，`src/runs/background/subagent-runner.js:88` 在 child runner 进程置 `1`，`src/extension/index.js:220` 以同一标记让 ambient 副本失效；`PI_SUBAGENT_FANOUT_CHILD` 是仓库 fanout child 的既有标记（`test/pi-subagents-runtime.integration.mjs`、`test/session-owner-install.integration.mjs` 等处以同一 `=== "1"` 语义使用）。guard 位置在 factory 入口最先执行，早于任何 `pi.on(...)` 注册、定时器排定与 `sendUserMessage`。

未改动的部分：未改 `src/network-recovery/**` 状态机、未改 provider/settings 配置、未修上一轮记录的其他已接受风险（detached daemon 环境继承、coordinator 旧注册迁移、被删除的 dead-daemon admission 测试）、未新增测试、未提交。

### 验证结果

1. 临时内存探针（`/tmp/network-recovery-guard-probe.mjs`，未入库、未启动 Host、未排真实定时器、`sendUserMessage` 被替换为抛错以禁止提交）：以假 `ExtensionAPI` 记录 `on()` 调用。

```text
main:        ["session_start","session_shutdown","turn_end","agent_start","agent_settled","input"]  (6 个 hook)
child:       []   (PI_SUBAGENT_CHILD=1)
fanout:      []   (PI_SUBAGENT_FANOUT_CHILD=1)
both:        []   (两个标记同时为 1)
childZero:   6    (PI_SUBAGENT_CHILD=0，非 "1" 不误伤主 Host)
PROBE_OK
```

即主 Host 正常注册，普通 child 与 fanout child 均零注册。

2. 静态检查：`npm run typecheck`（`typecheck:root` + `typecheck:subagents-enhanced`）通过。

3. 已有测试（`env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_FANOUT_CHILD` 下运行，模拟主 Host）：

```text
node --test test/coordinator-registry-lock.test.mjs test/managed-workspace-coordinator-recovery.test.mjs \
  test/wave2y-coordinator-broker.test.mjs test/extension-reload-boundary.test.mjs test/system-prompt-override-policy.test.mjs
ℹ tests 46  ℹ pass 46  ℹ fail 0  ℹ duration_ms 1961
```

未运行：真实 Pi Host / provider 请求 / network-recovery 真实 30 分钟定时器与探活 / coordinator daemon 与 live yugang 复核 / 全量 `npm test` 与 integration gate。`src/network-recovery` 在本次合入中没有任何自带测试文件，因此该入口的 guard 结论来自上面的内存探针，而不是上游测试。

### 仍需 fresh Host 的限制

- 已合入的 coordinator daemon 生命周期与旧 registration/lock 协议不能与旧 writer 在线混跑：必须先停止旧 Host，再由新 Host 处理迁移现场；静态测试绿色不等于 live 迁移完成。
- network-recovery 的 guard 只在 factory 阶段生效，实际效果需在新 Host 进程重启后确认（当前长驻进程仍运行旧扩展代码）。
- 未被本轮修复的已接受风险仍在：detached coordinator daemon 继承主 Host 完整 env；上游删除了 dead-daemon admission recovery 的旧测试覆盖。

### 本轮最终状态

- fast-forward：完成，`779d466..b1e9d0f`。
- 边界修复：`pi/extensions/network-recovery.ts` 主 Host 独占，`+8 -0`。
- 工作区：1 个已跟踪修改（本轮修复）+ 3 份未跟踪报告；暂存区为空；忽略配置未受影响。
- 提交：无。
