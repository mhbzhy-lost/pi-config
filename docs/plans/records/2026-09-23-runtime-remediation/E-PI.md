# E-PI：真实 Pi lane 验证

**状态：** 环境受限，未完成真实 lane 验收。

## 实际检查

- `/opt/homebrew/bin/pi`：执行器已确认存在并尝试作为 `PI_REAL_BIN`。
- 命令：`PI_REAL_BIN=/opt/homebrew/bin/pi npm run test:subagents`
- 实际结果：工具执行超时；先后使用 120 秒、300 秒预算均未取得稳定退出码或完整测试汇总。
- 未持久化 `PI_REAL_BIN`，未修改配置、源码、测试或 live workspace。

## 分类

这是环境/运行时受限，不是 production 通过，也不是 production 失败。当前无法证明真实 Pi lane 的成功或失败，保留为 `environment-constrained / unverified`。

## 限制

- A-ENV 已判定 `degraded`，真实 supervisor transport 未验证。
- 本次执行被超时打断，未取得可靠测试计数。
- 后续若需重跑，应在独立的已知可终止 harness 中设定更细的 test subset 和进程级 timeout，不得把超时伪造成 PASS。

## TDD 豁免

本节点只执行环境验证并写入文档，不修改 production behavior、源码或测试，适用纯文档/证据记录豁免。按 test-driven-development Skill 的项目规则，本次属于纯文档/证据回写，明确豁免 RED-GREEN 流程；没有生产行为变更，故不新增或修改测试。

## 最窄卡点

- 独立窄测中，`test/pi-subagents-runtime.integration.mjs` 的普通 top-level RPC completing-executor 测试使用真实 Pi RPC 通过，exit 0，耗时约 2.35 秒。这是当前可复用的真实通过证据。
- 同一文件的真实 Root Broker startup 测试不能直接作为隔离证据：从仓库 cwd 启动会受到仓库 `.git/.pi-coordinator` live coordinator 影响；不设置 `PI_CODING_WORKSPACE_DIR` 时出现 state-root 错误，使用临时 state root 时出现 scope mismatch。
- attention/supervisor-resume 测试子集在 45 秒有界运行中超时，并留下 node/Pi/jiti 进程子树。该结果只能证明 attention lane 不可结束且测试级清理不完整，不能推出 production Root Broker 或 Supervisor transport 的具体根因。

## 隔离污染

仓库 `.git/.pi-coordinator` 是 startup 探针的隔离污染源。因上述 cwd、state-root 与 scope mismatch 边界，Root Broker startup 结果不应记为 PASS、FAIL 或独立 transport 诊断。A-ENV 仍为 `degraded`；真实 supervisor steer/resume transport 未验证，当前结论保持 `environment-constrained / unverified`。不得为了变绿修改测试或实现兼容 fallback。

## 进程清理

本轮诊断遗留的进程组已由主 agent 按组执行 TERM/KILL 清理。此报告不记录 PID、runId、session identity 或完整临时路径。

## 后续有界探针

下一次如需探测 attention lane，应使用 `start_new_session=True` 的 process-group wrapper，总 timeout 45 秒；先发送 TERM，等待 5 秒后对仍存活的进程组发送 KILL。仅使用临时 HOME、XDG、TMP、agent 与 workspace，并证明探针不会连接仓库 `.git` coordinator；若无法证明，应跳过 attention lane。普通 RPC 子集可继续作为已通过的真实证据。任何重跑都必须保留超时事实，不得把未取得可靠整体 exit/test count 的结果伪造成 PASS。
