# V2：真实 TUI 验收（L2通过，L3待用户）

## 结果

`PI_TEST_BG_VISUAL=1 node --test --test-reporter=tap test/background-activity-visual.integration.mjs`：最终 **exit0、8 tests / 8 pass / 0 fail / 0 skip**，约12.2秒；原始日志 `/tmp/inline-visual-verified.log`。

所有7组PTY的Pi child和driver自然退出code0、signal=null、waitpid/reap明确、residualPaths=[]；第8组RPC普通管道process退出code0。完整ANSI/input/output/debug/probe/exit保存在每个 `bg-visual-*` 自造根内；没有删除根。最终根/PID以原始日志各`[visual-ledger]`为准。

首跑6/8：draft/themes裸Esc后接字节被按键解析器合并，overlay未退出，probe/debug超时。来源是本测试人工组合字节→官方终端输入解析→正常overlay合同；分类为测试输入错误，只改CSI-u Escape `\x1b[27u`，未修改production。两次失败根保留；随后ps确认原PID不再存在，但不补造其当时reap成功事实。

## V1–V14证据分层

| 项 | L1/L2机器证据 | L3 |
| --- | --- | --- |
| V1 三source | base官方debug含三kind各一行 | pending-user |
| V2 顺序 | base三行＋L1稳定排序合同；不声称长期tick像素稳定 | pending-user |
| V3 网格/状态 | 官方debug每行78列、标题前缀3列、状态终列一致；全状态词表由L1覆盖 | pending-user |
| V4 Alt+O | 真实快捷键与右箭头触发subagent/bash/scheduler三类detail probe，Esc关闭 | pending-user |
| V5 中文长词 | 78列frame-long中(delegate)完整，续行3空格；与实际用户终端宽度无关 | pending-user |
| V6 窄宽 | 20/40/78/120 winsize及官方每行visibleWidth<=cols | pending-user |
| V7 窄高 | rows4/10/24均不崩且尺寸匹配；too-small不挂overlay严格断言仍归L1 | pending-user |
| V8 overflow/recent | overflow场景真实debug，预算/计数严格证明由L1；非所有宽高组合均像素验收 | pending-user |
| V9 theme | light/dark公开setTheme与detail重取；无残影/色彩不由文本证明 | pending-user |
| V10 draft | 真实editor fixture草稿经Alt+O→Esc→快捷probe逐字恢复 | pending-user |
| V11 raw | 只引用既有raw不变L1；本fixture不是业务raw producer，不读取用户session | 不适用机器raw判定 |
| V12 availability | stale/unavailable真实debug出现过期观察/暂不可用；不伪造任务完成 | pending-user |
| V13 生命周期 | new/resume/fork/reload公开API与freshctx、真实start事件；晚回fence归L1 | pending-user |
| V14 RPC | 同extensions管道启动、每行JSON、无ANSI/footer/detail、自然退出0 | L2已证 |

## 供用户一次性确认的三类帧

以下是官方debug去颜色后的文字样图；字体/闪烁/IME/色彩需要本人终端确认，不能把这段文字当截图：

```text
›● fixture:  在 /Users/fixture/brightness-control 只读诊断长标题换行   running
   测试 (delegate)
 ⌘ fixture:bash_async:0                                                running
 ⏱ fixture:scheduler:0                                                等待触发
```

另两类证据为base三source同场和draft probe的`fixture 草稿保留`逐字相等。用户可在本机自行执行同一隔离harness并查看各根`frame-*.log`/`ansi.log`，当前没有控制用户终端、改字体或主题配置。

## 边界

- L2通过不等于L3签核，不宣称所有V1–V14终端观感已完成。
- fixture只经公开显示source注入，不是真实任务调度/恢复/消费实测。
- 无网络、无真实模型、无kill；历史heartbeat/workspace仍原样保留。
