# P-SNAPSHOT：修正 state root 后只读快照

执行时间：2026-09-23T19:28:10+08:00

状态：快照完成。上次失败原因是将 root repository 路径误用为 state root，导致错误寻找 partition；本次已按 canonical state root 重做 provenance 核对并完成只读复制。

## Provenance

临时内存 Python 检查结果（仅记录布尔结果，不输出 coordinator 字段值）：

- canonicalStateRoot、`PI_CODING_WORKSPACE_DIR` 与指定 state root 的 realpath 一致：**true**。
- coordinator 的 storageRepositoryId 命中指定四 partition 集合：**true**。
- 四个目标源 partition 均为普通目录且不是 symlink：**true**。

## 快照结果

快照目录：`var/snapshots/2026-09-23-pre-remediation/`。以下 P1–P4 顺序对应任务指定的四个 partition；不在此记录其敏感标识或源绝对路径。

| 分区 | records | integration-queue | terminal-proof-outbox | queue 文件数 | state 字段出现 | admissionGeneration 字段出现 | outbox pending/receipt/debt/supersession | 复制文件数 |
|---|---|---|---|---:|---|---|---|---:|
| P1 | present | present | present | 8 | 是 | 是 | 5 / 0 / 188 / 3 | 14 |
| P2 | absent | present | present | 0 | 否 | 否 | 0 / 0 / 110 / 0 | 1 |
| P3 | absent | present | present | 0 | 否 | 否 | 0 / 0 / 130 / 0 | 1 |
| P4 | absent | present | present | 0 | 否 | 否 | 0 / 0 / 101 / 0 | 1 |

records 缺失数：3。对缺失的 records 未创建源目录、未初始化 source；快照 manifest 仅记录 `absent`，没有虚构数量为零。其余指定目录存在并已复制。四个 outbox JSON 均解析后只取四个集合长度；没有输出集合元素、runId、proofId、token、凭据或敏感标识。queue 报告仅给出文件数及 state/admissionGeneration 字段是否出现，不记录其值或敏感 ID。

各 partition 指定目录复制文件数合计 17；另复制 root coordinator 文件 1 个，**总计 18**。快照目录内有 `P1`–`P4` 子目录、`coordinator.json` 和 `manifest.json`。复制期间针对文件执行前后元数据/内容哈希比对及目标哈希核验；未发现复制变化或意外类型。root coordinator 为普通文件且 JSON 可解析。root repository worktree list 条目计数：**7**，未保存原始路径清单或读取 worktree 内容。

## 限制与无副作用结论

仅写入授权快照目录和本报告；未修改 `var/workspaces` 源现场、源码、测试、配置或其他路径。未执行 git add/commit/stash/reset/clean/checkout 或 raw worktree mutation。没有创建 live 缺失目录、修复或初始化现场。未运行测试：这是纯文档证据快照任务，按要求豁免 TDD。复制/检查未报告权限、JSON、类型错误或源变化。
