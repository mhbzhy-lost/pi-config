# 根安装 Pi 核心依赖漂移

## 问题

根 `package.json` 与已提交 `package-lock.json` 均要求四个 Pi 核心包为 `0.87.1`，但执行根安装状态检查时，当前 `node_modules` 及其隐藏锁 `node_modules/.package-lock.json` 记录的是 `0.85.1`。因此原生 ESM 解析命中了旧安装，`npm ls --offline --depth=0` 报 `ELSPROBLEMS`，四个包均为 `invalid`。

## 现场证据（安装前）

- 根 manifest：`package.json` 的 `@earendil-works/pi-agent-core`、`pi-ai`、`pi-coding-agent`、`pi-tui` 均为 `0.87.1`。
- 已提交锁：`package-lock.json` 对应四个 `node_modules/@earendil-works/pi-*` 条目均为 `0.87.1`。
- 实际安装：四个包均为 `0.85.1`。
- 隐藏锁：`node_modules/.package-lock.json` 的四个对应条目均为 `0.85.1`。
- RED：`npm ls --offline --depth=0` 退出码为 `1`，并逐项输出 `invalid: ...@0.85.1 "0.87.1" from the root project`。

## 数据来源分类

这是本地安装状态与权威根 manifest/lock 不同步，不是生产代码接收到的异常事件或资源事实；首个偏离点是根 `node_modules` 与隐藏锁仍保留 `0.85.1`。本次只按用户授权用已提交 lock 重建根安装，不增加 production 兼容、fallback 或 init 逻辑。

## 处理与验证记录

- 目标：仅同步根 `node_modules`，不修改任何 manifest/lock，不升级 global/enhanced，不覆盖既有 Doctor 修复，不提交。
- 安装命令：`env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_FANOUT_CHILD TMPDIR=/tmp npm ci --ignore-scripts --no-audit --no-fund`，退出码 `0`，耗时约 7 秒；仅出现既有依赖的 deprecated 警告，未发生网络重试或超时。
- `--ignore-scripts` 评估：锁中原生/平台相关依赖采用已锁定的 optional platform 包；安装后 `node -e "require('esbuild').version"` 为 `0.28.2`，`node_modules/.bin/esbuild --version` 为 `0.28.2`，证明当前平台原生可执行依赖可用。未执行第三方安装脚本，未增加任何生产兼容逻辑。
- 安装后四包实际版本与隐藏锁均为 `0.87.1`：`pi-agent-core`、`pi-ai`、`pi-coding-agent`、`pi-tui`；`npm ls --offline --depth=0` 退出码 `0`，不再有 `invalid`。
- `package.json`、`package-lock.json` 的 `git diff` 为空；安装未产生受 Git 跟踪的 manifest/lock 变更。global `@earendil-works/pi-coding-agent` 保持 `0.87.1`，enhanced 本地依赖保持四包 `0.87.1`，本次未升级它们。

## 门禁记录

- 类型检查：`env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_FANOUT_CHILD TMPDIR=/tmp npm run typecheck` 通过（root 与 enhanced 均通过）。
- 相关回归：同环境 `npm run test:integration` 通过，4 passed、1 skipped（`PI_REAL_BIN` 未设置的环境跳过）。Doctor 单独记录，不作为根依赖同步的版本验收条件。
- Doctor：同环境 `npm run doctor` 退出码 `1`。这是独立的、已确认的 Doctor 阻塞：当前 Doctor 报告 `pi-subagents-enhanced` 内四个 package-local Pi core peer error，另有既有 managed-workspace warning；不为使依赖同步验收变绿而修改 Doctor 或其既有未提交修复。
- 主测试：同环境 `npm test` 已完成，`973` 项中 `972` passed、`1` todo、`0` failed。
- 可行全量集成：同环境 `npm run test:all-integration` 已在有界运行内完成，`243` 项中 `233` passed、`5` skipped、`5` failed。失败均为环境前置/配置来源：相关真实 Pi 测试要求显式 `PI_REAL_BIN`，其中断言直接报告未设置，两个后续 RPC 场景因该变量为 `undefined` 触发 `ERR_INVALID_ARG_TYPE`；另一个 root-broker 场景同样报告 `PI_REAL_BIN` 未设置。未将这些失败归因于根依赖漂移，也未读取或修改凭据。

## 结论

根安装状态已按现有 lock 同步完成；四个 Pi 核心包均为 `0.87.1`，`npm ls` 有效。剩余 Doctor 错误属于独立的 package-local peer 审计问题，全量集成的 5 个失败属于缺少显式真实 Pi binary 的测试环境前置条件。
