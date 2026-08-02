# Plan IR v3 完整 Capsule 合同 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可在 worktree 外持久化和安全更新的 `plan-ir.v3` revision 体系，让 Plan Capsule 的调度、Executor、验证和恢复消费者从同一份完整批准合同选择性取数。

**Architecture:** 新增严格的 `pi-plan.v3` 文档合同和唯一的 `plan-ir.v3` 领域 IR；Launcher 在 Host 启动前把原始 Plan 字节、编译 IR 和 manifest 原子写入 `stateRoot` 的不可变 revision 目录，且不向 worktree 复制或覆盖批准版本。Plan Runner 通过受限 `plan_amend` 领域工具提交完整新文本，revision store 先准备 artifact，单写者事件以 projection-version CAS 提交 `plan.amended`，再 supersede 受影响 Attempt；消费者通过无身份 selector 读取当前 event-committed revision，不创建第二套领域 IR。

**Tech Stack:** Node.js 22 ESM、Node 内置 test runner、Git worktree、Pi Plan events、`pi-subagents` execution backend。

---

## Execution Contract

```json
{
  "schemaVersion": "pi-plan.v2",
  "verification": [
    "node --test test/plan-document.test.mjs test/plan-ir.test.mjs test/plan-ir-schema.test.mjs test/plan-revision-store.test.mjs",
    "node --test test/plan-event-writer.test.mjs test/plan-events.test.mjs test/plan-projection.test.mjs test/plan-amendment.test.mjs",
    "node --test test/plan-coordinator.test.mjs test/plan-gates.test.mjs test/plan-attempt-validator.test.mjs test/plan-integration-queue.test.mjs",
    "node --test test/plan-launcher-extension.test.mjs test/plan-capsule-extension.test.mjs test/plan-runner-dependencies.test.mjs",
    "PI_REAL_BIN=\"$(command -v pi)\" node --test test/plan-parallel-harness.integration.mjs",
    "npm test",
    "npm run doctor",
    "git diff --check"
  ],
  "requiredGates": [
    "deterministic",
    "plan-audit",
    "external-review",
    "final-completeness"
  ],
  "resourceCapacities": {},
  "taskVerification": {
    "task-1": ["contract:verification:1"],
    "task-2": ["contract:verification:1"],
    "task-3": ["contract:verification:1", "contract:verification:4"],
    "task-4": ["contract:verification:2"],
    "task-5": ["contract:verification:2"],
    "task-6": ["contract:verification:2", "contract:verification:4"],
    "task-7": ["contract:verification:3"],
    "task-8": ["contract:verification:3"],
    "task-9": ["contract:verification:4", "contract:verification:5", "contract:verification:6", "contract:verification:7", "contract:verification:8"]
  }
}
```

## 冻结范围

1. 只有一套 Plan 领域 IR，版本为 `plan-ir.v3`；selector 返回临时只读 view，不具有独立版本、hash 或持久化身份。
2. `plan-ir.v1/v2` 与 `pi-plan.v1/v2` 保留兼容读取；所有新 launch 都进入 revision store，但只有 `pi-plan.v3` 编译为 `plan-ir.v3` 并允许 amendment。旧 session 不重新解释成新合同。
3. `pi-plan.v3` canonical hash 必须覆盖 Plan 级说明、Task body、执行策略、验收策略、验证命令、Gate、资源和依赖；revision 更新只能创建新 artifact，禁止覆盖旧 IR。
4. 原始 Plan 必须以启动时读取到的精确 UTF-8 字节复制到 `stateRoot`，另存 `sourceBytesSha256`；parser 的规范化 `planHash` 与原始字节 hash 都进入 manifest。
5. IR 只包含对应 revision 批准时可知的不可变合同。`planId`、Attempt identity、base/result commit、workspace、run binding、Attention、Gate round、cleanup debt 等继续属于运行事件或 artifact。
6. `plan.created` 或 `plan.amended` 是当前 revision 的提交事实；`current.json` 只是可重建缓存，不能覆盖事件权威。
7. 运行事件必须用 `planIrHash`、`taskHash` 和 `dispatchContextHash` 绑定对应 IR；不复制完整 IR 到事件日志。
8. Plan Markdown 中无法结构化解释的业务语义不能丢弃：Plan 级正文进入 `instructions`，每个 Task 的完整规范化正文进入 `body`。
9. 调度顺序以当前 revision `ir.nodes` 的稳定拓扑序为准；`sourceOrder` 只用于相同 frontier 的稳定优先级和审计。
10. 不在本计划中修复 Gate adapter 或 Host cleanup；approved-plan snapshot、Event Writer/CAS 和 amendment 状态机已经成为本计划的必要组成。
11. `plan-runner-dispatch` Skill 的 v3 作者指引需要按 `writing-skills` 完成独立 RED/GREEN 压力测试，因此不混入本代码合同计划；在该独立迁移完成前，现有 Skill 继续只承诺 v1 输入。

## `pi-plan.v3` 输入合同

Execution Contract 固定为以下字段：

```json
{
  "schemaVersion": "pi-plan.v3",
  "revision": 1,
  "parentPlanHash": null,
  "verification": [
    {"id": "plan:test", "command": "npm test", "cwd": ".", "timeoutMs": 900000},
    {"id": "plan:diff", "command": "git diff --check", "cwd": ".", "timeoutMs": 120000}
  ],
  "requiredGates": [
    "deterministic",
    "plan-audit",
    "external-review",
    "final-completeness"
  ],
  "resourceCapacities": {"xcode": 1},
  "executionDefaults": {
    "agent": "executor",
    "risk": "normal",
    "workflow": {"mode": "inherit-repository"},
    "timeoutMs": 900000
  },
  "taskExecution": {
    "task-2": {
      "risk": "high",
      "workflow": {"mode": "tdd"},
      "timeoutMs": 1200000
    }
  },
  "taskAcceptance": {
    "task-1": {
      "strategy": "commands",
      "commandIds": ["plan:test"]
    },
    "task-2": {
      "strategy": "inherit-final",
      "reason": "行为只能在全部任务集成后验证"
    }
  }
}
```

字段规则：

- `revision` 是大于零的整数；初始 revision 的 `parentPlanHash` 必须为 `null`，后续 revision 必须是 64 位 SHA-256。
- v3 `verification` 是非空 command object 数组；`id` 全局唯一，`cwd` 必须是安全仓库相对 POSIX 路径，`timeoutMs` 是正安全整数。
- `executionDefaults.agent` 当前只允许 `executor`；`risk` 允许 `low/normal/high`。
- `workflow.mode` 允许 `inherit-repository/tdd/existing-tests/docs-only`；`existing-tests/docs-only` 必须带非空 `reason`。
- `timeoutMs` 是正安全整数，范围为 1 秒到 24 小时。
- `taskExecution` 只能覆盖 `risk/workflow/timeoutMs`，不能改变 agent、路径、依赖或资源。
- `taskAcceptance` 必须覆盖每个 Task，不能引用未知 Task。
- `commands` 要求非空 `commandIds` 且禁止 `reason`。
- `inherit-final/structural-only/deferred` 要求非空 `reason` 且 `commandIds` 固定为空数组。
- `pi-plan.v3` 要求 Plan 级 `instructions` 和每个 Task 的语义正文非空；v1/v2 保持旧兼容行为。

## `plan-ir.v3` 字段合同

编译结果固定为以下形状：

```json
{
  "version": "plan-ir.v3",
  "source": {
    "schemaVersion": "pi-plan.v3",
    "revision": 1,
    "parentPlanHash": null,
    "planHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "title": "Plan title",
  "instructions": "Plan 级 Goal、Architecture、约束和其他批准说明",
  "executionPolicy": {
    "isolation": "attempt-worktree",
    "repositoryInstructions": "required",
    "externalSideEffects": "attention-required",
    "resultContract": "plan-attempt-result.v1",
    "commit": {
      "requiredOnSuccess": true,
      "exactlyOne": true,
      "allowMerge": false
    }
  },
  "verification": {
    "commands": [
      {
        "id": "plan:test",
        "command": "npm test",
        "cwd": ".",
        "timeoutMs": 900000
      }
    ],
    "requiredGates": [
      "deterministic",
      "plan-audit",
      "external-review",
      "final-completeness"
    ]
  },
  "resourceCapacities": {"xcode": 1},
  "nodes": [
    {
      "id": "task-1",
      "sourceOrder": 1,
      "title": "Implement feature",
      "body": "完整规范化 Task 正文",
      "dependencies": [
        {
          "taskId": "task-0",
          "requiredState": "integrated",
          "receipts": [
            "result-commit",
            "integrated-head",
            "changed-paths",
            "verification-summary"
          ]
        }
      ],
      "allowedPaths": ["src/**"],
      "resources": [{"id": "xcode", "mode": "exclusive"}],
      "execution": {
        "agent": "executor",
        "risk": "normal",
        "workflow": {"mode": "inherit-repository"},
        "timeoutMs": 900000
      },
      "acceptance": {
        "strategy": "commands",
        "commandIds": ["plan:test"],
        "reason": null
      },
      "hashes": {
        "scheduling": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "semantics": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "full": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "effective": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    }
  ],
  "edges": [{"from": "task-0", "to": "task-1"}],
  "hashes": {
    "context": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "verification": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "graph": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "full": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

Hash 覆盖规则：

- `context`：`title + instructions + executionPolicy`。
- `verification`：完整 verification commands（包括 id、command、cwd、timeoutMs）和 required gates。
- 节点 `scheduling`：`id + sourceOrder + dependencies + allowedPaths + resources + execution.agent`。
- 节点 `semantics`：`id + title + body + execution + acceptance`，只表示 Task 局部业务语义。
- 节点 `full`：不含 `hashes` 的完整局部节点；accepted/integrated 历史用它判断 Task 合同是否被改写。
- 节点 `effective`：`context hash + verification hash + 节点 full hash`；运行事件使用它作为 `taskHash`。全局说明或命令变化只使 pending/active Task 重绑定，不篡改已集成 Task 的局部历史。
- `graph`：`resourceCapacities + edges + 所有节点 scheduling hash`。
- 根 `full/hash`：不含根 `hashes/hash` 的完整 IR，加上派生的 context、verification、graph 和 node hashes。

## 编译所有权与工具边界

IR compiler 只属于 Harness，不暴露为模型可调用工具，也不接受 Main Agent 或 Plan Runner 直接提交的 IR JSON。

外部 `plan_run` 保持最小输入：

```json
{
  "planPath": "docs/superpowers/plans/feature.md",
  "planId": "可选稳定 ID"
}
```

Main Agent 不重复填写 tasks、deps、paths、resources、verification 或 execution policy。Launcher 负责读取 `planPath` 的精确字节并交给 revision store；store 内部调用纯函数 `parsePlanDocument(source) -> compilePlanToIR(plan)`，冻结 revision 1。`plan_run` 的输出 handle 增加 `revision/manifestSha256/sourceBytesSha256/planHash/planIrHash`，这些是 Harness 产生的事实，不是调用方声明。

内部 `plan_open` 不再接受任意 `planPath/planHash/approvedHash`，只接受已经位于受信 stateRoot 的 revision identity：

```json
{
  "planId": "plan-123",
  "revision": 1,
  "manifestSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "planIrHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "baseCommit": "0123456789012345678901234567890123456789",
  "worktree": "/trusted/attempt/worktree",
  "allowPlanCommits": true
}
```

Plan Runner 决定更新时也不抽取或拼装 IR 字段。它先通过只读 `plan_read_revision` 获取当前 event-committed source，再提交完整 `pi-plan.v3` source 给 `plan_amend`。Harness 重新 parse/compile、比较 hash、执行 revision commit。这样业务判断可以来自模型，但事实提取、canonicalization、hash 和安全校验始终是确定性代码。

`plan_read_revision` 不接受文件路径，只允许读取当前 revision：

```json
{
  "input": {},
  "output": {
    "revision": 1,
    "planHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "irHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "source": "完整 pi-plan.v3 Markdown"
  }
}
```

## Revision Store 与冻结事实

所有批准合同位于 worktree 外：

```text
<stateRoot>/var/plan-runs/<planId>/
  revisions/
    000001/
      source.md
      plan-ir.json
      manifest.json
    000002/
      source.md
      plan-ir.json
      manifest.json
  current.json
```

`source.md` 保存 Launcher 或 `plan_amend` 收到的精确 UTF-8 字节，不做换行或空白重写。`plan-ir.json` 使用 `JSON.stringify(ir, null, 2) + "\n"`，但领域身份仍是 `ir.hash`；文件字节另有 `irArtifactSha256`。`manifest.json` 固定为：

```json
{
  "schemaVersion": "plan-revision.v1",
  "planId": "plan-123",
  "revision": 2,
  "parentRevision": 1,
  "sourceBytesSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "planHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "irVersion": "plan-ir.v3",
  "irHash": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "irArtifactSha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "taskHashes": {
    "task-2": {
      "full": "1111111111111111111111111111111111111111111111111111111111111111",
      "effective": "2222222222222222222222222222222222222222222222222222222222222222",
      "scheduling": "3333333333333333333333333333333333333333333333333333333333333333"
    }
  },
  "createdAt": "2026-07-29T00:00:00.000Z",
  "reason": "executor-found-missing-contract",
  "initiator": {
    "kind": "supervisor-request",
    "requestId": "request-123",
    "taskId": "task-2",
    "attemptId": "attempt-123",
    "runId": "run-123"
  }
}
```

初始 manifest 使用 `revision:1`、`parentRevision:null`、`reason:"initial-approval"` 和 `initiator:{"kind":"launcher"}`。每个 revision 目录先写入同级临时目录，文件模式 `0600`、目录模式 `0700`；三个文件写完并重新读取校验 hash 后，以一次 rename 发布。目标 revision 已存在时只允许字节完全一致的幂等重试，任何差异都 fail closed。

`current.json` 只包含 `{schemaVersion, planId, revision, manifestSha256, irHash}`。它在 revision commit event 成功后原子更新；若 crash 导致它缺失或过期，恢复逻辑按最后一条 `plan.created/plan.amended` 事件重新生成。无事件引用的 candidate revision 是可回收 orphan，不得自动成为当前合同。

## IR 更新协议

Plan Runner 不直接写 revision 目录，只能调用领域工具：

```json
{
  "name": "plan_amend",
  "input": {
    "expectedProjectionVersion": 42,
    "baseRevision": 1,
    "requestId": "request-123",
    "reason": "executor-found-missing-contract",
    "source": "完整 pi-plan.v3 Markdown"
  }
}
```

更新流程固定为：

1. 验证 `requestId` 唯一对应当前 `waiting-attention` Supervisor request，且 task/attempt/run 身份一致。
2. 要求新文档 `revision = baseRevision + 1`，`parentPlanHash = 当前 manifest.planHash`；parse、compile、严格验证完整新 IR。
3. 对旧/新 IR 按稳定 Task ID 计算 `added/changed/rebound/retired/unchanged`：`changed` 表示局部 full 改变，`rebound` 表示局部合同不变但全局 context/verification 使 effective hash 改变。
4. 已 accepted/integrated Task 的局部 full hash 禁止改变，也禁止删除或复用 ID；全局变化导致的 rebound 可以 carry-forward。需要修改已集成 Task 本身时必须新增依赖旧 Task 的 repair Task，保留历史合同。
5. pending Task 可以修改或 retired；active/waiting-attention Task 的 effective hash 改变时，revision commit 后必须 supersede 原 Attempt，再基于新 effective task hash 创建新 Attempt。
6. 新增 Task 和 pending graph 变化必须重新通过 cycle、路径冲突、资源容量和 verification reference 校验；新容量不得低于当前未释放 claim。
7. Plan Runner 对 amendment 的业务判断是权威输入；Harness 不重新解释理由，只验证来源 Supervisor identity、完整新文本、revision 链、IR 安全约束和 Task 历史不变量。涉及真实外部副作用时仍受现有 Attention/side-effect policy 约束，但 IR 字段变化本身不要求 Main Agent 重复提交结构化字段。
8. revision store 先准备不可变 candidate artifact；Event Writer 以 `expectedProjectionVersion` CAS 追加 `plan.amended`，该事件才是 revision commit record。
9. 事件提交后更新 `current.json`；对 changed/rebound active Task 调用官方 stop，有界等待 terminal artifact，再追加 `attempt.superseded` 并释放 workspace/resource。
10. Coordinator 从最后 committed revision 重新计算 frontier。跨 crash 恢复时不得重新派发旧 task hash；candidate 无 event 时忽略，event 有 artifact 但 pointer 落后时修复 pointer。

`plan.amended` 事件只保存身份和 diff，不复制正文：

```json
{
  "revision": 2,
  "parentRevision": 1,
  "manifestSha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "sourceBytesSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "planHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "irHash": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "taskHashes": {
    "task-1": {
      "full": "1111111111111111111111111111111111111111111111111111111111111111",
      "effective": "2222222222222222222222222222222222222222222222222222222222222222",
      "scheduling": "3333333333333333333333333333333333333333333333333333333333333333"
    },
    "task-2": {
      "full": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      "effective": "8888888888888888888888888888888888888888888888888888888888888888",
      "scheduling": "9999999999999999999999999999999999999999999999999999999999999999"
    },
    "task-3": {
      "full": "4444444444444444444444444444444444444444444444444444444444444444",
      "effective": "5555555555555555555555555555555555555555555555555555555555555555",
      "scheduling": "6666666666666666666666666666666666666666666666666666666666666666"
    },
    "task-4": {
      "full": "7777777777777777777777777777777777777777777777777777777777777777",
      "effective": "abababababababababababababababababababababababababababababababab",
      "scheduling": "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"
    }
  },
  "diff": {
    "added": ["task-4"],
    "changed": ["task-2"],
    "rebound": [],
    "retired": [],
    "unchanged": ["task-1", "task-3"]
  },
  "supersededAttemptIds": ["attempt-task-2-1"],
  "requestId": "request-123",
  "reason": "executor-found-missing-contract"
}
```

## 动态 Capsule 信息边界

以下信息不进入 `plan-ir.v3`，但必须继续存在并绑定 IR：

| 信息 | 权威来源 | IR 绑定方式 |
|---|---|---|
| 初始/修订 Plan 原文与 IR | revision store | manifest hash、`plan.created/plan.amended` |
| `planId`、workspace、base/head commit | `plan.created` | committed revision、`planIrHash`、`sourcePlanHash` |
| Attempt、workspace lease、resource claim | Plan events | `taskHash`、`schedulingHash` |
| dispatch、cwd、output、timeout | `attempt.dispatch-requested` | `dispatchContextHash`、`taskHash` |
| runId、asyncDir、sessionFile | `attempt.bound` 与官方 artifact | dispatch/attempt identity |
| result commit、changed paths、verification evidence | Git 与 `attempt.validated` | `taskHash`、validation hash |
| integrated head | `integration.finished` | task/attempt identity |
| Attention、用户回复、Gate round、cleanup debt | Plan events/artifacts | projection version 与 planId |

## 文件结构

| 路径 | 职责 |
|---|---|
| `scripts/lib/plan/plan-revision-store.mjs` | 在 stateRoot 原子准备、读取、校验和发布不可变 source/IR/manifest revision |
| `scripts/lib/plan/plan-event-writer.mjs` | 单写者队列、expected projection version CAS 和 reducer-before-append |
| `scripts/lib/plan/plan-amendment.mjs` | IR diff、授权分类、accepted Task 不可变规则和 Attempt supersede 计划 |
| `scripts/lib/plan/plan-document.mjs` | 解析 `pi-plan.v3`、保留全局和 Task 语义、生成完整 canonical hash |
| `scripts/lib/plan/ir/schema.mjs` | `plan-ir.v3` 常量、严格验证和递归冻结 |
| `scripts/lib/plan/ir/compile.mjs` | 从 `pi-plan.v3` 确定性编译唯一完整 IR 和多粒度 hash |
| `scripts/lib/plan/ir/views.mjs` | 调度、执行和验证 selector；只返回临时 view |
| `scripts/lib/plan/ir/index.mjs` | 公开 compiler、validator 和 selector |
| `scripts/lib/plan/coordinator.mjs` | 读取执行 view、渲染完整 Task prompt、绑定 task/dispatch hash |
| `scripts/lib/plan/gates.mjs` | 从 IR verification view 构造命令注册表和 Task 验收 |
| `scripts/lib/plan/plan-events.mjs` | 在 Plan/Attempt 事件中验证 IR identity |
| `scripts/lib/plan/plan-capsule-extension.mjs` | `plan.created` 写入 revision identity，并提供受限 `plan_amend` tool |
| `scripts/lib/plan/plan-launcher-extension.mjs` | 启动前在 stateRoot 冻结原始 source、IR 和 manifest，不再复制 Plan 到 worktree |
| `scripts/lib/plan/plan-runner-dependencies.mjs` | 读取 event-committed revision，装配 amendment、Coordinator、Queue 和 Gate |
| `test/plan-revision-store.test.mjs` | 原始字节冻结、私有权限、幂等发布、orphan/pointer crash recovery |
| `test/plan-event-writer.test.mjs` | 并发 append CAS、终态后事件和 stale projection 拒绝 |
| `test/plan-amendment.test.mjs` | Supervisor amendment、授权分类、Task diff、supersede 和 restart |
| `test/plan-ir-schema.test.mjs` | 完整字段、严格 schema、hash 变更矩阵和 selector 合同 |
| `test/fixtures/plan-harness/plans/*.md` | `pi-plan.v3` 真实入口 fixture |

### Task 1: 增加 pi-plan.v3 完整文档合同

**Files:**
- Modify: `scripts/lib/plan/plan-document.mjs`
- Modify: `test/plan-document.test.mjs`

- [ ] **Step 1: 写 v3 canonical 语义保留失败测试**

在 `test/plan-document.test.mjs` 增加以下 fixture，覆盖 Goal、Architecture、Task 步骤和 v3 contract：

```javascript
const v3Contract = JSON.stringify({
  schemaVersion: "pi-plan.v3",
  revision: 1,
  parentPlanHash: null,
  verification: [
    { id: "plan:test", command: "node --test", cwd: ".", timeoutMs: 900_000 },
  ],
  requiredGates: ["deterministic", "plan-audit", "external-review", "final-completeness"],
  resourceCapacities: {},
  executionDefaults: {
    agent: "executor",
    risk: "normal",
    workflow: { mode: "inherit-repository" },
    timeoutMs: 900_000,
  },
  taskExecution: {
    "task-1": { risk: "high", workflow: { mode: "tdd" }, timeoutMs: 1_200_000 },
  },
  taskAcceptance: {
    "task-1": { strategy: "commands", commandIds: ["plan:test"] },
  },
}, null, 2);

function makeV3Document({
  planInstructions = "**Goal:** preserve every approved instruction\n\n**Architecture:** one canonical IR",
  taskInstructions = "- [ ] Write the failing semantic hash test first",
  executionContract = v3Contract,
} = {}) {
  return `# Complete IR plan\n\n${planInstructions}\n\n## Execution Contract\n\n\`\`\`json\n${executionContract}\n\`\`\`\n\n### Task 1: Compile semantics\n\n**Files:**\n- Modify: \`src/ir.mjs\`\n\n${taskInstructions}\n`;
}

const v3Document = makeV3Document();
const v3DocumentWithoutPlanInstructions = makeV3Document({ planInstructions: "" });
const v3DocumentWithoutTaskSteps = makeV3Document({ taskInstructions: "" });
const plan = parsePlanDocument(v3Document, "/plans/v3.md");
assert.equal(plan.schemaVersion, "pi-plan.v3");
assert.equal(plan.revision, 1);
assert.equal(plan.parentPlanHash, null);
assert.match(plan.instructions, /Goal: preserve every approved instruction/);
assert.match(plan.instructions, /Architecture: one canonical IR/);
assert.match(plan.tasks[0].body, /Write the failing semantic hash test/);
assert.deepEqual(plan.tasks[0].acceptance, {
  strategy: "commands",
  commandIds: ["plan:test"],
  reason: null,
});
assert.deepEqual(plan.tasks[0].execution, {
  agent: "executor",
  risk: "high",
  workflow: { mode: "tdd" },
  timeoutMs: 1_200_000,
});
assert.deepEqual(plan.requiredGates, [
  "deterministic", "plan-audit", "external-review", "final-completeness",
]);
assert.throws(
  () => parsePlanDocument(v3DocumentWithoutPlanInstructions, "/plans/v3-no-plan-instructions.md"),
  /Plan instructions must be non-empty/,
);
assert.throws(
  () => parsePlanDocument(v3DocumentWithoutTaskSteps, "/plans/v3-no-task-steps.md"),
  /Task instructions must be non-empty.*task-1/,
);
```

另用 `makeV3Document()` 生成只改变 Plan instructions 和 Task body 的文档；用 `JSON.parse(v3Contract)` 后修改 `taskAcceptance.task-1` 为 `{strategy:"inherit-final", reason:"只在最终集成后验证"}`，或修改 `verification[0].command` 再 `JSON.stringify`，断言每次 `plan.sha256` 都改变。

- [ ] **Step 2: 运行 parser 测试确认 RED**

Run:

```bash
node --test test/plan-document.test.mjs
```

Expected: FAIL，错误包含 `schemaVersion must be pi-plan.v1 or pi-plan.v2`，或返回对象缺少 `instructions/revision/acceptance/execution`。

- [ ] **Step 3: 实现严格 v3 contract 解析**

将 schema 判断扩展为 v3，并增加以下常量与归一化函数：

```javascript
const PLAN_SCHEMAS = new Set(["pi-plan.v1", "pi-plan.v2", "pi-plan.v3"]);
const RISKS = new Set(["low", "normal", "high"]);
const WORKFLOW_MODES = new Set(["inherit-repository", "tdd", "existing-tests", "docs-only"]);
const ACCEPTANCE_STRATEGIES = new Set(["commands", "inherit-final", "structural-only", "deferred"]);
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function normalizeWorkflow(value, location) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !WORKFLOW_MODES.has(value.mode)) {
    fail(location, "workflow is invalid");
  }
  if (["existing-tests", "docs-only"].includes(value.mode) && (typeof value.reason !== "string" || !value.reason.trim())) {
    fail(location, "workflow reason is required");
  }
  return value.reason === undefined ? { mode: value.mode } : { mode: value.mode, reason: value.reason.trim() };
}

function normalizeAcceptance(value, location) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !ACCEPTANCE_STRATEGIES.has(value.strategy)) {
    fail(location, "acceptance is invalid");
  }
  const commandIds = value.commandIds ?? [];
  if (!Array.isArray(commandIds) || commandIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(id))) {
    fail(location, "acceptance commandIds are invalid");
  }
  if (value.strategy === "commands") {
    if (commandIds.length === 0 || value.reason !== undefined) fail(location, "commands acceptance requires commandIds and forbids reason");
    return { strategy: value.strategy, commandIds: [...commandIds], reason: null };
  }
  if (commandIds.length !== 0 || typeof value.reason !== "string" || !value.reason.trim()) {
    fail(location, `${value.strategy} acceptance requires reason and forbids commandIds`);
  }
  return { strategy: value.strategy, commandIds: [], reason: value.reason.trim() };
}
```

对 `executionDefaults` 和 `taskExecution` 使用以下严格归一化；`taskExecution` 只能覆盖三个字段，最后给每个 v3 Task 写入具体 `execution`：

```javascript
function exactKeys(value, location, allowed, required = allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(location, "must be an object");
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(location, `unknown field ${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(location, `missing field ${key}`);
  return value;
}

function normalizeTimeout(value, location) {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > MAX_TIMEOUT_MS) {
    fail(location, "timeoutMs must be between 1000 and 86400000");
  }
  return value;
}

function normalizeCommandCwd(value, location) {
  if (value === ".") return value;
  validateAllowedPath(value, location);
  if (/[?*\[\]{}]/.test(value)) fail(location, "verification cwd cannot contain globs");
  return value;
}

function normalizeVerificationCommands(value, location) {
  if (!Array.isArray(value) || value.length === 0) fail(location, "verification must be non-empty");
  const seen = new Set();
  return value.map((entry, index) => {
    const item = exactKeys(entry, `${location}[${index}]`, ["id", "command", "cwd", "timeoutMs"]);
    if (typeof item.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(item.id) || seen.has(item.id)) {
      fail(location, "verification id is invalid or duplicated");
    }
    if (typeof item.command !== "string" || !item.command.trim()) fail(location, "verification command is invalid");
    seen.add(item.id);
    return {
      id: item.id,
      command: item.command.trim(),
      cwd: normalizeCommandCwd(item.cwd, `${location}[${index}].cwd`),
      timeoutMs: normalizeTimeout(item.timeoutMs, `${location}[${index}].timeoutMs`),
    };
  });
}

function normalizeExecutionDefaults(value, location) {
  exactKeys(value, location, ["agent", "risk", "workflow", "timeoutMs"]);
  if (value.agent !== "executor") fail(location, "agent must be executor");
  if (!RISKS.has(value.risk)) fail(location, "risk is invalid");
  return {
    agent: value.agent,
    risk: value.risk,
    workflow: normalizeWorkflow(value.workflow, `${location}.workflow`),
    timeoutMs: normalizeTimeout(value.timeoutMs, `${location}.timeoutMs`),
  };
}

function normalizeTaskExecution(value, defaults, location) {
  exactKeys(value ?? {}, location, ["risk", "workflow", "timeoutMs"], []);
  const risk = value?.risk ?? defaults.risk;
  if (!RISKS.has(risk)) fail(location, "risk is invalid");
  return {
    agent: defaults.agent,
    risk,
    workflow: value?.workflow ? normalizeWorkflow(value.workflow, `${location}.workflow`) : { ...defaults.workflow },
    timeoutMs: value?.timeoutMs === undefined ? defaults.timeoutMs : normalizeTimeout(value.timeoutMs, `${location}.timeoutMs`),
  };
}
```

解析 Task 后比较 `Object.keys(taskAcceptance).sort()` 与全部 Task ID，要求精确一致；逐 Task 调用 `normalizeAcceptance()` 和 `normalizeTaskExecution()`。`parseContract()` 对 v1/v2 保留字符串 verification 校验，对 v3 调用 `normalizeVerificationCommands()`，并在 canonical object 中保留 command objects，再进入 v3 canonical hash。

- [ ] **Step 4: 保留 Plan 级正文和完整 Task body**

调整 contract parser 返回 fenced block 的 `start/end`，以第一个 Task 起点为界，从前缀中删除标题与 Execution Contract 后得到 `instructions`：

```javascript
function extractPlanInstructions(text, contractRange, firstTaskIndex) {
  const prefix = text.slice(0, contractRange.start)
    + text.slice(contractRange.end, firstTaskIndex);
  return prefix
    .replace(/^#\s+.+\n?/, "")
    .replace(/^---\s*$/gm, "")
    .trim();
}
```

让共享 Task metadata parser 额外返回语义步骤，但 v1/v2 丢弃该派生字段以保持 canonical hash：

```javascript
while (lines[cursor] === "") cursor++;
const instructions = lines.slice(cursor).join("\n").trim();
return { deps, files, allowedPaths: [...files], resources, instructions };

// v2
const { instructions: _instructions, ...parsed } = parseV2TaskBody(body, path, id);

// v3
const parsed = parseV2TaskBody(body, path, id);
if (!parsed.instructions) fail(path, "Task instructions must be non-empty", id);
const { instructions: _instructions, ...metadata } = parsed;
tasks.push({ id, title: match[2].trim(), ...metadata, body });
```

v3 Task 保留包含 Deps、Files、Resources 和执行步骤的完整规范化 `body`；v3 Plan instructions 也必须非空。v1/v2 的 canonical 对象和固定 hash 测试保持不变。

- [ ] **Step 5: 运行 parser 测试到 GREEN 并提交**

```bash
node --test test/plan-document.test.mjs
git add scripts/lib/plan/plan-document.mjs test/plan-document.test.mjs
git commit -m "feat(plan): 增加完整 v3 文档合同"
```

Expected: PASS；v1 固定 SHA 测试仍保持原值。

### Task 2: 编译唯一完整 plan-ir.v3

**Deps:** Task 1

**Files:**
- Create: `scripts/lib/plan/ir/schema.mjs`
- Create: `scripts/lib/plan/ir/views.mjs`
- Modify: `scripts/lib/plan/ir/compile.mjs`
- Modify: `scripts/lib/plan/ir/index.mjs`
- Create: `test/plan-ir-schema.test.mjs`
- Modify: `test/plan-ir.test.mjs`

- [ ] **Step 1: 写完整 IR 与 hash 变更矩阵失败测试**

在 `test/plan-ir-schema.test.mjs` 用 Task 1 的 v3 fixture 解析 `plan`，并用以下 helper 生成变体：

```javascript
import { createHash } from "node:crypto";
import { compilePlanToIR } from "../scripts/lib/plan/ir/index.mjs";

function compileVariant(plan, mutate) {
  const copy = structuredClone(plan);
  mutate(copy);
  delete copy.sha256;
  copy.sha256 = createHash("sha256").update(JSON.stringify(copy)).digest("hex");
  return compilePlanToIR(copy);
}

const ir = compilePlanToIR(plan);
const bodyChanged = compileVariant(plan, (copy) => { copy.tasks[0].body += "\nChanged requirement"; });
const pathChanged = compileVariant(plan, (copy) => { copy.tasks[0].allowedPaths = ["src/**"]; });
const contextChanged = compileVariant(plan, (copy) => { copy.instructions += "\nNew global constraint"; });
const verificationChanged = compileVariant(plan, (copy) => { copy.verification[0].command = "node --test test/other.test.mjs"; });

assert.equal(ir.version, "plan-ir.v3");
assert.equal(ir.source.planHash, plan.sha256);
assert.equal(ir.nodes[0].body, plan.tasks[0].body);
assert.deepEqual(ir.nodes[0].acceptance, plan.tasks[0].acceptance);
assert.match(ir.hash, /^[a-f0-9]{64}$/);
assert.equal(ir.hash, ir.hashes.full);
assert.equal(Object.isFrozen(ir.nodes[0].execution.workflow), true);

assert.equal(bodyChanged.nodes[0].hashes.scheduling, ir.nodes[0].hashes.scheduling);
assert.notEqual(bodyChanged.nodes[0].hashes.semantics, ir.nodes[0].hashes.semantics);
assert.notEqual(bodyChanged.nodes[0].hashes.full, ir.nodes[0].hashes.full);
assert.notEqual(bodyChanged.nodes[0].hashes.effective, ir.nodes[0].hashes.effective);
assert.notEqual(pathChanged.nodes[0].hashes.scheduling, ir.nodes[0].hashes.scheduling);
assert.notEqual(pathChanged.nodes[0].hashes.full, ir.nodes[0].hashes.full);
assert.notEqual(pathChanged.nodes[0].hashes.effective, ir.nodes[0].hashes.effective);
assert.equal(contextChanged.nodes[0].hashes.semantics, ir.nodes[0].hashes.semantics);
assert.equal(contextChanged.nodes[0].hashes.full, ir.nodes[0].hashes.full);
assert.notEqual(contextChanged.nodes[0].hashes.effective, ir.nodes[0].hashes.effective);
assert.equal(verificationChanged.nodes[0].hashes.full, ir.nodes[0].hashes.full);
assert.notEqual(verificationChanged.nodes[0].hashes.effective, ir.nodes[0].hashes.effective);
```

断言 v1/v2 仍分别编译为现有版本，不改变旧 hash 行为。

- [ ] **Step 2: 运行 IR 测试确认 RED**

```bash
node --test test/plan-ir.test.mjs test/plan-ir-schema.test.mjs
```

Expected: FAIL，提示 `plan-ir.v3`、schema validator 或 selector 尚不存在。

- [ ] **Step 3: 实现严格 schema、hash 和递归冻结**

在 `schema.mjs` 导出：

```javascript
export const PLAN_IR_V3 = "plan-ir.v3";
export const DEPENDENCY_RECEIPTS = Object.freeze([
  "result-commit", "integrated-head", "changed-paths", "verification-summary",
]);

export function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function assertPlanIRV3(ir) {
  if (ir?.version !== PLAN_IR_V3 || ir?.source?.schemaVersion !== "pi-plan.v3") throw new Error("invalid plan-ir.v3 identity");
  if (!Array.isArray(ir.nodes) || ir.nodes.length === 0 || !Array.isArray(ir.edges)) throw new Error("invalid plan-ir.v3 graph");
  if (ir.hash !== ir.hashes?.full || !/^[a-f0-9]{64}$/.test(ir.hash)) throw new Error("invalid plan-ir.v3 hash");
  return ir;
}
```

`schema.mjs` 不接受外部构造的任意对象作为权威 IR；生产 IR 只能由 compiler 生成。`assertPlanIRV3` 用于 compiler 后置条件和 selector 防误用，只校验 identity、完整顶层 shape、hash 及递归冻结；每个嵌套字段的精确 shape 由 compiler 构造和 `test/plan-ir-schema.test.mjs` 的 `deepEqual` 固定。

- [ ] **Step 4: 实现 compileV3 和 selector**

`compile.mjs` 根据 `pi-plan.v3` 调用 `compileV3`。每条字符串依赖转换为包含 `requiredState` 和固定 receipt 种类的对象；具体构造包含在下面的完整 `compileV3()` payload 中。

verification commands 保持批准合同中的稳定 ID、cwd 和 timeout，不按数组位置重命名：

```javascript
const verification = {
  commands: plan.verification.map((entry) => ({ ...entry })),
  requiredGates: [...plan.requiredGates],
};
```

`compileV3()` 按以下顺序构造 canonical payload，避免 hash 循环依赖：

```javascript
const executionPolicy = {
  isolation: "attempt-worktree",
  repositoryInstructions: "required",
  externalSideEffects: "attention-required",
  resultContract: "plan-attempt-result.v1",
  commit: { requiredOnSuccess: true, exactlyOne: true, allowMerge: false },
};
const source = {
  schemaVersion: plan.schemaVersion,
  revision: plan.revision,
  parentPlanHash: plan.parentPlanHash,
  planHash: plan.sha256,
};
const contextHash = sha256({ title: plan.title, instructions: plan.instructions, executionPolicy });
const verificationHash = sha256(verification);
const sourceOrder = new Map(plan.tasks.map((task, index) => [task.id, index + 1]));

const nodes = sorted.map((task) => {
  const node = {
    id: task.id,
    sourceOrder: sourceOrder.get(task.id),
    title: task.title,
    body: task.body,
    dependencies: task.deps.map((taskId) => ({
      taskId,
      requiredState: "integrated",
      receipts: [...DEPENDENCY_RECEIPTS],
    })),
    allowedPaths: [...task.allowedPaths],
    resources: task.resources.map((resource) => ({ ...resource })),
    execution: structuredClone(task.execution),
    acceptance: structuredClone(task.acceptance),
  };
  const scheduling = sha256({
    id: node.id,
    sourceOrder: node.sourceOrder,
    dependencies: node.dependencies,
    allowedPaths: node.allowedPaths,
    resources: node.resources,
    agent: node.execution.agent,
  });
  const semantics = sha256({
    id: node.id,
    title: node.title,
    body: node.body,
    execution: node.execution,
    acceptance: node.acceptance,
  });
  const full = sha256(node);
  const effective = sha256({ contextHash, verificationHash, full });
  return { ...node, hashes: { scheduling, semantics, full, effective } };
});
const edges = plan.tasks.flatMap((task) => task.deps.map((from) => ({ from, to: task.id })));
const graphHash = sha256({
  resourceCapacities: sortedRecord(plan.resourceCapacities),
  edges,
  schedulingHashes: nodes.map((node) => node.hashes.scheduling),
});
const root = {
  version: PLAN_IR_V3,
  source,
  title: plan.title,
  instructions: plan.instructions,
  executionPolicy,
  verification,
  resourceCapacities: sortedRecord(plan.resourceCapacities),
  nodes,
  edges,
};
const hashes = { context: contextHash, verification: verificationHash, graph: graphHash };
const full = sha256({ root, hashes });
return assertPlanIRV3(deepFreeze({ ...root, hashes: { ...hashes, full }, hash: full }));
```

在构造完整依赖对象之前，继续用现有字符串 deps scheduling view 调用 `assertNoConcurrentOwnershipConflicts()`；不改变当前路径冲突语义。

`views.mjs` 只导出无状态 selector：

```javascript
export function selectSchedulingView(ir) {
  return {
    resourceCapacities: ir.resourceCapacities,
    nodes: ir.nodes.map((node) => ({
      id: node.id,
      deps: node.dependencies.map(({ taskId }) => taskId),
      allowedPaths: node.allowedPaths,
      resources: node.resources,
      agent: node.execution.agent,
    })),
  };
}

export function selectExecutionView(ir, taskId) {
  const task = ir.nodes.find((node) => node.id === taskId);
  if (!task) throw new Error(`unknown IR task: ${taskId}`);
  return { plan: { title: ir.title, instructions: ir.instructions, executionPolicy: ir.executionPolicy }, task };
}

export function selectVerificationView(ir, taskId) {
  const task = ir.nodes.find((node) => node.id === taskId);
  if (!task) throw new Error(`unknown IR task: ${taskId}`);
  return { commands: ir.verification.commands, requiredGates: ir.verification.requiredGates, acceptance: task.acceptance };
}
```

selector 返回普通临时 view，不增加 `version/hash`，不持久化。

- [ ] **Step 5: 运行 IR 测试到 GREEN 并提交**

```bash
node --test test/plan-document.test.mjs test/plan-ir.test.mjs test/plan-ir-schema.test.mjs
git add scripts/lib/plan/ir test/plan-ir.test.mjs test/plan-ir-schema.test.mjs
git commit -m "feat(plan): 编译完整单一 v3 IR"
```

Expected: PASS，hash 变更矩阵逐项符合冻结规则。

### Task 3: 在 worktree 外冻结初始 Plan revision

**Deps:** Task 2

**Files:**
- Create: `scripts/lib/plan/plan-revision-store.mjs`
- Modify: `scripts/lib/plan/plan-launcher-extension.mjs`
- Modify: `scripts/lib/plan/plan-host-runtime.mjs`
- Create: `test/plan-revision-store.test.mjs`
- Modify: `test/plan-launcher-extension.test.mjs`
- Modify: `test/plan-host-runtime.test.mjs`

- [ ] **Step 1: 写原始字节冻结和 worktree 隔离失败测试**

在 `test/plan-revision-store.test.mjs` 用包含 CRLF 和行尾空格的 source Buffer 调用 store，断言：

```javascript
const prepared = await store.prepareRevision({
  planId: "plan-1",
  sourceBytes,
  reason: "initial-approval",
  initiator: { kind: "launcher" },
});
assert.equal(prepared.revision, 1);
assert.deepEqual(await readFile(prepared.sourcePath), sourceBytes);
assert.equal(prepared.manifest.sourceBytesSha256, sha256(sourceBytes));
assert.equal(prepared.manifest.planHash, prepared.plan.sha256);
assert.equal(prepared.manifest.irHash, prepared.ir.hash);
assert.equal((await stat(prepared.sourcePath)).mode & 0o777, 0o600);
assert.equal((await stat(prepared.directory)).mode & 0o777, 0o700);
await assert.rejects(access(path.join(worktree, ".pi-plan-runtime", "approved-plan.md")));
```

增加 crash matrix：只存在临时目录时 `readCurrent()` 返回 null；完整 revision 无 event/current pointer 时可读取但不成为 current；相同字节重复 prepare 幂等；相同 revision 不同字节拒绝。

- [ ] **Step 2: 运行 revision/launcher 测试确认 RED**

```bash
node --test test/plan-revision-store.test.mjs test/plan-launcher-extension.test.mjs test/plan-host-runtime.test.mjs
```

Expected: FAIL，`plan-revision-store.mjs` 不存在，Launcher 仍把 Plan 映射或复制到 worktree。

- [ ] **Step 3: 实现不可变 revision store**

新模块固定公开以下 API：

```javascript
export function createPlanRevisionStore({ stateRoot, now = () => new Date().toISOString() }) {
  return Object.freeze({
    prepareRevision,
    readRevision,
    readCurrent,
    writeCurrent,
    reconcileCurrent,
  });
}
```

路径和原子写 helper 固定为：

```javascript
function revisionDirectory(stateRoot, planId, revision) {
  if (!PLAN_ID.test(planId) || planId.includes("..") || !Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("invalid Plan revision identity");
  }
  return path.join(stateRoot, "var", "plan-runs", planId, "revisions", String(revision).padStart(6, "0"));
}

async function writePrivate(file, bytes) {
  await writeFile(file, bytes, { mode: 0o600, flag: "wx" });
}
```

`prepareRevision()` 接收不超过 1 MiB 的 Buffer，先用 UTF-8 decoder fatal mode 验证，再调用唯一 parser/compiler。v3 revision 取自文档；v1/v2 只允许 Launcher 创建 revision 1，不能 amendment。可选 `expectedIrHash` 用于 amendment service 对二次编译结果做一致性校验。IR artifact 与兼容 task identity 按以下规则生成：

```javascript
function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashCanonical(value) {
  return sha256Bytes(Buffer.from(JSON.stringify(value), "utf8"));
}

function revisionTaskHashes(ir) {
  return Object.fromEntries(ir.nodes.map((node) => {
    if (ir.version === "plan-ir.v3") {
      return [node.id, {
        full: node.hashes.full,
        effective: node.hashes.effective,
        scheduling: node.hashes.scheduling,
      }];
    }
    const full = hashCanonical(node);
    return [node.id, {
      full,
      effective: full,
      scheduling: ir.nodeFingerprints?.[node.id] ?? full,
    }];
  }));
}

const irArtifact = Buffer.from(`${JSON.stringify(ir, null, 2)}\n`, "utf8");
const irArtifactSha256 = sha256Bytes(irArtifact);
const irHash = ir.hash ?? irArtifactSha256;
```

因此新 launch 的 v1/v2 也有 revision/event identity，但不会获得 v3 缺失的业务语义。Store 在 `revisions/.candidate-<revision>-<uuid>` 写 `source.md/plan-ir.json/manifest.json`，逐文件回读并校验 hash，最后 rename 到正式目录。正式目录已存在时，先回读并校验 source bytes、IR hash、reason 和 initiator，直接返回原 manifest/createdAt；不得用新的时间戳重写。并发 rename 遇到已存在目标时执行同一比较，只有所有字段一致才视为幂等成功，任何差异都 fail closed。

`writeCurrent()` 使用同目录临时文件加 rename，内容固定为：

```javascript
{
  schemaVersion: "plan-revision-pointer.v1",
  planId,
  revision: manifest.revision,
  manifestSha256,
  irHash: manifest.irHash,
}
```

- [ ] **Step 4: Launcher 启动前准备 revision，不再复制 Plan**

`launchPlan()` 对原始 bytes 只读取一次，并把编译完全交给 revision store：

```javascript
const sourceBytes = await readFile(planPath);
const prepared = await revisionStore.prepareRevision({
  planId,
  sourceBytes,
  reason: "initial-approval",
  initiator: { kind: "launcher" },
});
const { plan, ir } = prepared;
```

删除 `planPathInWorktree()`、`copyFile()` 和 `.pi-plan-runtime/approved-plan.md`。Host bootstrap 不传任意文件路径，改传 revision identity：

```javascript
{
  planId,
  revision: prepared.revision,
  manifestSha256: prepared.manifestSha256,
  planIrHash: prepared.manifest.irHash,
  baseCommit,
  originRoot,
  stateRoot,
  cwd: worktree,
}
```

`plan_open` 根据受信 `stateRoot + planId + revision` 调用 `revisionStore.readRevision()`，再比较 manifest/IR hash。`trustedHandle()` 验证 handle 中的 revision identity 和 hash；handle 不携带 source/IR 任意绝对路径。

- [ ] **Step 5: 运行测试到 GREEN 并提交**

```bash
node --test test/plan-revision-store.test.mjs test/plan-launcher-extension.test.mjs test/plan-host-runtime.test.mjs
git add scripts/lib/plan/plan-revision-store.mjs scripts/lib/plan/plan-launcher-extension.mjs scripts/lib/plan/plan-host-runtime.mjs test/plan-revision-store.test.mjs test/plan-launcher-extension.test.mjs test/plan-host-runtime.test.mjs
git commit -m "feat(plan): 在状态目录冻结批准 revision"
```

Expected: PASS；untracked/dirty Plan 的批准字节都只进入 stateRoot。若 base commit 本身跟踪同路径文件，worktree 中该历史版本可以存在，但 runtime 不读取、不覆盖，也不把它当批准事实。

### Task 4: 建立单写者 Plan Event Writer

**Deps:** Task 2

**Files:**
- Create: `scripts/lib/plan/plan-event-writer.mjs`
- Modify: `scripts/lib/plan/coordinator.mjs`
- Modify: `scripts/lib/plan/plan-capsule-extension.mjs`
- Modify: `scripts/lib/plan/plan-runner-dependencies.mjs`
- Create: `test/plan-event-writer.test.mjs`
- Modify: `test/plan-coordinator.test.mjs`
- Modify: `test/plan-capsule-extension.test.mjs`
- Modify: `test/plan-runner-dependencies.test.mjs`

- [ ] **Step 1: 写并发 CAS 和 reducer-before-append 失败测试**

构造两个并发 append 都声明 `expectedProjectionVersion:1`：

```javascript
const [cancelled, bound] = await Promise.allSettled([
  writer.append({ expectedProjectionVersion: 1, type: "plan.cancelled", data: { reason: "parent_cancel" } }),
  writer.append({ expectedProjectionVersion: 1, type: "attempt.bound", data: bindingData }),
]);
assert.equal([cancelled, bound].filter((result) => result.status === "fulfilled").length, 1);
assert.equal(entries.length, 2);
assert.doesNotThrow(() => replay(entries));
```

再断言 reducer 拒绝的 Attention kind、终态后事件和 stale version 都不会调用底层 append。

- [ ] **Step 2: 运行 Event Writer 测试确认 RED**

```bash
node --test test/plan-event-writer.test.mjs
```

Expected: FAIL，`createPlanEventWriter` 尚不存在。

- [ ] **Step 3: 实现进程内单写者和 version CAS**

```javascript
export function createPlanEventWriter({ readEntries, append, id, now }) {
  let tail = Promise.resolve();
  function submit(operation) {
    const result = tail.then(operation, operation);
    tail = result.catch(() => {});
    return result;
  }
  return Object.freeze({
    append({ expectedProjectionVersion, planId, type, data }) {
      return submit(async () => {
        const projection = replay(await readEntries());
        if (projection.version !== expectedProjectionVersion) {
          throw Object.assign(new Error("Plan projection version conflict"), { code: "PROJECTION_CONFLICT" });
        }
        const effectivePlanId = projection.planId ?? planId;
        if (typeof effectivePlanId !== "string" || !effectivePlanId) throw new Error("Plan event planId is unavailable");
        const entry = {
          schemaVersion: "pi-plan-event.v1",
          eventId: id(),
          planId: effectivePlanId,
          occurredAt: now(),
          type,
          data,
        };
        applyEvent(projection, entry);
        await append(entry);
        return entry;
      });
    },
  });
}
```

底层 `append` 只能由该 writer 持有；`plan-runner-dependencies` 创建唯一 writer 并注入 Coordinator/Capsule。Coordinator、control timer、Attention 和 amendment 不得保留旧 projection 后直接 append；每次 writer 成功后重新 replay 获取 projection。

- [ ] **Step 4: 覆盖 spawn/cancel 真实交错序列**

测试使用 deferred spawn：先写 `dispatch-requested`，在 spawn 未返回时 append cancel，再让 spawn 返回。Coordinator 返回路径必须重新读取 projection；若 Plan 已 cancelled，不写 `attempt.bound`，而是 stop 已启动 run 并记录 cleanup evidence。最终日志 replay 必须成功。

- [ ] **Step 5: 运行测试到 GREEN 并提交**

```bash
node --test test/plan-event-writer.test.mjs test/plan-events.test.mjs test/plan-coordinator.test.mjs test/plan-capsule-extension.test.mjs test/plan-runner-dependencies.test.mjs
git add scripts/lib/plan/plan-event-writer.mjs scripts/lib/plan/coordinator.mjs scripts/lib/plan/plan-capsule-extension.mjs scripts/lib/plan/plan-runner-dependencies.mjs test/plan-event-writer.test.mjs test/plan-coordinator.test.mjs test/plan-capsule-extension.test.mjs test/plan-runner-dependencies.test.mjs
git commit -m "feat(plan): 增加事件单写者版本栅栏"
```

Expected: PASS，同一个 expected version 不可能提交两个互相冲突的事件。

### Task 5: 用事件绑定 Plan revision 身份

**Deps:** Task 3, Task 4

**Files:**
- Modify: `scripts/lib/plan/plan-events.mjs`
- Modify: `scripts/lib/plan/plan-capsule-extension.mjs`
- Modify: `scripts/lib/plan/plan-projection.mjs`
- Modify: `scripts/lib/plan/plan-runner-dependencies.mjs`
- Modify: `test/plan-events.test.mjs`
- Modify: `test/plan-projection.test.mjs`
- Modify: `test/plan-capsule-extension.test.mjs`
- Modify: `test/plan-runner-dependencies.test.mjs`

- [ ] **Step 1: 写 Plan revision 和 Attempt IR identity 失败测试**

扩展 v3 `plan.created` 测试，要求：

```javascript
const revisionIdentity = {
  number: 1,
  manifestSha256: "a".repeat(64),
  sourceBytesSha256: "b".repeat(64),
  planHash: "c".repeat(64),
  irVersion: "plan-ir.v3",
  irHash: "d".repeat(64),
  taskHashes: {
    "task-1": {
      full: "e".repeat(64),
      effective: "9".repeat(64),
      scheduling: "f".repeat(64),
    },
  },
};
assert.deepEqual(projection.revision, revisionIdentity);
```

v3 workspace 不再包含 `planPath/planHash`；所有新 launch 通过 revision identity 绑定 v1/v2/v3 IR，只有历史 legacy plan.created 继续接受旧 workspace。扩展 `attempt.dispatch-requested`，要求 `planIrHash/taskHash/schedulingHash/dispatchContextHash` 均为 SHA-256，并分别断言 effective 或 scheduling hash 与当前 revision task hash 不一致时 reducer 拒绝事件。

- [ ] **Step 2: 运行事件测试确认 RED**

```bash
node --test test/plan-events.test.mjs test/plan-projection.test.mjs test/plan-capsule-extension.test.mjs test/plan-runner-dependencies.test.mjs
```

Expected: FAIL，projection 尚未保存 IR identity，dispatch event 尚未验证 task hash。

- [ ] **Step 3: 扩展 plan.created 和 dispatch reducer**

v3 `plan.created.data` 增加：

```javascript
revision: {
  number: binding.revision.manifest.revision,
  manifestSha256: binding.revision.manifestSha256,
  sourceBytesSha256: binding.revision.manifest.sourceBytesSha256,
  planHash: binding.revision.manifest.planHash,
  irVersion: binding.revision.ir.version,
  irHash: binding.revision.ir.hash,
  taskHashes: structuredClone(binding.revision.manifest.taskHashes),
}
```

`createPlan()` 对 v3 revision identity 做严格 SHA、revision、Task 精确覆盖校验并保存到 projection。v3 workspace 只保存 `originRoot/worktree/baseCommit/headCommit`。新增本地 SHA validator，并让 `requestDispatch()` 校验：

```javascript
function requireSha256(data, field) {
  if (typeof data?.[field] !== "string" || !/^[a-f0-9]{64}$/.test(data[field])) {
    throw new Error(`invalid ${field}`);
  }
}

if (data.planIrHash !== projection.revision.irHash) throw new Error("dispatch plan IR hash does not match");
const expectedTask = projection.revision.taskHashes[data.taskId];
if (data.taskHash !== expectedTask?.effective) throw new Error("dispatch task hash does not match");
if (data.schedulingHash !== expectedTask?.scheduling) throw new Error("dispatch scheduling hash does not match");
requireSha256(data, "dispatchContextHash");
```

旧 plan.created 没有 `ir` 时保持 legacy projection，不要求新字段。

- [ ] **Step 4: 在 Capsule open 时写入已验证 IR identity**

`validateBinding()` 在 `plan-runner-dependencies.mjs` 中根据受信 `stateRoot + planId + revision` 读取 revision store，校验 manifestSha256/planIrHash，并返回 `binding.revision`。`plan_open` 参数固定为：

```javascript
{
  type: "object",
  properties: {
    planId: STRING,
    revision: { type: "integer", minimum: 1 },
    manifestSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    planIrHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    baseCommit: STRING,
    worktree: STRING,
    allowPlanCommits: { type: "boolean", const: true },
  },
  required: ["planId", "revision", "manifestSha256", "planIrHash", "baseCommit", "worktree", "allowPlanCommits"],
  additionalProperties: false,
}
```

`plan_open` 不接受 planPath，也不重新解析 worktree 文件；它通过 Event Writer 调用 `append({expectedProjectionVersion:0, planId, type:"plan.created", data})`，成功后调用 `revisionStore.writeCurrent()`。Projection status 只公开 revision number、manifest/IR hash，不把完整 Task body 写入状态文件。

- [ ] **Step 5: 运行事件测试到 GREEN 并提交**

```bash
node --test test/plan-events.test.mjs test/plan-projection.test.mjs test/plan-capsule-extension.test.mjs test/plan-runner-dependencies.test.mjs
git add scripts/lib/plan/plan-events.mjs scripts/lib/plan/plan-capsule-extension.mjs scripts/lib/plan/plan-projection.mjs scripts/lib/plan/plan-runner-dependencies.mjs test/plan-events.test.mjs test/plan-projection.test.mjs test/plan-capsule-extension.test.mjs test/plan-runner-dependencies.test.mjs
git commit -m "feat(plan): 用事件绑定 revision 执行身份"
```

Expected: PASS，legacy 事件测试继续通过。

### Task 6: 实现 Supervisor 驱动的 plan_amend

**Deps:** Task 5

**Files:**
- Create: `scripts/lib/plan/plan-amendment.mjs`
- Modify: `scripts/lib/plan/plan-events.mjs`
- Modify: `scripts/lib/plan/plan-capsule-extension.mjs`
- Modify: `scripts/lib/plan/plan-runner-dependencies.mjs`
- Modify: `scripts/lib/plan/pi-subagents-execution-backend.mjs`
- Modify: `scripts/lib/plan/attempt-workspace.mjs`
- Modify: `pi/agents/plan-runner.md`
- Create: `test/plan-amendment.test.mjs`
- Modify: `test/plan-events.test.mjs`
- Modify: `test/plan-capsule-extension.test.mjs`
- Modify: `test/plan-runner-dependencies.test.mjs`
- Modify: `test/plan-attempt-workspace.test.mjs`

- [ ] **Step 1: 写 IR diff、历史保护和 supersede 失败测试**

在 `test/plan-amendment.test.mjs` 固定以下矩阵：

```javascript
assert.deepEqual(diffPlanRevisions(oldIr, bodyChangedIr), {
  added: [], changed: ["task-2"], rebound: [], retired: [], unchanged: ["task-1"],
});
assert.deepEqual(diffPlanRevisions(oldIr, globalContextChangedIr), {
  added: [], changed: [], rebound: ["task-1", "task-2"], retired: [], unchanged: [],
});
assert.throws(
  () => validateAmendment({ projection: acceptedTaskProjection, oldIr, newIr: acceptedTaskChangedIr }),
  /accepted task contract is immutable: task-1/,
);
assert.doesNotThrow(() => validateAmendment({
  projection: acceptedTaskProjection,
  oldIr,
  newIr: addRepairTaskIr,
}));
assert.deepEqual(
  validateAmendment({ projection: activeTaskProjection, oldIr, newIr: activeTaskChangedIr }).supersededAttemptIds,
  ["attempt-task-2-1"],
);
assert.throws(
  () => validateAmendment({ projection: activeResourceProjection, oldIr, newIr: capacityBelowClaimsIr }),
  /resource capacity is below active claims/,
);
```

再测试 revision 链不匹配、未知或仍 pending/nonblocking 的 Supervisor request、同一 request 重复 amendment、删除 accepted Task、复用 retired Task ID 全部拒绝且不写 revision/event。

- [ ] **Step 2: 运行 amendment 测试确认 RED**

```bash
node --test test/plan-amendment.test.mjs test/plan-events.test.mjs test/plan-capsule-extension.test.mjs
```

Expected: FAIL，`plan-amendment.mjs` 和 `plan_amend` 尚不存在。

- [ ] **Step 3: 实现 revision diff 和历史不变量**

```javascript
export function diffPlanRevisions(oldIr, newIr) {
  const oldById = new Map(oldIr.nodes.map((node) => [node.id, node]));
  const newById = new Map(newIr.nodes.map((node) => [node.id, node]));
  const added = [...newById.keys()].filter((id) => !oldById.has(id)).sort();
  const retired = [...oldById.keys()].filter((id) => !newById.has(id)).sort();
  const changed = [...oldById.keys()]
    .filter((id) => newById.has(id) && oldById.get(id).hashes.full !== newById.get(id).hashes.full)
    .sort();
  const rebound = [...oldById.keys()]
    .filter((id) => newById.has(id)
      && oldById.get(id).hashes.full === newById.get(id).hashes.full
      && oldById.get(id).hashes.effective !== newById.get(id).hashes.effective)
    .sort();
  const unchanged = [...oldById.keys()]
    .filter((id) => newById.has(id) && oldById.get(id).hashes.effective === newById.get(id).hashes.effective)
    .sort();
  return { added, changed, rebound, retired, unchanged };
}
```

`validateAmendment()` 检查：accepted/integrated Task 必须在 new IR 中存在且局部 full hash 不变，允许它们在全局 context/verification 变化时 carry-forward；retired 仅允许 pending 且从未分配 Attempt 的 Task；新增 ID 不得出现在 projection 历史；active/waiting task effective hash 变化时收集 attemptId；新 capacity 必须覆盖 projection 中未释放 resource claims。返回：

```javascript
{
  diff,
  supersededAttemptIds: [...supersededAttemptIds].sort(),
  taskHashes: Object.fromEntries(newIr.nodes.map((node) => [
    node.id,
    { full: node.hashes.full, effective: node.hashes.effective, scheduling: node.hashes.scheduling },
  ])),
}
```

事件 payload helper 固定为：

```javascript
function amendmentEventData(prepared, validated, input) {
  return {
    revision: prepared.manifest.revision,
    parentRevision: prepared.manifest.parentRevision,
    manifestSha256: prepared.manifestSha256,
    sourceBytesSha256: prepared.manifest.sourceBytesSha256,
    planHash: prepared.manifest.planHash,
    irHash: prepared.manifest.irHash,
    taskHashes: validated.taskHashes,
    diff: validated.diff,
    supersededAttemptIds: validated.supersededAttemptIds,
    requestId: input.requestId,
    reason: input.reason,
  };
}
```

- [ ] **Step 4: 实现 prepare -> event commit -> pointer -> supersede 协议**

`plan.amended` reducer 先拒绝 legacy projection、非法 requestId/超过 4096 UTF-8 bytes 的 reason、错 revision 链、已存在于 `projection.amendmentRequestIds` 的 requestId，以及任一尚未完成 cleanup 的 `supersede-requested` Attempt；严格重算 diff/hash 关系后，原子更新 projection revision/taskHashes、增加 added Task、把允许删除的 pending Task 标记为 `retired`、把 requestId 加入已消费集合，并把列出的合同 Attempt 改为 `{status:"supersede-requested", supersededTaskHash:<old effective hash>, supersededByRevision:<new revision>}`。`retired` ID 永久保留用于禁止复用，但不再参与 frontier。accepted/integrated Task 的 full hash 改变或删除必须由 reducer 再次拒绝，不能只依赖 service 预校验。

`createPlanAmendmentService()` 固定依赖和入口：

```javascript
export function createPlanAmendmentService({ revisionStore, eventWriter, currentProjection, supersedeAttempt }) {
  return Object.freeze({ amend });

  async function amend(input) {
    if (!Number.isSafeInteger(input.expectedProjectionVersion) || input.expectedProjectionVersion < 1) throw new Error("Plan projection version is invalid");
    const projection = currentProjection();
    if (projection.version !== input.expectedProjectionVersion) throw new Error("Plan projection version conflict");
    if (projection.revision.number !== input.baseRevision) throw new Error("Plan base revision is stale");
    const sourceMatches = [...projection.attempts.entries()].filter(([, attempt]) =>
      attempt.attention?.requestId === input.requestId
      && attempt.attention.status === "resolved"
      && attempt.attention.blocking === true
    );
    if (sourceMatches.length !== 1) throw new Error("Plan amendment requires exactly one resolved blocking Supervisor request");
    const [sourceAttemptId, sourceAttempt] = sourceMatches[0];

    const current = await revisionStore.readRevision(projection.planId, input.baseRevision);
    if (!current || current.planId !== projection.planId || current.revision !== projection.revision.number
      || current.manifestSha256 !== projection.revision.manifestSha256
      || current.manifest.planId !== projection.planId || current.manifest.revision !== projection.revision.number
      || current.manifest.sourceBytesSha256 !== projection.revision.sourceBytesSha256
      || current.manifest.planHash !== projection.revision.planHash
      || current.manifest.irVersion !== projection.revision.irVersion
      || current.manifest.irHash !== projection.revision.irHash
      || current.ir.version !== projection.revision.irVersion || current.ir.hash !== projection.revision.irHash) {
      throw new Error("Plan amendment current revision identity does not match projection");
    }
    const sourceBytes = Buffer.from(input.source, "utf8");
    if (sourceBytes.length === 0 || !input.source.trim() || sourceBytes.length > 1024 * 1024) throw new Error("Plan amendment source is invalid");
    const parsed = parsePlanDocument(input.source, current.sourcePath);
    if (parsed.revision !== input.baseRevision + 1 || parsed.parentPlanHash !== current.manifest.planHash) {
      throw new Error("Plan amendment revision chain does not match");
    }
    const nextIr = compilePlanToIR(parsed);
    const validated = validateAmendment({ projection, oldIr: current.ir, newIr: nextIr });
    const prepared = await revisionStore.prepareRevision({
      planId: projection.planId,
      sourceBytes,
      expectedIrHash: nextIr.hash,
      reason: input.reason,
      initiator: {
        kind: "supervisor-request",
        requestId: input.requestId,
        taskId: sourceAttempt.taskId,
        attemptId: sourceAttemptId,
        runId: sourceAttempt.runId,
      },
    });
    await eventWriter.append({
      expectedProjectionVersion: input.expectedProjectionVersion,
      planId: projection.planId,
      type: "plan.amended",
      data: amendmentEventData(prepared, validated, input),
    });
    await revisionStore.writeCurrent(prepared);
    const errors = [];
    for (const attemptId of validated.supersededAttemptIds) {
      try {
        const attempt = projection.attempts.get(attemptId);
        const expectedTaskHash = attempt.taskHash ?? projection.revision.taskHashes[attempt.taskId].effective;
        await supersedeAttempt({ attemptId, expectedTaskHash });
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Plan amendment committed with pending Attempt supersede cleanup");
    return { revision: prepared.revision, irHash: nextIr.hash, ...validated };
  }
}
```

`plan.amended` reducer 在切换状态前为每个目标 Attempt 冻结 `supersededFromStatus`、旧 revision 的 `supersededTaskHash` 和目标 `supersededByRevision`；已有 `attempt.taskHash` 必须等于旧 effective hash，否则整个 amendment fail closed。`supersedeAttempt()` 由 `plan-runner-dependencies.mjs` 装配，并按已排序 attemptId 串行调用：每个 callback 可并行等待自己的 runtime facts，但跨 Attempt 的领域事件提交必须顺序读取最新 projection version；一个 callback 失败时收集错误并继续后续 Attempt，最后抛 AggregateError。各 callback 按持久状态处理：`workspace-allocated` 在确认无 dispatch intent 后直接提交 never-started proof；`dispatch-requested` 先让 backend 以 dispatchId 建立 late-start cancel fence，spawn reply/started event 任何一方到达都 stop；`active/waiting-attention` stop 后等待 official terminal artifact；`succeeded/validated` 只验证已有 terminal artifact，不重复 stop。

取得 proof 后通过 Event Writer 追加严格事件：

```javascript
{
  type: "attempt.superseded",
  data: {
    attemptId,
    taskId,
    supersededByRevision: projection.revision.number,
    oldTaskHash: attempt.supersededTaskHash,
    evidence: neverStarted
      ? { kind: "never-started", dispatchId: attempt.dispatchId ?? null }
      : { kind: "terminal", dispatchId: attempt.dispatchId ?? null, runId: attempt.runId, asyncDir: attempt.asyncDir, artifactSha256 },
  },
}
```

Reducer 要求 Attempt 正处于 `supersede-requested`、revision/old hash/run binding 与投影一致，再改为 `superseded`；若 Attempt 原状态是 `waiting-attention`，`plan.amended` 同一原子事件把未 resolved blocking Attention 标为 `status:"superseded" + supersededByRevision`，保留 request/evidence 但不伪造 reply 或 resolution。随后追加 `attempt.workspace-released`。disposition 只能是：确认 never-started、无 resultCommit 且 workspace clean 时用 `superseded-cleanup`；任何已启动 run、dirty workspace 或 `succeeded/validated` 用 `superseded-preserve`。`attempt-workspace.mjs` 为两者都只允许 derived status=`superseded` 且 workspaceReleased/disposition 完全匹配；cleanup 才物理删除 clean worktree/branch，preserve 只释放逻辑 lease/resource 并保留物理 worktree/branch 作为证据。其他状态/disposition 拒绝。`supersede-requested/superseded` 在 workspace release event 前继续阻止下一轮 amendment、同 Task allocation、HEAD observation 和 Plan validation，event 后才允许新 hash 派发。任一步失败都保留当前持久状态供恢复，不能重新派发旧/new hash Attempt。

`pi-subagents-execution-backend.mjs` 增加按 dispatchId 的 `supersede()`：pending entry 先标记 cancelling；若尚未 bound，lifecycle/start reply 后立即 stop；若已 bound，幂等 stop；零个/多个匹配或 reply 丢失进入 `dispatch_uncertain`。stop RPC 返回和 `running/queued/stopping` 均不是 terminal proof；只有 binding 校验后的 stable status `complete/failed/paused/stopped` 才返回，对规范化 status value 做确定性 SHA256 作为 `artifactSha256`。不得把 pre-bind Attempt 当成 `{runId:undefined}` 调用普通 stop。超时后 cancel fence 仍保留，后到的 start 仍自动 stop；失败的单次 proof promise 不得永久缓存，后续恢复可重试并复用已取得 binding/terminal proof。

恢复时，已 bound Attempt 通过 `recoverBinding()` 注入 event 中持久化且与当前 Plan session 完全相等的 sessionFile；旧 null/跨 session identity fail closed。未 bound 的 `dispatch-requested` 通过 `recoverDispatch()` 严格重建完整 normalized spawn request，只注册 unbound cancelling entry，绝不再次调用 spawn。恢复扫描所有 `supersede-requested` 并重复同一状态机，直到 `attempt.superseded + attempt.workspace-released` durable。

- [ ] **Step 5: 注册受限 revision tools 并提交**

Capsule 先注册无参数只读工具：

```javascript
{
  name: "plan_read_revision",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async execute(_id, _input, _signal, _update, ctx) {
    return result(await options.readCurrentRevision({ ctx }));
  },
}
```

`readCurrentRevision()` 从 projection 取得 current revision identity，再通过 revision store 回读并校验 manifest/IR hash，只返回 `{revision, planHash, irHash, source}`。它不接受 revision number、路径或 hash override，避免模型读取 orphan/未提交 candidate。

同时从 `pi/agents/plan-runner.md` 和 Capsule active tools 删除 `bash`；Plan Runner 只通过 revision tools 访问合同，Integration Queue 仍是 accumulator 唯一写者。测试断言 `bash` 调用被 tool hook 拒绝。

Capsule 再注册 amendment schema：

```javascript
{
  name: "plan_amend",
  parameters: {
    type: "object",
    properties: {
      expectedProjectionVersion: { type: "integer", minimum: 1 },
      baseRevision: { type: "integer", minimum: 1 },
      requestId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
      reason: { type: "string", minLength: 1, maxLength: 4096 },
      source: { type: "string", minLength: 1, maxLength: 1048576 }
    },
    required: ["expectedProjectionVersion", "baseRevision", "requestId", "reason", "source"],
    additionalProperties: false
  }
}
```

它只调用 `amendPlan()`，不接受 IR JSON、task patch、路径覆盖或 hash override。`pi/agents/plan-runner.md` 明确规定：收到需要更新合同的 Supervisor request 后，先调用 `plan_read_revision`，生成完整 revision N+1 source，再调用 `plan_amend`；禁止用 `bash` 读取或写入 revision store。运行并提交：

```bash
node --test test/plan-amendment.test.mjs test/plan-events.test.mjs test/plan-capsule-extension.test.mjs test/plan-runner-dependencies.test.mjs test/plan-attempt-workspace.test.mjs
git add scripts/lib/plan/plan-amendment.mjs scripts/lib/plan/plan-events.mjs scripts/lib/plan/plan-capsule-extension.mjs scripts/lib/plan/plan-runner-dependencies.mjs scripts/lib/plan/pi-subagents-execution-backend.mjs scripts/lib/plan/attempt-workspace.mjs pi/agents/plan-runner.md test/plan-amendment.test.mjs test/plan-events.test.mjs test/plan-capsule-extension.test.mjs test/plan-runner-dependencies.test.mjs test/plan-attempt-workspace.test.mjs
git commit -m "feat(plan): 支持 Supervisor 更新 Plan revision"
```

Expected: PASS；旧 revision 保持可读，changed/rebound active Attempt 不会以旧 effective task hash 继续运行。

### Task 7: 让 Coordinator 完整消费当前 revision IR

**Deps:** Task 5, Task 6

**Files:**
- Modify: `scripts/lib/plan/coordinator.mjs`
- Modify: `scripts/lib/plan/ir/frontier.mjs`
- Modify: `scripts/lib/plan/ir/views.mjs`
- Modify: `scripts/lib/plan/plan-runner-dependencies.mjs`
- Modify: `test/plan-coordinator.test.mjs`
- Modify: `test/plan-resource-locks.test.mjs`
- Modify: `test/plan-ir-schema.test.mjs`
- Modify: `test/plan-runner-dependencies.test.mjs`

- [ ] **Step 1: 写完整 Executor prompt 与 hash 绑定失败测试**

把 Coordinator fixture 改为传入编译后的 v3 IR，断言 spawn task 同时包含：

```javascript
assert.match(spawned[0].task, /Plan: Complete IR plan/);
assert.match(spawned[0].task, /Plan instructions:\nPreserve all approved semantics/);
assert.match(spawned[0].task, /Task body:\n\*\*Files:\*\*/);
assert.match(spawned[0].task, /Write the failing semantic test first/);
assert.match(spawned[0].task, /Acceptance: commands/);
assert.match(spawned[0].task, /plan:test/);
assert.equal(intent.data.planIrHash, ir.hash);
assert.equal(intent.data.taskHash, ir.nodes[0].hashes.effective);
assert.equal(intent.data.schedulingHash, ir.nodes[0].hashes.scheduling);
assert.match(intent.data.dispatchContextHash, /^[a-f0-9]{64}$/);
```

再构造依赖 Task 已 integrated 的 projection，断言下游 prompt 与 dispatch context 包含有界 receipt：

```javascript
assert.match(spawned[0].task, /Dependency receipts:/);
assert.match(spawned[0].task, /"resultCommit":"dep-commit"/);
assert.match(spawned[0].task, /"integratedHead":"integrated-head"/);
assert.match(spawned[0].task, /"changedPaths":\["src\/dep.mjs"\]/);
assert.match(spawned[0].task, /"verificationSummary":\[\{"commandId":"plan:test","exitCode":0\}\]/);
```

另测试只改变 Task body 会改变 prompt、taskHash 和 dispatchContextHash，但不改变 schedulingHash。向事件流追加 `plan.amended` revision 2 后，再调用 `coordinatorFor()`，断言新 dispatch 使用 revision 2 IR；缓存的 revision 1 IR 不得复用。

保留 v1/v2 回归：v1 `files` 被临时 scheduling selector 映射为 `allowedPaths` 且 resources 为空，v2 原样保留 ownership/resources；两者继续使用 legacy prompt，不生成第二套带 version/hash 的持久 IR。

- [ ] **Step 2: 运行 Coordinator 测试确认 RED**

```bash
node --test test/plan-coordinator.test.mjs test/plan-resource-locks.test.mjs
```

Expected: FAIL，当前 prompt 仍只有标题和 allowed paths。

- [ ] **Step 3: 删除 authorizationIR 降级对象并使用 selector**

`createPlanCoordinator` 改为接收已编译 `ir`，入口执行：

```javascript
if (!ir || !["plan-ir.v1", "plan-ir.v2", "plan-ir.v3"].includes(ir.version)) {
  throw new Error("compiled Plan IR is required");
}
const scheduling = ir.version === "plan-ir.v3"
  ? selectSchedulingView(ir)
  : selectLegacySchedulingView(ir);
```

`selectLegacySchedulingView()` 返回无 `version/hash` 的冻结临时对象；v1 把 `node.files` 映射为 `allowedPaths`、`resources:[]`、`resourceCapacities:{}`，v2 只 defensive-copy 既有调度字段。它不伪造完整 Task 语义，不持久化，也不成为第二套 IR。

`coordinatorFor()` 先重放 projection，再用 `projection.revision.number` 调用 `revisionStore.readRevision()`；读取结果的 manifest/IR hash 必须与 projection 完全一致。缓存 key 固定为 `${planId}:${revision}:${irHash}`，revision 更新后不可命中旧对象。Frontier 只消费 scheduling view；projection 中 `retired` Task 不进入 frontier，状态汇总把 retired 视为无需执行。v3 节点派发时通过 `selectExecutionView(ir, node.id)` 取得完整合同；v1/v2 走现有 legacy prompt，避免伪造缺失语义。

- [ ] **Step 4: 确定性渲染完整 v3 prompt**

新增 `collectDependencyReceipts()`，只从已 integrated Attempt 的 projection 生成有界、无本地路径的事实：

```javascript
function collectDependencyReceipts(projection, task) {
  return task.dependencies.map(({ taskId }) => {
    const match = [...projection.attempts.values()].find((attempt) =>
      attempt.taskId === taskId && attempt.status === "integrated"
    );
    if (!match?.resultCommit || !match.integration?.newHead) {
      throw new Error(`integrated dependency receipt is unavailable: ${taskId}`);
    }
    return {
      taskId,
      resultCommit: match.resultCommit,
      integratedHead: match.integration.newHead,
      changedPaths: [...(match.validationChangedPaths ?? [])],
      verificationSummary: (match.validationEvidence ?? [])
        .filter((item) => item.kind === "command")
        .map((item) => ({ commandId: item.commandId, exitCode: item.exitCode })),
    };
  });
}
```

新增 `buildV3ExecutionPrompt()`，固定章节顺序：Plan、Plan instructions、Task、Task body、Dependency receipts、Allowed paths、Resources、Execution、Acceptance、Result contract。动态值只允许 `attemptId/baseCommit/output/dependencyReceipts`：

```javascript
function buildV3ExecutionPrompt({ view, attemptId, baseCommit, output, dependencyReceipts }) {
  const { plan, task } = view;
  const blockedResult = {
    attempt_id: attemptId,
    task_id: task.id,
    status: "blocked",
    reason: "blocked-prerequisite",
    blockers: ["blocked-prerequisite"],
    changed_files: [],
    commit: null,
  };
  return [
    `Plan: ${plan.title}`,
    `Plan instructions:\n${plan.instructions}`,
    `Task: ${task.id} ${task.title}`,
    `Task body:\n${task.body}`,
    `Dependency receipts:\n${JSON.stringify(dependencyReceipts)}`,
    `Allowed paths:\n${task.allowedPaths.join("\n")}`,
    `Resources:\n${JSON.stringify(task.resources)}`,
    `Execution:\n${JSON.stringify(task.execution)}`,
    `Acceptance: ${task.acceptance.strategy}\n${JSON.stringify(task.acceptance)}`,
    `Attempt: ${attemptId}`,
    `Base commit: ${baseCommit}`,
    `Authoritative output: ${output}`,
    `Result contract: ${plan.executionPolicy.resultContract}`,
    `Blocked result shape: ${JSON.stringify(blockedResult)}`,
  ].join("\n\n");
}

const dependencyReceipts = collectDependencyReceipts(projection, task);
const dispatchContext = {
  planIrHash: ir.hash,
  taskHash: task.hashes.effective,
  schedulingHash: task.hashes.scheduling,
  attemptId,
  baseCommit: attemptBaseCommit,
  output,
  dependencyReceipts,
};
const dispatchContextHash = sha256(dispatchContext);
```

Dependency receipt 只传 commit、integrated head、changed paths 和命令退出摘要，不传 transcript、stdout/stderr 路径或命令输出。

`tool.timeoutMs` 使用 `task.execution.timeoutMs`，agent 使用 `task.execution.agent`。`attempt.dispatch-requested` 写入四个 hash，不把完整 body 复制进事件；`toolHash` 继续覆盖实际 transport payload。

- [ ] **Step 5: 运行 Coordinator 测试到 GREEN 并提交**

```bash
node --test test/plan-coordinator.test.mjs test/plan-resource-locks.test.mjs test/plan-ir-schema.test.mjs test/plan-events.test.mjs test/plan-runner-dependencies.test.mjs
git add scripts/lib/plan/coordinator.mjs scripts/lib/plan/ir/frontier.mjs scripts/lib/plan/ir/views.mjs scripts/lib/plan/plan-runner-dependencies.mjs test/plan-coordinator.test.mjs test/plan-resource-locks.test.mjs test/plan-ir-schema.test.mjs test/plan-events.test.mjs test/plan-runner-dependencies.test.mjs
git commit -m "feat(plan): 从完整 IR 派发 Executor"
```

Expected: PASS，Executor prompt 包含完整 Plan/Task 语义和验收合同。

### Task 8: 统一 Queue 与 v3 Gate 的 IR 消费

**Deps:** Task 7

**Files:**
- Modify: `scripts/lib/plan/gates.mjs`
- Modify: `scripts/lib/plan/attempt-validator.mjs`
- Modify: `scripts/lib/plan/plan-runner-dependencies.mjs`
- Modify: `test/plan-gates.test.mjs`
- Modify: `test/plan-attempt-validator.test.mjs`
- Modify: `test/plan-integration-queue.test.mjs`
- Modify: `test/plan-runner-dependencies.test.mjs`

- [ ] **Step 1: 写单一 IR 消费和前向依赖失败测试**

Gate 测试改为从 v3 IR 创建 registry：

```javascript
const registry = await createTaskCommandRegistry({ cwd, ir });
assert.deepEqual(resolveTaskVerification({ ir, taskId: "task-1", registry }), [
  {
    id: "plan:test",
    command: "node --test",
    cwd: ".",
    timeoutMs: 900_000,
  },
]);
```

再增加 Attempt validator 测试：命令在 `path.resolve(lease.path, command.cwd)` 运行，使用 `command.timeoutMs`；`../outside`、绝对 cwd、非正 timeout 都在执行前拒绝。

再保留一个 v2 legacy 测试，通过 `legacyPlan` 读取原 `verification/taskVerification`，证明旧 session 没有被重新解释为 v3。

增加合法前向依赖 Plan：源顺序 `task-1 -> depends task-2`，断言 Task 2 验证后 Queue 使用 `ir.nodes.map(node => node.id)` 集成 Task 2，再解锁 Task 1。

- [ ] **Step 2: 运行 Queue/Gate 测试确认 RED**

```bash
node --test test/plan-gates.test.mjs test/plan-integration-queue.test.mjs test/plan-runner-dependencies.test.mjs
```

Expected: FAIL，Gate 仍读取 parsed plan，Queue 仍使用 `plan.tasks` 源顺序。

- [ ] **Step 3: Gate 只读取 verification selector**

修改接口，对 v3 只读取 IR；v1/v2 使用显式命名的兼容输入：

```javascript
async function addPackageScripts(registry, cwd) {
  let packageJson;
  try {
    packageJson = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const name of Object.keys(packageJson?.scripts ?? {}).sort()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(name)) continue;
    registry.set(`package:${name}`, Object.freeze({
      id: `package:${name}`,
      command: `npm run ${name} --`,
    }));
  }
  return registry;
}

export async function createTaskCommandRegistry({ cwd, ir, legacyPlan }) {
  const approved = ir?.version === "plan-ir.v3"
    ? ir.verification.commands
    : (legacyPlan?.verification ?? []).map((command, index) => ({
        id: `contract:verification:${index + 1}`,
        command,
      }));
  const registry = new Map(approved.map((entry) => [entry.id, Object.freeze({ ...entry })]));
  return addPackageScripts(registry, cwd);
}

export function resolveTaskVerification({ ir, legacyPlan, taskId, registry }) {
  const v3 = ir?.version === "plan-ir.v3";
  const task = v3 ? ir.nodes.find((node) => node.id === taskId) : null;
  const acceptance = v3
    ? selectVerificationView(ir, taskId).acceptance
    : {
        strategy: "commands",
        commandIds: legacyPlan?.taskVerification?.[taskId] ?? [],
      };
  if (acceptance.strategy !== "commands") return [];
  return acceptance.commandIds.map((id) => {
    const command = registry.get(id);
    if (!command) throw new Error(`Task verification ID is not a registered command: ${id}`);
    if (!v3) return { id: command.id, command: command.command };
    return {
      id: command.id,
      command: command.command,
      cwd: command.cwd ?? ".",
      timeoutMs: command.timeoutMs ?? task.execution.timeoutMs,
    };
  });
}
```

`attempt-validator.mjs` 对 v3 command 使用安全 repo-relative cwd 和有界 timeout，同时保留 legacy `{id, command}`：

```javascript
function normalizeVerificationCommand(entry) {
  if (!entry || typeof entry !== "object" || !COMMAND_ID.test(entry.id ?? "")
    || typeof entry.command !== "string" || !entry.command.trim()) {
    throw new Error("controlled verification requires registered command objects");
  }
  if (entry.cwd === undefined && entry.timeoutMs === undefined) {
    return { id: entry.id, command: entry.command };
  }
  if (typeof entry.cwd !== "string" || path.isAbsolute(entry.cwd)
    || entry.cwd.split("/").some((segment) => !segment || segment === "..")
    || !Number.isSafeInteger(entry.timeoutMs) || entry.timeoutMs <= 0) {
    throw new Error("controlled verification cwd or timeout is invalid");
  }
  return { id: entry.id, command: entry.command, cwd: entry.cwd, timeoutMs: entry.timeoutMs };
}
```

`runVerification()` 对结构化 command 调用：

```javascript
const commandCwd = item.cwd === undefined ? lease.path : path.resolve(lease.path, item.cwd);
const options = {
  cwd: commandCwd,
  encoding: "utf8",
  ...(item.timeoutMs === undefined ? {} : { timeout: item.timeoutMs }),
};
const result = await execFile("/bin/sh", ["-c", item.command], options);
```

`inherit-final/structural-only/deferred` 在 Attempt validator 中都不运行 Task command，但 prompt 和 evidence 保留不同 strategy/reason。

- [ ] **Step 4: 全链路只编译一次 IR 并使用拓扑顺序**

`coordinatorFor()` 在读取并校验批准 Plan 后只调用一次 `compilePlanToIR(plan)`，同一对象传给 Coordinator、registry 和 Gate。Integration Queue 改为：

```javascript
nodeOrder: ir.nodes.map((node) => node.id),
```

v3 `verifyPlan()` 把 `ir.verification.commands` 原样交给 `runPlanGates()`；legacy path 继续传 `plan.verification` 字符串。Final completeness 对当前 IR 节点要求 accepted，对 projection 中已从 revision 合法移除的 Task 接受 `retired`；任何其他状态仍 fail closed。`runPlanGates()` 使用以下归一化执行，不丢弃 cwd/timeout：

```javascript
function normalizeGateCommand(entry) {
  if (typeof entry === "string" && entry.trim()) {
    return { command: entry, cwd: ".", timeoutMs: undefined };
  }
  if (!entry || typeof entry.command !== "string" || !entry.command.trim()
    || typeof entry.cwd !== "string" || path.isAbsolute(entry.cwd)
    || entry.cwd.split("/").some((segment) => !segment || segment === "..")
    || !Number.isSafeInteger(entry.timeoutMs) || entry.timeoutMs <= 0) {
    throw new Error("Plan verification command is invalid");
  }
  return entry;
}

for (const entry of commands.map(normalizeGateCommand)) {
  await execFile("/bin/sh", ["-c", entry.command], {
    cwd: path.resolve(cwd, entry.cwd),
    ...(entry.timeoutMs === undefined ? {} : { timeout: entry.timeoutMs }),
  });
}
```

增加断言：parsed v3 plan 语义修改后必须先产生不同 IR hash，旧 event identity 不能继续运行。

- [ ] **Step 5: 运行 Queue/Gate 测试到 GREEN 并提交**

```bash
node --test test/plan-gates.test.mjs test/plan-attempt-validator.test.mjs test/plan-integration-queue.test.mjs test/plan-runner-dependencies.test.mjs test/plan-coordinator.test.mjs
git add scripts/lib/plan/gates.mjs scripts/lib/plan/attempt-validator.mjs scripts/lib/plan/plan-runner-dependencies.mjs test/plan-gates.test.mjs test/plan-attempt-validator.test.mjs test/plan-integration-queue.test.mjs test/plan-runner-dependencies.test.mjs
git commit -m "refactor(plan): 统一消费者读取 v3 IR"
```

Expected: PASS，前向依赖按拓扑顺序集成，Gate 与 Executor 使用同一 IR verification 合同。

### Task 9: 迁移真实 Harness 并完成回归门禁

**Deps:** Task 8

**Files:**
- Modify: `test/fixtures/plan-harness/plans/parallel-success.md`
- Modify: `test/fixtures/plan-harness/plans/resource-serialized.md`
- Create: `test/fixtures/plan-harness/plans/amendment-success.md`
- Modify: `test/fixtures/deterministic-provider.mjs`
- Modify: `test/plan-parallel-harness.integration.mjs`
- Create: `docs/architecture/plan-ir-v3.md`
- Modify: `docs/audits/2026-07-29-plan-runner-architecture-audit.md`

- [ ] **Step 1: 把 Harness fixture 改成严格 pi-plan.v3**

每份 fixture 增加非空 Plan instructions、Task 执行步骤、`revision/parentPlanHash/executionDefaults/taskAcceptance`。parallel fixture 的 verification 与 acceptance 固定为：

```json
{
  "verification": [
    {"id": "plan:worker-1", "command": "grep -q '^worker$' README.md", "cwd": ".", "timeoutMs": 120000},
    {"id": "plan:worker-2", "command": "grep -q '^worker-2$' worker.txt", "cwd": ".", "timeoutMs": 120000}
  ],
  "taskAcceptance": {
    "task-1": {"strategy": "commands", "commandIds": ["plan:worker-1"]},
    "task-2": {"strategy": "commands", "commandIds": ["plan:worker-2"]}
  }
}
```

resource-serialized fixture 使用最终命令 `test -f one.txt && test -f two.txt`；两个 Task acceptance 都固定为 `structural-only`，reason 为“Harness 仅验证资源串行与路径所有权，文件组合在最终 Gate 验证”。

真实 Harness 增加断言：两个 Executor session 的 prompt 分别包含各自完整 Task body，且 `attempt.dispatch-requested.taskHash` 等于对应 IR 节点的 effective hash。

新增 amendment-success fixture：Task 1 Executor 首次调用 Supervisor，deterministic Plan Runner 读取固定 revision 2 全文并调用 `plan_amend`；revision 2 修改 active Task body 并新增一个 repair Task。Harness 断言：

```javascript
assert.deepEqual(await readFile(revision1Source), originalSourceBytes);
await assert.rejects(
  access(path.join(planWorktree, ".pi-plan-runtime", "approved-plan.md")),
  (error) => error?.code === "ENOENT",
);
assert.equal(status.revision.number, 2);
assert.equal(events.some((event) => event.type === "plan.amended"), true);
assert.equal(events.some((event) => event.type === "attempt.superseded"), true);
assert.match(secondAttemptPrompt, /Revision 2 clarified requirement/);
assert.equal(secondAttemptTaskHash, revision2Ir.nodes.find((node) => node.id === "task-1").hashes.effective);
assert.equal(status.lifecycle, "validated");
```

测试还要在 `plan.amended` 后、`current.json` 更新前注入一次 crash，重启后确认 pointer 从事件修复且旧 task hash 不重派。

- [ ] **Step 2: 运行真实 Harness 确认迁移 RED**

```bash
PI_REAL_BIN="$(command -v pi)" node --test test/plan-parallel-harness.integration.mjs
```

Expected: FAIL，production parser/dispatch 或 fixture 尚未满足 v3 语义与 hash 断言。

- [ ] **Step 3: 写字段权威文档并更新审计结论**

`docs/architecture/plan-ir-v3.md` 写入本文冻结的两份 schema、编译所有权、revision store、更新协议、hash 覆盖矩阵、selector 规则和动态 Capsule 边界。审计报告将原“GraphIR + TaskExecutionIR”推荐改为：一套可 revision 的完整 Plan IR、多个无身份 selector view、Harness 独占 compiler、Main/Plan Runner 不直接提交 IR、动态 Attempt context 与 transport request 不作为第二领域 IR。

- [ ] **Step 4: 运行全部验证**

```bash
node --test test/plan-document.test.mjs test/plan-ir.test.mjs test/plan-ir-schema.test.mjs test/plan-revision-store.test.mjs
node --test test/plan-event-writer.test.mjs test/plan-events.test.mjs test/plan-projection.test.mjs test/plan-amendment.test.mjs
node --test test/plan-coordinator.test.mjs test/plan-resource-locks.test.mjs
node --test test/plan-gates.test.mjs test/plan-attempt-validator.test.mjs test/plan-integration-queue.test.mjs test/plan-runner-dependencies.test.mjs
node --test test/plan-launcher-extension.test.mjs test/plan-host-runtime.test.mjs test/plan-capsule-extension.test.mjs
PI_REAL_BIN="$(command -v pi)" node --test test/plan-parallel-harness.integration.mjs
npm test
npm run doctor
git diff --check
```

Expected: 全部 PASS；Doctor 不新增 IR/schema/fixture warning；`git diff --check` 无输出。

- [ ] **Step 5: 检查兼容性与提交**

确认：

```text
pi-plan.v1 -> plan-ir.v1，旧 hash 不变
pi-plan.v2 -> plan-ir.v2，旧 hash 不变
pi-plan.v3 -> revision store/source.md + plan-ir.v3 + manifest
plan_run -> 只传 planPath；Harness 冻结并编译
plan_open -> 只传 revision identity；不接受 planPath/IR JSON
plan_amend -> 传完整新 source；Harness 重新编译
legacy plan.created -> 继续 replay
v3 plan.created/plan.amended -> 强制 revision identity
旧 revision -> 永久可读且不可覆盖
current.json -> 可从最后 committed event 重建
```

然后提交：

```bash
git add test/fixtures/plan-harness/plans test/fixtures/deterministic-provider.mjs test/plan-parallel-harness.integration.mjs docs/architecture/plan-ir-v3.md docs/audits/2026-07-29-plan-runner-architecture-audit.md
git commit -m "docs(plan): 固化 v3 IR 字段与迁移边界"
```

## 验收标准

- `plan_run` 外部输入只需要 planPath/可选 planId；Main Agent 和 Plan Runner 都不能直接提交 IR JSON。
- Launcher 必须在 Host 启动前把原始 Plan 精确字节、IR 和 manifest 写到 stateRoot revision 1；不得向 Plan worktree 复制或覆盖批准版本，base commit 自带的同路径历史文件不具有合同权威。
- `plan_open` 只接受 revision/manifest/IR identity，并从受信 revision store 读取合同。
- `plan_read_revision` 只能返回事件提交的 current source，不能读取路径、orphan 或任意 revision。
- `plan_amend` 只接受完整新 Plan source、Supervisor request identity、reason 和 projection/revision fence；Harness 独占 parse/compile。
- revision artifact 永不覆盖；`plan.created/plan.amended` 是提交事实，`current.json` 可从事件恢复。
- accepted/integrated Task 的局部 full 合同不可修改；全局 rebound 可 carry-forward；changed/rebound active Task 必须 supersede、stop、释放后按新 effective task hash 重派。
- amendment、cancel、spawn completion 并发时只能由单 Event Writer 通过 expected-version CAS 提交可 replay 日志。

- Plan 级 instructions 或 verification command 变化时，根 full 与节点 effective hash 必须变化，节点局部 semantics/full 保持不变。
- Task body、execution 或 acceptance 变化时，节点 semantics/full/effective 与根 full 必须变化。
- 只修改 Task body 时，scheduling hash 必须保持不变。
- 修改 deps、allowed paths、resources、sourceOrder 或 agent 时，节点 scheduling/full/effective、graph 和根 full hash 必须变化。
- Executor prompt 必须包含完整 Plan instructions、完整 Task body、执行策略、验收策略和 result contract。
- Frontier、Integration Queue、Executor、Attempt validator 和 Gate 必须消费同一 IR 或其无身份 selector view。
- v3 Plan/Attempt events 必须绑定 `planIrHash/taskHash/schedulingHash/dispatchContextHash`。
- v1/v2 Plan、IR 和 legacy event replay 保持兼容。
- 真实 Pi Harness 必须证明语义进入 Executor，而不只是路径驱动 deterministic provider。
