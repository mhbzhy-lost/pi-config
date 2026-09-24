# P-HARNESS：构造隔离真实 coordinator/Root Broker/Git 环境

## 结论

**GO（隔离临时 harness 验收通过）**。本节点只验证临时、独立的真实 coordinator/Root Broker/Git 入口能力；不涉及 live queue/proof 修复验收，也不要求或执行旧 `~/new-api-account-pool` host 重启。

执行时间（UTC）：2026-09-24T03:52:54Z

## 复用实现与入口核查

只读检查确认以下测试文件真实存在，并复用了仓库已有 fixture/helper，没有新增 fixture 或修改测试：

1. `test/subagent-auto-integration-real-git.integration.mjs`
   - 测试：`real Root Broker/coordinator/Git lifecycle preserves FIFO, continues two conflicts, publishes, proves and releases`
   - 入口/helper：`fixture(t)` 创建临时根、origin Git repository、state root、coordinator socket、Root Broker；`createCoordinatorServer`、`server.listen`、`connectRepositoryCoordinator`、`startAndBindRootBroker`、`child`、`proof` 和 `t.after` cleanup 覆盖真实 allocate/bind/queue/proof 生命周期。
2. `test/managed-workspace-recovery-rebind.integration.mjs`
   - 真实 coordinator fixture：`fixture(t)`；入口/helper：`createCoordinatorServer`、`coordinator.listen`、`connectRealClient`、`allocateCandidate`、`enqueue`、`activateResume`，以及 fixture 的 `t.after` close/remove cleanup。
   - 文件内实际包含 9 个 recovery/rebind 测试，覆盖 allocate/bind、queue、proof pending/resume、重绑与 crash-window replay。
3. `test/subagent-runtime-root-broker-startup.integration.mjs`
   - 测试：`persisted root session shares its broker registry with an independent Jiti extension`
   - 入口/helper：真实 `PI_REAL_BIN` RPC 启动，加载现有 deterministic provider、`subagent-runtime.ts` 和 registry probe；通过独立临时 agent/session/TMP 环境验证 Root Broker startup、bind、registry 可见性和 close 后 socket 不存在。

## 实际执行与结果

所有命令均从仓库根目录执行，输出仅作脱敏摘要；未记录绝对临时路径、workspace identity、lease identity、run/proof identity、token 或 session identity。

### 1. 真实 Root Broker/coordinator/Git FIFO lifecycle

```text
node --test --test-name-pattern='real Root Broker/coordinator/Git lifecycle preserves FIFO' test/subagent-auto-integration-real-git.integration.mjs
```

- exit code：`0`
- 测试计数：1 passed，0 failed，0 skipped/cancelled
- 结果：通过。
- 证据：测试自身以 `mkdtemp` 构造隔离临时根和真实 Git origin/state；创建 coordinator socket，真实 listen/connect；启动并绑定 Root Broker；通过真实 workspace service 完成 allocate、bind、FIFO queue、Git worktree/conflict publish、terminal proof/release；fixture/candidate `t.after` 完成 client/server/broker/lifecycle 关闭并递归移除临时根。

### 2. managed workspace recovery/rebind

```text
node --test test/managed-workspace-recovery-rebind.integration.mjs
```

- exit code：`0`
- 测试计数：9 passed，0 failed，0 skipped/cancelled
- 结果：通过。
- 证据：使用文件内真实 coordinator fixture，执行 listen/connect、managed workspace allocate/bind、queue、terminal proof pending/resume、原子 rebind 和 crash-window replay；fixture `finally/t.after` 关闭 coordinator 并递归移除本次临时根。

### 3. Root Broker startup

首次按无配置环境运行时，测试以 exit code `1` 拒绝启动，因为该测试明确要求真实 `PI_REAL_BIN`。这是环境前置条件缺失，不是 harness 逻辑失败。未修改测试，补齐已有真实 Pi binary 环境变量后按同一测试重新运行：

```text
PI_REAL_BIN="$REAL_PI_BINARY" node --test test/subagent-runtime-root-broker-startup.integration.mjs
```

- 最终 exit code：`0`
- 测试计数：1 passed，0 failed，0 skipped/cancelled
- 结果：通过。
- 证据：真实 Pi RPC 入口加载现有 runtime/Jiti probe；临时 session/agent/TMP 根由测试创建，Root Broker registry 可被独立 extension 观察，测试 finally 递归移除临时根，并断言 broker socket 在关闭后为 `ENOENT`。

## 真实资源生命周期与隔离边界

- **origin/state/socket/worktree**：由现有测试 fixture 在系统临时目录下创建，均属于本次测试创建的临时资源；Git origin 初始化并提交基线，managed workspace 通过真实 Git worktree 逻辑产生。
- **coordinator**：真实 `createCoordinatorServer`，真实 listen；真实 client connect；测试结束关闭 server/client。
- **Root Broker**：真实 startup/bind/registry 入口；真实 close/unbind；startup 测试验证关闭后 socket 不存在。
- **managed workspace**：真实 allocate、run bind、FIFO queue/admission、Git publish/conflict、terminal proof/release；recovery 套件还覆盖 resume/rebind/replay。
- **cleanup**：各 fixture 使用 `t.after`/`finally` 关闭服务并递归移除本次创建的临时根；startup 测试额外断言 socket 已不存在。未清理、触碰或重启任何 live host、非本次创建目录、配置、workspaces 或 live var。
- **隔离性**：测试 origin/state/socket/worktree、session、agent 和 TMP 均为临时 fixture；没有连接旧 host，也没有依赖其运行状态。旧 host 未重启不是本次验收失败条件。

## 失败与限制

- Root Broker startup 首次运行因未设置 `PI_REAL_BIN` 而失败；随后使用已有真实 binary 重跑通过。该失败已记录为环境前置条件提示，不属于生产代码或测试失败。
- 本记录是临时 harness 能力验收，不是 live queue/proof 修复验收；不对旧 host 的状态作结论。
- 测试输出中的敏感/身份字段和完整临时路径均已脱敏或省略。

## acceptance-report

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "仅增量写入 docs/plans/records/2026-09-23-runtime-remediation/P-HARNESS.md。"
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "真实 Root Broker/coordinator/Git 测试 exit 0（1 passed），recovery/rebind 测试 exit 0（9 passed），Root Broker startup 测试在补齐真实 binary 前置后 exit 0（1 passed）。"
    },
    {
      "id": "criterion-3",
      "status": "satisfied",
      "evidence": "现有 fixture 创建临时 origin/state/socket/worktree/session 根，真实 coordinator listen/connect、Root Broker bind/close、workspace allocate/bind/queue/proof 均通过；测试 cleanup hook/finally 执行，startup socket 关闭后断言不存在，不依赖 live host。"
    },
    {
      "id": "criterion-4",
      "status": "satisfied",
      "evidence": "报告明确 P-HARNESS GO，并记录 PI_REAL_BIN 前置失败、cleanup/隔离证据及 live queue/proof 验收限制。"
    }
  ],
  "changedFiles": [
    "docs/plans/records/2026-09-23-runtime-remediation/P-HARNESS.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "node --test --test-name-pattern='real Root Broker/coordinator/Git lifecycle preserves FIFO' test/subagent-auto-integration-real-git.integration.mjs",
      "result": "passed",
      "summary": "1 passed, 0 failed, exit 0"
    },
    {
      "command": "node --test test/managed-workspace-recovery-rebind.integration.mjs",
      "result": "passed",
      "summary": "9 passed, 0 failed, exit 0"
    },
    {
      "command": "node --test test/subagent-runtime-root-broker-startup.integration.mjs",
      "result": "failed",
      "summary": "环境未设置 PI_REAL_BIN，测试按设计拒绝启动；exit 1"
    },
    {
      "command": "PI_REAL_BIN=\"$REAL_PI_BINARY\" node --test test/subagent-runtime-root-broker-startup.integration.mjs",
      "result": "passed",
      "summary": "1 passed, 0 failed, exit 0"
    }
  ],
  "validationOutput": [
    "真实隔离 coordinator/Root Broker/Git lifecycle 通过。",
    "cleanup 由现有测试 finally/t.after 执行；Root Broker startup 测试确认关闭后 socket 不存在。",
    "git staged 状态检查通过：无 staged files。"
  ],
  "residualRisks": [
    "未验证 live host、live queue 或 live proof；本节点明确不执行旧 host 重启。",
    "除 startup 测试对 socket 的显式 ENOENT 断言外，其他临时根移除由现有 fixture cleanup hook 负责。"
  ],
  "noStagedFiles": true,
  "diffSummary": "新增唯一 P-HARNESS 证据文档；未修改源码、测试、配置或计划正文。",
  "reviewFindings": [
    "no blockers"
  ],
  "manualNotes": "P-HARNESS GO；真实 binary 前置缺失导致的首次失败已记录并在不改测试的情况下重跑通过。"
}
```