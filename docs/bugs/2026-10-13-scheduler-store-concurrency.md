# Scheduler 存储并发缺陷与 FileSchedulerLock 锁缺陷记录（修复暂停）

- 日期：2026-10-13；任务：dispatch-6d06a8cc（切片 1）
- 上游 pinned 版本：`@amaster.ai/pi-task-scheduler` 0.1.9（`pi/npm/node_modules/@amaster.ai/pi-task-scheduler/dist/`，行号以该 dist 为准）
- 状态：**修复暂停**。本切片仅完成事实记录；`src/task-scheduler/store.ts`、测试与 adapter 接线均**未创建**，等待主层只读调查产出的最小安全合同。
- 本记录不含任何用户敏感信息；repro 脚本内任务均为 /tmp 隔离文件 + 固定非真实字面量 prompt。

## 一、D1–D3：store 存储层并发缺陷（来源报告登记，本次未重跑）

来源：`/tmp/scheduler-delete-repair-contract.md` 第一节（承接 `/tmp/scheduler-delete-orphan-diagnosis.md`），复现脚本 `/tmp/scheduler-delete-repro.mjs`（合同记录为 7/7 PASS）。**限制**：本切片未重跑该脚本，以下为合同记录证据的转述登记，结论以脚本可复现为准。

经真实上游公开入口（`JsonScheduledTaskStore` / `PersistentTaskScheduler` / `FileSchedulerLock` 公开构造参数与公开方法）、/tmp 隔离文件、固定非真实 prompt、远期 interval 保证真实 timer 不触发、触发一律经公开 `runNow`，复现三类 production 可达缺陷：

| # | 缺陷 | 源码根因（stores.js） |
|---|---|---|
| D1 | 跨实例删除后继续触发并复活：实例 B 删除任务 X 后，实例 A 仍 get 到 X、runNow 照常触发 runner，run 完成后 X 被写回盘面 | store 一次性快照永不刷新（`loaded` 旗标 :7，`load()` :53-64）；execute 读自身陈旧快照（index.js:223） |
| D2 | stale 写双向破坏：对另一任务的公开 update 使已删任务复活；跨实例顺序两次 update 必然失更新（last-writer-wins） | 每次 mutator 整文件 `save()`（:65-67），updateState 内 mutator 后**无条件** save（:68-77），无锁/CAS/合并 |
| D3 | 失败（no-op）mutator 仍整文件写回：delete 目标不在快照中返回 false，但仍把陈旧快照整体写盘，抹掉盘上其他实例的全部任务 | updateState（:68-77）中 mutator 返回 false 不阻止 `save()`（:72） |

用户个案（其他会话删后残留触发）provenance 仍未知，不得归因给该个案；D1–D3 修复正当性独立成立。

拓扑澄清：上述复现为同 PID 双实例（双 active）的合成拓扑，仅佐证共享 store 算法缺陷本身，不等同实际 Host 现场。生产中真正共享 store 的正常可达前提是两个 Host 同时 resume 同一 session 文件（resume 保留 header.id，new/fork 生成新 ID）；正常单 Host 单实例不触发双 store 问题，第二 Host 通常 inactive 但工具照注册可写、sessionPath 相同。

## 二、L1：FileSchedulerLock 不构成可靠跨进程互斥锁（本次源码级现场核实）

**核实方式**：完整 read pinned dist `stores.js` 全文（未做真实进程实验、未做真实任务实验，遵守实验边界）。以下为源码事实与由此推出的正常调用链。

### 2.1 正常调用链（双进程、盘面无锁文件时）

`acquire()`（stores.js:85-107）：

1. `mkdirSync(dirname)` 后 `holderPid()`（:87）→ 文件不存在 → `readFileSync` ENOENT → catch → 返回 `undefined`（:128-140）；
2. `holder` 为空 → 不进入 `holder !== process.pid` 拒绝分支（:88-90）→ 继续执行；
3. **无条件** `unlinkSync(this.path)`（:92，ENOENT 等异常被吞）；
4. `writeFileSync(this.path, String(process.pid), { flag: 'wx' })`（:98）→ 成功 → `acquired = true`。

竞态交错：A、B 两进程均先 `holderPid()` 得 `undefined`；A 执行 unlink（吞 ENOENT）+ wx 建锁成功；随后 **B 的 `unlinkSync` 删掉 A 刚建的锁文件**，B 的 wx 也成功。结果：A、B 同时 `acquired=true`，双双进入"临界区"。`wx` 排他性失效的根因是"check → unlink → create"三步非原子，且 unlink 主动销毁了排他依据；acquire-retry 只重入同一竞态窗口，不提供原子性。

### 2.2 holderPid() 把坏元数据与 EPERM 误判为 dead 并 unlink

`holderPid()`（:128-140）：`Number(readFileSync(...).trim())` 非 NaN 才继续；锁文件内容损坏 → NaN → 走 `unlinkSync(this.path)`（:134），**删除存活持有者的锁文件**；`isProcessAlive`（:142-148）`process.kill(pid, 0)` 抛 `EPERM`（进程存活但无信号权限）→ catch → 视为 dead → 同样 unlink；pid 复用（持有者死亡、pid 被无关进程复用）→ 被误判存活。即：锁文件是「pid 提示」而非互斥事实。

### 2.3 同 pid 重入不互斥

`holder === process.pid`（:88）直接放行并重复 unlink+重建：同进程内多实例/多操作在同一锁路径上可交错；一方 `release()`（:110-123）按 pid 匹配 unlink，**另一方随之失锁**。reload、SDK 同进程多实例场景并非可直接判不可达，「生产中每进程每 session 恰一个 store 实例」在无防御前提下只是假设，不能作为正确性依据。

### 2.4 对原修复合同的影响

- 不能把 `FileSchedulerLock` 用作以正确性为目标的跨进程 mutator 锁；
- 「10s 锁超时 + 毫秒级持锁 ⇒ 超时正常不可达」推断不成立：竞争下 acquire 的真假与锁文件归属都不反映真实互斥；
- 原合同设想的「acquire false → sleep → retry」协议在 L1 下不产生互斥保证，只产生计时上界。

### 2.5 来源分类（按仓库缺陷数据来源分类门禁）

L1 属第 1 类「预期 production 数据未被正确处理」：`acquire/holderPid/release` 是上游公开导出的正常入口，触发只需两个进程的正常并发调用，无非法 fixture、无倒退时间、无手工拼装状态；源码交错链完整闭合。按门禁应按生产缺陷处理：中文问题记录（本文）、精确复现证据（上述调用链 + 上游公开实现）、最小修复。**本次未做双进程实测**：不进行真实进程杀死/真实任务实验；交错链为源码级确定性推导，修复实施时应补受控双进程验证（列入待办）。

## 三、修复状态：暂停，未创建 store / 未接线

- 原合同（切片 1）拟新建 `src/task-scheduler/store.ts`（`RefreshingScheduledTaskStore` + `SchedulerStoreLockTimeoutError`）与 `test/task-scheduler-store.test.mjs`：**均未创建**。
- 原合同中「默认 `new FileSchedulerLock(storePath + '.lock')` 作为生产锁」的接入已在实施前叫停（L1）；未引入任何生产 fallback、未新写锁算法、未以测试替身冒充跨进程互斥证明。
- adapter（`src/task-scheduler/adapter.ts`）注入不在本切片，且该文件维持 dirty 现状未触碰；vendored dist 未修改。
- 未提交任何 git 变更；除本文档外无其他新增/修改。

## 四、待修订合同闭合的开放问题

在最小安全合同落地前，以下语义问题尚未闭合，不得提前固化为实现：

1. **五方法完整 replace 与调用方 stale 字段覆盖**：store 层 update 为整任务替换（上游 `store.update` 语义）。合并责任在上游 scheduler（get→merge→update）时，store 层 refresh 才能消除 stale 字段覆盖；若调用方直接持 stale 整任务调用 store.update，锁内重读也无法恢复其未携带的字段。接口是否维持完整 replace、是否在文档中显式声明该边界，待定。
2. **readJsonFile 损坏回退空数组的写丢风险**：`readJsonFile`（dist/json-file.js）在主文件 SyntaxError 时回退 `.bak`，仍失败回退 `[]`（:8-15）。若后续操作以 `[]` 为基线做条件写，会把盘上（可恢复或部分可恢复的）任务写丢。损坏场景下的 fail-closed 边界（拒绝写 vs 回退写）待定。
3. **legacy 迁移跳过**：注入 store 时上游跳过 legacy `tasks.json` 迁移（extension.js:53 条件 `!config.store`）。对本仓 dataDir 布局影响评估未闭合。

## 五、已知上游窗口（登记，不在本切片修复）

- get（index.js:223）与 runner 调用（:247）之间的毫秒窗口：跨实例 delete 不能拦截已进入 execute 的 run；store 层无法中止 upstream 内部 runner，需 upstream 侧跟进。
- delete 不撤回在途 run：保留语义；run 完成后的「复活」部分由 D1/D2/D3 修复消除（待修复实施）。
- `void this.execute`（index.js:119,189,206,213）无 rejection 处理：锁超时等异常落入该路径时在 Node 默认策略下可能影响 Host 稳定性；不加全局兜底（禁止隐式 fallback），登记为独立上游缺陷。
- 新建/调度修改的跨 Host 即时可见性（活跃实例无 timer 直至重启/接手）：不在本切片扩大。

## 六、验证记录（本切片实际执行）

- `npm run typecheck:root`：通过（仅新增本文档，树内既有 dirty 不受影响）。
- `git diff --check`：通过（无空白错误）。
- `node --test test/task-scheduler-store.test.mjs`：未运行（测试文件按决定未创建）。
- D1–D3 repro 未重跑（限制见第一节）；L1 为源码级核实，未做双进程实测（限制见 2.5）。
