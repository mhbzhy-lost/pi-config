# L-ORPHAN：归属两个 lifecycle orphan

## 范围与方法

本记录是纯文档静态诊断；没有修改 production code、allowlist、计划、live workspace、配置。按 `test/package-orphan-export-guard.test.mjs` 的规则，只读扫描 package `src`，并以 production roots `packages/pi-subagents-enhanced/{src,extensions,child-extensions,scripts}`、仓库 `src`、`pi/extensions`、`scripts` 为 importer 候选。测试、docs、handoff、artifact 不计入 production importer。除相对 `from` 外，也检查相对 `import()`/`require()` 形态。TDD 豁免：本任务只产生诊断文档，不改变生产行为，符合纯文档变更豁免；因此不新增 RED/GREEN 测试。证据不足时按 fail closed 处理。

## 结果总览

| 文件 | production 静态 importer | production 动态 importer | public/typed entry | 当前 allowlist 证据 | 建议 owner/动作 | C13 | E-PI | D-AUDIT |
| --- | ---: | ---: | --- | --- | --- | --- | --- | --- |
| `src/subagent-dispatch/durable-run-registry.ts` | 0 | 0 | 无 package export；文件自身导出 typed `InventoryV1` 与 `DurableRunRegistry`，但没有 production root 接入 | allowlist 条目存在且有中文理由：`lifecycle 批次 P2-T3 交付的持久运行登记契约，当前由后续生命周期收尾批次接线；本任务不改变生产实现。` | lifecycle 接线（由后续收尾批次接入 registry）；在接线前继续 allowlist，不删除 | 不阻塞（条目已有明确理由） | 不阻塞 package export/API（未宣称 public export） | 不阻塞当前 allowlist 审计，但 owner 尚未完成接线 |
| `src/workspace/coordinator-process.ts` | 0 | 0（候选 production roots 内无动态 importer） | 文件导出 typed `startCoordinatorProcess`；非 `package.json` export；自身有 `if (process.env.PI_COORDINATOR_ENDPOINT) await startCoordinatorProcess()` 顶层入口 | allowlist 条目理由是：`workspace 生命周期批次交付的协调进程模块，当前由宿主外部动态装载；接线不属于本任务范围。` 该文字不是 importer 证据 | 继续 allowlist；由 workspace lifecycle/宿主 owner 提供并验证外部 loader 接线，或在确认无宿主后再评估删除；本任务不擅自删除或接线 | 不阻塞当前 allowlist gate | 不阻塞 package API（没有 export） | **阻塞关闭项**：宿主外部动态装载未被仓内证据证实，不能仅凭 allowlist 文字视为 production owner |

## 1. `durable-run-registry.ts`

### 搜索证据与计数

- 精确名称在 production roots 中没有 importer：`0` 静态、`0` 动态。
- package `exports` 只有 `./dispatch-ir`、`./generic-prompt`、`./workspace`、`./workspace/admin`；没有 registry 路径，因此 package public entry 为 `0`。
- package scripts 只有 `test`、`setup:runtime`、`typecheck`、`verify:package`；没有执行 registry 的 script entry。
- 文件自身是 typed module：导出 `InventoryV1` 和 `DurableRunRegistry`，方法为 `recordInventory`、`loadInventory`、`markOrphaned`。这证明可复用的 typed entry 存在，但不证明 production 接线。
- `test/durable-lifecycle.test.mjs` 有一处测试入口通过 jiti 动态载入该文件（`registryModule = await jiti.import(...)`）；它是测试，不计入 production importer。
- `src/subagent-dispatch/durable-run-registry.ts` 仅静态依赖 `durable-contract.ts` 和 `durable-storage.ts`；这些是被测实现内部依赖，不是该文件的 production importer。

### 归属判断

当前真实 owner 仍是“待生命周期收尾批次接入”的 lifecycle owner，而不是某个已发现的 runtime root。allowlist 理由与实际搜索一致到“尚未接线”这一事实，但没有生产调用点。建议由 lifecycle 接线 owner 把 registry 接入明确的 runtime composition/owner lifecycle；在此之前继续 allowlist。不要因本次诊断删除模块，也不要把测试 importer 当作 production owner。

### 门禁影响

本文件当前不阻塞 C13 或 E-PI：它没有 package export，也没有被误报为缺少 allowlist 理由。它仍是未接线的 lifecycle debt；因此 D-AUDIT 若要求所有持久 lifecycle contract 都有已验证 runtime owner，应标记为未完成接线，而不是把 allowlist 当成完成证明。

## 2. `coordinator-process.ts`

### 搜索证据与计数

- 精确名称在所有指定 production roots 中没有 importer：`0` 静态、`0` 动态。
- `package.json` exports 与 scripts 均没有 coordinator-process 条目；无 package public export、无 package script entry。
- 文件自身导出 typed `startCoordinatorProcess(environment)`，读取 `PI_COORDINATOR_*` 环境变量、创建并监听 coordinator server；末尾仅有自身的条件顶层调用：`if (process.env.PI_COORDINATOR_ENDPOINT) await startCoordinatorProcess()`。这使它可作为被 Node 直接执行的 process entry，但不是仓内 importer。
- `test/managed-workspace-coordinator.integration.mjs` 通过 `spawn(process.execPath, ["--experimental-strip-types", path.resolve("packages/pi-subagents-enhanced/src/workspace/coordinator-process.ts")], ...)` 启动它；这是测试入口，按任务约束不计入 production importer。
- 未发现 production `import()` 或 `require()` 指向该文件。特别是 `extensions/subagent-runtime.ts` 生产中直接调用 `createCoordinatorServer`，不是调用或动态装载 `coordinator-process.ts`，因此不能转移为该文件的 importer 证据。

### 归属判断（fail closed）

allowlist 的“宿主外部动态装载”只能算待验证假设：本仓指定 production roots 没有静态或动态 importer，package exports/scripts 也没有入口。当前证据不能证明外部 host loader 的模块路径、调用方、生命周期 owner 或部署接线。建议继续 allowlist，owner 指向 workspace lifecycle/宿主集成方，后续必须补充可复核的宿主 loader/部署入口证据；若确认没有这样的 owner，再由明确决策评估删除。不得仅凭 allowlist 文本认定已接线。

### 门禁影响

C13/E-PI：当前没有 package export 或 production importer，不构成现有 package public-surface 失败；但这不等于 owner 已证实。D-AUDIT：对“宿主外部动态装载”归属的审计应保持 blocked/未关闭，直到获得仓外 host 的可审计 loader 证据；本任务不修改 allowlist 或代码来绕过该缺口。

## 测试入口与 production 入口的区分

- 测试入口：`test/durable-lifecycle.test.mjs` 的 jiti import registry；`test/managed-workspace-coordinator.integration.mjs` 的 child-process spawn coordinator process。两者均排除。
- production 入口：本次限定 roots 中两个文件均未找到 importer；registry 没有 package export/script，coordinator 只有可直接执行的自启动条件和 typed function export。
- “宿主外部动态装载”来源未在限定仓内得到证实，故不计入动态 importer（计数为 `0`），并按 fail closed 处理。

## Residual risks / manual notes

- 计数是限定 production roots 与静态文本搜索的结果，不是对仓外宿主、发布系统或运行时命令行的证明。
- `coordinator-process.ts` 的直接 Node 执行能力可能是有意的 standalone entry，但缺少宿主 owner、部署声明或 package script 仍是审计残留。
- registry 的 typed API 目前只有测试消费证据；将测试改成 production owner 的推断被明确拒绝。
- 本文未输出凭据、token、runId 或 session identity。
