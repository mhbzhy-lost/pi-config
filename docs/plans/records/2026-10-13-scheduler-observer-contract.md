# Scheduler owner/observer 合同（F4g 静态记录）

**性质：** 统一计划 `2026-10-13-remaining-runtime-execution.md` F4g 的静态证据记录与实现合同。本文只做静态阅读 + 记录，不改任何代码、不含测试（unit 归 F4a）、不验证真实任务。实现归 F4a（capture-before-await token、typed observer）与 F4b（activity source）。

**修订记录：**

- **R1（2026-10-13 首版）：** 静态源码事实核对与初版签名。
- **R2（2026-10-13，父层验收 gate 修订）：** ① observer 公开形状修订为 `{snapshot, subscribe, detail(id)}`，detail 由 adapter 闭包内部 capture token，`SchedulerRefreshOwner` 不出公开面（R1 的 `fetchSchedulerDetail(owner,…)` 要求 source 持 token 却无 capture API，属设计漏洞，废止）；② 新增 subscribe 异常隔离/失效/unsubscribe 语义；③ 单飞在途触发改"直接 drop"为同 epoch dirty flag + 单次合并重跑，并冻结在途 list 读取时机与至多一个 flight；④ 内部→公开 mapper 统一字段命名（原子计划 `id`/`lastStatus`、`observedAt?:string`），R1 的 `taskId`/`status` 命名废止；⑤ 明确 epoch 跨闭包数值可相同但 token 闭包私有、source 不得拼装三字段；⑥ sessionId 非实例唯一判别符 caveat（不同 manager resume 同文件同 ID）。§1/§2/§4/§5/§6/§7/§8/§10 按本轮修订。**此前"无 blocked"结论仅覆盖源码事实核对；API 形状部分未经先前验证，以本轮修订为准。**

**证据来源（均为本仓锁定版本现场读取，行号为当日现场行号）：**

- `src/task-scheduler/adapter.ts`（当前 membrane 实现）
- `pi/npm/node_modules/@amaster.ai/pi-task-scheduler/dist/{extension.js,tools.js,index.d.ts}`（上游 0.1.9）
- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/{runner.js,wrapper.js,types.d.ts}`（Pi 1.0.4 SDK）
- `node_modules/@earendil-works/pi-coding-agent/dist/core/{agent-session.js,session-manager.js}`（reload / 身份事实）

---

## 1. 公开身份事实核对（F4g checklist 第 1 项，已核实，无 blocked-upstream）

| 事实 | 证据 |
| --- | --- |
| 工具 execute 收到**全新 ctx 对象**：每次工具调用经 `wrapRegisteredTool` → `runner.createToolContext(toolCallId, signal)`，其内部调用 `this.createContext()` 并注释 "returns a fresh object" | `wrapper.js:12-13`、`runner.js:696-699`、`runner.js:613` |
| `ctx.sessionManager` 是 live getter，返回 `runner.sessionManager`；ExtensionRunner 的 sessionManager 仅在构造器赋值一次，**没有公开 setter** | `runner.js:634-637`、`runner.js:200/205` |
| 事件分发（`emit`/`emitBoundary`，含 `session_start`/`session_shutdown`）每次也 `createContext()` 产生新对象 | `runner.js:814/843`（emit）、`runner.js:760`（emitBoundary） |
| `getSessionId()` 返回实例字段 `this.sessionId`，同一 SessionManager 生命周期内恒定 | `session-manager.js:779-781` |
| **sessionId 不是实例唯一判别符（R2 补）**：resume/重开既有 session 文件时 `_loadEntries` 从 header 恢复 `this.sessionId = header.id`，**不同的 SessionManager 实例可携带相同 sessionId** | `session-manager.js` `_loadEntries`（`this.sessionId = header.id`）、`_setSessionFile`（668-688） |
| **同 session /reload：manager 对象与 sessionId 都不变**。`AgentSession.reload()`（agent-session.js:2932）先对旧 runner 发 `session_shutdown`(reason:"reload") 并 `oldRunner.invalidate()`（2935-2936），再 `_buildRuntime` → `new ExtensionRunner(..., this.sessionManager, ...)`（2917）；`AgentSession.sessionManager` 只在构造器赋值（177）。**reload 后新的 runner 拿到同一个 SessionManager 对象** | `agent-session.js:2932-2936, 2917, 177` |
| 换 session（newSession/fork/switch）= AgentSession 整体替换：旧 runner `invalidate()`（dispose 路径 992-999），旧 ctx 所有 getter 经 `assertActive()` 抛错；替换后是**新 SessionManager 对象**，sessionId 视目标而定——newSession/fork 产生新 ID，**switch/resume 既有 session 文件则是新对象携带同一 ID**（勿宣称所有 switch 都换 ID） | `runner.js:482-485`、`agent-session.js:999`、`session-manager.js` `_loadEntries`/`newSession`、invalidate 文案 "stale after session replacement or reload" |
| `ctx.ui.setStatus(key, text|undefined)` 是公开 ExtensionUIContext 接口 | `extensions/types.d.ts:84` |
| 工具 execute 形参序为 `(toolCallId, params, signal, onUpdate, ctx)`，即 adapter 包装里的 `args[4]` 是 ctx | `extensions/types.d.ts:494` |
| 上游 scheduler 实例是**扩展闭包局部**（`let scheduler`），按 `sha256(sessionId)` 派生 store/lock 文件名，非模块单例 | 上游 `extension.js:38-39, 50-51, 63` |
| **上游 store 读取时机（R2 补）**：`JsonScheduledTaskStore` 首次 `list()` 惰性读 JSON 文件进内存 Map（`loaded` 标志），此后 list/get 读内存 Map；mutator 经 `writeTail` 串行（load → 变更 Map → save） | 上游 `stores.js` `load()`/`updateState()`/`list()`；`PersistentTaskScheduler.list` 直接委托 `store.list`（上游 index.js:15-17） |

**推论（token 设计的直接依据）：** manager 对象 + sessionId 在"同 session reload"前后完全相同（同一 SessionManager 对象、同一 sessionId），而 adapter 闭包已被 `session_shutdown` 终止、新闭包重新 `session_start`。因此**仅凭 manager/sessionId 身份无法区分世代**；跨闭包的对象比较也无意义。唯一可靠的世代判别是 adapter 闭包本地的 epoch 计数，且 token 必须在 await 之前一次性捕获，不能事后重新查询（事后查询在任何世代里都只会拿到"当前值"，等于没有校验）。

**R2 补充推论：** sessionId 可被不同 manager 实例共享（resume 同一 session 文件），故 sessionId 相等不能证明"同一实例"，manager 对象相等也不能证明"没有换过会话文件"；跨闭包的 epoch **数值**可以相同（各闭包独立从零起计），但 token 只在签发闭包内判定，**永不跨闭包共享、比较或拼装**。

---

## 2. `SchedulerRefreshOwner` 冻结定义与 capture-before-await 生命周期

```ts
type SchedulerRefreshOwner = { manager: object; sessionId: string; epoch: number };
```

- `manager`：execute 进入时 `ctx.sessionManager` 的对象快照（getter 取值那一刻的对象引用；无公开 setter，唯一变化路径是 runner 整体重建）。
- `sessionId`：进入时 `ctx.sessionManager.getSessionId()` 的**字符串快照**，不是函数引用、不在完成后再调用。
- `epoch`：**adapter 闭包本地**世代计数在进入时刻的值快照。闭包内现有节奏冻结为：`session_start` 包装进入即 `epoch += 1` 并 `expected = epoch`（adapter.ts:263），`session_shutdown` 包装进入即 `epoch += 1`（adapter.ts:260）。

**捕获与发布规则（逐条冻结）：**

1. **tool execute 进入时、`await` 原调用之前**捕获 owner 三字段（`manager`/`sessionId`/`epoch`），该 token 随 hooks 传递给 refresh hook。当前实现违反此点：`hooks.refresh?.(args[4])` 在 `await definition.execute(...)` **之后**才调用（adapter.ts:213），且 `refresh` 的默认参数 `expected = epoch` 在**事后**求值（adapter.ts:229）——两处都必须改为 pre-await 捕获。
2. **hook 只接收该 token**，禁止在原 execute 完成后重新取 ctx、重新调 `getSessionId()` 或重新读 epoch 拼新 token（"hook不能原execute完成后取新epoch"）。
3. **timer 固定 capture**：`beginPolling(owner, expected)` 在建立时固定 token（现实现 adapter.ts:238-243 已经是固定捕获，保留）；30 秒 tick 只用该 token 校验，不读当前值。保留 `clearTimer()` + 唯一 `setInterval` + `unref()` 与 `FOOTER_POLL_MS = 30_000`。
4. **completion 三字段全等才发布**：listing 完成后，token 的 manager（同一闭包内当前记录的 manager 对象）、sessionId、epoch 必须与 adapter 当前状态**三个字段全部相等**才允许写缓存与 publish；任一不等则丢弃结果，不发布、不写缓存、不报错打扰。
5. **shutdown 先失效**：`session_shutdown` 包装内顺序冻结为 `clearTimer() → epoch += 1 → publish(undefined) → sessionCtx/sessionCwd 清空`（adapter.ts:260 现状顺序保留）。epoch 先自增使所有在途 token 立即失效，再做清理；在途 listing 完成时按规则 4 丢弃。
6. **发布只经当前 ctx**：publish 沿用 `owner === sessionCtx && owner?.ui && typeof owner.ui.setStatus === "function"` 门（adapter.ts:228），即只有 token 判定通过且 `sessionCtx` 仍是同一对象时才触碰 `ctx.ui`；**不得**对过期 ctx 调 `.ui`（invalidate 后 getter 抛错）。status key 冻结为 `"pi-scheduler"`。
7. **manager reload 同 object；token 闭包私有**：`/reload` 时旧闭包收到 `session_shutdown` → 旧 epoch 失效；新闭包重新注册并 `session_start`。token 只在**签发它的闭包内**可判定，跨闭包一律不匹配——两个闭包的 epoch **数值**可以相同，但 token 不跨闭包共享、不跨闭包比较，闭包外任何代码（含 F4b source）不得用观察到的 manager/sessionId/epoch 自行拼装三字段（R2 修订后 source 根本接触不到 token，见 §7）。绝不允许用"manager 还是同一个对象"或"sessionId/epoch 数值相同"来豁免世代校验。
8. **listing 可用前不刷新**：`listing` 在上游于 `session_start` 内 `registerTool("scheduler_list", ...)` 时才被捕获（adapter.ts:247）；此前 refresh 按 `!listing` 短路（adapter.ts:230），initial 刷新语义保留（`await refresh(ctx, expected)` 后 `beginPolling`，adapter.ts:266-267）。

---

## 3. 现状缺陷冻结（F4a 要修什么，不许顺手删门禁）

- **fresh ctx 使 refresh 静默失效**：Pi 1.0.4 每次工具调用给全新 ctx（§1 行 1），adapter 以 `owner !== sessionCtx`（对象同一性）为门（adapter.ts:230），而 `sessionCtx` 是 session_start 事件的独立新 ctx —— 工具路径的 `hooks.refresh` **永远**早退。这与 `docs/architecture/task-scheduler-adapter-contract.md` "不能宣称正常工具调用后已经即时刷新"一致。修复 = 换 token 判别，**不是删掉世代门禁**。
- **post-await 捕获**：`expected = epoch` 默认参数在 await 后求值；若 create 调用期间发生 shutdown，事后取值会拿到**新** epoch，等于给过期结果放行（正是反例 C）。token 必须 pre-await。
- store 注入已撤回（`src/task-scheduler/store.ts` 不存在）；D1–D3 共享 store 问题停在 `docs/bugs/2026-10-13-scheduler-store-adapter.md`、`docs/bugs/2026-10-13-scheduler-store-concurrency.md`，本合同不触碰。

---

## 4. typed 记录冻结（F4g checklist 第 2 项）

### 4.1 status 联合类型

```ts
type SchedulerActivityStatus = "pending" | "success" | "error" | "running";
```

上游 list 摘要在任务尚无 `lastStatus` 时输出正常值 `pending`——**精确字面值 `'pending'`**，由上游在 list summary JSON 中 materialize（`tools.js:13` `lastStatus: task.lastStatus ?? 'pending'`；上游 `ScheduledTaskStatus = 'success' | 'error' | 'running'`，`index.d.ts`）。即 parsed summary 的 `lastStatus` 字段**恒存在**，`'pending'` 是上游自己的缺省 materialize，不是 adapter 发明；`enabled` 是独立 boolean，`/cron` 命令的 `formatTaskList` 会显示 `'disabled'` 文案（上游 extension.js），但工具 `scheduler_list` 的 summary JSON **不含**该文案。**pending 是正常数据（等待首次触发），不是坏 fixture、不是错误**；`running` 仅表示该次查询观察到投递中，不构成实时 runningTaskIds 保证；`success` 是 runner 投递结果，不证明业务成功；`enabled` 是计划启用，不代表模型正在执行。观察结果不做语义升级。

### 4.2 `SchedulerActivityRecord` 字段（R2：公开形状与原子计划统一；缓存只存元数据，永不存 prompt）

公开 record 采用原子计划（footer 计划 T4b 接口契约）的字段名；R1 版的 `taskId`/`status` 命名废止：

```ts
type SchedulerActivityRecord = Readonly<{
  id: string;                               // 上游 JSON 字段名即 id（tools.js:8），不重命名
  name?: string;
  type: "cron" | "once" | "interval";
  schedule: string;
  enabled: boolean;
  lastStatus?: SchedulerActivityStatus;      // 原子计划公开类型可选；parsed summary 恒带 materialize 值，adapter 恒填
  nextRunAt?: string;
  runCount: number;
}>;
```

来源字段与上游 `formatTaskSummary`（tools.js:6-17）一致，但**剔除 `prompt`**：list 摘要内嵌最长 100 字符 prompt 片段（`tools.js:16`），observer 不得把它带入缓存或任何持久位置。name/type/schedule 是不可信上游字符串，只作展示投影来源；ANSI/control 清理属 renderer-only（F4b/F5），**不得写回缓存或 raw**。

### 4.3 raw JSON 判别：三态必须分开

refresh 直接调用**上游原始** `listing.execute`（非模型侧包装结果）。解析前必须先做大小/text/details 安全校验及 secret 扫描（语义对齐现有 `scanPersistent`/1MiB 输入上限，adapter.ts:134-153）；F4a 落地时不得把 `boundedResult` 截断后的模型输出反解析。三态判别冻结为：

| 文本形态 | 判定 | 处理 |
| --- | --- | --- |
| `No scheduled tasks.`（上游空列表固定哨兵，tools.js:86；匹配沿用 adapter.ts:178 的 `/^No scheduled tasks\.?$/i`） | **正常空** | records 清空、availability 按正常观察处理，不是坏数据 |
| JSON.parse 失败 / 结构非数组 | **畸形** | 不当作空、不当作 pending；该次观察置 stale（保留上一次可用缓存供展示并标注过期）或 unavailable，如实上报 |
| 携带 `[scheduled-task upstream] truncated` 截断标记（adapter.ts:26,165） | **截断** | 只可能来自有界模型输出；observer 不消费该路径，若在 raw 输入中出现按畸形同级处理（stale/unavailable），绝不静默截半截 JSON |

metadata 超限或扫描异常 → stale 或 unavailable；**不允许把正常 pending 当异常，也不允许把异常当空列表**。

### 4.4 可用性语义（adapter 内部缓存形状）

```ts
// adapter 闭包内部缓存形状；公开 observer.snapshot() 形状见 §7（observedAt 转为 string）
type SchedulerCacheSnapshot = {
  availability: "available" | "stale" | "unavailable";
  observedAt: number;                    // listing 完成时刻的 clock 毫秒；从未观察为 0
  records: SchedulerActivityRecord[];
  errorLabel?: string;                   // 供原子计划 ActivitySnapshot.errorLabel 透传的诊断文案（不泄密，见 §9）
};
```

`available` 只表示**当前 adapter 闭包内 scheduler 实例的本次 list 观察成功**（上游实例是闭包局部、按 sessionId 派生 store 文件），**不保证共享 store 的跨 Host 最新状态**；不等待、不引入 store 修复。

### 4.5 内部→公开 mapper（R2：统一字段命名，禁止照抄冲突）

原子计划已锁定公开面（footer 计划 T4b 接口契约）：`SchedulerActivityRecord={id;…;lastStatus?}`、observer `snapshot():{availability;records;observedAt?:string;errorLabel?}`、协议 `ActivitySnapshot.observedAt?:string`。本合同 R1 的 `taskId`/`status`/`observedAt:number` 与其冲突，统一映射冻结如下（R1 命名仅作历史对照，新代码不得出现）：

| 内部（R1/缓存） | 公开（原子计划） | 映射规则 |
| --- | --- | --- |
| record `taskId` | record `id` | 上游 JSON 字段名即 `id`，1:1 透传不改名 |
| record `status`（恒有值） | record `lastStatus?` | 同值改名；`'pending'` 来自上游 materialize；公开类型可选但 adapter 恒填 |
| 缓存 `observedAt:number`（ms） | `observedAt?:string` | **唯一转换点**在 adapter 公开 `observer.snapshot()`：`new Date(ms).toISOString()`；0/从未观察 → `undefined` |
| 缓存 `errorLabel?` | `errorLabel?` | 透传（文案约束见 §9） |
| detail controlledOutcome（§7） | 原子计划 `detail(id):Promise<AgentToolResult<unknown>\|undefined>` | `ok:true → result`；`ok:false → undefined`，原因不得伪造为结果，经 errorLabel/诊断呈现 |

F4b renderer/行映射（消费公开 observer，**不做二次格式转换**）：

- `id` → `ActivityRow.key` = `scheduler:<id>`（kind + source 稳定 ID；扁平列表无 child index；**不按标题去重**）。
- `lastStatus` → `stateLabel` 按 footer 计划词表投影：`pending→等待触发`、`running→观察到投递中`、`error→上次投递失败`，正常计划行按「启用 scheduler 为 scheduled」呈现；`enabled=false` 且无投递状态只进详情（footer 计划布局规则）。**上游字段名 `lastStatus`/`enabled` 不得原样进入 rows 字段。**
- `availability` 同名直通 `ActivityAvailability`；`stale` 携带原 rows/observedAt，`unavailable` 空 rows。
- `observedAt` string 原样透传进 `ActivitySnapshot.observedAt`，F4b/renderer **不再转换或再格式化**。

---

## 5. 单飞（single-flight）、dirty flag 合并重跑与唯一 timer

**R2 修订（关键）：** R1 的"在途即丢弃不排队"不闭合——create/delete 触发时若有 flight 在途，在途 list 的快照已在调用时刻取得（见下"读取时机"），settle 后会发布变更前视图，且直到 30s timer 才再读，违反 create/delete 即时刷新目标。改为**同 epoch dirty flag + 一次合并重跑**：

1. adapter 闭包维护当前 epoch 的 `needsRefresh` 布尔脏标记。
2. mutator（`scheduler_create`/`scheduler_delete`）合法完成（pre-await token 三字段全等校验通过）时：置 `needsRefresh = true` 并请求刷新。
3. 无在途 flight → 立即开始一次 listing，**开始时清标记**（重跑期间又有 mutator 完成会再次置位）。
4. 有在途 flight → **不直接 drop**：保留标记；当前 flight settle（发布或丢弃）后，若**同 epoch** 且 `needsRefresh` 且 `listing` 存在 → 恰好**再读一次**（合并重跑），重跑开始时清标记。
5. 无新 timer、无 poll 循环：重跑只由实际 mutator 完成触发；同一 flight 期间多个 mutator 完成 → 幂等布尔标记 → **单次**合并重跑覆盖全部；标记只在真实事件置位，settle 后为 false 即停，**不形成无穷链**。
6. shutdown/epoch 失效：丢弃 `needsRefresh` 与在途结果（§2 规则 5 顺序），新 epoch 从干净状态开始；合并重跑跨 shutdown 一律不执行。
7. **source invalidate 不触发 listing**：F4b/registry 的 invalidate 只是"缓存已更新"的消费通知，不是刷新请求；禁止 source 驱动的 invalidate→listing→invalidate 无穷循环。刷新发起权只在：initial、30s timer、mutator 合法完成、（合并重跑）。

**在途原生 list Promise 的数据读取时机（源码事实，上游 stores.js）：**

- `JsonScheduledTaskStore` 首次 `list()` 惰性读 JSON 文件进内存 Map（`loaded` 标志，stores.js `load()`）；此后 `list`/`get` 读内存 Map，不再读文件。
- `list()` 的数组快照在其 `store.list` 续体执行时取得（已加载时 ≈ execute 调用时刻 + 一个微任务）；mutator 经 `writeTail` 串行（load → 变更 Map → save 文件，stores.js `updateState`）。
- 因此**完成晚于快照的 mutator 对在途结果不可见**——这是必须 dirty flag 重跑的源码依据；快照与 writeTail Map 变更交错的非确定性由规则 4 收敛：最后一次 mutation 之后至少还有一次读取，最终发布视图反映它。
- 任一时刻**至多一个在途 flight**：`refreshingEpoch` 门（adapter.ts:226,231,236）+ 合并重跑只在 settle 之后启动，不并发叠加。

- initial 刷新（session_start 包装内 `await refresh`）、30 秒 timer tick、mutator hook 触发的刷新，全部收敛到**同一 per-epoch 单飞**（含上述合并重跑）。
- 全进程唯一 timer：`clearTimer()` 后 `setInterval`，`unref()`，30 秒间隔不变；新 session_start / shutdown 都先 `clearTimer()`。

---

## 6. detail 受控 get 合同

- detail **只能**经 adapter 捕获的受控 `scheduler_get` 包装（即注册给 pi 的、带 `boundedResult` 安全包装的定义，adapter.ts:202-203 的 list/get 分支）发起，走既有模型侧安全门：非 text block 拒绝、`details !== undefined` 拒绝、1MiB 输入审计 + 扫描、50KiB/2000 行有界输出、固定不可信来源标记。**不直接读任务文件、不反解析有界输出、不绕过 safety。**
- **R2 修订：detail 入口由 adapter 闭包内部 capture token**——`detail(id)` 被调用时，adapter 在闭包内**当场一次性捕获**当前 `{manager, sessionId, epoch}`（外部无 capture API，source 永不接触 token），发起前与 `await` 返回后都做三字段全等校验；失败返回 `{ok:false, reason:"token-stale"}`，不发布内容。source 无法也无需自拼 token（含跨闭包拼装，见 §2 规则 7）。
- get 结果对外类型冻结为公开的 `AgentToolResult<unknown>`（SDK 类型，`extensions/types.d.ts:37,494`）；"Task not found: <id>" 等上游文本原样在 content 中呈现，observer 不二次解释。RPC/模型侧返回结构不变（F4a 验收项）。

---

## 7. observer 公开形状冻结（R2 修订；供 F4a/F4b 实现，不改语义地照抄）

**R2 修订要点：** R1 的 `fetchSchedulerDetail(owner, taskId)` 要求 source 持有 token 却无任何 capture API，属设计漏洞，废止。公开面改为单一 observer 对象；`SchedulerRefreshOwner` **仅存在于 adapter 闭包内部，不出现在任何公开导出**。

```ts
// —— 仅 adapter 闭包内部，永不导出 ——
type SchedulerRefreshOwner = { manager: object; sessionId: string; epoch: number };

// —— 公开 observer（F4a 在 src/task-scheduler/index.ts 导出；与原子计划 T4b 接口契约对齐）——
type SchedulerDetailOutcome =
  | { ok: true; result: AgentToolResult<unknown> }
  | { ok: false; reason: "token-stale" | "no-detail-tool" | "get-failed" };

type SchedulerActivityObserver = {
  snapshot(): {
    availability: "available" | "stale" | "unavailable";
    records: readonly SchedulerActivityRecord[];   // §4.2 公开形状（id/lastStatus…）
    observedAt?: string;                            // §4.5 唯一转换点：内部 ms → ISO string
    errorLabel?: string;
  };
  subscribe(listener: () => void): () => void;
  detail(id: string): Promise<SchedulerDetailOutcome>;
};

// —— F4b 消费面（统一计划 F4b / 原子计划 T4b 一致）——
function createSchedulerActivitySource(observer: SchedulerActivityObserver): ActivitySource;
```

**subscribe(listener): unsubscribe 精确语义（R2 补）：**

- listener 在**每次 publish 落地**后同步调用（成功发布、records/availability 变化或确认、清空、stale/unavailable 转换）；单飞丢弃与合并重跑等待期**不**通知。
- **异常隔离**：每个 listener 调用包裹独立 try/catch；单个 listener 抛错被吞并计入 diagnostic 计数，不影响其他 listener、不影响 refresh/publish 生命周期。F4b 将 listener 映射为协议 `ActivitySource.subscribe(invalidate)` 的 invalidate 回调，invalidate 抛错因此不会破坏刷新。
- 返回 unsubscribe：幂等，重复调用安全；adapter 闭包失效（shutdown/新 epoch 清场）后调用仍是安全 no-op。
- **失效清场**：session_shutdown / 新 session_start 清空全部 listener；旧闭包的 unsubscribe 不能影响新闭包的 listener 集合。
- listener 只是缓存更新通知，**不得**被实现为刷新请求（§5 规则 7：source invalidate 不触发 listing）。

**detail(id) 精确语义：** adapter 闭包内部当场 capture 当前 token（一次性，§6 R2 条），发起前与返回后三字段全等校验；`no-detail-tool` = 受控 get 包装未被捕获（session 未建立/上游未注册）；`get-failed` = 包装执行抛错；结果不缓存、不发布，仅供当次 detail 请求消费。

**token 产生点冻结（全部在 adapter 闭包内）：** `session_start` 建立当前 `{manager, sessionId, epoch}` 并随 timer 固定；工具 hook 使用 pre-await 捕获的 token；detail 请求时 adapter 内部一次性捕获再校验。**没有任何对外 capture API；source 及闭包外任何代码无法观察、持有或拼装 token。**

---

## 8. 可验证正反例（F4a 单测断言对象，此处为静态可核查依据）

| 用例 | 依据 | 期望 |
| --- | --- | --- |
| **正例 A：fresh ctx 刷新放行** | 同一 session 内、无 shutdown；SDK 对每次工具调用新建 ctx（wrapper.js:13 → runner.js:696/613）；pre-await 捕获的 `{manager, sessionId, epoch}` 与 adapter 当前值全等 | create/delete 完成后 hook 携带 token 通过校验 → listing 单飞刷新并发布 |
| **正例 B：同 session reload 后 manager 同 object，旧 token 仍拒绝** | `AgentSession.reload()`（agent-session.js:2932-2936）→ 旧闭包 `session_shutdown`（epoch+1、清缓存）→ 新 runner 携带**同一** SessionManager（2917/177）→ 新闭包 `session_start` | 旧闭包任何在途结果按三字段校验丢弃；新闭包只认自己的 epoch。禁止用 manager/sessionId 相同而放行 |
| **反例 C：late 完成取新 epoch 被禁** | 现状 `refresh(owner)` 默认 `expected = epoch` 在 await 后求值（adapter.ts:229）；create 期间 shutdown 会使事后取值得到新 epoch | 修复后 hook 只用 pre-await token；shutdown 期间完成的刷新不发布、不写缓存 |
| **反例 D：不同 session** | newSession/fork/switch = AgentSession 替换，旧 runner invalidate（agent-session.js:999），旧 ctx getter 抛错；新 session 新 manager/新 sessionId | 旧 token 的 manager/sessionId 不匹配 → 丢弃；任何路径不得触碰过期 ctx 的 `.ui` |
| **反例 E：畸形 JSON ≠ 空列表** | 上游空列表固定返回**精确文本** `'No scheduled tasks.'`（tools.js:86）；JSON.parse 失败是另一形态 | 空哨兵 → 清空 records；畸形/截断 → stale/unavailable，两者不得合并 |
| **正例 F：在途 flight 期间 mutator 完成 → 合并重跑（R2 补）** | §5 dirty flag 机制；在途 list 快照读取时机见 §5 源码事实（stores.js） | create/delete 触发时不直接 drop：settle 后同 epoch 恰好一次重读并发布变更后视图，30s timer 之前收敛；多次 mutator 合并为单次重跑 |
| **反例 G：不同 manager 实例 resume 同 sessionId（R2 补）** | §1：`_loadEntries` 从 header 恢复 `this.sessionId = header.id`，不同实例可同 ID | token 的 manager 对象不同 → 丢弃；sessionId 相同**不豁免** manager/epoch 校验 |
| **反例 H：跨闭包 epoch 数值相同（R2 补）** | §2 规则 7：epoch 是闭包本地计数，数值可跨闭包重合 | 旧闭包 token 永不进新闭包判定；source 无 capture API，也不能自拼三字段 |

**无 store 改造声明：** 不注入 `config.store/lock/scheduler`（upstream `extension.d.ts` 的注入面维持现状，仅 dataDir getter，adapter.ts:250-253），不改 `stores.js`，不读写任务 JSON 文件，不做 D1–D3。满足验收标准 3"无 store 改造"。

---

## 9. 诊断与安全边界

- `diagnostic()`（adapter.ts 环形 25 条）新增文案只允许类别/计数/工具名，**不得**包含 prompt、任务名、store 内容或任何可能携带 secret 的上游文本片段。
- secret 扫描沿用 `scanPersistent` 语义（adapter.ts:134-138：invisible Unicode、注入句式、私钥/API key 形态）；扫描与解析的顺序冻结：**先审计后解析**（对齐 boundedResult 的 input audit，adapter.ts:145-148）。
- 本文与 F4a/F4b 的实现都不改变：四工具门禁、create/delete 免确认与结果透传、`sendUserMessage` 固定路由提示、session-owner 前置边界（`docs/architecture/task-scheduler-adapter-contract.md`）。

## 10. 范围外（明确不做）

不读 settings/models/auth/真实任务数据；无 Host/网络/通知/kill/TDD；不 commit/reset/stash；不做共享 store 修复；不扩展上游 facade（`scheduler_update`/`scheduler_run_now`/`/cron` 继续拦截）。

**关于 blocked 结论的准确表述（R2）：** §1 的源码事实核对（fresh ctx、identity getter、reload 同 object、单飞现状、status/空哨兵精确字面值、store 读取时机）经现场读取成立，此前"无 blocked-upstream"结论**仅覆盖这些源码事实**；本合同 R1 的 observer/detail API 形状未经先前验证、且与原子计划存在命名冲突与设计漏洞，已在 R2 修订闭合（§4.5/§5/§6/§7）。F4a 尚未派发（F1 仍在运行），本记录为其前置 gate。
