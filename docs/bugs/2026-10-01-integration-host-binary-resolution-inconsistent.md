# 集成测试的 Host 二进制解析不一致：一处静默回退到过期全局 pi

- 日期：2026-10-01
- 级别：P1（测试基础设施缺陷；直接污染缺陷归因，并已导致一次错误定性）
- 状态：已定位，待修（需先由 T8/T7 的 A/B 对照实验闭合因果）
- 关联：reviewer Blocker B3；`var/upgrade/t7-workaround-feasibility.md` §2.1；
  `var/upgrade/t8-bounded-experiment.md`（T8 版本错配已证实）

## 现象

三个被集成门禁排除的文件，对「用哪个 pi 作为真实 Host」的解析方式**互不一致**：

| 测试文件 | 解析方式 | 未设置 `PI_REAL_BIN` 时的行为 |
|---|---|---|
| `test/pi-subagents-runtime.integration.mjs:15` | `process.env.PI_REAL_BIN`（无回退） | `assert.ok(piBinary, "PI_REAL_BIN must point to an explicitly supported Pi runtime")` → **响亮失败** |
| `test/subagent-auto-integration-resumed-child.integration.mjs:16` | `process.env.PI_REAL_BIN ?? "/opt/homebrew/bin/pi"` | **静默回退到全局 pi** |
| `test/session-owner-runtime.integration.mjs`（原状） | `PI_REAL_BIN: "/opt/homebrew/bin/pi"` 硬编码 | 静默使用全局 pi |

其余同类文件（`pi-subagents-project-workflow`、`subagent-runtime-root-broker-startup` 等）
均为「无回退 + `assert.ok(piBinary, ...)`」的响亮失败模式，属正确写法。

## 关键事实：没有任何 script 注入 `PI_REAL_BIN`

```
test:all-integration = node scripts/run-integration-gate.ts
test:subagents       = node --test test/pi-subagents-runtime.integration.mjs
```

`scripts/run-integration-gate.ts:52` 的子进程环境是
`{ ...process.env, TMPDIR: process.env.TMPDIR ?? "/tmp" }` —— **不注入 `PI_REAL_BIN`**。
`test:subagents` 是裸 `node --test`，同样不注入。

因此 `PI_REAL_BIN` 只可能来自**执行者的环境**。推论：

1. `pi-subagents-runtime.integration.mjs` 在未显式设置该变量的环境里**根本无法运行**
   （立即断言失败）。而它被排除的理由是 `WIRED-ELSEWHERE: 已由 test:subagents script 维护验收`
   —— 这精确印证 reviewer 的判断：**「有独立 script 不等于有通过的门禁」**。
   所谓 3/5 的结果，必然是在某个 ambient 设置了 `PI_REAL_BIN` 的环境里得到的，
   而该环境未被记录、不可复现。
2. `subagent-auto-integration-resumed-child.integration.mjs` 在同样环境里**不会失败**，
   而是静默使用 `/opt/homebrew/bin/pi`。

## 版本事实（绝对路径核实，2026-10-01）

```
$ /opt/homebrew/bin/pi --version
0.85.1
$ stat -f '%Sm' /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
2026-09-12 20:14:34            # 数周未变；T12 第三段「全局安装 0.87.1」尚未执行
$ which -a pi
/opt/homebrew/bin/pi           # PATH 上只有这一个
$ ./node_modules/.bin/pi --version
0.87.1                         # 本仓 repo-local
```

即：**全局 pi = 0.85.1，本仓 = 0.87.1，二者并存**。

## 后果：一次错误定性，以及本文首版因果结论的自我更正

> ⚠️ **本文首版曾断言"T8 的失败已证实是版本错配导致 record 恒空"。该因果结论已被
> A/B 对照实验证伪，现予更正。** 但本文的**核心发现（Host 解析契约不一致）依然成立**，
> 且其独立危害不依赖该因果结论。完整证据见 `var/upgrade/t8-bounded-experiment.md` 第六节。

### 已被证伪的部分：版本错配不是 T8 失败的原因

对同一 PTY 用例只改 `PI_REAL_BIN` 做 A/B 对照，结果**两组行为一致**：

| 组 | Host | 版本 | 首个 `active` record（自 ready marker 起算） |
|---|---|---|---|
| A 组 | `/opt/homebrew/bin/pi`（全局） | **0.85.1** | **169ms** |
| B 组 | 本仓 `node_modules/.../dist/bundle/cli.js` | **0.87.1** | **170ms** |

即：**0.85.1 Host 同样能成功加载本仓 session-owner 扩展并登记 record**。
"旧 Host 下扩展未注册成功 → record 恒空"的推断不成立，版本不是变量。

### 依然成立的部分：原定性确实错误，且错误机制已查清

HANDOFF 与原诊断把 T8 定性为「夹具时序脆弱（SIGKILL 接管超 60s 预算）、非生产缺陷」，
这**确实是错的**，错因有两处，均与版本无关：

1. **`PI_OWNER_READY` 并非 pi 或扩展打印**，而是 expect 脚本自己 `send_user` 的
   （原 `:362`，匹配到 provider 名 `deterministic` 就发）。原诊断把"进程启动并输出
   provider 信息"误当成"扩展注册成功"，这是错误定性的直接来源。
2. **历史失败发生在第一个 owner**，根本没走到 SIGKILL 接管阶段（trace 无 `owner-sigkill`
   事件），所以"接管超预算"的表述与现场不符。

另有一个**测试自身缺陷（类别 2）**已被查出并修复（提交 `7847863`）：
ESRCH 探针原置于 `await first.child.once("exit")` 之前，而被 SIGKILL 的 pi 是 expect
wrapper 的子进程，wrapper 未退出前它是 **zombie**，`kill(pid, 0)` 对 zombie **会成功**，
故探针在 wrapper 存活期间永远拿不到 ESRCH —— 与 pi 版本无关，A/B 两组同样失败。

### 当前状态：T8 根因属**类别 3（来源尚未证实）**

修正探针后重跑，暴露出**不同**的失败现场（repo-local 0.87.1）：

- `wrapper-spawn → wrapper-ready-marker → wrapper-exit(+23985ms)`，**无 `record-ready`**，
  63s 内 record 从未变 active；
- wrapper 输出显示 pi 启动**完全正常**：`pi v0.87.1`、
  `[Extensions] deterministic-provider.mjs, session-owner.ts`（扩展已加载）、
  `PI_OWNER_READY` 已发；
- 但现场出现守卫文案 **`Warning: 该会话正由另一个 Pi 窗口使用，已取消切换`**；
- **复现不稳定**：同一 0.87.1 二进制，两次运行 ~890ms 成功、一次 63s 恒空。

按根 `AGENTS.md`「缺陷数据来源分类门禁」，此为类别 3：必须 fail closed、保留现场、
补 provenance，**在完成分类前禁止任何预防性兼容/防御/fallback**。
待判定的三个假设（ownerId 碰撞致谓词永不匹配 / 守卫主动拒绝接管 / 与负载相关）
见 `var/upgrade/t8-bounded-experiment.md` §6.4 与 `var/upgrade/t8-root-cause.md`。

## 对 T7 归因的影响（仍未闭合，但风险等级下调）

`var/upgrade/t7-workaround-feasibility.md` 已确证两件事：

- **上游代码缺口真实存在且与 Host 版本无关**：`pi-subagents@0.71.0` 的
  `runs/foreground/subagent-executor.js:2938-3002`，`runAsyncPath` 调 `executeAsyncSingle`
  时未复制请求级 `params.subagentOnlyExtensions`；`async-execution.js:1599-1605,1744-1746`
  只读 `agentConfig.subagentOnlyExtensions`，而 workflow 注入值不在 agent profile 上
  → step 缺该字段。runner 读取点 `subagent-runner.js:510/:867` →
  `runner-child-launch.js:31-33`，**runner 不是首个偏离点**（既有文档说反了）。
- **child 是进程内拉起**（本仓 pinned `pi-subagents@0.71.0` 的 runner，经
  `subagent-runner-bootstrap.js:163-167`、`child-session.js:10-16,151-166`），
  **不经全局 pi 二进制** → 该子假设已排除。

仍存的风险：T7 用例的 **root Host** 是 `PI_REAL_BIN ?? "/opt/homebrew/bin/pi"` = **0.85.1**，
即"上游缺口"这一诊断是在版本错配的 root Host 下做出的。

**但风险等级应下调**：T8 的 A/B 实验已证明 0.85.1 Host 能正常加载本仓扩展，
所以"错配必然致错"不成立——错配是**风险**，不是**已证实的致因**。
要闭合 T7 因果，仍需对 `subagent-auto-integration-resumed-child.integration.mjs` 做
同样的 `PI_REAL_BIN` A/B 对照（全局 0.85.1 vs repo-local 0.87.1），观测挂起是否仍复现：

- 若 0.87.1 下**仍挂起** → 上游缺口确为挂起主因，维持"待上游修复"，但排除理由须改写准确；
- 若 0.87.1 下**通过** → 挂起主因是错配，排除可立即解除。

## 修复方向

1. **统一 Host 二进制解析契约**：所有需要真实 Host 的集成测试一律
   「无回退 + 响亮断言」，或统一优先 repo-local pi（T8 夹具已改为
   `process.env.T8_PI_REAL_BIN ?? repoLocalPi` + 绝对路径版本校验 + 把 `piVersion`
   写入 trace，可作为范式）。**禁止**任何测试静默回退到可能滞后于本仓的全局安装。
2. **由 gate runner 显式注入** `PI_REAL_BIN`（指向 repo-local cli），使集成门禁
   **自洽可复现**，不依赖执行者 ambient 环境；并在日志中记录所用 Host 版本。
3. 修正 `scripts/run-integration-gate.ts` 排除表中 `WIRED-ELSEWHERE` 的表述：
   `test:subagents` 在未注入 `PI_REAL_BIN` 时**无法运行**，不构成有效门禁。
   这一条**不依赖**任何 T8/T7 因果结论，独立成立。
4. 闭合 T7 因果：执行上述 `PI_REAL_BIN` A/B 对照实验。

## 数据来源分类

- **本文主体（Host 解析契约不一致）：类别 2** —— 缺陷位于测试基础设施，不是 production 代码。
  其危害是**让归因判断失去可复现的环境前提**（同一测试在不同执行者环境下跑的是不同 Host），
  已实际导致 T8 一次错误定性；但**不得**据此为 production 增加兼容分支。
- **T8 当前失败现场：类别 3（来源尚未证实）** —— 复现不稳定、机制未定，
  必须 fail closed 并补 provenance，禁止预防性兼容。
- **T7 的上游 `subagentOnlyExtensions` 传播缺口：类别 1** —— production 可达的真实缺陷，
  与本文的测试基础设施缺陷是**两个独立问题**，不可混为一谈。

## 更正记录

- 2026-10-01 首版：断言 T8 失败"已证实"为版本错配所致（`0.85.1 Host 加载 0.87.1 扩展
  → 扩展未注册 → record 恒空`）。
- 2026-10-01 更正：A/B 对照实验（A 组 0.85.1 / B 组 0.87.1，record 分别 169ms、170ms 出现）
  **证伪**该因果结论；T8 根因改判类别 3 待诊断。本文核心发现（解析契约不一致、
  `WIRED-ELSEWHERE` 不构成门禁、`PI_OWNER_READY` 来自 expect 而非 pi）不受影响，依然成立。
