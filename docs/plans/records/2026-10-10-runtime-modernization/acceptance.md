# Pi 1.0.4 runtime 现代化 M12 聚焦验收记录

- 任务：dispatch-39775839（M12 一次聚焦汇总验收与交付）
- 执行代理：executor（仅本任务 WritePaths；无 production/配置/计划 checkbox 改动）
- 生成时间：2026-10-10；仓库：`/Users/leshi.zhy/pi-config`
- 基线：`docs/plans/records/2026-10-10-runtime-modernization/baseline.json`（M00 冻结，arena `/tmp/pi104-modernization-1XMAot`）；M12 自有 arena `/tmp/pi104-m12-acceptance/`
- 结论：**13 前驱闭包核对完成；M12 执行/静态验证全部通过**。enhanced `tsc --noEmit` 首轮 exit=1（唯一文件 `packages/pi-subagents-enhanced/src/tui/tool-renderers.ts` 11 个 TS2339/TS2345），已按合同上报；M06 owner 并行修复（`isRecord` 类型守卫收窄，公开 `ToolRenderers` 标注保留，无 as any/降选项，显示等价）后本任务补跑复核 **exit=0 零诊断**，并按主授权补跑一次 `subagent-native-conversation` 纯 13 **13/13 exit=0**（`logs/m12-native-post-typefix.log`）。root noEmit/listFilesOnly 已通过且 root source 未变不重跑。shell `--no-skills` 移除（M09 范围追加，owner 3f3117d4…）已完成并经主 read source/diff/logs/hash 接受：fake physical CLI 隔离正向 pattern 13/13 exit=0（before/after `/tmp/pi104-m09-shell-close-lxj4iz/`，`logs/pi-shell-unit.log`/`.exit`，7999.573ms；14 既有 case 中 13 跑、bare pi ANSI case 显式排除，非真实 shell Host/会话）。**主会话已核对源码、最终日志与交付哈希并接受收口：执行/静态验证通过，非真实 Host 全验证；真实 runtime Skill 发现未实测，刷新 shell 与 fresh Host 后才加载。**

## 1. 13 前驱闭包核对（M00–M11）

批量核对由自有脚本完成（`/tmp/pi104-m12-acceptance/verify.py` → `verify-before.json`），未逐文件 bash 分析。结果（60 条 baseline taskBefore union）：

| 分类 | 数量 | 说明 |
|---|---|---|
| unchanged | 4 | README.md、packages/pi-subagents-enhanced/README.md（均 M12 编辑前）、src/compact-tools/renderer.ts、test/bash-cwd-policy.test.mjs 与 M00 hash 一致（README 两者编辑后见 §6） |
| changedByOwner | 46 | 均有明确 owner 任务（M01–M11 WritePaths），无越权路径改动 |
| plannedNewNowExists | 7 | baseline.json、public-boundaries.md、tool-renderers.ts、result.ts、src/async-progress/index.ts、src/compact-tools/index.ts、src/pi-settings/index.ts |
| plannedDeleteNowAbsent | 1 | `src/skill-whitelist/extension.ts`（M09 删除） |
| expectedMissing | 2 | `pi/extensions/skill-whitelist.ts`（见下）；`acceptance.md`（本文件，M12 新建） |
| unexpectedChange | 0 | 无任何无主路径被改动 |

- **pi/extensions/skill-whitelist.ts 删除说明**：M00 baseline 将该 66 字节入口标为 `plannedDelete:false`（仅 `src/skill-whitelist/extension.ts` 标记删除），但 M09 合同明确"删除仅返回 resources_discover.skillPaths 的入口及实现，不留 no-op/re-export facade"。taskbefore 副本证实其为单行 re-export facade（`export { default } from "../../src/skill-whitelist/extension.ts"`），随实现一并删除符合 M09 合同且已随 M09 accept；taskbefore 副本保留（sha `1c0dccff…`）。此偏差为 M00 标记口径，非越权删除。
- **dirty 保护**：M00 dirty 8 项中 5 项（runtime-membrane.ts、title-registry.ts、compact-rendering.ts、test/subagent-compact-rendering.test.mjs、idle-system-notification 决策 doc）与 taskbefore 副本字节一致；3 项合法演进：`.pi/handoff/context-handoff.md` 与计划文件（主会话正常更新，属主授权范围）、`test/subagent-runtime-membrane.test.mjs`（M05B owner）。
- **原始数据权限边界**：未读取/未 hash 真实 `pi/settings.json`、`pi/models.json`、auth、会话、authority 数据；git index 为空、无 staged 文件；未执行 add/commit/push/reset/restore/stash/worktree 写操作。
- **主会话新增 scope 例外 docs**（main 独立授权，非 child 越界，本任务未改动）：`docs/bugs/2026-10-10-rpc-session-capability-negotiation.md`、`docs/bugs/2026-10-10-supervisor-reply-required-state-views.md`、`docs/todos/2026-10-10-runtime-followups.md`，现场均存在，hash 已冻结于 verify-before.json。

## 2. test/joint-upgrade-feature.test.mjs 按新合同同步（未运行）

- 编辑前冻结（arena supplemental `/tmp/pi104-m12-acceptance/supplemental-freeze.json` + 副本 `joint-upgrade-taskbefore.mjs`）：sha256 `0134efb57df95698027c810a02078a013e390bfa9b65e88d0e8f8220c0572096`，case 数 **6**。
- 变更（case 数保持 6，不增）：
  1. 删除已退役模块 import `../src/skill-whitelist/extension.ts`（M09 删除，无 facade 保留）。
  2. 旧 write reminder case 改为原生合同：断言 `tool_result` handler 不存在、`tool_call` handler 保留；真实 write 后原始 `content`/`details` 不变（`structuredClone` 对照 + 结果恒等），无 `test-driven-development` 注入文本；原 synthetic 结构 fixture 一并移除，不作为 fixture 驱动的 production compat。
  3. skills case 改为公开原生 resource discovery + scoped selector 合成 fixture：合成 HOME/agentDir/project（含 `.git` 截断祖先遍历），`SettingsManager.inMemory({skills:["!**/plan-runner-dispatch/**"]})` + `DefaultPackageManager.resolve()`，断言合法技能被发现且退役技能经原生 auto 通道被声明 selector 关闭；不读真实 `~/.agents/skills`，不启动 session。
  4. 其余四个真实工具/CLI/provider 用例（bash、apply_patch、BasicMemory、provider fallback）逐字节不变。
- **验证口径：仅 `node --check` exit=0（语法）；本文件任何 case 未运行**（合同禁止真实工具/CLI/provider 场景），同步结果不计为通过，不假 green。

## 3. 既有分支 pure 日志复用（16 项清点）

| 任务 | 日志 | tests 实测/预期 | exit |
|---|---|---|---|
| M01 | /tmp/pi104-m01-unit-logs/security-gates-extension.(log/.exit) | 9/9 | 0 |
| M01 | /tmp/pi104-m01-unit-logs/shell-policy.(log/.exit) | 26/26 | 0 |
| M02 | arena/m02-ensure-unit-final-ec12df93.(log/.exit) | 8/8 | 0 |
| M03 | arena/m03-33fc3f25/extension.(log/.exit) | 3/3 | 0 |
| M03 | arena/m03-33fc3f25/renderer.(log/.exit) | 21/21 | 0 |
| M03 | arena/m03-33fc3f25/error-visibility.(log/.exit) | 47/47 | 0 |
| M04 | arena/m04-bd5cc168/unit.(log/.exit) | 12/12（7+5） | 0 |
| M05A | arena/m05a-unit.(log/.exit) | 22/22（11/6/5） | 0 |
| M05B | arena/m05b-fix-membrane.log | 91/91 | 无独立 .exit，exit 无法独立复核（如实记录） |
| M05B | arena/m05b-fix-scheduler.log | 21/21 | 无独立 .exit，同上 |
| M06 | arena/m06-native-conversation.(log/.exit) | 13/13 | 0 |
| M06 | arena/m06-custom-footer.(log/.exit) | 45/45 | 0 |
| M07 | 无独立日志 | 报告证据 2 total / 1 pass / 1 todo | 无法独立 exit，记限制 |
| M08 | arena/m08-apply-patch.(log/.exit) | 14/14 | 0 |
| M09 | arena/m09-skill-whitelist.(log/.exit) | 2/2 | 0 |
| M09 | arena/m09-doctor.(log/.exit) | 26/26（positive pattern） | 0 |

- M03/M04 `delta-and-hashes.json` 逐 path after-hash 与当前 source 全部一致（11/11；`pi/extensions/bash-cwd.ts` 以 M04 记录为准，M03 记录被后继任务合法取代）。
- **最终最小复用组**（source 均不新于对应日志，mtime 逐项核对）：compact-tools-extension（M03）、compact-tools-error-visibility（M03）、bash-cwd-extension（M04）、subagent-native-conversation（M06）、ensure-pi-settings（M02）；reviewer-agent 仅报告证据（无日志）。M10 parser/tail 5 纯 case 亦为报告证据复用，未运行 watch/timer 用例。
- **M12 新增运行（共两次，均已结束）**：① `test/subagent-compact-rendering.test.mjs` 19/19 pass、0 fail/0 skipped，exit=0（日志 `logs/m12-compact-rendering.log`；先 read 确认纯度：仅消费 `compact-rendering.ts` 与 `title-registry.ts` 纯函数）；② 主授权的 `test/subagent-native-conversation.test.mjs` 纯 13，在 M06 类型修复后 source（tool-renderers.ts `11f5bbde…`）下 13/13 pass、exit=0（`logs/m12-native-post-typefix.log`），运行结束即释放 unit-runner。除此外未重复任何套件/tsc。
- **计数口径**：旧 `/tmp/notify-tests-sync-unit.log` 110/110 与 M05B 91/91 是不同时间的不同日志，不冒充全 suite 总数；M12 实际运行两个纯测试文件；静态检查为三个不同检查目标（listFilesOnly/root noEmit/enhanced noEmit）、共四次调用（enhanced 首轮失败及修正后复核），另有 joint fixture 的 node --check。均保留实际日志，不把补验重复计为新的测试覆盖，不重复全矩阵。

## 4. 静态检查（unit-runner 独占；真实 exit，无 pipe 掩失败）

命令环境：`env -i` 隔离 HOME/XDG/TMPDIR/PI_CODING_AGENT_DIR，`PI_TEST_CODING_AGENT_ROOT` 指向本仓物理包，`PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0`，Node `/opt/homebrew/Cellar/node/26.8.1/bin/node`（v26.8.1，满足 >=22.19.0）。均 ≤60s。

1. **listFilesOnly**：`tsc --listFilesOnly -p tsconfig.json` exit=0；由脚本解析实际输出（非 grep 手工拼覆盖）证明：src 全部 28 个 .ts、include 点名 scripts 5 入口、13 项计划新增条目全部出现在 tsc 文件清单；无 skill-whitelist 已删文件、无本机/敏感/文档文件混入。6 个不在 include 的 `pi/extensions/*` 入口（interactive-stderr-guard、openai-codex-proxy、provider-fallback、rtk、security-gates、test-payload）均为 tracked-clean 非本计划改动，属计划前既有状态，记观察。
2. **root noEmit**：`tsc --noEmit -p tsconfig.json` exit=0，零诊断。
3. **enhanced noEmit**：`tsc --noEmit -p packages/pi-subagents-enhanced/tsconfig.json` **首轮 exit=1，曾阻塞；修正后复核 exit=0，阻塞已解除**。11 个错误全部在 `src/tui/tool-renderers.ts`（M06 新建 WritePath）：TS2339（47,35/47,62/48,28/48,40/48,55/48,70/76,33/76,60/79,34/79,62）与 TS2345（57,44）。首 error：`(47,35) Property 'action' does not exist on type 'unknown'`。
   - **provenance（按 supervisor 纠正口径）**：M06 前原文件以 `(args: any, …)` 显式标注；M06 提取进新文件后改用公开 `ToolRenderers["renderCall"]` 类型标注回调，公开类型将参数解析为 `unknown`，属性访问构成**本次新类型边界**新暴露的错误，不推断为"既有问题"（enhanced noEmit 此前从未运行，仅说明不可见性，不构成既有性证据）。运行时行为不受影响（Node type-stripping 不查类型；M06 13/13 日志在案）。
   - **处理**：未修 production、未改 tsconfig、未降 compilerOptions、未加 as any/compat fallback；已上报，main 另派 M06 唯一文件类型修正 owner。owner 修复（新增 `isRecord` 守卫与 `Record<string, unknown>` 收窄，公开类型标注保留）落盘后，本任务按 supervisor 决策补跑一次 enhanced noEmit 复核：**exit=0，零诊断**（日志 `/tmp/pi104-m12-acceptance/logs/m12-enhanced-noemit-recheck.log`）。首轮失败日志完整保留于 `logs/m12-enhanced-noemit.log`。

## 5. README 更新（当前事实，不重写历史）

- **根 README.md**：安装/初始化版本更新为 Pi `1.0.4` 四核心 + `pi-subagents@0.75.0`（enhanced package 封装），删除 0.87.1/0.71.0 旧口径；compact 段改为"仅 `registerToolRenderer` 显示覆盖、不注册/执行/激活、原生 metadata 保持、defaultTools 经 settings 合并生效"；Skill 段改为原生 discovery 唯一 owner + 声明 selector 排除 + managed 工具保留（删除已退役 whitelist 扫描描述）；新增"角色流程与失败恢复"（GLOBAL/角色 append/SHARED 分工、偶发失败主管优先 resume、不自动换模/不常驻重试）与"配置模板与运行时边界"（template 非 Host 配置、`hideThinkingBlock` 唯一共享标量、本机字段不入 Git、delivered 公开转发仍阻塞于上游）；集成测试措辞去"白名单"。历史回滚小节与升级审计保持原样，不改写成今天结论。未声称真实 TUI/trust/模型 append/active 集已实际验过。
- **packages/pi-subagents-enhanced/README.md**：probe Host 版本 1.0.2 → 1.0.4；新增 `src/tui/tool-renderers.ts` 纯 renderer 工厂为唯一显示 owner（主入口与 child preview 共同消费、原生工具仅取渲染字段、未知回退原生）、structuredContent/outputSchema 为显式程序数据通道非展示改写、TUI 精简仅在 renderer 层的边界段。

## 6. 交付文件 hash（最终）

| 文件 | sha256 |
|---|---|
| README.md | `bb5d72ffe95db3fc331c1b9bc9da2ac3260b59fd64a7b8c3ce4ba73e9ca5b861` |
| packages/pi-subagents-enhanced/README.md | `d8ad23a7083c4f8e7d13bedd6227f6edabcda5e10c361d0e98d17ca732b639ec` |
| test/joint-upgrade-feature.test.mjs | `f3e369dda09f93dfc73effcce225e26946ae24f9b112188e4dd871391321fcd1`（case 数 6，与冻结前相同；未运行，仅 node --check exit=0） |
| docs/plans/records/2026-10-10-runtime-modernization/acceptance.md | 本文件自身 hash 在完成回执中报告（写入后不可自含） |

## 7. 偏差与限制（如实记录）

- **静态复核**：enhanced noEmit 首轮 exit=1 → M06 owner 修复后复核 exit=0（§4.3）。修复后 `subagent-native-conversation` 限制已按主授权闭合：tool-renderers.ts（`11f5bbde…`）下补跑一次纯 13，13/13 pass exit=0（`logs/m12-native-post-typefix.log`）；无其它套件重跑。root noEmit/listFilesOnly 通过且 root source 未变，不重跑。
- **joint-upgrade 未运行**：仅 node --check/静态审查；M01 旧 test 断言与 M09 deleted import 的同步未获运行证明。
- **M09**：第一次 negative pattern 在 Node 下未排除 last case，**实际 27/27 执行且包含禁跑的 last inspectConfiguration 真实 repo 读取——属实际越界执行**：现场保留（`m09-doctor.attempt1-pattern-not-effective.log`），不计为批准证据；HOME 隔离不能掩盖该次已发生的真实 repo 状态读取。后 positive pattern 26/26 有效，为有效证据。
- **M00**：当时 noEmit 未获预算未跑，本轮才完成 root/listFilesOnly/enhanced 三项。
- **M04**：before 副本系编辑后按 M03 原始全文重建，非预先 snapshot；hash 事实来源 M00/M03（`pi/extensions/bash-cwd.ts` 970b 衔接核对），无 reset production。
- **主调度偏差**：早前 supervisor 资源多批准同批，属主会话调度事项，不重测。
- **M07/M10**：无独立日志/exit 文件，仅报告证据（2/1/1；parser/tail 5），无法独立 exit 记限制；未读真实 session/body 补证。
- **M05B**：两个日志无 .exit 文件，exit 无法独立复核（owned command 记录在案）。
- **旧 `subagent-workspace-tool.test.mjs`** 英文 description 断言早于本轮，仅记历史限制，不越界修改、不运行真实 worktree case。
- **shell 修复实施与验收（原 pending 已闭合）**：shell `--no-skills` 移除由主追加进原 M09 计划范围，owner 3f3117d4… 完成并经主 read source/diff/logs/hash 接受：`scripts/pi-shell.zsh` sha `676421797fd391659742d0d45b17ca5010374e5de775f877583c5e989a8547e3`、`test/pi-shell.test.mjs` sha `d878f3dfa46b15c844dded8b7a9ee86ec0f40c25edb6cd5b5934326e804721e7`；before/after `/tmp/pi104-m09-shell-close-lxj4iz/`；正向 pattern 隔离 fake physical CLI 13/13 exit=0（7999.573ms，`logs/pi-shell-unit.log`/`.exit`）；14 既有 case 只跑 13，bare pi ANSI case 显式排除；普通 helper 去 `--no-skills`、`pi-lite` 显式保留、用户显式 flag 原样透传、env/owner 不变；该测试不等同“真实 shell Host skill 已验证”。**supplemental before 记录**：两个新增 M09 paths 的 task-before 由 owner 提供并存于 `/tmp/pi104-m09-shell-close-lxj4iz/`，角色 owner 3f3117d4…；该 supplemental 与 M00 baseline 60 条分开记录，不改动 baseline 文件。
- **明确未验证**：active 集实际生效、project trust/真实 shell、真实 runtime Skill 发现生效（刷新 shell 与 fresh Host 后才加载，本任务不自行运行）、模型 append 实际行为、skills 跨 scope/第三方追加集合等价、UI 可见性、真实 Host/RPC/TUI/PTY/provider/MCP、paid canary。
- **保留边界**：apply_patch move 未纳入共享队列（未覆盖并发边界）；SkillInvocation private patch 保留（无公开等价替代）；preview 点击/MouseRegion 互动未恢复；Codex-only 代理作用域保留；delivered 公开转发阻塞于上游；runtime 原始数据保持不变，structured channel 是显式 API 非展示改写；fresh Host 生效（当前 action list 可能仍是旧 replace cache）；无 hot reload/真实 Host/commit/push。

## 8. 后续三项 TODO（账本 `docs/todos/2026-10-10-runtime-followups.md`，均未实施、不随本验收自动授权）

1. 主会话空闲系统通知（用户明确暂缓；依据 `docs/decisions/2026-10-10-idle-system-notification.md`）。
2. 纯派发回执选择性关闭 `triggerTurn`（仅投递 options，非静默丢弃）。
3. heartbeat / 主进程意外退出后的孤儿清理覆盖（先完成数据来源分类再设计最小修复）。

另有两项独立调查不混入上述三项：RPC `rpc:v1/session` 协商失败（`docs/bugs/2026-10-10-rpc-session-capability-negotiation.md`）、supervisor reply/pending/steer 视图差异（`docs/bugs/2026-10-10-supervisor-reply-required-state-views.md`）。

## 9. 资源释放与收口状态

- `unit-runner` 已释放：M12 持有期间完成 listFilesOnly、root/enhanced noEmit（含修复后复核）、compact-rendering 单测、joint-upgrade node --check；其后按主授权补跑一次 native-conversation 纯 13（13/13 exit=0，`logs/m12-native-post-typefix.log`），运行结束即再次明确释放——本任务此后不再执行任何测试/tsc；shell owner 3f3117d4… 的锁等待已解除。无活跃遗留进程/定时器/arena 写入仓库。
- 本任务无 commit/push、无依赖变更、无真实流程、无 MCP、无配置写入、无凭据读取。
- **收口状态**：主会话已核对最终四文件哈希、M06 类型修正与补验、M09 shell 接线与 fake CLI 日志，接受本计划在授权验证范围内完成；执行/静态验证通过，非真实 Host 全验证。无新的 active coder（本任务不再持有任何锁/进程）。三项 TODO 未实施、RPC capability negotiation 与 supervisor reply/pending/steer 两项调查记录不纳入本计划（账本独立，见 §8）。计划 checkbox 由主会话核对后更新，本任务不自行勾选。
