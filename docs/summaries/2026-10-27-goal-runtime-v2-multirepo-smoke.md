# Goal Runtime v2 多仓库真实 smoke 与单仓库回归

验证日期：2026-10-28。任务：T5 / `dispatch-193612b8`。本报告只记录真实 Host RPC、真实 provider、真实 child 与临时仓库现场；没有修改 production、主仓库 settings、主仓库 var/workspaces、用户 dirty 或凭据。

结论：双仓库真实并行、五工具检查点与失败修复、非法计划拒绝、真实 compact 加新 PID Host 恢复，以及单仓库正向、typed resume、compact 三个回归场景均通过。探针先后发现并修正两类 fixture/观察时序问题：临时 child profile 声明了沙箱不存在的 `apply_patch`，以及修复回执在等待窗口建立前已返回；均只改探针。首轮受污染并行现场和第一次 compact/工具观察失败现场按要求保留，未伪造通过。

## 范围与身份

- Node：`v26.8.1`；物理 CLI：`node_modules/@earendil-works/pi-coding-agent/dist/cli.js`。
- 所有模型回执均为 `qoder-pool/DeepSeek-Flash`，主 Host 每场景上限 16 条 assistant，child 每实例上限 6 条 assistant。探针使用计数器硬门，成功场景实际主 Host 消耗为：multi-parallel 7、multi-tools 14、multi-compact 13、positive 13、repair 14、typed resume 9、single compact 13；child 每实例均不超过 6 条（成功场景最大 4 条）。
- auth 只执行外部 `cp pi/auth.json <临时 agent>/auth.json`，不读取、解析或输出凭据；模型文件只复制到临时 agent 后按合同设置实际模型。
- 每个场景以 `mkdtemp` 创建 0700 临时根。多仓库场景的超级根本身不是 Git，`repoA`、`repoB` 各自有初始 commit，且只在临时根内执行 Git。

## 双仓库真实并行

命令：`node scripts/probes/goal-smoke.ts --scenario multi-parallel`。

成功现场 `goal-smoke-yuUqH8` 已清理（`removed:true`、`killedPids:[]`、`noStagedFiles:true`）。超级根内两个固定参与仓库的 `repositoryId`、`storageRepositoryId` 与 origin 分区均由真实 binding/Host 产生；任务只使用 `repoA/` 或 `repoB/` 前缀，派发后 workspace policy 中分别为 `multi-parallel-A.txt`、`multi-parallel-B.txt`。

- Host PID：`6341`；plan `891ea1cf-edfe-4dce-a3f3-ab36699155f0`；session `01a181ad-bfd5-75e6-b892-982478d1e33a`；真实 child PID：`6575`（A）、`6580`（B）。
- A run：`7671c305-82d8-47ba-aacc-c485fa037c4d`；B run：`7a7fc93a-7460-44c0-aad5-ae53a859d62d`。
- A/B child_start 分别为 `08:43:36.191Z`、`08:43:36.176Z`；shutdown 分别为 `08:43:47.974Z`、`08:43:48.041Z`；实际重叠 `11783ms`，证明是并发执行而非仅有并行容量配置。
- 两个 run 都取得 terminal proof、integration receipt、检查 exit 0，queue 为 `completed`，workspace 为 `released`；审计回执的 lease、owner rootSessionId、originRoot、dispatchCwd、相对 writePaths 和 repository identity 均匹配各自仓库。
- subject 为 `multi-repository`，复合检查和完成判定通过。无关超级根 `.git` 不存在，未把超级根作为 Git 操作目标。

首轮现场 `goal-smoke-QDu2CS` 保留。它确实启动了两个真实 child（PID `89955`、`89951`），两者均取得 proof/receipt/released，重叠约 `12.142s`；但复制的真实 `delegate` profile 声明 `apply_patch`，沙箱 `--no-extensions` 只有 read/write/edit/bash，正式通知记录了 `Agent 'delegate' requested unavailable child tools: apply_patch.`，Goal 停在 verifying。该数据被归类为测试沙箱装配问题，未计入通过；现场包含 ledger、session、日志与 `probe-events.jsonl`。

## 五工具、检查失败与非法计划

命令：`node scripts/probes/goal-smoke.ts --scenario multi-tools`。

成功现场 `goal-smoke-zly8G3` 已清理。checkpoint 成功时间 `2026-10-28T08:50:42.260Z`、revision 9，回执定位 `taskId=A / repoId=repoA`；retry 成功时间 `08:51:30.661Z`、revision 19，dispatch outcome=`bound`，新 run=`be84d363-1f8a-4be0-a999-f980e9c0856f`。真实链依次取得：`plan_execute`、`plan_checkpoint`（成功，记录 task A、decision/source ref/next action）、`plan_status`、受控 check-A exit `7`、blocked 后 released、`plan_retry` attempt 2、复合 `plan_verify`（check-A/check-B，均 exit 0）与终态 `verify` done。最终计划 completed，A attempt 为 2，A/B 均有 proof、integration receipt、queue completed、workspace released；主 Host 14 条 assistant，child 实例均在 6 条内。

第一次探针修复观察现场 `goal-smoke-Y85tbI` 保留：真实 exit 7 和 checkpoint 已发生，但修复 prompt 触发了正常 `/plan pause`，紧接着 retry 得到 `GOAL_NOT_ACTIVE`；这是探针遗漏既有 pause/resume 时序，不是生产缺陷。后续现场 `goal-smoke-XBfBPB` 也保留，业务链已到 completed 但探针错过早到的 retry 回执并超时；之后只修正回执 offset/等待，不改生产，不提高预算。

命令：`node scripts/probes/goal-smoke.ts --scenario multi-invalid`。

成功现场 `goal-smoke-nvD5oB` 已清理。两个独立的 `plan_execute` 均取得稳定失败回执：

- 无仓库前缀：`GOAL_REPOSITORY_PREFIX_REQUIRED`，任务 A 的 `outside.txt` 被拒绝。
- 跨仓库 writePaths：`GOAL_REPOSITORY_CROSS_TASK`，同一任务的 `repoA/out.txt` 与 `repoB/out.txt` 被拒绝。

两次拒绝后没有 Goal state、child、workspace 或 queue 副作用；主 Host 4 条 assistant。

## 真实 compact 与新 PID Host 恢复

命令：`node scripts/probes/goal-smoke.ts --scenario multi-compact`。

成功现场 `goal-smoke-uwAiej` 已清理。真实 compact 回执：`tokensBefore=182632`、`estimatedTokensAfter=28130`；compact 前 Host PID `55740`，关闭后新 Host PID `59490`，使用同一 session file。恢复后保留双仓库 binding、两个 run/workspace/proof/receipt 事实，`execution.inspect` 可用，复合 subject/verify 通过，最终 completed/released；主 Host 13 条 assistant，两个 child 均在预算内。

首次 compact 填充现场 `goal-smoke-zcrlXa`、`goal-smoke-6oQPkz` 保留，分别记录了尚未建立 Goal 时模型误调用 checkpoint 的合法 `NO_GOAL_STATE`、上下文过小导致 RPC `Nothing to compact`。没有把这些失败现场改写成通过。

**尚未归因的时序观察（分类 3）：`goal-smoke-OI5iFG` 使用正常 profile，Host PID `38500` 的 `smoke-61`（`/smoke-observe` 内部只读 `execution.inspect`）超过探针 30 秒等待窗口才返回 `success:true`，`smoke-62 get_entries` 先返回；没有 `extension_error`。当时另有四个独立回归 Host 正在运行。原始现场完整保留，未改超时、断言或 production。后续独立重跑 Host `55740→59490` 成功只证明该链路可达，不证明此次超时已经修复或根因已确定。** 主管允许以此明确残留交付 T5；再次出现应保留现场另派性能/时序归因。

## 单仓库三场景回归

所有场景均使用普通 Git 仓库、真实 Host RPC 和同一 qoder-pool qualified model；成功根均 `removed:true`、`killedPids:[]`、`noStagedFiles:true`。

- 正向：`--scenario positive`，现场 `goal-smoke-HJr06g`；计划 `f1bd886b-6d9f-4bf4-85bf-e4dad48f4cfb` completed，A/B 顺序依赖、proof/receipt、checks exit 0、released 均通过；主 13 条，child A PID `40689` 3 条、B PID `49402` 2 条。
- typed resume：`--scenario resume`，现场已清理；旧 run 形成 canonical pending intent，`subagent_run_resume` 使用新 PID 与同一 session/workspace，最终 intent completed、proof/receipt/released 通过；主 9 条，child 每实例均在限内。
- compact 加新 PID：`--scenario compact`，现场 `goal-smoke-YjKX7N`；`tokensBefore=176274`、`estimatedTokensAfter=24254`，旧 PID `39207`、新 PID `51081`，同一 session file；恢复后 `plan_verify`、exit 0、completed、proof/receipt/released 通过；主 13 条，child PID `45235` 3 条。

单仓库 repair 也独立通过：`--scenario repair`，现场 `goal-smoke-68Evja`；第一次检查真实 exit 7、blocked/released，随后 retry attempt 2、exit 0、completed，主 14 条，旧 child PID `40369` 2 条、新 child PID `49663` 3 条。

## 探针改动与清理规则

`scripts/probes/goal-smoke.ts` 现在：

- 提供独立 `multi-parallel`、`multi-tools`、`multi-invalid`、`multi-compact` 场景；每场景独立临时根，不把所有故障叠加在一个流程。
- 记录 ISO 时间、Host PID/exit、child PID/session/model/assistant 次数、plan/run/workspace/lease/identity、proof/receipt、queue、check exit code、parallel overlap 和 compact 前后 token。
- `--keep-artifacts` 可保留成功现场；失败、信号中断或模型/预算错误无条件保留 ledger、session、日志和 `probe-events.jsonl`。成功且未指定保留时清理临时根并记录 `removed:true`；成功保留时由 `preserved:true` 明示。
- 临时 profile 固定为真实模型并把工具集合限制到沙箱实际提供的 read/write/edit/bash；该改动只作用于临时 agent profile 生成，不改变仓库 profile 或 production。

## 验证命令与工作树

- `node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --target ES2024 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --skipLibCheck --types node scripts/probes/goal-smoke.ts`：passed。
- `git diff --check`：passed。
- `git diff --cached --name-only`：空；未 stage/commit。
- 本次允许写入范围只涉及探针和本报告及 v1 报告追加；未修改 production。

## 残留边界

首轮污染现场保留用于归因，成功根已清理。没有已确认且待修复的 production 缺陷；`goal-smoke-OI5iFG` 的 RPC 延迟仍属分类 3，不能据成功重跑关闭。真实场景未读取或输出凭据，未修改主仓 var/workspaces、settings 或用户 dirty。模型消耗均在授权预算内。v2 smoke 没有声称覆盖计划明确不支持的 nested/linked worktree、动态拓扑、跨仓库单任务之外的语法，亦未人工推进 queue 或伪造 receipt。

## 完整身份、预算与回执索引

以下表格由实际 JSONL 回执汇总；所有时间为 UTC，所有 Host 正常关闭 exit code 均为 0。失败探针 exit code 为 1，成功探针 exit code 为 0。`主` 按整个场景合并旧/新 Host assistant。compact 摘要调用不计为普通 assistant：单仓摘要 input/output/totalTokens=`127894/345/128239`，双仓摘要=`127894/297/128191`，两者 cacheRead=0；计入摘要也分别为 14 次主模型调用，未超过 16。下表 tokens 仅为 session assistant 汇总，摘要 usage 单列避免混算；模型目录 cost=0 不代表供应商实际免费。

| 临时根 | 场景结果 | 主 / 16 | child PID:次数（各 ≤6） | input / output / cacheRead / totalTokens | removed |
| --- | --- | ---: | --- | --- | --- |
| goal-smoke-QDu2CS | 探针失败，保留 | 4 | 89955:4，89951:2 | 53607 / 1830 / 10240 / 65677 | false |
| goal-smoke-yuUqH8 | 通过 | 7 | 6580:2，6575:2 | 97159 / 1741 / 33152 / 132052 | true |
| goal-smoke-Y85tbI | 探针失败，保留 | 10 | 10179:3，10183:3 | 118460 / 2806 / 70400 / 191666 | false |
| goal-smoke-XBfBPB | 探针失败，保留 | 13 | 14026:2，14085:2，16975:5 | 177043 / 3598 / 174336 / 354977 | false |
| goal-smoke-nvD5oB | 通过 | 4 | 无 | 5509 / 173 / 1536 / 7218 | true |
| goal-smoke-zcrlXa | 探针失败，保留 | 9 | 19538:2，19526:2 | 619235 / 1564 / 354944 / 975743 | false |
| goal-smoke-zly8G3 | 通过 | 14 | 28076:3，28143:2，34189:4 | 191365 / 4096 / 232960 / 428421 | true |
| goal-smoke-6oQPkz | 探针失败，保留 | 5 | 28465:2，28557:2 | 155057 / 1379 / 52480 / 208916 | false |
| goal-smoke-OI5iFG | 探针失败，保留 | 8 | 39642:2，39668:2 | 625899 / 1421 / 353536 / 980856 | false |
| goal-smoke-HJr06g | 通过 | 13 | 40689:3，49402:2 | 134606 / 2210 / 108288 / 245104 | true |
| goal-smoke-68Evja | 通过 | 14 | 40369:2，49663:3 | 112662 / 2298 / 97664 / 212624 | true |
| goal-smoke-Amyc5m | 通过 | 9 | 40609:4，46049:4 | 30584 / 3070 / 51968 / 85622 | true |
| goal-smoke-YjKX7N | 通过 | 13 | 45235:3 | 748776 / 1378 / 492160 / 1242314 | true |
| goal-smoke-uwAiej | 通过 | 13 | 56610:2，56614:4 | 797743 / 1895 / 530560 / 1330198 | true |

所有场景 cleanup 均 `killedPids:[]`、`noStagedFiles:true`。14 次执行合计 209 条普通 assistant（含所有失败轮次）及 2 次成功 compact 摘要；各次预算不互相转移。最终再次以文件系统核验：8 个成功根均不存在，6 个失败根均仍存在。失败临时根全路径统一前缀为 `/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/`；原始 stdout 仍保存在下表所列 `/tmp/goal-v2-*` 文件，失败根另有完整 `host-<PID>.json`、session、ledger 和 `probe-events.jsonl`。

### goal-v2-parallel-fixed.CrTW2u

原始回执：`/tmp/goal-v2-parallel-fixed.CrTW2u`。临时根：`/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/goal-smoke-yuUqH8`（已删除）。Host PID：6341；session：`01a181ad-bfd5-75e6-b892-982478d1e33a`；plan：`891ea1cf-edfe-4dce-a3f3-ab36699155f0`。

- repoA：origin `/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/goal-smoke-yuUqH8/super-root/repoA`；repositoryId `5a90e008c5a27fceeb06f1b002348585ebd33456e8b523298272eb7598d67633`；storageRepositoryId `1186287590cf4eee77322702b72f35463fa45a7dacbe84a06ae2bbc02f1e383f`。
- repoB：origin `/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/goal-smoke-yuUqH8/super-root/repoB`；repositoryId `7f1435b60b8b0c3c54291a9b3eacd157cf19f3fdc8772e670802abd3cc0e2263`；storageRepositoryId `620b167a75a24709f32c1dad5b4d44552a2e9895c16cf31c57f5ceffc8563325`。

| origin / runId | workspaceId / leaseId | proofId | queueId → integration receipt | 状态 / writePaths |
| --- | --- | --- | --- | --- |
| repoA / 7671c305-82d8-47ba-aacc-c485fa037c4d | 75fec7c8-1687-4de1-a97f-59f0b8add6e1<br>90c6262e9c680b223ec2f540bb45dce56612a5d1f2fd6f27606e298626938425 | b8c6e1c589479330d3d260d59fd877acd6209528eb7139c5a015f0a9f18ecd17 | 04520ef2-682e-4ff0-ba4f-679340759698 → 5fdfdf82-189a-4016-a115-846b8a6e4aee | released / multi-parallel-A.txt |
| repoB / 7a7fc93a-7460-44c0-aad5-ae53a859d62d | 6eeb72d6-3bb3-4a40-be88-b63d57dee28a<br>9e0e4a238ba213d3c4a9ed6adaa431726670fdf31ad315fee8d72efa0da1ebf9 | 20a57b546b4303a1001c6185639b8e81c275b417825c0e0c45ea616904ccfb59 | 7fe9df59-648f-47e0-a881-060eacddd1ac → 840a6f1f-2157-48c1-8723-38ffd0e30255 | released / multi-parallel-B.txt |

检查回执（全部经正式 `plan_verify → bash`，在计划规定的 cwd 执行）：

- check-A：exit 0，resultRef `d22b5124#0`，toolCallId `call_00_M0ERFqqqmqo6M0A4Kc929321`，subject multi-repository。
- check-B：exit 0，resultRef `57e4315f#0`，toolCallId `call_00_DdWhVSeG4farlbIrjhfb9466`，subject multi-repository。
- check-A：exit 0，resultRef `1b1ef0bd#0`，toolCallId `call_00_vKeIrUa98ncO4wQKozCj1575`，subject multi-repository。
- check-B：exit 0，resultRef `1b1ef0bd#1`，toolCallId `call_00_vKeIrUa98ncO4wQKozCj1575`，subject multi-repository。

### goal-v2-invalid.2OhSaU

原始回执：`/tmp/goal-v2-invalid.2OhSaU`。临时根：`/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/goal-smoke-nvD5oB`（已删除）。Host PID：14663；session：`01a181b1-00f6-716e-964b-bc30f0c14f0f`；plan：`不适用（typed resume 或非法计划拒绝）`。


### goal-v2-multi-tools-final.mYOIRx

原始回执：`/tmp/goal-v2-multi-tools-final.mYOIRx`。临时根：`/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/goal-smoke-zly8G3`（已删除）。Host PID：27583；session：`01a181b4-3837-7083-a903-d335af3f5e24`；plan：`023dcde6-d6d6-4f6c-866f-5cae4d2a7f0c`。

- repoA：origin `/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/goal-smoke-zly8G3/super-root/repoA`；repositoryId `955ae88e35e9c116458c16c102450e954091a5dd3a56ae709cc4780b99d02006`；storageRepositoryId `70ca0c72236df864b098cfc60c3d03d1d670c284d6b818a513b2ca0bffd402cd`。
- repoB：origin `/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/goal-smoke-zly8G3/super-root/repoB`；repositoryId `0045e79f93563eb88a3ebc973e139e1cd25a190966584183af3b04f26633064f`；storageRepositoryId `4963e40b54fa15d320f51c64219e4af2abb8169fbc0f50b370651c993dce1963`。

| origin / runId | workspaceId / leaseId | proofId | queueId → integration receipt | 状态 / writePaths |
| --- | --- | --- | --- | --- |
| repoA / be84d363-1f8a-4be0-a999-f980e9c0856f | a5aaf931-15c7-4d0d-bcd4-d4c017f67f1a<br>8c0e4dee8520846709c4157178fddb325df1b1f028b518fab4ff7102a35f9499 | 97ba740935ece44a7c32b8529bb40793bf6d6faca2ea756179d38dc8a3e54a40 | 93854551-c10e-430a-99ce-d1ccd1d1888c → c9b4dcfb-a59c-422d-84a8-bc964859b235 | released / multi-tools-A.txt |
| repoA / 1b4a6a21-e3c6-48a4-8d91-3048108517b1 | d1d8237d-0f32-4f0f-b569-544c26ab5c54<br>814b62ad667ea78743149c24438b7632aaad36db5b94b77c3033bd39d1f1c711 | ee20809f72b12aca03002e57fb34ec33c1011f37370c7696a811921eee2d81eb | d0db54eb-b7f1-48df-878c-1e01ecfa3deb → e9660de4-677e-409e-a83a-bf114b3db743 | released / multi-tools-A.txt |
| repoB / b4f6fe4b-b46b-46e9-8013-0c61ce721f09 | 2c8bcbb1-20ff-45da-a53b-5f530d992cb7<br>56e492903182103349b18b5cfeff79d10d74dd27a1bcf944247c02fc4ea8f4f1 | 246eb9ea69018d3da53ac7af2b7e8e8f273843e6937072b3d887bd78f6d82e4a | f3654ba1-faef-40e4-a8e6-2e7933592b08 → fe2ced7d-d9db-4202-98d0-9bc42e9316a1 | released / multi-tools-B.txt |

检查回执（全部经正式 `plan_verify → bash`，在计划规定的 cwd 执行）：

- check-A：exit 7，resultRef `f8110488#0`，toolCallId `call_00_1l6p6Vs7x6WHnO8WhERx5284`，subject multi-repository。
- check-B：exit 0，resultRef `67367ab0#0`，toolCallId `call_00_1npk1r4OgkhKqb2i5XMw4796`，subject multi-repository。
- check-A：exit 0，resultRef `18afc0c0#0`，toolCallId `call_00_BHHlX8OQocMhzBFCvCN00213`，subject multi-repository。
- check-A：exit 0，resultRef `546803de#0`，toolCallId `call_00_TaQ9NUVf2aQa7I0JkbLz6109`，subject multi-repository。
- check-B：exit 0，resultRef `546803de#1`，toolCallId `call_00_TaQ9NUVf2aQa7I0JkbLz6109`，subject multi-repository。

### goal-v2-positive.pXe08v

原始回执：`/tmp/goal-v2-positive.pXe08v`。临时根：`/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/goal-smoke-HJr06g`（已删除）。Host PID：39180；session：`01a181b7-3f1e-7108-b853-967d185385eb`；plan：`f1bd886b-6d9f-4bf4-85bf-e4dad48f4cfb`。


| origin / runId | workspaceId / leaseId | proofId | queueId → integration receipt | 状态 / writePaths |
| --- | --- | --- | --- | --- |
| repository / 0e6c00bc-2a96-45be-9f5d-33e652e05fe8 | bb09c88e-a8e5-47ac-928b-30af7664ba86<br>cd5fbd1e69dcaaf9e29540fb1b9b06b15dccb043608c9e8d0aa7e36b31645657 | 954ea891573b7c83f2582698033ca32ea8e9405602ebccee24df515b8339a129 | 25939b28-7953-46bb-ad2e-d5821f4aba03 → cb472816-5910-40cb-9cd1-61198405929d | released / positive-A.txt |
| repository / c73e9709-8c3d-42ce-b166-42e39eeecc79 | d34849e7-b0b5-40c3-b0b7-1c7e950ea6f6<br>aca2332d22d0d0230ef7c34618642e51e8d114c062722d02a3fdf489e09b9ce6 | 662586e01c29ba92689e6fdff6d468cb0d9bb29572ad14d57d825ba18368886e | fef632cf-003a-4cc0-8358-305df9fbf472 → 4c8247a2-dd32-4da6-9b11-1c06da9b3ba4 | released / positive-B.txt |

检查回执（全部经正式 `plan_verify → bash`，在计划规定的 cwd 执行）：

- check-A：exit 0，resultRef `eb23a22b#0`，toolCallId `call_00_Um0BNj3QIABDMqdAkrPy5526`，subject 单仓库。
- check-B：exit 0，resultRef `61eedbc8#0`，toolCallId `call_00_Tg4e414bUVdWr8AzylmT4719`，subject 单仓库。
- check-A：exit 0，resultRef `8576ef3f#0`，toolCallId `call_00_1NevWjZ4mFuFy0GLU3qv2087`，subject 单仓库。
- check-B：exit 0，resultRef `8576ef3f#1`，toolCallId `call_00_1NevWjZ4mFuFy0GLU3qv2087`，subject 单仓库。

### goal-v2-repair.Kn9OzD

原始回执：`/tmp/goal-v2-repair.Kn9OzD`。临时根：`/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/goal-smoke-68Evja`（已删除）。Host PID：39201；session：`01a181b7-4099-76d4-ae07-21fe4db9c711`；plan：`9df3d5be-ef4e-450d-8b0d-7a654acb3f55`。


| origin / runId | workspaceId / leaseId | proofId | queueId → integration receipt | 状态 / writePaths |
| --- | --- | --- | --- | --- |
| repository / ee6e868b-d1e8-40c3-bf72-2373b4f972d8 | 20faf74e-63e6-42f9-b57e-65906621d36f<br>fc430676115741ae2d478b2308490d85b025f8a3159a31601ec5c25bb1a3a3f4 | 28e59cf5b78f1cccdfdaf24c2a7e334c6954caf35736bcc0b0f594b334478ae1 | 5666dcc5-2b7a-4ebe-bf9e-494add7884d0 → 91798dd7-8ef5-4e72-93fd-7cee3ee17752 | released / repair-A.txt |
| repository / 2252d10e-019e-45e7-b024-c9ca525bd1d3 | 3408ee5a-fd88-4779-ac74-d2d1e46f3a29<br>c9a7092dde5196058663735317fe98c2b660fe6fcb0f1593ebee9fea944b07db | c2431522973de4e48bce446d63cbac9b9c2b6b581335206ece17d173f8943d56 | da1c298d-6475-4d4f-baa1-48047e2b47d3 → 9106a72d-631b-4769-a487-51549df0b2ef | released / repair-A.txt |

检查回执（全部经正式 `plan_verify → bash`，在计划规定的 cwd 执行）：

- check-A：exit 7，resultRef `49e8e84d#0`，toolCallId `call_00_ZkJ2pTEFivC2eM2vpn7p4475`，subject 单仓库。
- check-A：exit 0，resultRef `1518fc07#0`，toolCallId `call_00_HggVmWQ2DG7X2tqwoqUq7770`，subject 单仓库。
- check-A：exit 0，resultRef `7800eabe#0`，toolCallId `call_00_NVIKOrLjd0IjLbD8cdMW2854`，subject 单仓库。

### goal-v2-resume.DdAot2

原始回执：`/tmp/goal-v2-resume.DdAot2`。临时根：`/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/goal-smoke-Amyc5m`（已删除）。Host PID：39197；session：`01a181b7-4033-708b-8316-407096993844`；plan：`不适用（typed resume 或非法计划拒绝）`。


| origin / runId | workspaceId / leaseId | proofId | queueId → integration receipt | 状态 / writePaths |
| --- | --- | --- | --- | --- |
| repository / 873ff538-81f2-4f4e-a806-7b8ecab6875d | 7af9e9c0-d736-42d3-b94d-f80e109225dc<br>764da4be5788826d8bf361ee6eee6c71f9e2d3fdce4eacc84a3885d98cd2bcb6 | 3aa8fea339a691cf91ec1a5597526e6c720682f4b23a1eb441c2827f3ce370be | 9d508d0a-9980-4c5a-b5a6-5871c3d5dd3c → 002930be-cfe4-430a-a84a-fc5dd2d118c7 | released / resume.txt |

typed resume 回执：

```json
{
  "type": "resume_receipt",
  "at": "2026-10-28T08:54:50.659Z",
  "sourceRunId": "7f10f87d-bc1f-4cc0-94f9-ab41b323a242",
  "resumedRunId": "873ff538-81f2-4f4e-a806-7b8ecab6875d",
  "oldPid": 40609,
  "newPid": 46049,
  "sessionFile": "/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/goal-smoke-Amyc5m/sessions/2026-10-28T08-53-52-820Z_01a181b7-4033-708b-8316-407096993844/7f10f87d-bc1f-4cc0-94f9-ab41b323a242/run-0/session.jsonl",
  "workspaceId": "7af9e9c0-d736-42d3-b94d-f80e109225dc",
  "queueItemId": "9d508d0a-9980-4c5a-b5a6-5871c3d5dd3c",
  "resumeIntentId": "52b934e5-53e4-43a2-963c-db4ad7ee5430",
  "agentProfile": "delegate",
  "state": "completed",
  "proofId": "3aa8fea339a691cf91ec1a5597526e6c720682f4b23a1eb441c2827f3ce370be",
  "integrationReceiptRef": "002930be-cfe4-430a-a84a-fc5dd2d118c7"
}
```

### goal-v2-compact.tlgBPG

原始回执：`/tmp/goal-v2-compact.tlgBPG`。临时根：`/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/goal-smoke-YjKX7N`（已删除）。Host PID：39207 → 51081；session：`01a181b7-40f5-743c-b624-d25dea36a48e`；plan：`724fdbb4-7578-4647-b951-5e885cdc91cd`。


| origin / runId | workspaceId / leaseId | proofId | queueId → integration receipt | 状态 / writePaths |
| --- | --- | --- | --- | --- |
| repository / f07811da-1a02-4066-b3a5-53c931d0ee15 | 53dd1324-e94f-4a6b-b4b2-f59e3b774ed8<br>4391fcd30c77b609c24e5a244ed7fad2f3e53f21fd9d81955e28e3a0bd46f119 | 590a3ad06a04ef655d7780ff819f778236bd8c9e2ffc3db15eb8459aa053bf0c | d9d8804a-e6e5-4907-86bc-b47ca41f00ea → 93e99a53-43b7-4f3a-937b-f848b12df09a | released / compact-A.txt |

检查回执（全部经正式 `plan_verify → bash`，在计划规定的 cwd 执行）：

- check-A：exit 0，resultRef `126c3dbe#0`，toolCallId `call_00_VPmCoXNsj8v97Z4WDjnD0455`，subject 单仓库。
- check-A：exit 0，resultRef `40190b16#0`，toolCallId `call_00_sbDh6Cj8pOqhXD9qLQcU1501`，subject 单仓库。

### goal-v2-multi-compact-latest.9DMHhy

原始回执：`/tmp/goal-v2-multi-compact-latest.9DMHhy`。临时根：`/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/goal-smoke-uwAiej`（已删除）。Host PID：55740 → 59490；session：`01a181b9-a9c4-702b-be72-91ce62a11667`；plan：`fba044a2-f2da-4405-b782-f0ffeedb1faf`。

- repoA：origin `/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/goal-smoke-uwAiej/super-root/repoA`；repositoryId `74198fd61dcb61fb0f86730e477e8b5150a70050370329ff4beff78def46ff7a`；storageRepositoryId `b34e1e11f27433f12d58c189426eed778f29128aa6a9448d3e08138f7a363e35`。
- repoB：origin `/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/goal-smoke-uwAiej/super-root/repoB`；repositoryId `41218d71727977a93bac7cc927a9a73926a35c4d156e5b7f172d6c7a055eef1c`；storageRepositoryId `a8854f12187a694aa76950b26ad9735e0e7f20f8591894c853f528ff643ebbdd`。

| origin / runId | workspaceId / leaseId | proofId | queueId → integration receipt | 状态 / writePaths |
| --- | --- | --- | --- | --- |
| repoA / 91d2044d-151c-4180-8a84-f760fdd9de43 | 6b1eb044-c7ef-4026-9ce4-338ffeac0afa<br>b17460b174fa9097915292b67d0cbd36013350246d9a965ac2c8df91c42df652 | 316ed23ff5e3ff98db189658e011b6b6318829ec7a5c49841dce7f79f3a40ac1 | fd6ef930-5972-4ee6-bb0a-92aa0cbd050b → 9dd1c1cf-ceeb-4800-8fa0-72aa6fce0988 | released / multi-compact-A.txt |
| repoB / 1081b649-52a4-4a39-a797-10ca3c538222 | 899b8ec4-4b77-41c8-984c-1bf26b180765<br>a64f69cb44ac71601a3704efa6c9c59a57e214034be5a3ba27adac6ef22b0b1a | 939974ca68b89d2c020b38ec5b0cffd57d58a7dd1da87b0b1cdaa6107947fbf7 | 243431b8-ecb0-47f9-88c8-b2c7aee8d14d → 1155a6ef-ce35-4de6-b4b4-ee65b849a7cf | released / multi-compact-B.txt |

检查回执（全部经正式 `plan_verify → bash`，在计划规定的 cwd 执行）：

- check-A：exit 0，resultRef `b0844b43#0`，toolCallId `call_00_flwNYO2NY4zr4kdTSI4w2870`，subject multi-repository。
- check-B：exit 0，resultRef `72c22786#0`，toolCallId `call_00_uZlxU45D1q5KjlGV6wCA2260`，subject multi-repository。
- check-A：exit 0，resultRef `fb4bdf23#0`，toolCallId `call_00_Phm7D3j13Svo3NQwSHaX4328`，subject multi-repository。
- check-B：exit 0，resultRef `fb4bdf23#1`，toolCallId `call_00_Phm7D3j13Svo3NQwSHaX4328`，subject multi-repository。
