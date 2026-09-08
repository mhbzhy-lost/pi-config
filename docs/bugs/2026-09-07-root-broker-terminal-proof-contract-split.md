# Root Broker terminal proof 合同分裂

## 来源与可达性

真实 upstream writer 的入口为 `finalizeProcessTerminal()` → `writeAtomicJson(processTerminalPath(asyncDir), proof)`。其原始 sidecar 是 `version/runId/runnerProcessInstanceId/state/observedAt/instances`（可选 `resumeDisposition` 与 `canonicalSession`）；没有 `sessionId`、`asyncDir`、`agent` 或 `pid`。`writeAtomicJson` 未指定 mode，受 umask 影响，当前常见产物为 `0644`，不是 Broker 旧 reader 硬编码的 `0600`。

生产顺序是 Host `RunAuthorization` 登记 owned run（含 Goal ticket）→ `async-started` 核验 process birth identity → upstream 落盘官方 `process-terminal.json` → 内存 terminal event（允许因 Extension ctx 已失效而丢失）→ settlement reader。09-02 已证明最后一条 sidecar 路径是合法生产路径。`status.json` 仅是运行状态镜像；日志和 caller evidence 更不是终态权威。

## 首个偏离点

旧 `inspectExecutionProof` 只读内存 Map；新增的 `inspectExecutorProofAsync` 又单独接受 facade run、只接受 `0600`，且 snapshot 与同步 reader 的 terminal shape/outcome 位置不一致。`recoverExactTerminalProof` 和 `pollTerminalArtifact` 还读取 `status.processTerminal`。因此同一 official sidecar 在 settlement、stop 和 recovery 上有不同的身份、权限、mode 与 outcome 规则。

这不是测试手写扩展字段造成的问题：fixture 使用 upstream `writeAtomicJson` 写入原生 shape；其缺少 Host identity 正是 writer 的真实合同。修复将身份锚定在已核验的 Host-owned、Goal-bound run，不向原始 proof 补字段；只接受普通非 symlink、nlink=1、同 uid（平台支持时）及 0600/0644 的 official sidecar。facade、未绑定、identity unavailable/conflict、pending、foreign、malformed 和 conflict 一律 fail closed，status 不再参与 terminal authority。
