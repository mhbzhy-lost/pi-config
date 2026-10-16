# Runtime closeout 最终验收总账（2026-10-16 Inline）

## 总结

**总状态：partial，而非全部功能全绿。** 用户将主线剩余任务改为Inline，明确授权逐验收单元commit；当前主线实现、无kill真实CLI和真实TUI L2均完成。N1联网、P3单次SIGKILL、L3观感未获对应批准/确认，不把blocked算功能完成。未push，未运行全仓npm test。

基线：`baseline.json`、历史HEAD `a9875d6`。最初dirty包含多轮已完成未提交成果；当前按逻辑单元精确stage/commit，不stash/reset/clean，不覆盖旧实验现场。

## 任务状态

| 任务 | 状态 | 证据 |
| --- | --- | --- |
| B0 | verified | baseline.json，旧dirty保护；授权三态保持 |
| F1 | verified | footer-layout.md；51/51，commit1b94710 |
| P0 | verified | pty-driver.md；7行为测试+after退出账本，py_compile0，33710b4 |
| P1/S1事务 | verified | owner-harness.md；8非PTY+78合同，root types0，60d3a6c |
| P2 | verified | owner-cli.md；真实受控5/5，5cd1cc1 |
| P3 | blocked-permission | owner-esrch.md；未发SIGKILL |
| V1 | verified | visual-harness.md；4/4+fixture tsc0，d6d58fc |
| V2 | L2 verified / L3 pending-user | visual-acceptance.md；真实8/8，b8abd89 |
| D0–D3 | verified diagnostic only | rpc-diagnostics.md/supervisor-diagnostics.md；af9713e，不冒称历史根因已修 |
| N1 | blocked-environment/permission | package-acceptance.md；2pass/6ENOTCACHED、无网络 |
| bash_async引导/observer | verified | 39/39，b583052；634deb4补齐公开协议/Host接线 |
| edit原生diff | verified L1 | 91/91+root types0，7bd97f9；用户终端观感未签核 |
| prompt override | verified | 32/32；关联32pass+1既有TODO，c5923b6 |
| H1-key | verified focused | 111/111+package types0，110cc0e |
| scheduler observer | verified | 49/49，4068c86；store/lock并发未改 |
| Z1 | verified ledger / overall partial | 本记录、类型检查与聚焦回归；blocked边界保留 |

## 最终真实命令

所有npm命令显式 `npm_config_registry=https://registry.npmjs.org/ npm_config_offline=true`；没有使用手淘/第三方源、没有npm install、没有升级依赖。

| 组 | 结果 |
| --- | --- |
| footer runtime/registry/layout/details/bash activity/scheduler activity/isolation/custom footer/subagent provider，十个指定文件 | exit0，184/184；`/tmp/inline-footer-regression.log` |
| D0/D1/D2/D3/RPC/probe/membrane/adapter/consumption/replay/prompt/P0/visual contract，十二个指定文件 | exit0，248/248；`/tmp/inline-closeout-final.log` |
| compact renderer/extension/error三文件 | exit0，91/91；`/tmp/inline-edit-validation.log` |
| session owner contract/registry/extension三文件 | exit0，78/78；`/tmp/inline-owner-contract.log` |
| 非PTY session runtime指定pattern | exit0，8/8；`/tmp/inline-owner-unit.log` |
| 真实CLI新driver五项pattern | exit0，5/5；`/tmp/inline-owner-cli-verified.log` |
| 真实TUI八场景（带官方debug几何与三kind切换、stale/unavailable） | exit0，8/8；`/tmp/inline-visual-verified.log` |
| scheduler adapter/activity/isolation | exit0，49/49；`/tmp/inline-scheduler-validation.log` |
| title registry | exit0，3/3；`/tmp/inline-title.log` |
| 默认关闭heartbeat harness（无prepare/kill env） | exit0，2pass/1skip，不重复H2危险实验 |
| root+package `npm run typecheck` | exit0 |
| offline `npm run verify:subagents-enhanced` | exit0，1259 upstream files、151 import edges、1819 tarball files/17442782 bytes |
| visual fixture显式tsc（package TypeScript5.9.3） | exit0；根TypeScript7显式files先TS5112，改用既有编译器，不改依赖 |
| heartbeat fixture显式tsc | exit2：既有process-birth-identity.ts三处Error.code未声明；不属于本次fixture修复，未跨界修/不吞错 |
| diff check | exit0；含本批untracked在精确stage后的cached check |

不同组测试有重叠，不将数字相加冒充独立用例总数。package八项不重复运行必失败安装，沿用N1真实失败证据；verify通过不消除其6fail。

## 来源分类与修复边界

- P0：Python True/断言小写、合法授权pid被构造层外部pid禁表误拒，均tests-only harness缺陷；只修tests/helper。after钩子收口，不kill。
- prompt fixture：替换未先发input、AST DeleteExpression误判；只修测试生成顺序/scanner，不扩生产白名单。
- edit新增测试错误要求expanded error有折叠✗；仅修测试；DI可选槽类型是本实现新增类型缺陷，最小修复。
- P2：页脚模型名/历史assistant被误当当前prompt完成，测试utimes与真实_persist竞争；等待本用例当前user后assistant落盘，不改production排序。
- V2：裸Esc与后续字节合并为输入序列；改tests CSI-u Esc，不更改production按键合同。

## 进程/现场

新P2全部tracked child和driver自然退出（blocked launcher code1属预期），V2最终7PTY+1RPC全部退出0、无信号、无residual。P0 deadline故意失败artifact保留且fixture随后自然退出。V2首轮两失败根保留，事后ps确认PID不存在但没有当时reap proof，保留失败事实、不用后续绿抹去。

旧heartbeat四active workspace仍保留，无raw删除/新Host接管/补杀；H2历史通过与cleanup阻塞相互独立。heartbeat新提交只归档既有成功实验，未重新执行SIGKILL。本轮窄范围ps未发现controlled-pty/node test/owner/TUI fixture存活进程。

## 后续，不混入本批完成

- supervisor child级gate/queued-reply/inspect-clear：新计划已保存并修复review一致性问题，代码尚未实施；D3只是诊断。执行必须fresh Host，不热改当前控制状态。
- 每操作独立工具与MD/tool guidance迁移：只有研究，尚未实施；research提交不是功能提交。
- idle、triggerTurn、resume(model)、scheduler store/lock按既定决定暂缓或独立处理。
- 具体用户RPC/supervisor故障的字段级归因仍unknown，不能用合法fixture证明该历史个案。
- 官方npm补缓存和P3需要各自明确授权；L3需要用户一次现场确认。

## 提交说明

本轮按逻辑单元commit，无push。b583052实际包含F3observer历史增量，最初F1/诊断等中间commit并非全部可独立安装的闭包；最终634deb4补齐协议/出口/Host依赖。最终树统一typecheck/verify/184+248聚焦回归通过，不夸大每个历史commit自洽性。
