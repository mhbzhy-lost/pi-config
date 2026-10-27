# Pi 1.4.0 合回与初始化核对记录

## 2026-10-27 完整初始化收尾（R4，当前结果）

**原仓 `init-pi.sh` 已从头到尾真实执行成功，exit 0，出现 `[ok] Pi initialization complete`；当前1.4环境中的幂等性比较全部成立。** 执行窗口为 `2026-10-27T04:27:50Z` 至 `04:29:06Z`，约76秒。本轮使用用户授权的本机7897代理，npm保持官方源，本地测试服务绕过代理；没有把代理硬编码到init或全局配置。

| init内置阶段 | R4实际结果 |
| --- | --- |
| 锁定依赖、skill同步、settings与shell、Basic Memory | 完成 |
| `npm test` | exit0；1557项，**1556 pass、0 fail、0 skip、1既有TODO** |
| `npm run doctor` | exit0，0条error |
| `npm run test:integration` | exit0，**5/5 pass、0fail/skip** |
| 可选external-review | 目录不存在，按原脚本条件跳过，0项执行，不计通过 |
| 脚本最终完成标记 | 已出现，整条init exit0 |
| 完成后的补充typecheck | exit0（独立静态检查，非init内置阶段） |

执行前后65个登记文件、settings字节、默认模型与enabledModels字段、auth/models元数据、shell字节、skill链接、pi-lite及Git HEAD/tag/staged全部保持；其它在途文件0项变化。并发测试仍为4worker、80次操作、320次读取、1000ms，生产锁/guard/timeout均未放宽。

当前会话已重启到原仓1.4，实际持有存活coordinator的Host PID18176在执行前后均存活，canonical workspace根保持原var/workspaces。该条件下，doctor在同一条真实init中通过，不再依靠R1分项补检拼接结果。无Host时历史metadata可能被独立doctor报stale的既有行为没有改变；本次结论针对已记录的正常运行环境。

完整init历史分轮保留：R1因旧夹具退出1；R2直连下载长时间停滞，按用户代理建议只中断本次uv，init退出130；R3代理下载完成，但有ambient proxy断言与一次owner worker退出，init退出1；R4修正现有测试后完整退出0。proxy测试现在断言全局环境恢复到调用前的值；owner测试先监听close收齐stderr再统一断言。已有定向16/16与本轮全量均通过；R3首次worker退出的具体cause因原始测试未报告stderr而仍不完整，不将其包装为生产根因已修。

当前原始证据：`/Users/leshi.zhy/pi-upgrade-1.4.0/reports/activation-r4/{init-result.json,before.json,after.json,expected-source.json,typecheck.json,result.json}`；完整私有日志`cache/activation-inline-r4/logs/init-pi.log`，SHA-256 `74a5959ba5c231ef91165b7ee912cebaabc38e6e3f39f55dc618aa1aaa182f12`。R4执行后的本记录更新属于文档收尾，不是init过程中的文件漂移；修改前原文已归档为R4目录的`verification-before-r4-update.md`。

以下保留R1合回与首次验证历史；其中“只运行一次”“未整次退出0”等表述仅描述当时状态，当前结论以上述R4为准。

## R1合回背景（历史）

原仓 `/Users/leshi.zhy/pi-config` 已合回并安装 **Pi 1.4.0 / pi-subagents 0.80.0**。按用户明确授权，本次由主会话 inline 执行；保留旧进程，主会话未调用 subagent 工具委派工作、执行旧会话 `/reload` 或向旧进程发信号。现有自动化测试按各自隔离夹具运行。新开 Host 使用新安装，原有 Host 内存中的代码仍为原版本。

**历史R1实际 `init-pi.sh` 运行一次，首轮退出码为 1；修正过期测试夹具后，单元测试及各项后续检查已分别核对。历史R1不是“一次完整 init 从头到尾退出 0”；R4已在上文独立完成整条脚本。**

## 合回与现场保护

- 初始按固定清单应用 61 个路径：54 个 tracked 文件与 7 份新文档；文件级无冲突。没有整树覆盖原仓。
- 在独立临时树通过官方 npm 源执行 `npm ci --ignore-scripts`、`setup:subagents-enhanced` 和 typecheck，校验通过后替换 root、enhanced、`pi/npm` 三处依赖树。
- 原依赖与合回前文件保留在 `/Users/leshi.zhy/pi-config/var/rollback-1.0.4-to-1.4.0-20261026T104033Z`，包含 manifest、旧依赖、原在途文件，以及 init 前 settings、shell 等私有备份。
- pi-lite 的 DeepSeek 定制、Playwright 与 writing-plans 在途改动均保留；其它会话新增的 `docs/plans/2026-10-26-goal-runtime-v1.md` 未纳入本次修改。
- 认证与模型定义未改，`enabledModels`、默认 provider/model/thinking 字段保持；原 HEAD 与 `1.0.4` tag 仍为 `d819dc560a65ede60319899e415387d5475f6e1b`，staged 为空。本次未 commit、tag 或 push。

## R1初始化与幂等性（历史）

真实 init 已执行锁定依赖安装、skill 同步、settings 合并、shell 受控区块维护和 Basic Memory 0.22.1 安装，然后在首轮单元测试失败处停止。

- 首轮单元测试：1557 项，1521 pass、35 fail、1 todo、0 skip；原始结果与日志保留。
- 失败来源为旧 1.3.0/0.79.2 夹具及断言、缺少 `setProgramStatus` 的旧 Terminal mock，以及核对包装器选择的过长 Unix socket 临时路径。只修已有 test/fixture 和核对环境，没有添加 production 兼容分支、放宽版本门禁或 shell 安全策略，也没有新增测试。
- 共同步 12 个已有 test/fixture 文件和 2 份 README。第二轮暴露的两个调用方旧输出正则也已同步；原 pi-lite 测试的 exa 期望按既有 DeepSeek 定制修正。历史负例继续保留。
- settings 首轮仅规范化 `defaultTools`、`skills`；`.zshrc` 始终只有一个受控区块，非受控行逐行一致。skill 同步为 0 创建、0 更新、8 不变。
- 在私有副本上再次调用真实 settings 实现与从 init 原文提取的 shell 实现，输出均已字节收敛。该验证不改原文件，也不冒充第二次完整 init 成功。

## R1分项补检（历史）

| 检查 | 实际结果 |
| --- | --- |
| 全量 `npm test` | **exit 0；1556 pass、0 fail、0 skip、1 todo**，共 1557 项 |
| 根与 enhanced typecheck | exit 0 |
| enhanced package 自检 | exit 0 |
| settings 完整性检查 | exit 0 |
| `npm run test:integration` | **5/5 pass，0 fail、0 skip** |
| 原仓 fresh Host | get_state/get_commands/get_session_stats 三条只读 RPC 成功；EOF/exit 0，stderr 0 |
| fresh Host 存活时 doctor | **exit 0，errors=[]** |
| 无存活 coordinator 时独立 doctor | exit 1，仅 `coordinator singleton identity is stale`，见下文 |
| 可选 external-review 测试 | 目录不存在，按 init 原有条件 **N/A，0 项执行，不计通过** |

既有 TODO 为 `reviewer admission/discovery moves to the public registerAgent API (T7-T9 follow-up)`；它仍标 TODO，没有将其算作通过。

fresh Host 使用原仓 1.4 launcher、原机器配置和 `qoder-pool/DeepSeek-Flash`，session 为 `01a177ff-78e5-72b4-a07d-c1a62982ce7f`。仅做只读 RPC，messageCount=0、没有 prompt、模型请求或子代理派发。验证 session/goal/owner registry 隔离，workspace 继续使用原 canonical `var/workspaces`，没有引入新迁移根。

## doctor 的运行状态边界

旧 coordinator metadata 指向已不存在的 PID。新 Host 通过正常 session_start、Root Broker 与 registry.claim 合法接管，存活期间 doctor 为 0。Host 正常退出后，现有设计会保留 metadata，因此离线 doctor 仍可能报告 stale。

这一诊断逻辑在 1.0.4 中已存在，本次没有为检查变绿而删除记录或修改规则。它意味着：当前新安装和正常启动已验证，但不能宣称“无 Host 时重复执行 init 也必然完整成功”。本次的实际一次 init 非零结果、独立 doctor 非零结果与 live Host doctor 零结果分别保留。

另外，第一次独立核对漏了 `.local/bin`，导致已安装的 Basic Memory 被误报 unknown；后续环境已修正。可选 external-review 的报错也是补检包装器未遵守 init 的目录存在性 guard，实际没有执行任何该组测试。这两项均已作为核对方法问题记录，未改写原始失败。

## R1历史证据入口

R1完整证据目录：`/Users/leshi.zhy/pi-upgrade-1.4.0/reports/activation-r1/`。最新完整初始化结果在本记录开头所指R4目录。

- `merge-inputs.json`、`merge-execution.json`：61 条初始清单、备份、三树替换与原配置保护。
- `init-result.json`：R1轮次实际 init 的非零结果；`init-before.json` / `init-after.json` 保留前后事实。
- `init-failure-classification.md`、`diagnostic-provenance.md`：来源分类与首次偏离点。
- `unit-final.json`：最终完整单元测试；初次和中间失败日志分别保留，不求和为测试总数。
- `post-init-checks.json`：type/package/settings/doctor/RPC 等原始分项；`optional-check-resolution.json` 解释 N/A 与 doctor 上下文。
- `fresh-host.json`、`init-convergence.json`、`file-conservation.json`：新原仓 Host、幂等收敛与现场保护。
- `result.json`：本次最终汇总与证据哈希。

1.4 隔离候选与此前真实三链验收保持原样；该次 README 多一个空行的严格失败也没有被本次单元检查改写。本记录属于原仓安装与基线检查，不代表全量真人 TUI、多 provider、旧会话恢复或所有历史运行任务均已验收。
