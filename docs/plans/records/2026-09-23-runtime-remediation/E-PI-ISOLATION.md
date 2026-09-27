# E-PI-ISOLATION：设计可终止的真实 Pi 隔离探针

**状态：BLOCKED（本节点只读探索；未运行 attention lane）**

## 范围、证据边界与 TDD 豁免

本节点消费统一 DAG 的 E-PI-ISOLATION、`E-PI.md`、`P-HARNESS.md`，并只读核对：

- `test/pi-subagents-runtime.integration.mjs`：普通 `complete` 与 `attention` top-level RPC 场景、测试自身的 `runRpcUntil`、临时 project/package/runtime 目录及 fixture cleanup；
- `test/subagent-runtime-root-broker-startup.integration.mjs`：真实 Pi 启动参数、session/agent/TMP 配置与仓库 cwd 绑定；
- `test/helpers/pi-runtime.mjs`、`test/helpers/pi-host.mjs`：临时 Git repository、Host package/Jiti 路径解析及 Host identity 约束。

本次**没有**读取或修改 `var/workspaces`、live Host/live coordinator；没有在当前仓库 cwd 启动真实 Pi；没有重跑 `test:subagents` 或 attention 测试，也没有执行 git mutation。输出只有本文件。依据 `test-driven-development` Skill，本节点是纯文档/证据记录，属于明确的纯文档 TDD 豁免：不修改 production、测试、配置或 Skill 行为，故没有可先写的 RED/GREEN；后续 harness coding 必须恢复 RED→GREEN。

## 已有真实证据与首个不可观察点

### 普通 RPC：窄子集通过

E-PI 的现有证据是 `test/pi-subagents-runtime.integration.mjs` 中 `runScenario("complete")` 的真实 Pi RPC 子集：普通真实 Pi RPC 子集 exit 0，约 2.35 秒。它证明的是：在当时测试构造的临时 `projectRoot`/`runtimeTmp` 下，top-level RPC 能 dispatch executor、观察 terminal status/output 并完成。该证据不等价于 Root Broker startup 或 Supervisor transport 通过。

该测试的具体边界包括：`cwd` 为测试临时 project，`PI_CODING_AGENT_DIR` 仍由测试环境传入，fixture provider/extension 路径从仓库解析；`runRpcUntil` 只在观察到 `COMPAT_PARENT_DONE` 或 `COMPAT_PARENT_PENDING_MISSING` 后关闭 stdin，并仅对顶层 child 设置计时器。因此它不是完整的进程组终止证明。

### attention：45 秒超时，不能归因 production

现有 attention lane 在 45 秒有界运行中超时，并曾残留测试子树；残留已由既有记录说明并清理。本事实只证明该测试入口未在预算内得到预期结束/完整 exit 结果，首个可观察缺口位于 attention 的 Supervisor 等待/恢复完成之前（测试期望 `subagent_supervisor` reply、`contact_supervisor` 状态与最终 `COMPAT_PARENT_DONE`）。它不证明 production Root Broker 或 Supervisor transport 的根因，也不能宣称 transport 已通过。

测试实现的局部清理（`t.after`/`finally` 删除 package、project、runtime 临时目录）不等于子进程组清理；当 Pi、jiti 或 child 仍活着时，目录清理也不能作为终止成功证据。超时应分类为环境/测试 harness 可终止性未验证，不能直接归为 production 缺陷。

### startup：仓库 cwd 会 scope mismatch

`test/subagent-runtime-root-broker-startup.integration.mjs` 当前以 `cwd: repoRoot` 启动 Pi。它设置临时 `PI_CODING_AGENT_DIR`、`TMPDIR` 和 sessions，但仓库 `.git/.pi-coordinator` 仍是 workspace coordinator 的 live 权威元数据来源；在仓库 cwd 使用临时 state root 时，已有证据出现 state-root/scope mismatch。因此该结果不应作为隔离 startup PASS，也不能通过“只换 TMPDIR/agent”解决。

`createIsolatedHostRepository()` 只创建临时 Git repository；它是后续可复用的 cwd 起点，但要把 origin、工作树、state root、session、agent、HOME/XDG/TMP 全部纳入同一 fixture，且在启动前证明 cwd 的 `git-common-dir` 不属于仓库 `.git`。无法证明新进程不会发现或连接 live coordinator 时，必须保持 BLOCKED 并跳过真实 attention。

## 下一步可执行的隔离测试契约

### 1. Fixture 与身份绑定

后续 harness 只允许由测试 fixture 创建如下临时根 `root`，所有路径必须是 `root` 的后代；测试不得读取旧 Host 或旧 workspace：

```text
root/
  origin/       # bare Git origin，由 fixture 初始化
  cwd/          # 从 origin clone 的独立工作树；Pi 的唯一 cwd
  state/        # PI_CODING_WORKSPACE_DIR 或等价 durable state root
  agent/        # PI_CODING_AGENT_DIR；包含本次 fixture 的 agents/config
  home/         # HOME
  xdg-config/   # XDG_CONFIG_HOME
  xdg-data/     # XDG_DATA_HOME
  tmp/          # TMPDIR
  sessions/     # Pi session-dir
  logs/         # launcher stdout/stderr/终止记录
```

fixture 必须：

1. `git init --bare root/origin`，在临时 clone/cwd 写入并提交最小基线；以 `git -C cwd rev-parse --show-toplevel`、`--git-common-dir`、`git remote get-url origin` 记录**脱敏后的相对关系**，断言 toplevel 是 `root/cwd`、common-dir 不等于仓库 `.git`、origin 指向 `root/origin`。
2. 启动前断言 `cwd/state/agent/home/xdg-config/xdg-data/tmp/sessions` 均在 root 内；禁止把 repoRoot、`var/workspaces`、旧 `PI_CODING_AGENT_DIR`、真实 HOME/XDG/TMP 作为 fallback。
3. Host 权威 identity 使用真实 Host API 解析的 session identity；不得从 session 文件名、路径 basename 或手工拼接值冒充 identity。探针应从 Host 暴露的 session/agent identity 记录中取得值，并断言它与本次 fixture session 相等且不等于父进程继承的 `PI_SUBAGENT_*` identity。
4. 测试 fixture 中的 agent manifest、deterministic provider、runtime/registry probe 只从已知 package 路径解析：`repoRoot/test/fixtures/deterministic-provider.mjs`、`packages/pi-subagents-enhanced/extensions/subagent-runtime.ts` 及既有 `resolvePiHostPaths()` 返回的公开 package entry。路径可绝对传给子进程，但报告不得输出完整敏感路径、token、run/session identity。
5. 启动环境从清除后的基线构造：去除 `PI_SUBAGENT_CHILD`、`PI_SUBAGENT_FANOUT_CHILD`、`PI_SUBAGENT_PARENT_SESSION`、run/orchestrator identity 和 broker enable 开关，再显式设置上述临时 HOME/XDG/TMP/agent/state/session。`OPENAI_API_KEY` 仅使用 fixture 明确的未使用占位，不输出环境值。

**隔离阻断门：** 启动前若 `git-common-dir`、state root、coordinator socket 所在根或任何 Host identity 仍无法证明只属于 fixture，测试应报告 `blocked-isolation-unproven`，不启动 attention Pi。

### 2. 可终止 launcher 契约

将现有 `runRpcUntil` 替换/抽取为测试专用 launcher（建议 WritePath 见下节），核心接口：

```ts
spawnIsolatedPi({
  command: piBinary,
  args,
  cwd: fixture.cwd,
  env: fixture.env,
  input,
  totalTimeoutMs: 45_000,
  termGraceMs: 5_000,
  logDir: fixture.logs,
}) -> {
  child,
  records,
  stdoutPath,
  stderrPath,
  timedOut,
  termination: { signalSent, groupId, groupAliveAfterTerm, groupAliveAfterKill },
}
```

实现要求：

- Node `spawn(..., { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] })`；`detached: true` 在 POSIX 上建立独立 process group，等价于要求的 `start_new_session=True`。若平台不能证明独立组语义，直接 blocked，不降级为单 child kill。
- 总 timeout 从 launcher 创建开始计时，而不是从收到某个 RPC record 开始；正常匹配终止条件后先关闭 stdin，并等待 group 内进程自然退出。
- 超时先向负的 process-group id 发送 `SIGTERM`；等待严格 5 秒；仍存活则向同一 group 发送 `SIGKILL`。记录 signal、等待结果与 group 存活检查；不能只调用 `child.kill()`。
- 终止后等待 leader `close`，再用 `kill(-pgid, 0)`（忽略 `ESRCH`，区分权限/未知错误）和受控的 `ps`/平台等价检查确认 group 无成员；检查失败即测试失败/blocked，不得删除可能仍被使用的 fixture。
- `SIGTERM`/`SIGKILL` 和 orphan 检查只针对 launcher 创建的 pgid；禁止按名称、全局 PID、仓库目录或 live coordinator 扫描/杀进程。
- `t.after` 的顺序必须是：launcher 已结束并通过进程组检查 → 关闭/等待 fixture-owned server → 删除 fixture root。若进程组无法收敛，保留脱敏日志、阻断后续测试，不触碰 live state。

### 3. 断言契约与证据分层

普通 lane 的 GREEN 断言：exit 0；无 timeout；RPC response 成功；terminal artifact state 为 `complete`；terminal cwd 等于 fixture.cwd；Host identity/state root 属于 fixture；进程组检查无 orphan。

attention lane 的 GREEN 断言：在 45 秒内观察到 `contact_supervisor`；RPC status 与 artifact 指向同一 fixture-owned run；收到 Supervisor reply；恢复后 terminal `complete`；同样通过 cwd/state/identity/orphan 断言。任何超时只输出 `attention-timeout`（含首个未观察事件与 termination proof），不输出 transport PASS/production FAIL。

另需区分：

- 普通 lane 通过 ≠ attention/Supervisor transport 通过；
- 子进程组被可靠终止 ≠ attention 逻辑通过；
- fixture cleanup 成功 ≠ live workspace cleanup 成功。

## 后续 coding 任务（精确 WritePaths、RED/GREEN、命令）

### Harness 任务 H-PI-ISOLATION-1：可终止 launcher

**WritePaths（仅允许）：**

- `test/helpers/pi-process-group.mjs`（新增测试 helper）；
- `test/pi-subagents-runtime.integration.mjs`（仅替换本文件使用的 launcher/fixture 接线）；
- `test/subagent-runtime-root-broker-startup.integration.mjs`（仅将 cwd、state、HOME/XDG/TMP、agent、session 绑定到 fixture）；
- 如需测试 helper 的单元测试，新增 `test/helpers/pi-process-group.integration.mjs`。

**RED：** 先以独立 fake parent/child fixture（不启动真实 Pi）验证：子进程再派生一个 sleep child；总 timeout 到期后 leader 与 child 均收到 TERM，5 秒后仍存活者收到 KILL；断言 process group 不存在。再验证普通 child 提前成功不触发 signal。命令：

```bash
node --test test/helpers/pi-process-group.integration.mjs
```

预期初始 RED：缺少 `pi-process-group.mjs` 导出或当前 helper 无 process-group 终止/检查能力；不得以真实 Pi 替代该 RED。

**GREEN：** 实现最小 `detached/start_new_session`、总 timeout、TERM→5s→KILL、pgid existence/orphan 检查；同一命令通过后，再运行：

```bash
node --test test/helpers/pi-process-group.integration.mjs
node --test --test-name-pattern='top-level RPC compatibility waits for a completing executor' test/pi-subagents-runtime.integration.mjs
```

不得在 GREEN 阶段运行 attention 或整体 `test:subagents`。

### Harness 任务 H-PI-ISOLATION-2：真实普通 RPC 隔离探针

**WritePaths（仅允许）：**上述 helper，以及 `test/pi-subagents-runtime.integration.mjs`；不得修改 production。

**RED：** 在 fixture 断言中先证明当前仓库 cwd/state split-brain 会被拒绝（scope mismatch/隔离门失败），然后证明临时 Git origin/cwd + state/identity 环境能启动；RED 必须来自缺少隔离绑定而非真实 Pi 随机超时。命令：

```bash
node --test --test-name-pattern='isolated top-level RPC compatibility' test/pi-subagents-runtime.integration.mjs
```

**GREEN：** 临时 origin/cwd/state/agent/HOME/XDG/TMP/session 全部绑定且普通 lane exit 0、约束 identity/cwd、无 orphan；用同一命令验证。这个小范围测试不扩大到 attention，不宣称 Supervisor transport。

### Harness 任务 H-PI-ISOLATION-3：attention 探针（条件性）

**前置条件：** H-1/H-2 GREEN，且启动前隔离门与 launcher group 检查可证明；否则明确 blocked、不运行。

**WritePaths（仅允许）：**`test/pi-subagents-runtime.integration.mjs`、必要时 `test/helpers/pi-process-group.mjs`；禁止 production/live state 改动。

**RED：** 在 45 秒总预算内运行单一隔离 attention test，预期若仍失败须捕获结构化 `attention-timeout`、首个不可观察事件、TERM/KILL 与 group 无 orphan 证据；不能将 timeout 映射为 production defect。命令：

```bash
node --test --test-name-pattern='isolated top-level RPC compatibility observes attention' test/pi-subagents-runtime.integration.mjs
```

**GREEN：** 只有在同一隔离 fixture 中 45 秒内观察 Supervisor reply、resume、terminal complete 且 process group 归零时才算 attention lane GREEN；否则保留环境受限/未验证。该命令仍不是整体 `test:subagents`，也不证明真实 supervisor transport 在 live host 上通过。

## 当前结论与残余风险

当前不满足“已证明新进程不会连接 live coordinator”的启动前证明，因此本节点对 attention **BLOCKED，未运行**。普通 RPC 的约 2.35 秒 exit 0 是窄子集事实；attention 的 45 秒超时和曾有的测试子树残留是可终止性/环境证据，不是 production 缺陷结论。真实 supervisor transport 保持未验证。

残余风险包括：不同平台的 detached process group 语义、Pi/Jiti 额外派生进程是否加入同一组、Host 对 state root 的实际解析是否存在隐藏 fallback，以及 broker socket 路径是否完全由 fixture identity 派生。任何一项无法在启动前断言，均应保持 blocked；不得通过更长 timeout、删除 live 目录或 fallback 到仓库 cwd 来“修复”。

## acceptance-report

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "报告给出 root/origin/cwd/state/agent/HOME/XDG/TMP/session 的复制型 fixture 契约、Host 权威 identity 要求，以及 detached 独立进程组、总 45 秒、TERM 后 5 秒 KILL 与 pgid/orphan 检查规则。"
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "明确记录普通真实 RPC 子集 exit 0 约 2.35 秒；attention 45 秒超时及残留测试子树已清理；分别说明首个不可观察点，并明确不宣称 Supervisor transport 通过、不把超时归为 production 缺陷。"
    },
    {
      "id": "criterion-3",
      "status": "satisfied",
      "evidence": "H-1/H-2/H-3 分别列出精确 WritePaths、RED/GREEN 断言与窄命令；H-3 以隔离门为前置，无法证明时 blocked 且不运行。"
    },
    {
      "id": "criterion-4",
      "status": "satisfied",
      "evidence": "本次仅写指定文档；没有读取/修改 live state、没有仓库 cwd 真实 Pi、没有整体 test:subagents 或 attention 重跑；纯文档 TDD 豁免理由已记录。"
    }
  ],
  "changedFiles": [
    "docs/plans/records/2026-09-23-runtime-remediation/E-PI-ISOLATION.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "读取统一 DAG、E-PI.md、P-HARNESS.md 及指定测试/helper 文件",
      "result": "passed",
      "summary": "完成只读证据核查；未启动真实 Pi。"
    },
    {
      "command": "node --test --test-name-pattern='top-level RPC compatibility waits for a completing executor' test/pi-subagents-runtime.integration.mjs",
      "result": "not-run",
      "summary": "按任务约束不重跑测试；仅报告 E-PI 已有约 2.35 秒 exit 0 证据。"
    },
    {
      "command": "git diff --check",
      "result": "not-run",
      "summary": "待父会话在最终工作树上执行；本节点未执行 git 命令。"
    }
  ],
  "validationOutput": [
    "只写目标报告路径；未修改 production、测试、配置或 live state。",
    "attention 探针保持 BLOCKED，真实 supervisor transport 保持未验证。"
  ],
  "residualRisks": [
    "尚未实现并验证 process-group launcher；不同平台 detached 语义和 Pi/Jiti 派生树仍需 H-1 验证。",
    "尚未证明 Root Broker socket/state root 的所有解析路径都 fixture-owned；证明缺失时不得运行 attention。",
    "现有 attention 超时不能区分 Supervisor transport、测试 harness 或环境原因。"
  ],
  "noStagedFiles": true,
  "diffSummary": "新增唯一 E-PI-ISOLATION 设计与证据报告；无源码、测试或 live state 变更。",
  "reviewFindings": [
    "no blockers for this read-only design; implementation remains blocked pending isolation proof"
  ],
  "manualNotes": "manual-notes: 普通真实 RPC 窄子集约 2.35 秒 exit 0；attention 45 秒超时且曾残留测试子树（已清理）；仓库 cwd startup 有 scope mismatch。未运行 attention，因为无法在本节点证明新进程不会连接 live coordinator。"
}
```
