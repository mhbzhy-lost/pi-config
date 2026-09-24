# 跨会话错误码流行度统计 v2

## v2 修订说明

- 修正：toolCallId 去重；details 不独立计数。
- T1 仅统计 runtime 工具且错误前缀匹配；其它工具为受污染 T2。
- awaiting-disposition 与 cleanup-debt 为成功状态标签，不计入错误。
- 目标校准：toolResults=547、INVALID_CONTRACT=12、INVALID_PATH=6、MODEL_NOT_AVAILABLE=2、SUBAGENT_RPC_FAILED=1、Started=104、MANAGED_WORKSPACE_GIT=5、STATE=3、ACTION=1、NOT_FOUND=1。（快照：读取时 1602 行 / 547 toolResult / 最后事件 2026-09-23T07:35:05.718Z；目标为 live，会继续增长。）

## 1. 总览

- 扫描会话文件：316；T1 命中：64；项目 cwd：14。

## 2. T1｜runtime 真实拒绝（主表）

|签名|次数|会话数|项目数|最早|最晚|判定|
|---|---:|---:|---:|---|---|---|
|INVALID_CONTRACT|322|52|10|2026-07-20|2026-09-20|慢性|
|INVALID_PATH|336|52|12|2026-07-20|2026-09-20|慢性|
|INVALID_GENERIC_DISPATCH|8|3|2|2026-09-14|2026-09-17|慢性|
|INVALID_CODING_ROUTER|3|1|1|2026-09-08|2026-09-08|偶发|
|MODEL_NOT_AVAILABLE|20|12|5|2026-09-04|2026-09-20|慢性|
|MODEL_MATCH_USED_GLOBAL_CATALOG|0|0|0|||未出现|
|MANAGED_WORKSPACE_GIT|7|3|3|2026-09-04|2026-09-20|慢性|
|MANAGED_WORKSPACE_STATE|3|1|1|2026-09-20|2026-09-20|偶发|
|MANAGED_WORKSPACE_ACTION|1|1|1|2026-09-20|2026-09-20|偶发|
|MANAGED_WORKSPACE_NOT_FOUND|1|1|1|2026-09-20|2026-09-20|偶发|
|MANAGED_WORKSPACE_SCOPE|0|0|0|||未出现|
|SUBAGENT_RPC_FAILED|22|11|4|2026-08-26|2026-09-20|慢性|
|is missing required field boundaries|17|3|3|2026-09-08|2026-09-20|慢性|
|contains unknown field outputMode|1|1|1|2026-09-20|2026-09-20|偶发|
|workflow.reason is forbidden when mode is tdd|182|41|10|2026-07-20|2026-09-20|慢性|
|workflow.reason is required when mode is docs-only|8|7|6|2026-07-20|2026-09-20|慢性|
|must be a repo-relative POSIX path|200|47|12|2026-07-20|2026-09-20|慢性|
|contains an unsupported path pattern|104|30|10|2026-07-20|2026-09-20|慢性|
|action token is stale, replayed, or does not match|1|1|1|2026-09-20|2026-09-20|偶发|
|git worktree remove|7|3|3|2026-09-04|2026-09-20|慢性|
|workspace status is unavailable in preserved|2|1|1|2026-09-20|2026-09-20|偶发|
|only a preserved or cleanup-debt workspace can be released|1|1|1|2026-09-20|2026-09-20|偶发|
|is paused; stop only supports running async runs|9|6|5|2026-08-12|2026-09-20|慢性|

## 3. T2｜全量字符串出现（受污染源附表）

|工具|签名|次数|
|---|---|---:|
|bash|INVALID_CONTRACT|341|
|bash|git worktree remove|91|
|bash|SUBAGENT_RPC_FAILED|71|
|bash|INVALID_PATH|48|
|bash|MODEL_MATCH_USED_GLOBAL_CATALOG|45|
|bash|workflow.reason is forbidden when mode is tdd|41|
|bash|INVALID_GENERIC_DISPATCH|39|
|bash|MANAGED_WORKSPACE_STATE|35|
|bash|MODEL_NOT_AVAILABLE|28|
|bash|MANAGED_WORKSPACE_GIT|28|
|bash|MANAGED_WORKSPACE_ACTION|23|
|bash|INVALID_CODING_ROUTER|14|
|bash|must be a repo-relative POSIX path|13|
|bash|is missing required field boundaries|13|
|bash|contains an unsupported path pattern|12|
|bash|workflow.reason is required when mode is docs-only|11|
|bash|action token is stale, replayed, or does not match|11|
|bash|MANAGED_WORKSPACE_NOT_FOUND|11|
|bash|workspace status is unavailable in preserved|9|
|bash|only a preserved or cleanup-debt workspace can be released|8|
|bash|contains unknown field outputMode|8|
|bash|is paused; stop only supports running async runs|7|
|bash|MANAGED_WORKSPACE_SCOPE|5|
|grep|INVALID_CONTRACT|64|
|grep|SUBAGENT_RPC_FAILED|48|
|grep|INVALID_GENERIC_DISPATCH|28|
|grep|MANAGED_WORKSPACE_ACTION|27|
|grep|INVALID_PATH|13|
|grep|MANAGED_WORKSPACE_STATE|12|
|grep|MODEL_MATCH_USED_GLOBAL_CATALOG|7|
|grep|git worktree remove|2|
|grep|MODEL_NOT_AVAILABLE|2|
|grep|workflow.reason is forbidden when mode is tdd|1|
|grep|contains an unsupported path pattern|1|
|grep|must be a repo-relative POSIX path|1|
|grep|MANAGED_WORKSPACE_NOT_FOUND|1|
|grep|MANAGED_WORKSPACE_GIT|1|
|grep|action token is stale, replayed, or does not match|1|
|read|INVALID_CONTRACT|908|
|read|INVALID_PATH|256|
|read|MODEL_MATCH_USED_GLOBAL_CATALOG|169|
|read|INVALID_GENERIC_DISPATCH|108|
|read|SUBAGENT_RPC_FAILED|80|
|read|must be a repo-relative POSIX path|45|
|read|contains an unsupported path pattern|45|
|read|workflow.reason is forbidden when mode is tdd|42|
|read|INVALID_CODING_ROUTER|32|
|read|git worktree remove|16|
|read|MANAGED_WORKSPACE_STATE|12|
|read|MODEL_NOT_AVAILABLE|11|
|read|MANAGED_WORKSPACE_ACTION|7|
|read|MANAGED_WORKSPACE_GIT|6|
|read|MANAGED_WORKSPACE_NOT_FOUND|1|
|read|action token is stale, replayed, or does not match|1|

## 4. 目标会话相对位置

按 T1 仅对该签名命中会话排名：
- `INVALID_CONTRACT`：12 次，排名 7/52，普通水平
- `INVALID_PATH`：6 次，排名 16/52，普通水平
- `INVALID_GENERIC_DISPATCH`：0 次，未出现
- `INVALID_CODING_ROUTER`：0 次，未出现
- `MODEL_NOT_AVAILABLE`：2 次，排名 2/12，普通水平
- `MODEL_MATCH_USED_GLOBAL_CATALOG`：0 次，未出现
- `MANAGED_WORKSPACE_GIT`：5 次，排名 1/3，历史最高
- `MANAGED_WORKSPACE_STATE`：3 次，排名 1/1，历史最高
- `MANAGED_WORKSPACE_ACTION`：1 次，排名 1/1，历史最高
- `MANAGED_WORKSPACE_NOT_FOUND`：1 次，排名 1/1，历史最高
- `MANAGED_WORKSPACE_SCOPE`：0 次，未出现
- `SUBAGENT_RPC_FAILED`：1 次，排名 4/11，普通水平
- `is missing required field boundaries`：8 次，排名 1/3，历史最高
- `contains unknown field outputMode`：1 次，排名 1/1，历史最高
- `workflow.reason is forbidden when mode is tdd`：1 次，排名 22/41，普通水平
- `workflow.reason is required when mode is docs-only`：1 次，排名 2/7，普通水平
- `must be a repo-relative POSIX path`：2 次，排名 20/47，普通水平
- `contains an unsupported path pattern`：4 次，排名 9/30，普通水平
- `action token is stale, replayed, or does not match`：1 次，排名 1/1，历史最高
- `git worktree remove`：5 次，排名 1/3，历史最高
- `workspace status is unavailable in preserved`：2 次，排名 1/1，历史最高
- `only a preserved or cleanup-debt workspace can be released`：1 次，排名 1/1，历史最高
- `is paused; stop only supports running async runs`：1 次，排名 3/6，普通水平

## 5. 派生指标

- 全局派发拒绝率按会话聚合：拒绝结果/（成功 Started + 拒绝）需从逐会话数据重算；目标基准：成功 64、拒绝 15、19.0%。目标实际成功=104、拒绝=22，拒绝率=17.5%。
- 目标 worktree 处置失败率：10/33 = 30.3%。
- 目标被拒派发参数体积：54617 bytes；均值=2482.6 bytes/次；目标被拒数=22。
- taskId 重试深度：本脚本按每会话 toolCall arguments 的 taskId 计数；见下方目标及全局分布。
- 目标 taskId 次数：{'t1-baseline': 2, 't2-baseline-audit': 2, 't2-baseline-audit-retry': 1, 't2-fetch-upstream-release': 1, 't3-custom-diff-matrix': 1, 't3-diff-matrix-integration': 1, 't4-platform-adapter-contract': 1, 't5-qoder-grpc-capability': 1, 't5-capability-report-retry': 1, 't7-responses-compact-design': 3, 'qoder-user-quota-impact': 1, 't6-dual-pool-scheduling-contract': 1, 'record-owner-decisions': 2, 't7-recover-and-finish': 2, 't7a-service-converter': 1, 't7b-handler-unsupported': 1, 't7c-codex-compact': 2, 't7c1-compact-pure-adapter': 2, 't7c2-compact-http-integration': 2, 't7-finalize-e1': 3, 't7-local-anchor-commit': 1, 't8a-v027-rebase-scaffold': 1, 't8d4-1-contributor-settings': 3, 't8d4-1-contributor-settings-fresh': 1, 'clean-root-worktree': 1, 'integrate-canonical-migration': 1, 't8d4-1-settings-canonical': 1, 'integrate-settings-workspace': 1, 't8d4-2-cache-invalidation': 1, 'integrate-cache-workspace-fallback': 1, 't8d4-3-contributor-policy': 1, 't8d4-4-contributor-repository': 1, 't8d4-5-token-refresh-write': 1, 't8d4-6-contributor-http-wire': 1, 'fix-qoder-quota-expiry-test': 1, 't8d4-7-proxy-snapshot': 1, 't8e1-frontend': 1, 't8e2-qoder-admin-routes': 1, 't8e3-self-service-deploy': 1, 't8e4-fork-deploy-blockers': 1, 't8e5-deploy-readiness': 1, 't8f-final-audit': 1, 't8f-test-hygiene': 1, 't8f-final-audit-scoped': 1, 't9-grpc-only-boundary': 1, 't10-dynamic-catalog-vision': 1, 't10b-catalog-endpoints-vision': 2, 't10b1-catalog-endpoints-green': 1, 't10b2-vision-gate': 1, 't10b3-client-config-parse': 1, 't11-observability-readiness': 1, 't11b-quota-readiness': 1, 't11b-quota-poll-green': 1, 't11c-qoder-readiness-backend': 1, 't11d-deploy-readiness-integration': 1, 't11r-fix-d2-qoder-allowlist': 1, 't11r-findings-resolution': 1, 't11r-fix-contributor-lifecycle': 1, 't11r-fix-blk4-quota-proxy': 2, 't11r-fix-blk5-quota-reserve-patch': 1, 'qoder-contributor-downstream-association': 5, 't11r-fix-high1-ops-session-id': 1, 't11r-fix-high2-sse-observability': 1, 't11r-fix-high3-qoder-usage-422': 1, 't11r-fix-a1-authentication-unrecoverable': 1}；全局 taskId 尝试深度分布：{1: 4498, 2: 431, 3: 107, 4: 26, 5: 8, 7: 1, 9: 1}

## 6. 时间趋势

|月份|T1 总数|
|---|---:|
|2026-07|482|
|2026-08|314|
|2026-09|459|

## 7. 项目分布（T1 前 10）

- `new-api-account-pool`：438
- `mega-aone-service`：257
- `taoappuse`：192
- `pi-config`：121
- `crash-analyzer-agent`：79
- `taobao-mobile-workspace`：73
- `CrashAgentService`：40
- `taobao-biz-workspace`：19
- `miross-employees`：15
- `crash-analyzer-agent-v2`：6

## 8. child session 交叉验证

- 根会话：316；Started 与 child 目录数吻合：259；吻合率：82.0%；不吻合：57。
- 不吻合清单：
  - `2026-07-20T08-12-46-192Z_019f7e95-acf0-7967-9c4b-9d0adac62c25.jsonl`：Started=0, child=1
  - `2026-07-20T09-03-30-862Z_019f7ec4-222e-7453-9ff9-9a2686058670.jsonl`：Started=91, child=272
  - `2026-07-20T10-22-19-749Z_smoke-test-plan-runner.jsonl`：Started=0, child=1
  - `2026-07-20T10-43-56-800Z_smoke-test-2.jsonl`：Started=0, child=1
  - `2026-07-20T10-50-17-253Z_smoke-test-3.jsonl`：Started=0, child=1
  - `2026-07-20T10-53-54-700Z_smoke-test-4.jsonl`：Started=0, child=1
  - `2026-07-20T11-13-22-093Z_smoke-test-5.jsonl`：Started=0, child=1
  - `2026-07-20T11-21-21-176Z_smoke-test-6.jsonl`：Started=0, child=1
  - `2026-07-20T12-28-14-898Z_smoke-test-final.jsonl`：Started=0, child=1
  - `2026-07-20T12-36-49-969Z_smoke-test-review.jsonl`：Started=0, child=1
  - `2026-07-20T12-40-11-945Z_smoke-review-2.jsonl`：Started=0, child=1
  - `2026-07-21T02-59-52-939Z_019f829d-93eb-77e3-be8d-71db733d8eab.jsonl`：Started=0, child=4
  - `2026-07-21T04-20-43-630Z_019f82e7-97ee-7b54-b528-5c1a1ca5aa16.jsonl`：Started=101, child=162
  - `2026-07-21T07-26-10-707Z_019f8391-6113-796e-9980-577b23380a16.jsonl`：Started=0, child=8
  - `2026-07-21T09-53-19-837Z_019f8418-19dd-7a55-b1a7-95a9beb636ec.jsonl`：Started=0, child=162
  - `2026-07-21T12-07-32-291Z_019f8492-f8c3-7bb9-be14-64ac0cd2cf67.jsonl`：Started=0, child=89
  - `2026-07-21T12-51-56-121Z_019f84bb-9e59-7bb4-b233-1e2cd0c6a043.jsonl`：Started=0, child=8
  - `2026-07-21T13-39-45-072Z_019f84e7-6530-7474-8902-38e9bc60638c.jsonl`：Started=0, child=30
  - `2026-07-23T03-07-26-353Z_019f8cf1-3710-77d7-a61f-17bd3e54f1ad.jsonl`：Started=0, child=2
  - `2026-07-23T10-28-15-522Z_019f8e84-cc22-7162-b8cf-6e08e5289e09.jsonl`：Started=0, child=5
  - `2026-07-23T14-13-20-723Z_019f8f52-ded3-7d18-bec6-314af69bcb33.jsonl`：Started=0, child=1
  - `2026-07-24T06-06-46-924Z_019f92bb-c48c-7ae9-b536-59db996884b5.jsonl`：Started=396, child=414
  - `2026-07-24T06-57-28-417Z_019f92ea-2d61-7bab-bd72-b615f1ae1926.jsonl`：Started=0, child=5
  - `2026-07-26T11-48-12-432Z_019f9e41-1210-7f0f-8b1b-da4cc917b8d9.jsonl`：Started=141, child=187
  - `2026-07-26T14-52-27-178Z_019f9ee9-c0aa-7ef2-93c5-509b04293302.jsonl`：Started=27, child=76
  - `2026-07-27T11-10-42-866Z_019fa345-1ab2-7554-b81f-33714fbc6e41.jsonl`：Started=0, child=3
  - `2026-07-29T03-09-17-075Z_019fabd9-0f93-7b93-8754-f30cc9bedc51.jsonl`：Started=5, child=0
  - `2026-07-29T04-05-37-719Z_019fac0c-a537-7d6a-bb15-8e6ead88e143.jsonl`：Started=577, child=629
  - `2026-07-29T04-05-51-297Z_019fac0c-da41-7534-a2fd-5e0f4118f39f.jsonl`：Started=6, child=0
  - `2026-07-29T04-31-08-532Z_019fac24-00f4-70ab-913f-ca1724149f8e.jsonl`：Started=16, child=0
  - `2026-07-30T03-28-35-176Z_019fb111-1768-797d-9de4-416052716514.jsonl`：Started=39, child=0
  - `2026-07-30T07-26-11-668Z_019fb1ea-a0d4-7781-85e3-27b03504cc46.jsonl`：Started=52, child=0
  - `2026-07-30T19-13-37-109Z_019fb472-4b55-785f-a052-fb01734cbcf9.jsonl`：Started=292, child=0
  - `2026-07-30T19-13-50-596Z_019fb472-8004-7e97-ac83-5eddb73853f7.jsonl`：Started=292, child=0
  - `2026-07-30T19-39-22-388Z_019fb489-df94-7209-b76a-1a9a452d319f.jsonl`：Started=300, child=0
  - `2026-07-31T02-53-25-335Z_019fb617-41d7-7520-ac47-b44240593e10.jsonl`：Started=62, child=0
  - `2026-07-31T06-11-26-544Z_019fb6cc-8cd0-7019-919f-1dc7d2bb8eb8.jsonl`：Started=63, child=0
  - `2026-07-31T08-03-54-404Z_019fb733-83a4-728c-98ba-5955ff90312a.jsonl`：Started=17, child=16
  - `2026-08-05T03-12-00-853Z_019fcfe8-1355-7a1b-9d54-600f613df9db.jsonl`：Started=75, child=0
  - `2026-08-05T03-12-14-730Z_019fcfe8-498a-79fb-b1a5-16b2866ec95f.jsonl`：Started=75, child=0
  - `2026-08-05T03-14-34-074Z_019fcfea-69da-7877-ad63-f28c5eacade5.jsonl`：Started=19, child=16
  - `2026-08-10T07-44-21-784Z_019feaa1-3718-7e79-af25-d34c62b547f2.jsonl`：Started=26, child=28
  - `2026-08-10T14-46-50-423Z_019fec24-0137-785f-8e7c-a0a626841083.jsonl`：Started=154, child=158
  - `2026-08-11T07-18-19-892Z_019fefaf-bdf4-76bd-985c-4a24fa1b0d12.jsonl`：Started=29, child=31
  - `2026-08-11T11-10-45-427Z_019ff084-88b3-7da2-96ac-7b08561bf86e.jsonl`：Started=52, child=54
  - `2026-08-12T04-13-59-372Z_019ff42d-54cc-723d-a709-edf555650346.jsonl`：Started=190, child=194
  - `2026-08-17T03-12-42-808Z_01a00db5-0738-74a9-aac4-2993c8f380e1.jsonl`：Started=271, child=269
  - `2026-08-19T10-09-04-867Z_01a0197e-f163-759a-86af-568946f1ab59.jsonl`：Started=30, child=29
  - `2026-08-20T03-52-55-175Z_01a01d4c-ea87-776a-9bbc-c77638df98a6.jsonl`：Started=55, child=54
  - `2026-08-27T06-40-52-897Z_01a041f3-34a1-7f2a-87eb-54c1ef5ca069.jsonl`：Started=94, child=92
  - `2026-09-05T15-13-57-381Z_01a07222-2c85-7684-91aa-c168424bd84f.jsonl`：Started=44, child=45
  - `2026-09-08T06-36-39-933Z_01a07fbb-a87d-7d52-b34e-c2f0baa03ae0.jsonl`：Started=34, child=33
  - `2026-09-08T07-09-09-954Z_01a07fd9-69c2-7e5b-a6bf-5d4098c14fc6.jsonl`：Started=481, child=477
  - `2026-09-09T03-42-29-328Z_01a08442-8dd0-75f2-ace5-fc2dd29a9a1a.jsonl`：Started=118, child=116
  - `2026-09-09T09-32-36-811Z_01a08583-1a4b-7638-b564-b5435b1ea914.jsonl`：Started=80, child=72
  - `2026-09-10T04-13-54-822Z_01a08985-af06-7007-91f7-7e6d1387ec96.jsonl`：Started=36, child=34
  - `2026-09-12T09-20-06-514Z_01a094ea-bb72-799c-8a04-907c7bf32509.jsonl`：Started=128, child=126

## 9. 状态标签出现频次

awaiting-disposition 与 cleanup-debt 是成功 status/list 返回中的状态标签，不计入错误。

## 10. child transcript 补充抽样

- artifacts transcript 文件数：1040；总大小：387479169 bytes；仍保留上一版最新 20 个抽样的空结果结论。child 不派发下级 subagent，writePaths 校验发生在父侧派发时，因此 child 侧本就不应出现这些拒绝码。

## 11. 可信度说明

- JSONL 逐行处理；toolResult 按 toolCallId 去重；T1/T2 按工具名和错误前缀分离。
- child transcript 真实位置为根 session 同名目录；artifacts 仅作兼容性补充。
- 结构化嵌套输出、截断文本、非标准结果可能漏计。
- live 目标会话导致跨会话统计时点不一致；历史会话稳定，目标会话每次重跑可能增长，排名/占比仅为近似。
