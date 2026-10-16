# Footer 显示回归与 Runtime 剩余验收收口实施计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。执行方式由计划完成后的用户选择决定。计划编写、首轮审阅和修订不等于实施授权。

**目标：** 修复用户截图中的 footer 换行与缩进回归，补真实 TUI 和受控 CLI 验收，重跑被缓存阻塞的 package 测试，并增加 RPC/supervisor 的最小安全诊断。不能把“能诊断”宣称为“历史故障已修复”。

**架构：** 保留 package 唯一 footer/Alt+O owner 和三 source 业务边界；只改根 renderer 的列网格与换行。CLI 与视觉验证共用 tests-only 的直接子进程 PTY 驱动，模型为本地 deterministic fixture；诊断仅投影已有权威事实，不改变派发准入、durable gate 或消费判据。

**技术栈：** Node `>=22.19.0` 原生 TypeScript、当前 Pi `1.0.4`、pi-subagents `0.75.0`、Python 3 标准库 `pty/select/termios`、Node test、现有本地 deterministic provider。

**执行状态：** 用户最初选择 Subagent-Driven，2026-10-16明确改为全部Inline并授权逐验收单元commit；下文旧“不stage/commit”约束被该最新授权取代，不含push。用户曾选择Subagent-Driven并行执行（“可以并行执行计划吧，不影响”）；首轮 reviewer `b57eb813-5469-4ceb-9062-19164fd97167` 已完成，H1/M1–M4/L1–L4 已由父层修订。当前先执行 B0，后续按 DAG ready set 调度，不等待同 Wave。联网补缓存与 fixture SIGKILL 仍未授权；不自动成果 review。

## 0. 已有证据与本计划裁决

- 现有 HEAD：`a9875d62a75a0d5ee2893646ea5a96e89bbf8e27`。工作区包含上一批已验收但未提交的代码和文档；它们是本计划输入，不要求 clean 起点。
- 入口证据：`docs/plans/records/2026-10-13-remaining-runtime-acceptance.md`、`2026-10-13-footer-acceptance.md`、`2026-10-13-session-owner-acceptance.md`（后两项均在同 records 目录）。F2b/F4b/F5b/F6/S1a/S1b/H2 的已过证据不重复记为待实现。
- 设计输入：`docs/research/2026-10-14-background-activity-visual-readiness.md`、`2026-10-14-session-owner-pty-readiness.md`、`2026-10-14-trigger-rpc-supervisor-design-gaps.md`（三项均在 research 目录）。
- 用户截图：`/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/pi-clipboard-8df89397-7147-4f20-a090-8ed12c7e51e9.png`。截图有实际排版投诉；源码与纯布局回放将其关联到本次新增 renderer。`width=78` 是复现向量，不是测得的用户终端宽度；标题精确原文、字体、实际 rows/cols 仍未知，不需要读取用户 session 来补齐。
- **父层裁决：** research 中“符合现行设计所以非回归”的描述仅代表旧合同符合性，不否定用户报告的显示质量回归。本计划主动修订该显示合同，不拿旧断言证明观感正确。
- PTY research 的“5 ready”仍缺失败路径的身份/退出/保留门禁；其“PID 复用概率低”“wrapper 死后 SIGHUP 应能收子进程”不能充当安全证明。本计划先修测试 harness，再跑真实入口。
- 视觉 research 的启动草案含未绑定的PTY驱动占位、未绑定的fixture入口和无效 `--no-session-dir-typo`，**不得原样执行**。以本计划的实际文件和参数为准。
- research 中 `snapshot().requests + receipts` 不是现有 API（现 snapshot 只有 requests）。本计划明确增加有界、只读诊断方法，不读取私有 Map 或伪造 receipt。

## 1. 全局约束与范围

- 不修改上游、`node_modules`、vendor 或依赖 fork/patch；`pi-subagents` 固定 `0.75.0`，Pi 固定 `1.0.4`，不升级依赖。
- 禁止 MCP，包括 wrapper 内隐藏 MCP；不使用浏览器/MCP 获取终端证据。
- 所有TUI摘要、ANSI/control清理、截断、换行仅在renderer，raw messages/results/events/details不改。诊断字段扩充是明确的可观测性合同变更，不是为展示精简 raw。
- package 保持唯一 `setFooter` 和 Alt+O owner；root 只提供 presenter；不创建第二 sender、scheduler、authority、daemon 或 production timer。
- 不读真实 settings/models/auth/credential、完整session或authority正文。仅自生成 fixture 可读并显式标识；诊断默认不输出正文、路径、owner token、payload digest 或错误 cause 文本。
- 不使用TDD/RED/相关skill；实现后补合同测试。数据来源先分类：合法public链才认production；fixture异常只修fixture；未知fail closed。
- 文档、代码注释使用中文。新的 production/CLI 使用 `.ts`；`.mjs`/`.py` 仅用于 tests/fixture/helpers，不引入 production 对测试或 scripts 的反依赖。
- 不 stash/reset/clean，不覆盖 dirty，不 stage/commit/push；不 raw 删除 managed workspace，不运行原 heartbeat 实验，不清理旧 hb-* 根或共享 socket。
- npm 只能使用官方源 `https://registry.npmjs.org/`；联网需单独明确授权，禁止因为“执行计划”自动解除离线限制。
- 后续新 subagent 禁止 GPT provider，使用可用非 GPT 档位模型；不得使用 deepseek 系列模型。
- Session-owner 只承诺本仓受控 launcher/interactive 路径；不外推直接物理 CLI、独立 SDK、RPC/JSON/print 的独占保证。
- 历史 RPC/supervisor 故障的根因仍 `blocked-evidence`；本计划不加兼容/fallback，不放宽 `SUPERVISOR_REPLY_REQUIRED`，不改变 TTL、terminal proof 或 owner 三态。
- idle 系统通知和 `resume(model)` 按用户决定移至后续独立事项，本次包括 preflight 拒绝/warning 在内一律不实施。
- `triggerTurn` 缺发送前结构化合同，保持原语义；scheduler store/lock 并发修复、旧实验工作区清理不在本批。
- 不自动派发成果 review；计划首轮 reviewer 自动一次，后续 review 每轮需用户授权。

### 授权门禁（不是技术依赖）

| 门禁 | 允许动作 | 未获授权时 |
| --- | --- | --- |
| 执行方式 | 用户选择 Subagent-Driven 或 Inline 后才实施 | 仅编写/审阅计划 |
| `network-package-cache` | 官方 npm 源下载隔离 package fixture 所需依赖，禁止生命周期脚本，不动根/真实 package 安装 | N1 记 blocked-permission，其他分支继续 |
| `fixture-sigkill` | P3 对本次 PTY driver 尚未 reap 的唯一直接 Pi 子进程发送至多一次 SIGKILL；身份不匹配不发送，不杀组、不补杀 | P3 不运行，P2 其余 5 项正常验证 |
| 紧急进程清理 | 不包含在本计划中；未知存活进程保留根、报告 PID/birth/启动链 | 不因测试超时自动扩大 kill 范围 |
| 视觉确认 | 用户查看隔离画面或修复后本人终端截图并确认观感 | L3=pending-user，不影响 L1/L2 的实测状态 |

内部 `unit-runner`/`visible-host` 是父层调度资源，不是要求用户逐次授予的权限。

## 2. Footer 冻结显示合同

本次采用明确的新网格，不将多种备选路线交给实现者临时选择：

1. **统一左基线、仅一层挂起缩进。** 删除 activity 独有的左 pad 和双列选择区。正常宽度下选择标记占 col1（选中 `›`、未选中空格），类型图标从 col2 开始，随后 1 列 gap；标题从 `3 + maxGlyphWidth` 列开始（1-indexed；当前 glyph 宽为1时为col4）。同帧先计算三种类型 glyph 的最大 `visibleWidth`，对短 glyph 补空格，避免 ⏱/● 不同宽导致标题列跳动。续行只补前缀宽，不保留断点空格；cwd/元数据/overflow 从 col1 起，不再增加 col2 的第三种左沿。信息行保留空选择列+图标，文本也对齐标题列。
2. **状态是真正的独立右列。** 同一 activity 区域按本帧全部 main rows（先于预算裁剪）计算最长状态宽，公共 state budget 和右边界因此稳定，不随本帧 overflow 选择变化。首行标题和状态间至少 2 列空格；短标题补空格，续行保留空状态列；不把状态接进拆开的标题中间。宽度不足以容纳前缀+至少2列标题+2列间隔+完整状态时，转 stacked：标题按区域可用宽逐行，最后独立 `状态：<state>` 行挂到标题列并换行；不静默隐藏状态。极小宽度连图标/文字都不可能容纳时，沿用 glyph-only 降级，完整内容仍可在详情看，不能宣称窄到1列仍展示全部身份。
3. **词边界优先。** 显示副本先作既有 ANSI/control 清理，ASCII/空白分词优先；能放入空行的完整词如 `(delegate)` 不拆。超宽长路径/连续 CJK/emoji 使用字素兜底。可消费换行边界空白，但不改 raw label，也不删除词内部内容；检验拼接按去边界空白后的显示 token 序列比较，不能以原字符串所有空格都保留的断言误判。
4. **使用已有宽度工具。** `visibleWidth`/`wrapTextWithAnsi`/`truncateToWidth` 为公开工具；正常换行优先复用 `wrapTextWithAnsi`，对单字素宽于极小 budget 的情况保留明确降级，不再造独立 ANSI parser。
5. **元数据与活动区不交错。** 第一行仍 cwd（左）/context（右）。provider/model 与 thinking 合为第二元数据行：能放下时左 provider/model、右 thinking；放不下时分别换行，均从共同左基线开始，不占用两条空左“activity槽位”。活动区全部在元数据之后连续绘制，禁止整条下移同时保留空 activity 槽。
6. **不增主视图截断。** 标题按整 block 渲染，不中段截断身份。cwd/context 同行不够时分行并按词/字素换行；provider/model 同理。物理预算仍 `max(0, terminalRows-6)`，详情 reserve=4、详情 footer<=3 不变。预算不足时优先保留 context/cwd 第一元数据行，预留 overflow/Alt+O 行，次要元数据整 block 后让位；任何隐藏必须用现有 overflow 数与说明入账，不能把预算外任务当无任务。
7. **分组公平与稳定。** 充足高度按 subagent→bash_async→scheduler、类型内稳定顺序。预算紧时先从每个非空 kind 取首个完整 block（仍按类型顺序），再追加剩余条目；放不下整 block 就计 overflow，不截 block；预算不足三类首 block 时明确数量提示，不承诺任意尺寸三类都可见。recent 和 availability 独立状态不当业务成功。
8. **独立详情不改网格。** overlay 正文不是 footer entry，不强行套本次列网格；不改输入、trusted transcript、draft/editor 恢复、握手或 source 生命周期。

示意（省略号只为文档示意，实际 label 不人为截断）：

```text
~/brightness-control                                  1.4%/900k
(codex-pool) gpt-6.1-sol                           thinking: low
›● 在 /Users/… 只读诊断用户刚报告的 b                     运行中
   (delegate)
 ⌘ 本地命令                                                running
 ⏱ 每日巡检                                               等待触发
```

这是建议用户在选择执行时接受的明确显示方案；若用户要求保留旧三行 metadata + 左右同行形式，父层修改本节后再实施，不能让 child 自行折中。

## 3. 文件结构与领域边界

| 文件 | 职责/owner |
| --- | --- |
| `src/background-activity/layout.ts` | 唯一显示网格、wrap、metadata/block预算；不新增 source/状态 |
| `test/background-activity-layout.test.mjs` | 改后显示合同及截图同形输入 |
| `test/helpers/controlled-pty.mjs`、`controlled-pty-driver.py` | tests-only PTY 生命周期、几何、信号与证据协议，禁止接收外部现存 PID |
| `test/controlled-pty-contract.test.mjs` | tests-only 驱动合同；使用短命普通 fixture，不启动 Pi |
| `test/session-owner-runtime.integration.mjs` | 将既有6个真实入口测试接到受控 driver；不更改 production owner |
| `test/fixtures/background-activity-visual.ts` | 只通过公开 ActivitySource/Publisher 接口注入显示 fixture，不伪造真实 run authority |
| `test/background-activity-visual.integration.mjs` | 真实交互 CLI/键位/尺寸/生命周期；不作为业务调度测试 |
| `packages/pi-subagents-enhanced/src/subagent-dispatch/diagnostics.ts` | 该领域的纯、白名单诊断投影，不是根 common/utils |
| 同目录 `extension.ts` | RPC失败/trace、supervisor结果接线；仍唯一 typed dispatcher |
| 同目录 `supervisor-control-plane.ts` | 读取自身已持久化事实的有界只读方法；不新建状态机 |
| 同目录 `supervisor-consumption.ts` 与 package `extensions/subagent-runtime.ts` | 已有诊断 producer 的安全 envelope 接线；不改消费规则 |
| `test/subagent-diagnostic-projection.test.mjs`、`test/subagent-rpc-diagnostics.test.mjs`、`test/supervisor-diagnostics.test.mjs` | 公开调用链与脱敏合同 |
| `docs/plans/records/2026-10-15-runtime-closeout/` | 各任务独立证据，不覆盖上一批账本 |
| `docs/bugs/2026-10-15-background-activity-footer-alignment.md` | 真实问题来源、首偏离点、复现、修复与未验边界 |

不新增 production 对 tests/scripts/pi/extensions 的 import；package 不反向依赖根 feature；无新 package export/依赖。新增 fixture `.ts` 用显式 tsc 覆盖，不为 tests 扩 production tsconfig。

## 4. DAG、Waves 与资源

```text
B0 基线
├─ F1 布局修复 ────────────────────────┐
├─ P0 受控PTY驱动 ─┬─ P1 owner测试适配 ─┬─ P2 五项CLI实测 ─────┐
│                  │                   └─ P3 单次SIGKILL实测 ─┤
│                  └─ V1 视觉fixture/验收harness ─────────┐    │
│                                 F1 + V1 ── V2 真实TUI ─┤    │
├─ D0 诊断投影 ────┬─ D1 RPC接线与sink合同 ──┐             │    │
│                  └─ D2 supervisor只读方法 ─┴─ D3接线 ───┤    │
└─ N1 package缓存与原测试重跑（网络门禁）──────────────────┤    │
                                                         v    v
                                                     Z1 回归/文档总账
```

依赖理由：B0产出保护基线；P1/V1消费P0的驱动协议；P2/P3消费P1可安全运行的实际测试；V2消费F1显示合同与V1可执行场景；D1/D2消费D0投影类型；D3同时消费D1的安全 trace 序列化接点与D2的当前root只读方法。Z1只等这些具体产物或明确阻塞记录，不制造实现阶段统一集成屏障。

- Wave 0：B0。
- Wave 1：F1、P0、D0、N1。
- Wave 2：P1、V1、D1、D2。
- Wave 3：P2、P3、V2、D3（实际随各自前驱ready即可派）。
- Wave 4：Z1。
- **关键路径：** B0→P0→V1→V2→Z1；P1→P2/P3与D0→D1/D2→D3为独立分支。网络或SIGKILL不批准不阻其他分支。

资源容量：`unit-runner=1`（Node纯/fake测试、tsc、package校验）、`visible-host=1`（P2/P3/V2）、`npm-cache-writer=1`（N1及需要同cache的verify）。真实Host不同时再占unit，二者可并行。不运行全仓 `npm test` / all-integration glob。代码路径互不重叠默认同工作树并行；D3有真正产物依赖不与D1同时写extension。每项预计<=30min，纯实现与真实运行拆分；如果超预算按停点报告，不用常驻重试。

若使用managed worktree，必须取得可包含既有dirty输入的合法基线；父层不stash/reset或提交输入以凑clean。对publication=allowed的coding workspace由child发布并release；遇origin dirty integration门禁即停报，不raw Git重放。路径不重叠的任务不必为形式创建worktree。

## 5. 任务合同

所有任务共同停止条件：越WritePaths、需读取真实敏感数据、需改上游/放宽标准、命中未知进程身份、production与fixture来源未分类、验收互斥时 `contact_supervisor`；不先加 fallback。每任务记录实际命令/exit/计数/未跑条款，`git diff --check`必须真实执行。

### B0：冻结本批保护基线

**Deps：** none。**Resources：** static-evidence。
**WritePaths / Files：** Create `docs/plans/records/2026-10-15-runtime-closeout/baseline.json`。
**接口：** Consumes git status/HEAD/index、根/package manifest与Node/Pi版本元数据；Produces dirty路径类别、允许变更路径、授权三态、资源表。不得把整个目录status当允许提交范围。
**验收：** 旧dirty逐项保留；记录network/sigkill/visual是否获授权，不推定为true。
- [x] 只读采集HEAD/index、版本和路径，不读取settings/models/auth。
- [x] 生成JSON，解析验证，exit0；没有启动Host/安装/清理。

### F1：修复 footer 网格、断词与空槽

**Deps：** B0。**Resources：** unit-runner（仅验证阶段）。
**WritePaths / Files：** Modify `src/background-activity/layout.ts`、`test/background-activity-layout.test.mjs`；Create `docs/bugs/2026-10-15-background-activity-footer-alignment.md`、`docs/plans/records/2026-10-15-runtime-closeout/footer-layout.md`。
**接口：** Consumes §2；Produces原有 `renderActivityRows(rows,width,selection?,theme?):string[]`、`renderActivityLayout(input):ActivityLayoutResult`、geometry签名不变。内部增加公共glyph前缀宽、公共state列与完整block预算，不扩协议。
**方法：** `composeEntrySegments` 从固定pad/sel改为单选择cell+最大glyphcell+gap；wrap用词优先的公开函数，极窄有界；首行补齐state右列，stacked状态单独行。`renderActivityLayout`删除旧slotInliningAllowed/pending槽位策略，按metadata→完整activity blocks→availability/recent→overflow布局，采用§2的公平首项选择和预算。
**验收：** width78同形label保留完整 `(delegate)`（该词宽不超label列时）、状态不夹在词中、标题/续行同列且无额外断点空格；短长/selected/unselected、三glyph、overflow网格一致；至少一帧三kind皆可见；输入冻结deepEqual不变。
- [x] 先写中文问题记录：真实截图来源→ActivityRow投影→layout首个偏离；截图标题未知部分显式当显示fixture，不称精确原文。
- [x] 实现§2纯renderer，不改presenter/owner/source。
- [x] 实现后更新旧布局断言，增加 widths `{0,1,3,12,20,40,78,80,120}` 与 rows `{0,4,7,10,24}` 组合；覆盖ASCII词、长路径、CJK、ZWJ emoji、ANSI、双空格、state超宽、空meta、三类拥挤。
- [x] `node --test test/background-activity-layout.test.mjs test/background-activity-details.test.mjs`；`npm run typecheck:root`；记录实际数量/退出。
**禁止：** 不为过旧snapshot恢复坏布局，不顺带改变overlay/input/业务状态。

### P0：tests-only 受控 PTY 驱动与安全生命周期

**Deps：** B0。**Resources：** unit-runner（contract验证），不占visible-host；不启动Pi。
**WritePaths / Files：** Create `test/helpers/controlled-pty.mjs`、`test/helpers/controlled-pty-driver.py`、`test/controlled-pty-contract.test.mjs`、`docs/plans/records/2026-10-15-runtime-closeout/pty-driver.md`。
**接口契约：**
```text
startControlledPty({command,args,cwd,env,cols,rows,artifactDir,deadlineMs})
  -> {pid, write(text), resize(cols,rows), waitForText(text,timeoutMs),
      waitForExit(timeoutMs), signalFixtureKill(authorization), close()}
```
`command/args`只允许当前测试指定可执行项；不接受attach/PID入参。Node只持有自己spawn的python driver；driver用`pty.fork()`，child `chdir+execve` 指定launcher，parent持有**尚未reap的直接child**。JSONL control/response走driver的stdin/stdout；PTY raw输出放base64 data事件，UTF-8增量解码不能丢中文跨chunk。每个请求带id，wait监听先注册，再发动作。

**方法/验收：**
- child PID在fork时捕获，birth/PPID/command在exec稳定、ready之后采样，`LANG=C LC_ALL=C`仅用于ps读取；不得拿exec前command hash比对exec后。
- 信号必须由driver发送给自己的尚未reap子进程；`waitpid(pid,WNOHANG)`若已退出立即记terminal并拒signal。若检查后child退出，它仍是driver未reap zombie，不能复用给别人；不启用异步reaper与signal竞态。额外复核birth/PPID；未知不发送。
- `signalFixtureKill`默认禁用，只有显式本窗口一次性许可且匹配lease才可一次SIGKILL；不支持group/descendant kill或任意signal字符串。
- `resize`只对本PTY调用`TIOCSWINSZ`，依赖内核向该PTY前台进程组发送`SIGWINCH`；若平台/driver必须显式补发，只能沿同一child birth/PPID身份门执行，不改用户终端。
- 正常退出先Esc关闭overlay、Ctrl+U清fixture草稿、Ctrl+D退出；等待child exit/reap，再关闭master和driver。deadline失败标记测试失败，保留artifact与live driver/child身份，**不自动杀wrapper或删除临时根**；父层收到精确残留后另决策。driver若接control EOF，不擅自杀进程，写残留证据。
- 不使用旧 `test/helpers/pi-process-group.mjs`（其负PGID强杀合同不适用）。不改全局createTestRuntime的自动删除；本驱动只清自己明确全部退出的根。
- [x] 实现驱动与Node包装，所有等待有deadline，退出事件重复幂等。
- [x] 实现后用短命Python/Node fixture验证TTY、UTF-8分片、resize、自然退出、重复close、拒外部PID/无许可kill；contract测试不主动kill。
- [x] `node --test test/controlled-pty-contract.test.mjs`；`python3 -m py_compile test/helpers/controlled-pty-driver.py`（PYTHONPYCACHEPREFIX指向本任务临时目录），实际exit0。

### P1：受控 session-owner 真实测试接线（不跑真实Host）

**Deps：** P0（driver协议与exit证据）。**Resources：** unit-runner。
**WritePaths / Files：** Modify `test/session-owner-runtime.integration.mjs`；Create `docs/plans/records/2026-10-15-runtime-closeout/owner-harness.md`。
**接口：** 保留6个 `真实 Pi` 测试名与产品断言，内部从expect wrapper换成P0直接PTY child；`readyPty`直接返回Pi child lease、registry record。旧 `record.pid !== expect.pid` 改为 `record.pid === controlledPty.pid`，不能删除真实PID归属验证。
**方法：** 不使用自动rm的createTestRuntime分配真实Host根；仅6项PTY改为退出全部证明后删除自己根、失败保留。移除killPty及timeout wrapper SIGKILL兜底；所有freeSession/assertBlocked路径也进driver tracked set。Fake SDK的8项逻辑不变。

**env固定白名单：** PATH、临时HOME/TMPDIR/agentDir/sessionDir/registry/workspace/goal、TERM=xterm-256color、PI_HOST_NODE=`process.execPath`、PI_HOST_ROOT/PI_PACKAGE_DIR=`<repo>/node_modules/@earendil-works/pi-coding-agent`、PI_OFFLINE=1、PI_SKIP_VERSION_CHECK=1、PI_TELEMETRY=0；不继承用户token/proxy/ZDOTDIR/XDG/PI_SESSION_*。
**argv：** launcher + `--offline --no-mcp --no-skills --no-prompt-templates --no-themes --no-context-files --provider fake --model fake/deterministic -e <repo>/test/fixtures/deterministic-provider.mjs --session-dir <fixture>/sessions`，保留每项原测试参数。第6项额外要求 `PI_TEST_OWNER_SIGKILL=1`，未设时显式skip且说明缺权限，不将整个6项泛称pass。
- [x] 适配P0，保留active/recent/pin/no-extensions/picker/ESRCH产品断言，不改registry/lifecycle/launcher。
- [x] 第6项依次验证active record→PID等于driverchild→即刻身份重核→至多一次kill→child reap→ESRCH→下一wrapper；不把SIGKILL返回当退出证明。
- [x] 实现后只跑非PTY8项：`node --test --test-name-pattern='^(waitForRecord|real AgentSessionRuntime|真实 SDK：|session_start |session_before_switch |owner-less)' test/session-owner-runtime.integration.mjs`，预期8项exit0；driver contract回归。
**停止：** 需要production兼容时停止，先来源分类并另派修复；不把测试适配与真实运行打包。

### P2：五项受控 CLI／PTY 实测

**Deps：** P1。**Resources：** visible-host=1，fixture根独立。
**WritePaths / Files：** Create `docs/plans/records/2026-10-15-runtime-closeout/owner-cli.md`；Run既有测试，生产/测试文件仅读。
- [x] 预检Node版本、Python pty、固定物理Pi `--version`，命令加各自10s期限；任一失败不启动Host。
- [x] 显式运行：
```bash
node --test --test-name-pattern='^真实 Pi (Expect PTY|PTY: (active recent blocks|-c pins|--no-extensions|selecting picker))' test/session-owner-runtime.integration.mjs
```
- [x] 记录5项实际pass/fail/skip、各临时根/实际入口/退出码/剩余PID；预期5项通过且无SIGKILL、无网络、registry释放。非匹配项按当前Node真实report记账，不硬写0 skipped。
**停止：** 失败保留现场、记录首偏离，不能现场改source/fixture；不启动真实provider，不自动补杀。

### P3：单项 SIGKILL→ESRCH 实测（条件任务）

**Deps：** P1。**Resources：** visible-host=1；**门禁：** fixture-sigkill 明确批准。
**WritePaths / Files：** Create `docs/plans/records/2026-10-15-runtime-closeout/owner-esrch.md`。
- [ ] 未批准写blocked-permission，引用registry历史证据但不冒充真实端到端通过。
- [ ] 批准后仅运行 `PI_TEST_OWNER_SIGKILL=1 node --test --test-name-pattern='^真实 Pi PTY: SIGKILL' test/session-owner-runtime.integration.mjs`。
- [ ] 记录本窗口唯一child PID/birth/PPID/killAt、实际信号次数、reap、ESRCH、replacement owner与根保留/释放事实。原H2授权不继承。
**验收：** 1项真实通过，一次kill、无补杀；identity未知、quit失败、孤儿或额外信号需求立即停报。

### V1：真实 TUI fixture 与可执行验收 harness（只构建，不跑Host）

**Deps：** P0（PTY与resize协议）；**无需等待F1**，消费§2冻结合同。
**Resources：** unit-runner。
**WritePaths / Files：** Create `test/fixtures/background-activity-visual.ts`、`test/background-activity-visual.integration.mjs`、`test/background-activity-visual-contract.test.mjs`、`docs/plans/records/2026-10-15-runtime-closeout/visual-harness.md`。
**接口：** fixture只经 `pi-subagents-enhanced/tui/background-activity` 的公开 ActivitySource/owner bus 注入3类display rows；不手拼subagent production event/status/authority冒充真实run。每条标 `fixture:`，稳定key，detail组件有固定正文/原始块计数，不提供run/delete/cancel操作。真实controller/adapter集成证据归F6旧测试，本harness证明真实终端而非业务producer。

**真实入口固定argv：** `scripts/pi-launcher.zsh --tui-mode fullscreen --offline --no-mcp --no-extensions --no-tools --no-skills --no-prompt-templates --no-themes --no-context-files --use-theme dark --session-dir <fixture>/sessions -e <repo>/test/fixtures/deterministic-provider.mjs --provider fake --model fake/deterministic -e <repo>/packages/pi-subagents-enhanced/extensions/custom-footer.ts -e <repo>/pi/extensions/background-activity.ts -e <repo>/test/fixtures/background-activity-visual.ts`；采用P1白名单，不读真实配置。创建临时空cwd，除了本地fixture seed请求不发业务prompt。

fixture注册命令 `/fixture-bg <base|overflow|stale|unavailable|probe|light|dark|new|switch|fork>`；其中 `switch` 表示通过公开 `ctx.switchSession` 进入既有 session 文件的 resume 场景，所有文件与输出限定本窗口root；每条命令完成写0600 probe JSONL（仅fixtureID/epoch/cwd存在性/draft/keys/尺寸事实，不写token），不 `sendMessage(triggerTurn)`。new/resume/fork由命令ctx的公开方法执行；fresh ctx重绑，不使用旧ctx。fork seed只用真实SessionManager/本地fake响应创建合法user entry，不手拼JSONL。

**证据分层：**
- L1：现有fake TUI+source tests，检验raw/owner/late fence，不能称真实视觉。
- L2：PI_TUI_WRITE_LOG原始ANSI与PTY完整capture，记录input和winsize；可以证明快捷键触发、所见文本存在、draft probe恢复、session lifecycle。几何采用隔离Host的官方 `/debug` 输出（含all rendered lines/visible widths）+已知winsize；`/debug`会附当前fixture消息，**只读自造fixture文件**，禁止用于用户Host。不能将strip-ANSI历史流当最终屏幕；overlay画面以对应PTY段+L1几何证据标注证明力，不冒充像素验收。
- L3：用户观感（色彩/闪烁/字体/IME/整体缩进）待现场确认，不要求给14个重复approval。提供同一fixture的人工查看命令与修复前后文本样图；没有用户输入时pending-user。

**场景（机器8组）：** ①三类同场/顺序/选中网格；②截图同形长label+额外前导空格边界；③width20/40/78/120并恢复；④rows4/10/24、overflow+recent；⑤Alt+O左右换type+Esc草稿probe；⑥light/dark切换+detail重取；⑦reload/new/resume/fork代际；⑧同extensions以RPC启动，stdout每行JSON且零footer/overlay，RPC不外推session-owner独占。
- [x] 构建fixture与8场景runner，默认无 `PI_TEST_BG_VISUAL=1` 时显式skip，不自动挂all-integration或npm test。
- [x] 增contract用例只校验白名单/argv/source协议与场景枚举，不跑Host；`node --test test/background-activity-visual-contract.test.mjs`。
- [x] `node_modules/.bin/tsc --noEmit --allowImportingTsExtensions --module NodeNext --moduleResolution NodeNext --target ES2024 --skipLibCheck test/fixtures/background-activity-visual.ts`。
**停止：** public API无法形成某场景如fork，停报具体字段，不能制造production event骗过门禁；不能测试自动删未退出根。

### V2：真实 TUI 实测与截图问题验证

**Deps：** F1的修复布局 + V1的8场景harness。**Resources：** visible-host=1。
**WritePaths / Files：** Create `docs/plans/records/2026-10-15-runtime-closeout/visual-acceptance.md`；Run既有harness，代码仅读。
- [x] 运行 `PI_TEST_BG_VISUAL=1 node --test test/background-activity-visual.integration.mjs`，预期8组场景通过；实际计数/skip按report，不将组数当断言数。
- [x] 从自造debug/render/ANSI/input/winsize证据核查§2列网格：标题col、续行col、state终列、metadata空槽、三kind公平；保留78列复现但不冒称用户终端是78列。
- [x] 将V1–V14逐项记L1/L2/L3状态，特别raw不变量只引用对应L1/fixture事实，不能声称读取验证用户真实session。
- [x] 输出供用户一次性确认的3张文字帧/截图请求：长标题、三类同场、Alt+O退出草稿。不自行控制用户终端或改字体。
**验收：** L2实际exit0、全部测试生成进程自然退出并reap、根内证据可追溯；L3缺确认则partial；任一字节/geometry偏离保留现场，另派精确修复。

### D0：RPC 与 supervisor 白名单诊断投影

**Deps：** B0。**Resources：** unit-runner。
**WritePaths / Files：** Create `packages/pi-subagents-enhanced/src/subagent-dispatch/diagnostics.ts`、`test/subagent-diagnostic-projection.test.mjs`。
**接口（package内部，不增加export面）：**
```text
projectRpcNegotiation(result:unknown, expectedCwd:string,
  dispatchPath:'coding'|'generic'): RpcNegotiationDiagnosticV1
projectSupervisorTrace(entry:unknown, monotonicMs:number): SafeSupervisorTraceV1|undefined
projectSupervisorReceipt(receipt:unknown): SupervisorReceiptDiagnosticV1|undefined
```
RPC字段：schemaVersion=`rpc-negotiation-diagnostic.v1`、stage=`spawn-capability-assertion`、dispatchPath、capabilitiesEnvelopePresent、versionOk、spawnMethodOk、sessionIdPresent、lifecycleIdentityPresent、sessionCwdPresent、cwdEqual、missingCapabilities（仅既有4安全capability与rpc:v1/session白名单）。原判定函数仍权威，投影不接管准入。

Supervisor trace字段：version=1、eventKind=`supervisor-diagnostic`、phase/type投影接受现有9种诊断值（registration-failed、delivery-compensation-failed、owner-read-failed、runtime-read-failed、consumption-rejected、consumption-failed、persistence-corrupt、persistence-rejected、replay-failed；producer可能使用`phase`或`type`字段，输出统一为`phase`枚举），均带完整`supervisor-`前缀，monotonicMs、可选runId/requestId/receiptId/rootSessionId、errorCode/receiptStatus/consumed、requestGeneration/ownerGeneration。只输出safe ID（沿control plane ID规则）、枚举及有限整数；不拷贝error/cause/secondaryError/compensation对象、session路径、正文、payload digest。缺version/monotonicMs的既有producer允许在**诊断包络层**补当前单调时钟和version，不补业务身份/消费事实。`supervisor-replay-failed`同样纳入；D0投影测试必须覆盖phase/type两种输入形状。

Receipt字段：schemaVersion=`supervisor-receipt-diagnostic.v1`、receiptId/runId/requestId、status、consumed、ownerGeneration/requestGeneration；不包含idempotencyKey/payloadDigest/root路径。
- [x] 实现纯投影和精确类型，不读文件、不fetch/emit。
- [x] 实现后覆盖未知字段不透传、正文/路径canary、畸形类型/ID、完整8种phase、queued不等于consumed。
- [x] `node --test test/subagent-diagnostic-projection.test.mjs`、package typecheck，exit0。

### D1：RPC 准入失败安全回执与 trace 接线

**Deps：** D0。**Resources：** unit-runner。
**WritePaths / Files：** Modify `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`、`test/subagent-dispatch-startup-probe.test.mjs`；Create `test/subagent-rpc-diagnostics.test.mjs`、`docs/plans/records/2026-10-15-runtime-closeout/rpc-diagnostics.md`。
**接口：** `assertSpawnCapabilities`新增调用路径参数，仅失败时 `error.detail={negotiation:projectRpcNegotiation(...)}`；原code/message/missingCapabilities/upgradeStopped与断言顺序不变。generic早于统一断言的`assertSpawnAllowed`异常，在已有catch可得到同次ping时才附投影，保留createSubagentRpcFailureDetails原字段，不造缺失ping；generic早抛的投影必须由`createSubagentRpcFailureDetails`的安全白名单显式合并`negotiation`字段（或在同一catch分支安全合并），不能只挂`error.detail`后任其被sanitize丢弃。
**方法：** coding/generic现stage保持不作为语义改动，新增diagnostic.stage固定assertion避免误读旧workflow-spawn标签。tool-failed trace的白名单增加嵌套negotiation投影，0600/fd/no-follow/inode/dispose门禁原样保持。成功返回对象与wire options不变。
- [x] 接线两种路径；trace只序列化D0投影，不能对error.detail任意JSON透传。
- [x] 实现后经createTypedSubagentExtension公开execute测试合法ping、缺ctx/session、cwd不符、capability缺、generic早抛，断言不调用spawn/不新增回退，诊断无真实路径/ID值/正文canary。
- [x] `node --test test/subagent-rpc-diagnostics.test.mjs test/subagent-dispatch-rpc.test.mjs test/subagent-dispatch-startup-probe.test.mjs`、package typecheck。
**验收边界：** 只完成未来可诊断性，历史RPC个案仍blocked-evidence，不“修复session丢失”。

### D2：supervisor 自身root有界只读 provenance

**Deps：** D0。**Resources：** unit-runner。
**WritePaths / Files：** Modify `packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-control-plane.ts`；Create `test/supervisor-diagnostics.test.mjs`。
**接口：** 新增 `readDiagnostics(rootSessionId:string, filter?:{requestId?:string}):Promise<SupervisorDiagnosticsV1>`。返回 `{schemaVersion:'supervisor-diagnostics.v1', availability:'available'|'unavailable', requests:[{requestId,runId,state,ownerGeneration,requestGeneration,createdAt,expiresAt}], receipts:SupervisorReceiptDiagnosticV1[], complete:boolean}`；每组最多50条，按ID稳定排序；超限complete=false。root身份由调用方Host resolver给，不能agent参数指定；requestId只过滤不扩大scope。
**方法：** 持久化模式直接read唯一DurableStorage对应root已存state并验证既有schema/stateDigest；不调用会过期request的loadRoot/ready/transaction，不修改Maps、不新铸token。`DurableStorage.read()`首次会为该自身persistenceRoot执行一次0700 `ensureRoot()` mkdir，这是唯一允许的有界文件系统副作用；已有root及state字节/mtime不变。无持久化模式从既有Map生成安全副本。读取失败unavailable、固定code，不把它解释成空pending；不启动broker或扫描其它root。requests保持存储观察值，不额外计算expired/gate-open；queued/delivered仅来自receipt字段。
- [x] 实现只读方法，复用既有解析与digest语义，不新增宽容分支。
- [x] 实现后用public register→commit→observe生成合法fixture；验证本root过滤、隔离、50上限、未知root空/错误区分、调用前后state字节/mtime/内存请求一致；TTL后读取仍不触发过期写入。
- [x] `node --test test/supervisor-diagnostics.test.mjs test/supervisor-consumption.test.mjs test/supervisor-replay.test.mjs`、package typecheck。
**停止：** read无法保证无写副作用则停报，不复用会mutate的入口偷换“只读”。

### D3：supervisor trace、status与reply诊断接线

**Deps：** D1的sink白名单安全接点、D2的readDiagnostics方法。
**Resources：** unit-runner。
**WritePaths / Files：** Modify `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`、`packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-consumption.ts`、`packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`、`test/subagent-runtime-membrane.test.mjs`、`test/subagent-dispatch-startup-probe.test.mjs`；Create `docs/plans/records/2026-10-15-runtime-closeout/supervisor-diagnostics.md`。
**接口：** 不改supervisor参数schema；`status`使用当前Hostroot输出 `details.supervisorDiagnostic`，可选已有`replyTo`作requestId精确过滤；原content/details字段完整保留。reply成功commit后仅新增`details.deliveryReceiptDiagnostic`，文本原样，明确文档queued≠consumed；idempotent/failed路径不伪装提交成功。不新增第二tool或poller。
**方法：** 在现controlled adapter status passthrough后附只读投影；当前root不可验证时附unavailable，不调用其它root。reply从本次committed.receipt投影，不用snapshot猜。现producer phase/type混合且缺version/clock，由D0包装器在sink的独立supervisor分支规范化；不要求producer读session/body补事实。sink新增该白名单分支，但不放行其它未知phase及任意error文本。
- [x] status诊断分支必须在现`params.action !== 'reply'`早return之前处理；reply不变执行/commit/compensate顺序，native sender/content原样。
- [x] 接入全部9类producer诊断，兼容phase/type输入，sink异常隔离但可测试，不改TTL/消费条件/owner三态。
- [x] 实现后用既有公开adapter/plane调用链覆盖status过滤、queued回执、幂等、terminal consumed、unknown owner、sink替换/权限失败、保留raw原字段及error.canary不落盘。
- [x] `node --test test/subagent-runtime-membrane.test.mjs test/subagent-dispatch-startup-probe.test.mjs test/supervisor-diagnostics.test.mjs test/supervisor-consumption.test.mjs test/supervisor-replay.test.mjs test/subagent-supervisor-adapter.test.mjs`、package typecheck。
**边界：** 不声称child mid-run已消费；历史NOT_PENDING/gate故障仍需真实样本，不启用raw debug读取用户会话。

### N1：官方缓存补齐与原 package 用例重跑

**Deps：** B0。**Resources：** unit-runner + npm-cache-writer；**门禁：** network-package-cache。
**WritePaths / Files：** Create `docs/plans/records/2026-10-15-runtime-closeout/package-acceptance.md`；代码/manifest/lock仅读；仅隔离fixture和`var/tmp/npm-cache`可由原脚本写缓存。
**路线：** 不手工固定“只差一个tgz”假设，原fixture安装还需packument、传递依赖和TypeBox。先运行原8项离线确认，缺cache且未批准网络就记录，不改测试/校验器绕过。
- [ ] 干净临时HOME、空npm user/global config、无token/proxy的白名单env；配置 `npm_config_registry=https://registry.npmjs.org/`、`npm_config_cache=<repo>/var/tmp/npm-cache`、`npm_config_globalconfig=<临时空globalconfig文件>`、`npm_config_userconfig=<临时空userconfig文件>`、`npm_config_ignore_scripts=true`、`npm_config_audit=false`、`npm_config_fund=false`，全部npm子进程继承。保留明确物理PI_HOST_ROOT防止回落全局SDK。不得读取本机npmrc/auth。
- [ ] `npm_config_offline=true node --test test/pi-subagents-enhanced-package.test.mjs`，实际记录counts/ENOTCACHED/exit。
- [ ] 若用户批准网络，执行同一原测试，唯一变化`npm_config_offline=false`；它只在mkdtemp package copy内install，不在repo root/packageRoot调用setup。固定直接依赖 `pi-subagents@0.75.0`、`typescript@5.9.3`、Pi dev peers `1.0.4`、`typebox@1.3.27`；传递依赖原fixture无lock，按现manifest范围解析，记录实际树与官方resolved/integrity，**不能宣称全传递依赖都被lock固定**。出现Git/第三方下载、生命周期脚本或真实repo安装需要即停。
- [ ] 补齐后回到offline=true重跑同8项，再 `npm run verify:subagents-enhanced`。预期8项全过且verify通过；漂移/escape/canonical/closure负向断言不删。
- [ ] 比较根/package manifest/lock/真实node_modules受控源码未改（cache和隔离fixture除外），列下载清单与cache剩余缺项。网络拒绝不反复跑6个必失败fixture。

### Z1：聚焦回归、文档与未完成边界收口

**Deps：** F1、P2、P3、V2、D3、N1已有终态记录（blocked不算功能完成）。
**Resources：** unit-runner、npm-cache-writer（verify阶段）。
**WritePaths / Files：** Create `docs/plans/records/2026-10-15-runtime-closeout/acceptance.md`；Modify `docs/architecture/background-activity-display.md`、`docs/plans/records/2026-10-13-footer-acceptance.md`（仅追加本批取代的显示合同/真实验收）、`docs/todos/2026-10-10-runtime-followups.md`（保留idle/resume延期）、`docs/bugs/2026-10-10-rpc-session-capability-negotiation.md`、`docs/bugs/2026-10-10-supervisor-reply-required-state-views.md`（仅追加诊断入口，旧根因状态不升级）。
- [ ] 运行本批新增纯合同/诊断测试及 `node --test test/background-activity-runtime.integration.mjs test/background-activity-layout.test.mjs test/background-activity-details.test.mjs test/bash-async-activity.test.mjs test/task-scheduler-activity.test.mjs test/task-scheduler-package-isolation.test.mjs test/custom-footer-subagents.test.mjs test/custom-footer-input.integration.test.mjs test/subagent-activity-provider.test.mjs`；PTY不混进此unit命令。
- [ ] `npm run typecheck`、显式fixture tsc、offline `npm run verify:subagents-enhanced`、`git diff --check`；package原8项证据由N1拥有，不无条件重复网络安装。若cache门禁阻塞准确partial。
- [ ] 链接与path存在审计、root/package反依赖审计、index未改；列每task的implemented/verified/blocked-permission/blocked-evidence/failed/partial，记录原始exit、数量、skip、未跑。
- [ ] 记录所有本批fixture进程terminal proof/根处置；保留旧4active heartbeat workspace事实，不删除或当已清理。视觉L3缺确认单列，不把调研称测试。
- [ ] 文档明确RPC/supervisor是新增诊断、不是历史根因修复；triggerTurn、idle、resume、scheduler并发均未实施；不自动提交或成果review。

## 6. 计划自检与交接

- 用户投诉“换行”和“缩进”分别对应F1的词边界、跨行网格/state列/空槽合同与V2真实验证，不能只改一条字符串snapshot。
- 真实运行P2/P3/V2各有独立资源与授权界限，helper实现不顺带跑Host；network拒绝不阻其它分支。
- 所有新增生产类型在D0定义、D1/D2/D3消费；调用方源码实际入口已核，trace sink就在extension.ts，不引用不存在的trace-sink.ts。
- 本计划不默认创建commit，不承诺在现约束下修复历史RPC/supervisor或实现triggerTurn；没有用blocked结项伪造所有原目标完成。
- 写完本计划后自动派发首轮reviewer；父层依据证据inline修订，再由用户选择 **Subagent-Driven / Inline / 继续review**。执行方式选择前不实施；必要网络和fixture SIGKILL另行明确确认。


## 2026-10-16 Inline收口索引

已实现和验证分支已勾选；P3、N1和L3并未通过，不能因总账收口标绿。P0实际为7行为测试+after账本（非静态8计数），P2为5/5，V2为8/8。最新完整证据见 `docs/plans/records/2026-10-15-runtime-closeout/acceptance.md`。新的supervisor gate与工具拆分不在本closeout自动扩展范围内。


## N1/P3/类型尾项的后续授权与实测

用户已澄清官方源联网授权并批准其余明确尾项直接执行：P3已1/1、一次受控SIGKILL且reap/ESRCH/replacement完成；heartbeat类型修复身份8/8+fixture tsc0；N1增加官方codemode1.0.4安装根override后online/offline各8/8、verify0。旧N1/P3 not-granted门禁仅历史快照，不再重复索要。L3仍待本人确认，新gate/工具拆分另按各自计划。
