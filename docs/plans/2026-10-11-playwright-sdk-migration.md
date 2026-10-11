# Playwright SDK 直连与 skill 内聚迁移计划

> **执行方式：** 用户已明确授权 Inline。用户在实施期间进一步要求“全部内聚于 skill”，本修订记录最终架构及验收，不再以根 `src/` 作为交付边界。

**目标：** 删除旧 Python/代理链路，以直接 Playwright SDK 实现持久浏览器会话；实现、依赖、测试、fixture、静态检查及验收全部由 `skill-overrides/playwright/` 自己拥有，可复制目录独立安装运行。

**架构：** 本 skill 的 `playwright.ts` → `src/index.ts` → 直接 Playwright SDK。私有 Unix socket 只承载自有命令协议，不是 MCP。Node daemon 持有 context/page，真实 smoke 后才发布 ready，跨 CLI 命令复用会话。

**技术栈：** Node `>=22.19.0`、生产 `.ts`、稳定 Playwright/Core `1.64.0`、本 skill 的 TypeScript `tsc --noEmit`、Node `node:test`。依赖锁定在本 skill，不从仓库根或临时缓存解析。

## 全局约束

- 最低 Node `>=22.19.0`，production/CLI 使用 `.ts`，不以 type-stripping 代替类型检查。
- 用户指定本独立 skill 的实现与依赖全部内聚，根 `src/`、`test/`、`scripts/` 不保留 Playwright 专属模块；不新增共享库，不反向依赖宿主入口。
- 禁止 MCP client/server、旧工具协议、临时缓存依赖及自动浏览器 fallback；不运行旧 fake MCP。
- 默认 headless，显式系统 Chrome channel；不自动下载 browser，缺失判 blocked。
- 默认不用 TDD；实现后契约/回归/验收，不加载 TDD skill。
- named profile 只接受安全名称、0700/owner/非symlink；同 profile 原子lease排他。stop保留named，只删除匹配ownership的temporary。
- 不扫描/猜测/复制既有profile，不接管旧锁，不停止他人实例，不提供stopall/start-time reap。
- 认证阶段显式 --auth，只允许navigate/auth-check/status/stop；用户手动密码/MFA，只返回origin/业务结构布尔，不访问Cookie/storage。
- 不提供任意evaluate/run-file或跨进程凭据交接；snapshot/title是已授权普通页面内容，不能保证自动识别秘密，SSO阶段硬拒绝。
- 不输出token/credential/headers/storageState/签名URL；文档和注释中文；不自动提交或推送。
- 不覆盖dirty现场；生产异常先记录实际入口、首个偏离与调用链并分类，测试污染只修fixture，来源不明fail closed。

## 文件职责

全部以下路径均相对 `skill-overrides/playwright/`：

| 文件 | 职责 |
|---|---|
| `playwright.ts` | 薄CLI入口，仅调用本目录src/index.ts |
| `src/contracts.ts` | config/command/result/adapter/wire合同与校验 |
| `src/lifecycle.ts` | daemon/socket/lease/profile/ready/stop/idle |
| `src/sdk-adapter.ts` | 直接SDK persistent context、page smoke、close |
| `src/operations.ts` | navigate/snapshot/locator/tabs/screenshot/inspect/auth-check |
| `src/cli.ts`, `src/index.ts` | CLI参数、固定JSON结果、内部公开入口 |
| `package.json`, `package-lock.json` | 精确SDK与开发依赖，不依赖根node_modules |
| `tsconfig.json`, `.gitignore` | skill自有静态检查与依赖/cache忽略 |
| `test/helpers/playwright-runtime.mjs` | 私有fixture与fake adapter daemon，不起Chrome |
| `test/playwright-runtime-{contract,lifecycle,operations,cli}.test.mjs` | unit/协议/安全/生命周期回归 |
| `test/playwright-runtime-browser.smoke.mjs` | 显式真实Chrome gate，不匹配默认test glob |
| `test/fixtures/playwright-runtime/page.html` | 无真实认证的本机HTML和synthetic-secret |
| `scripts/acceptance.ts` | 只运行验收、输出私有报告，不修代码/升级 |
| `SKILL.md` | 最小启动、停止、安全边界与二级文档路由 |
| `docs/operations.md` | 页面操作按需参考 |
| `docs/authentication.md` | 合并后的认证会话按需参考 |
| `docs/diagnostics.md` | 启动/锁/清理诊断按需参考 |
| `docs/maintenance.md` | skill维护与独立验收按需参考 |

外部仅必要同步：`scripts/pi-shell.zsh` 的Python实现注释。认证流程已并入本skill的 `docs/authentication.md`；独立 `browser-auth-session` 入口删除。根package/lock/tsconfig恢复原样；旧三份`.py`删除。无此前字节基线的忽略`.pyc`保留，不作为启动链、不宣称目录字节级清空。工程计划是历史/调度文档，不是skill运行依赖。

## DAG / Waves

```text
T1 版本/API → T2 内聚依赖/合同 → (T3 lifecycle || T4 operations)
                                      ↓
                             T5 CLI/skill文档与旧入口删除
                                      ↓
                             T6 内聚验收harness
                                      ↓
                             T7 独立目录和仓库验收
```

- Wave1 T1；Wave2 T2；Wave3 T3/T4；Wave4 T5；Wave5 T6；Wave6 T7。
- 关键路径 T1→T2→max(T3,T4)→T5→T6→T7。用户选择Inline，当前串行执行；Wave不是并发屏障。

## T1：版本/API核对

**Deps：** none。**WritePaths：** none。**Resources：** 公共registry HTTPS。**Files：** SDK公共metadata/types。

**合同：** 产出稳定精确版本及支持Node最低版本、persistentContext/ariaSnapshot/locator API证据。

- [x] 公共registry核对 `playwright=1.64.0`、`playwright-core=1.64.0`，Nodeengine>=20满足22.19。
- [x] 只读包类型确认需要的API存在，不消费内部模块；不运行MCP。

## T2：skill独立依赖/配置/合同

**Deps：** T1版本证据。**WritePaths：** 本skill package/lock/tsconfig/gitignore/src/contracts.ts、test/helper与contract test。**Resources：** npm安装互斥。**Files：** 同WritePaths。

**合同：** RuntimeOptions固定channel/headless/authMode与正期限；Command明确locator和auth-check；SafeResult不允许任意对象直通。wire最多1MiB，超限错误不截断。测试adapter只能harness注入。

- [x] 本目录精确锁Playwright/Core1.64.0、TypeScript7.0.2和@types/node26.4.1；ignore-scripts且不下载browser。
- [x] 根Playwright依赖/脚本/tsconfig接入移除，根配置与HEAD无diff。
- [x] `cd <skill目录> && npm ci --ignore-scripts`可用；npm --prefix ci的外目录差异记录，不增加运行时兼容。
- [x] skill自有typecheck与合同测试通过。

## T3：直接SDK生命周期

**Deps：** T2合同。**WritePaths：** 本skill src/lifecycle.ts、sdk-adapter.ts、lifecycle test。**Resources：** fake adapter/私有root。**Files：** 同WritePaths。

**合同：** lifecycle唯一持session，操作委托dispatcher；launch→about:blank/title→ready/socket；nonce所有权，未确认close保留lease；不按裸PID抢占。

- [x] profile/目录权限symlink检查、并发lease、instance排他、scope哈希/socket预算。
- [x] stop/idle/pending/启动取消、fake崩溃与close未确认回归；named保留、temporary清理。
- [x] 合法并发mkdir竞态已修：来源为正常两个startup，首偏离privateDirectory/mkdir的EEXIST，仍校验目录权限；不是无限重试/fallback。

## T4：SDK固定页面操作

**Deps：** T2合同，可与T3并行。**WritePaths：** 本skill operations与operations test。**Resources：** fake page/context。**Files：** 同WritePaths。

**合同：** `executeOperation(session,command)`返回受限schema，不任意脚本执行；locator strict；artifact名字不接受路径；auth-mode固定布尔验证。

- [x] navigate/snapshot/click/fill/wait/tabs/screenshot/inspect/auth-check。
- [x] 截图私有0700根/0600新文件，不覆盖、不symlink写穿；密码fill拒绝。
- [x] synthetic-secret不进入auth-check reply或框架日志；普通文本非自动secret scrubber。

## T5：CLI、文档和旧入口清除

**Deps：** T3/T4实现。**WritePaths：** 本skill CLI/index/入口/SKILL.md/docs/*.md/CLI test；pi-shell注释；删除旧三份.py和独立browser-auth-session入口。**Resources：** 无真实认证。**Files：** 同WritePaths。

**合同：** 显式instance，start默认headless、--headed/--auth显式；status/instances/stop/command单行JSON；不同cwd使用绝对skill入口。

- [x] CLI跨进程会话、精确instance、无任意adapter环境变量。
- [x] 一级文档保留最小启动/停止；页面操作、认证、诊断、维护拆为按需加载的二级文档；认证流程并入本skill。
- [x] 旧Python wrapper/fake/测试删除，不接管旧进程，忽略.pyc残留单列。
- [x] 根src/test/scripts的本次Playwright模块全部搬迁，不保留facade。

## T6：skill内聚真实验收harness

**Deps：** T5CLI。**WritePaths：** 本skill test/browser.smoke、fixture、scripts/acceptance.ts。**Resources：** 构建harness不访问个人profile。**Files：** 同WritePaths。

**合同：** typecheck→unit→显式browser gate；verdict passed/blocked/failed；私有0600报告，Chrome缺失不通过。

- [x] canonical短临时root/全新测试HOME、loopback随机端口；不外网/认证。
- [x] 默认unit不发现browser.smoke；真实gate显式执行。
- [x] finally验证本次daemon与其子进程PID退出、lease/socket/profile清理，不杀全局Chrome。
- [x] macOS长临时HOME导致socket预算拒绝已分类fixture问题：只改测试私有短root，未放宽生产guard。

## T7：独立部署与最终验收

**Deps：** T6harness。**WritePaths：** none（私有临时报告）。**Resources：** 最多同时两个新Chromecontext；no headed。**Files：** 全部交付文件只读验收。

- [x] skill目录 `npm run typecheck`、`npm test`（20项）、`npm run verify`通过。
- [x] 将完整skill复制到仓库外短临时目录（不带node_modules/cache），进入目录`npm ci`后typecheck/unit/verify全通过；没有根代码或依赖可用。
- [x] 真Chrome155.0.8059.40：about:blank/title、跨CLI表单、snapshot/locator/wait、tabs、PNG0600、实例隔离、named排他/stop复用、auth-check/限制、idle/清理通过。
- [x] 根typecheck与pi-shell相关14项回归通过；根配置无Playwrightdiff；静态import边界审计无越界。
- [x] 全仓npm test已运行，4项失败与HEAD隔离基线同名测试复现；不修改无关测试，不宣称全仓GREEN。
- [ ] 全仓回归的4项既有失败由用户后续决定，不作为Playwright修复任务自动扩scope。

## 验收矩阵

| 项 | 证据要求 |
|---|---|
| A1 内聚/MCP清除 | 本skill无外部生产import，无MCP/client/cache依赖；根src/test/scripts无Playwright专属实现；根配置恢复 |
| A2 ready | 真实SDKpage/about:blank/title、headless/channel/version通过，不仅pid/socket |
| A3 页面操作 | 本机fixture跨CLI navigate→snapshot→fill→click→wait→visible |
| A4 tabs/截图/auth | tabs稳定id、0600PNG无覆盖；synthetic认证mode只固定布尔 |
| A5 隔离 | A/B两个context互不影响，stopA后B可查询 |
| A6 排他 | 同named profile两start一成功、另一profile-in-use；stop后可复用 |
| A7 清理 | 本次daemon/实际子进程退出，state/socket/lease释放、temporary删除、named保留 |
| A8 故障 | fake合法入口browser/page失败无假ready、close未确认保留lease；pending不idle |
| A9 安全边界 | symlink/mode拒绝、短socket校验、1MiB边界、未知op拒绝、无秘密错误内容 |
| A10 独立安装 | 仓库外复制目录npm ci/typecheck/unit/verify全部通过，不依赖root配置 |

**交付判定：** Playwright专属A1–A10通过，无skip；一级SKILL.md可独立指导最基本headless/headed启动；二级文档按需路由清晰；全仓4项既有失败仍单列，不能说全部TODO或全仓测试已完成。

**人工验收边界：** 未启动headed、未进行真实SSO；需要用户另行批准，headless无认证fixture成功不是SSO成功证据。

**审阅记录：** 首轮reviewer完成并据意见修订；当前内聚版没有独立成果review，后续每轮review需要用户授权。未提交commit。
