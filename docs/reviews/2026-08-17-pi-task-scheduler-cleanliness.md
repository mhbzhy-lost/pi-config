# `@amaster.ai/pi-task-scheduler@0.1.9` 只读安全与架构审查

- 审查日期：2026-08-17
- 宿主基线：Pi 0.84.2；`PI_CODING_AGENT_DIR=<repo>/pi`
- 审查对象：npm registry 的精确 tarball `@amaster.ai/pi-task-scheduler@0.1.9`、`@amaster.ai/pi-shared@0.1.9`，以及调度器声明的另一运行时依赖 `croner@10.0.1`
- 方法：`npm pack --ignore-scripts` 下载后解包，逐个审查实际发布的运行时 JS、声明、manifest、source map 元数据和归档成员；未执行第三方扩展或第三方测试
- 审查结论：**阻断直接加载上游 extension；唯一推荐是禁用上游资源、精确锁定依赖，由项目自有的同进程 adapter/membrane 注册受控能力。当前不需要 pi-subagents 式进程/RPC 隔离。**

## 1. 决策摘要

- **[接入形态]**：上游代码不应直接取得工具注册、配置读取和调度执行权。
- **推荐**：同进程项目自有 adapter，因为实际可达代码没有网络、子进程或动态执行，薄膜即可约束能力且仍经过宿主 `tool_call` 门禁。
- **不选原因**：直接加载缺少确认、授权与可靠存储；普通子进程/RPC 又不是操作系统沙箱，会增加生命周期和门禁透传复杂度。
- **选错代价**：无人值守 prompt 触发写操作、重复执行或状态丢失时暴露，修复代价高。

- **[上线条件]**：0.1.9 只能作为被固定、被包裹的库，不能按其 `pi.extensions` manifest 自注册。
- **推荐**：先完成本文 Must fix，再启用 adapter，因为现有 `run_now`、锁和完成状态语义会给出错误安全信号。
- **不选原因**：仅依赖现有 security-gates 无法补足 prompt 授权、调度器内部写入与 `/cron` 命令路径。
- **选错代价**：任务被误报成功、静默漏跑或多次派发时暴露，修复代价高。

## 2. 精确制品与 import 边界

### 2.1 Tarball 证据

| 制品 | 实际归档成员 | SHA-512（十六进制） | 结论 |
|---|---:|---|---|
| `@amaster.ai/pi-task-scheduler@0.1.9` | 24 | `35023f0dfef10d5cd390afd9a3718d2a0beb059b1df4c85813e2bd81f0d6b3d0d1f834ab063a5e515db087f4f86c3a210de3f3684fcbdf52dbd45918c87dab6b` | manifest、5 个运行时 JS、声明和 map 均已审查；无安装脚本 |
| `@amaster.ai/pi-shared@0.1.9` | 30 | `5f247ad3b504f0e4b99350945472dfaa5599cef8dd45d659dcb1e450ef8b894bb729f1be3cac27619232154c57032e122db4ae7aa562455aae4faddd3048cb5e` | 4 个运行时 JS 与误带入 tarball 的编译测试均已区分；无安装脚本 |
| `croner@10.0.1` | 8 | `8b136d0099ddaa1d7bdd54382a8752749108ea7ba2a01588d15d484cd2a1659b0ed2910ca03c73e77f53e054d36d267fc48392b839f3c4b551a81552bcf344da` | 无依赖、无安装脚本；运行时是日期解析和 timer 调度 |

三个归档均只有普通文件/目录，没有绝对路径、`..` 路径、符号链接或设备成员。scheduler 的 1.6 MB `preview.png` 和 manifest 中的远程 gallery 图片地址不被运行时 import；它们不是 extension 的网络请求来源。source map 只列源路径，没有内嵌 `sourcesContent`，因此结论以实际发布 JS 为准。

scheduler 的 manifest 精确固定 `@amaster.ai/pi-shared: 0.1.9`，但声明 `croner: ^10.0.1`。本次额外审查的是当前精确 `croner@10.0.1`；**未来重新安装时该范围可漂移到其他 10.x，不能把本次结论自动外推到未来解析结果。**

### 2.2 实际 import 图

```text
Pi package manifest ./dist/index.js
  ├─ node:crypto
  ├─ croner
  ├─ ./extension.js
  │    └─ @amaster.ai/pi-shared/settings
  ├─ ./stores.js
  ├─ ./json-file.js
  └─ ./tools.js
```

- scheduler **只 import** `@amaster.ai/pi-shared/settings` 子路径。该子路径由 exports 直接映射到 `dist/settings.js`，不会先执行 `pi-shared/dist/index.js`。
- `pi-shared/dist/network.js` 虽有 DNS、HTTP/HTTPS request 和 `safeFetch`，但 scheduler 不 import 它，是本接入路径的死代码。
- `pi-shared/dist/threat-patterns.js` 也是死代码；这同时意味着 scheduler **没有使用**其中的 prompt injection、隐形 Unicode、敏感信息扫描。
- `pi-shared/dist/index.js` 只 re-export network；编译测试依赖 vitest、部分还动态 import 未发布的 `src`，但它们不在任何 Pi resource manifest 中，也不会被 scheduler 加载。
- `pi-shared` 声明文件中的 `'mcp'` 只是类型字符串，不存在 MCP client/server、transport 或运行时 import。

## 3. 高风险能力盘点

| 能力 | scheduler 实际可达代码 | `pi-shared` 未被 scheduler import 的代码 | 判断 |
|---|---|---|---|
| 第三方网络请求 | 无 `fetch`、HTTP、socket、DNS | `network.js` 可发 HTTP(S)，本路径不加载 | scheduler 运行时无网络 |
| shell / 子进程 | 无 `child_process`、`pi.exec`、spawn/exec | 无 | 无 |
| MCP | 无 | 仅声明类型字符串 | 无 |
| 动态代码执行 | 无 `eval`、`Function`、`vm`、动态运行时 import | 测试有动态 import，但测试不加载 | 无 |
| 凭据文件读取 | 不读 `.env`、`auth.json`、cookie、token 文件 | 无凭据读取器 | 无直接凭据读取 |
| 设置与环境变量 | 调用 live 的 `loadPiSettings`、`resolveHome` | — | 有受配置选择的环境变量读取 |
| 文件读写 | 读写 task JSON、backup、PID lock；路径由 `dataDir` 决定 | `loadJsonProfileDir` 等函数同模块定义但 scheduler 不调用 | 有任意目录落点风险 |
| Agent 执行 | `pi.sendUserMessage(task.prompt)` | — | 仅注入 prompt，不自己执行 shell/网络 |

### 3.1 设置读取与路径边界

`pi-shared/dist/settings.js:resolveHome/loadPiSettings/readSettingsSection` 的 live 行为是：

1. 固定尝试读取 `~/.pi/agent/settings.json`、`PI_CODING_AGENT_DIR/settings.json`；项目受信任时再读 `<cwd>/.pi/settings.json`。
2. 只取键 `pi-scheduler`，但 global 与 agentDir 层会递归展开 `${NAME}`、`${NAME:-fallback}` 和裸 `$NAME`，可按配置中写出的名称读取任意 `process.env[NAME]`。
3. 受信任项目层不展开环境变量，却仍可把 `dataDir` 设为绝对路径、相对路径或仓库内路径。
4. `resolveConfig` 没有 realpath、根目录约束、符号链接检查或 Git tracked/ignored 检查。`path.join(dataDir, 固定文件名)` 因而可在配置指定的任意目录读写。

它不会枚举环境变量，也不会主动打开 auth/secret 文件；风险来自设置显式引用环境变量，或把 `dataDir` 指向不应访问的目录。`loadSettings` 将所有读取/解析错误吞掉并回退默认值，因此安全配置损坏时是静默 fail-open。

## 4. 注册面、确认、授权和输出

### 4.1 工具与命令

上游 factory 立即注册 `/cron`；在 `session_start` 内初始化 scheduler 后动态注册六个 LLM 工具：

| 名称 | 类别 | 实际副作用 |
|---|---|---|
| `scheduler_list` | 读 | 读取当前 session 的全部任务并把摘要送回模型 |
| `scheduler_get` | 读 | 返回完整任务，包括完整 prompt、历史和错误 |
| `scheduler_create` | 写 | 创建并持久化任务，active 时装 timer/cron |
| `scheduler_update` | 写 | 可改 prompt、schedule、名称、描述、enabled |
| `scheduler_delete` | 删除 | 删除 task；旧 prompt 仍可能暂留 `.bak` |
| `scheduler_run_now` | 执行 | fire-and-forget 调用 `execute`，立即返回“Triggered” |

`/cron` 子命令：`status/list/get` 是读；`enable/disable` 是 update；`delete` 是删除；`run` 是立即执行。命令没有 create 或一般 update。命令 handler 不是 LLM tool execution，不产生可供现有 `security-gates` 阻断的 `tool_call`。

### 4.2 缺失的安全控制

- **真实用户确认：没有。** 全包没有 `ctx.ui.confirm`。所有写、删、run-now 和未来自动运行均无需用户在执行参数上确认。
- **授权绑定：没有。** `sessionId` scope 与 runner 的 session 相等检查只是数据隔离，不是用户授权；没有 prompt hash、schedule、workspace、工具集、有效期或批准主体的绑定，也没有状态完整性校验。
- **参数上限：基本没有。** prompt/name/description 无长度上限，任务数无上限，run-now 无速率上限，不同任务无全局并发上限。interval 最低 5 秒但无最高值；once 无最大 horizon；`timeoutMs` 无 schema 上限且运行时完全忽略。
- **timer 溢出：存在。** once/interval 直接把毫秒数传给原生 `setTimeout/setInterval`（`dist/index.js:schedule`）。超过 Node 32 位 timer 范围的值会被缩短到极小延迟，长周期可能意外立即/高频触发。
- **输出截断：不完整。** list 仅把每条 prompt 截到 100 字符，却不限制任务条数或总字节；get 返回完整 prompt 和历史；`/cron get/list` 也无总量限制。没有采用 Pi 官方 50 KB/2000 行上限。
- **prompt 来源标记：没有。** 持久化 prompt 既会作为 get 的普通 tool result 回流模型，也会作为普通 user message 再注入；没有“不可信的持久化调度内容”标签、转义、扫描或调用关联 ID。
- **错误信号：不可靠。** create/update 的部分失败被包装成普通 text result，而不是 throw；按 Pi 官方语义这不会设置 `isError: true`。

并行的两个 `run_now` 还可能绕过 `runningTaskIds`：`execute` 在第一次 `await store.get(...)` **之前**检查 Set，两个调用可同时通过检查，恢复后各自派发同一 prompt，单进程也可能重复执行。

## 5. 状态存储与并发语义

### 5.1 位置和内容

默认文件为：

```text
<resolveHome()/data>/tasks-<sha256(sessionId)>.json
<resolveHome()/data>/tasks-<sha256(sessionId)>.json.bak
<resolveHome()/data>/scheduler-<sha256(sessionId)>.lock
```

状态以明文保存 prompt、名称、描述、sessionId、模型元数据、`toolPolicyProfile`、时间、run history 和错误。若新 session 文件不存在，还会从同目录旧 `tasks.json` 按 sessionId 迁移，但不删除旧文件。

当前 `scripts/pi-shell.zsh` 设置 `PI_CODING_AGENT_DIR`、session/goal 目录，却不设置 `PI_AGENT_HOME`；repo 的 `pi/settings.json` 也没有 `pi-scheduler`。所以在**没有未审查的 user-global override**时，`resolveHome()` 走 `~/.pi/agent`，默认不写 Git 工作区。可是 global/agent/project settings 均可改变 `dataDir`，受信任项目可以直接指定 repo 内路径，因此上游无法保证 prompt 不落进 Git 工作区。本文遵守边界，未读取 user-global settings。

### 5.2 权限、原子性和恢复

- `mkdir`、`writeFile`、`copyFile`、lock `writeFileSync` 都没显式 mode/chmod，完全依赖进程 umask；不能保证目录 `0700`、文件 `0600`。
- 单次主文件写使用同目录随机 temp + rename，单文件替换通常原子；写前 copy 当前主文件到 `.bak`，JSON 语法损坏时回退 backup。
- 没有 fsync 文件/目录；backup 更新本身没有事务；合法 JSON 但错误 shape 不会回退。删除后的敏感 prompt 会至少在 backup 中保留到后续写。
- `JsonScheduledTaskStore.writeTail` 只串行化**同一 JS store 实例**的写；store 首次 load 后永久缓存 Map，不观察外部进程的更新。
- 崩溃时 temp 会残留；代码仅在当前 write catch 时清理自己的 temp，没有启动清扫与保留策略。

### 5.3 锁与多实例

`FileSchedulerLock` 不是可靠互斥锁：

1. `acquire` 先做 PID 存活检查，随后**无条件 unlink lock**，再用 `wx` 创建。两个进程若都先完成检查，后者可删掉前者刚创建的 lock，二者都认为自己持锁。
2. 同一 PID 的第二个实例被明确允许继续，并会删掉第一个实例的 lock；因此同进程多 scheduler 也不互斥。
3. lock 只有 PID，没有随机 owner token、进程启动时间或 fencing generation；PID 重用会把无关进程误认成 holder。
4. 默认 `FileSchedulerLock` 没有 `extend`，所以 `startLockHeartbeat` 根本不会启动；inactive 实例也不轮询重试取得 lock。
5. lock 只决定 timer owner，不包围 store 的每次读改写。未持锁的 inactive 实例仍暴露全部 CRUD/run-now 工具。

| 场景 | 实际语义 |
|---|---|
| 同 store 实例内 | `writeTail` 串行 JSON 保存；同 task 的 `run_now` 仍有 await 前竞态 |
| 同 session、不同 Pi 进程 | 理想情况下一个 active；但 lock 获取有竞态，且 inactive 仍可覆盖全量 JSON |
| 同 session、同 PID 多实例 | lock 明确不能互斥，可能重复装 timer |
| 不同 session | hash 后的 task/lock 文件不同，默认相互隔离 |
| 多 Pi 实例、不同 session | 默认文件不同；若自定义 store/dataDir 或外部篡改，仍无强边界 |

两个 store 各自缓存全量 Map，后写者会覆盖另一进程新增、更新、run history 或删除，产生任务遗失和状态回退。反过来，双 active timer 或并行 run-now 会重复派发 prompt。

### 5.4 崩溃、missed run 与完成状态

- `execute` 先把任务写成 `running`，再调用 runner。重启时所有遗留 `running` 被改成 `error: Process was interrupted...`，**不会自动重放**。
- 若崩溃发生在“持久化 running 后、发送 prompt 前”，该次运行遗失；若发生在“发送后、持久化 success 前”，Agent 可能已执行但记录为 interrupted，人工重试又可能重复。
- 进程离线期间，cron/interval 不补跑；interval 从重启时重新计时；已过期 once 被标记 schedule error 并禁用。没有 durable occurrence queue 或明确 catch-up policy。
- 相同 task 正在 scheduler 内执行时，新 tick 被直接丢弃；不同 task 可无界并发。
- timer 均 `unref`，任务只在该 Pi 进程及该 session runtime 存活时有机会触发；它不是独立常驻调度服务。

最关键的是 runner：

```js
const runner = async (task) => {
  if (ctx.sessionManager.getSessionId() !== task.sessionId) throw ...;
  pi.sendUserMessage(task.prompt);
};
```

Pi 0.84.2 的 `ExtensionAPI.sendUserMessage` 返回 `void`。所以外层 `await runner(...)` 只等到 message 被同步提交，随后立即写 `lastStatus: success`、`Run completed`；**完全不等待 Agent 开始、工具执行、重试、compaction 或 `agent_settled`**。Agent 忙时又未传 `deliverAs`，按官方语义会报错。`runNow` 自身还 fire-and-forget：inactive、disabled、Set 命中或后续执行失败时，仍可返回 task 并显示 “Triggered”。

## 6. 调度执行与现有项目门禁

### 6.1 实际只发送 prompt

上游 standalone extension 不创建新 Agent、不选择模型、不切 cwd、不加载 MCP、不调用 shell。它在当前 session 中执行 `pi.sendUserMessage(task.prompt)`，且未启用 `expandPromptTemplates`；因此 prompt 文本本身不会直接按 `/command`、skill 或 template 展开。

`model`、`workspaceDir`、`timeoutMs`、`toolPolicyProfile` 只是持久化字段。`scheduler_create` 总写入 `toolPolicyProfile: 'workspace-write'`，但 runner 完全不读取该字段；也不使用保存的 model/provider。**`workspace-write` 没有任何实际执行效果，既不是 allowlist，也不是 sandbox。**

### 6.2 不会机械绕过，但不能当作授权

- scheduled prompt 仍进入当前 Pi agent pipeline；之后的 LLM tool call 仍会触发 `scripts/lib/security-gates-extension.mjs` 的 `tool_call`，敏感路径与 bash policy 继续生效，`tool_result` 的 coding/TDD reminder 也仍可追加。
- AGENTS/TDD/subagent 指令仍在宿主上下文中，上游没有代码主动删除它们。
- 但是现有 security-gates 只检查敏感路径、bash、push review，并不扫描 scheduler prompt、不批准 scheduler CRUD、不限制 scheduled turn 的工具集，也不证明用户授权。`/cron` handler 内部副作用更不会经过 `tool_call`。
- 持久化内容可能被同用户进程、并发丢写或不安全 dataDir 篡改，再以“用户消息”身份注入。仅靠模型遵循 AGENTS/TDD/subagent 指令不是可靠的延迟执行授权边界。

因此结论是：它**不直接绕开现有工具门禁**，却建立了“无当次用户确认即可触发完整当前工具集”的新入口；这在现有项目中仍是 blocker。

## 7. 异常处理：fail-open / fail-closed

| 路径 | 实际行为 | 判断 |
|---|---|---|
| settings 读取/JSON 错误 | 全部 catch，静默使用默认 config | fail-open 配置 |
| session_start 一般异常 | catch 后只显示 `scheduler: unavailable`；不注册六工具，但 factory 级 `/cron` 仍存在 | 大体 fail-closed，但不可诊断 |
| lock 未取得 | `start()` 正常返回；仍注册六工具并显示 idle | fail-open 能力暴露 |
| inactive/disabled `run_now` | 返回 task、“Triggered”；`execute` 静默不做 | 错误成功信号 |
| create/update 校验失败 | 普通 text result，不是 tool error | fail-open 信号 |
| runner 抛错 | 写 error 和 history | 局部 fail-closed |
| runner 返回 | 立即写 success，不等 Agent | fail-open 完成判定 |
| hook 抛错 | 全吞，scheduler 继续 | 可接受的业务连续性，但审计 fail-open |
| `void execute/refreshNextRun/markScheduleError` 的前置 store 错误 | 部分发生在内部 try 之外，可形成未处理 rejection | 不可靠 |
| missed run | 不补跑、不形成逐 occurrence 审计 | 静默丢失/弱可见 |

## 8. 三种接入方式比较与唯一推荐

| 方案 | 结论 | 原因 |
|---|---|---|
| settings 直接加载 `./dist/index.js` | **拒绝** | 第三方 extension 以完整进程权限自注册命令/工具；缺确认、授权、上限、可靠锁和真实完成状态 |
| settings 禁用上游 resources + 项目自有同进程 adapter | **唯一推荐** | 可复用已审查的纯调度算法，同时把路径、存储、确认、tool policy、审计和生命周期收回项目 |
| pi-subagents 式进程/RPC 隔离 | **当前不选** | 实际可达代码无网络/子进程/动态执行；普通同权限子进程不是安全沙箱，还会让宿主 tool_call 门禁、Agent 完成关联和 session 生命周期更难正确透传 |

Pi 官方 packages 文档明确说明 package 以完整系统权限执行，也明确对象过滤中 `extensions: []` 表示不加载该类资源。推荐的 package/adapter 布局应让**项目自有 adapter package 声明精确依赖**，只加载 adapter 自己；不能依赖不同 Pi package module root 之间的偶然解析。上游 package 的 extensions/skills/prompts/themes 均应显式为空。

同进程 adapter 不是对恶意依赖的沙箱：只有在 scheduler/shared/croner 的版本、完整性和解析结果都精确锁定，并在每次升级重新审查时才成立。若未来版本新增 shell、网络、动态执行、独立 Agent 或原生模块，应重新评估带操作系统沙箱的进程隔离；单纯 RPC 不够。

## 9. Adapter 最小安全边界（不含实现）

### 9.1 加载与工具面

1. settings 对上游 package 显式设置 `extensions/skills/prompts/themes: []`；不加载上游 `/cron` 和 `createSchedulerTools`。
2. adapter 仅注册 `scheduler_list`、`scheduler_get`、`scheduler_create`、`scheduler_update`、`scheduler_delete`、`scheduler_run_now`。前两者为只读；后四者统一走同一授权与审计路径。
3. 不注册上游 `/cron`。如保留人工命令，仅允许 status/list/get；所有写、删、立即运行必须复用与工具完全相同的 confirm/authorization 函数，不能另开捷径。
4. `get/list` 默认不回显完整 prompt，只显示 hash、长度和受限预览；总输出强制不超过 Pi 官方 50 KB/2000 行，并限制条数。

### 9.2 UI confirm 与授权绑定

- TUI/RPC 中 create、任何 update、delete、run-now 均调用 `ctx.ui.confirm`；对话框显示归一化 schedule、prompt 安全预览/hash、session、workspace、工具 policy、过期时间与运行次数上限。
- confirm 结果绑定到**精确的** task ID、prompt SHA-256、schedule、sessionId、canonical workspace、model/policy、有效期和授权版本；任一字段变化即使旧授权失效。
- 自动触发依赖已持久化的该授权，不把“曾创建 task”视为无限授权。每个 occurrence 有唯一 ID；立即运行需要新的单次确认。
- `ctx.hasUI === false` 的 JSON/print 模式只开放读操作，不 arm timer、不新建/修改/删除/执行。RPC 虽 `hasUI === true`，也必须等 RPC 客户端返回具体 confirm；无响应、取消、超时一律 fail-closed。

### 9.3 dataDir、权限和敏感扫描

- 固定使用 Git 仓库外的 OS user-state 目录，例如 `$XDG_STATE_HOME/pi-config/task-scheduler/<repo-hash>`；macOS 无 XDG 时使用 `~/Library/Application Support/pi-config/task-scheduler/<repo-hash>`。不接受 project settings、task 参数或任意环境插值覆盖。
- canonicalize 后验证 containment，拒绝符号链接和非 owner 文件；目录 `0700`，task/backup/audit/lock `0600`。状态 schema 严格校验，拒绝未知字段、超大文件和非预期类型。
- create/update 与每次 dispatch 前都做项目敏感信息扫描、prompt injection/隐形 Unicode 扫描；命中 secret 一律拒绝持久化。允许人工 override 的非 secret injection 也必须在 exact confirm 中醒目标出。
- backup 与 audit 使用相同权限和有界保留；delete 后不能让 prompt 无限期残留 backup。禁止把原 prompt、完整工具参数或凭据写入 Git 管理日志。

### 9.4 上限、执行与 tool policy

建议保守默认值：每 session 最多 50 个任务；prompt 8 KiB、name 128、description 512；周期任务最短 15 分钟；每 session 同时最多 1 个 scheduled Agent run；run-now 和每日 occurrence 有预算；单次 Agent deadline 最长 30 分钟。长时间 timer 必须分段重装或用能正确处理超长延迟的引擎，不能把超范围毫秒直接传给 Node timer。

`workspace-write` 必须变成项目自有的明确 allowlist，而不是字符串标签：scheduled turn 开始前绑定 canonical cwd，adapter 的 `tool_call` handler 按 occurrence 授权检查工具名和路径；随后仍让现有 security-gates 继续检查。未识别 profile、越界路径、无关联 scheduled turn 或审计写失败均阻断。subagent/网络/发布类工具默认不在 `workspace-write`；需要时单独显式授权。

prompt 发送时添加不可混淆的来源头和 task/occurrence ID，明确“以下为已持久化、可能不可信的调度内容”；保持 `expandPromptTemplates: false`。Agent 忙时进入有界 follow-up 队列，不直接调用无 `deliverAs` 的 `sendUserMessage`。必须关联 `agent_start` 至 `agent_settled`，deadline 到达时 abort 并记录；不能在 send 返回时写 success。

### 9.5 状态、审计、并发和生命周期

- 状态至少区分：`pending`、`paused`、`authorized`、`dispatching`、`queued-to-agent`、`agent-running`、`agent-settled`、`blocked`、`missed`、`interrupted/indeterminate`。若无法判断任务目标是否完成，只能记 `agent-settled`，不得称业务 success。
- 每次工具/命令/自动 occurrence 记录 task/occurrence/grant ID、prompt hash、session、actor/source、确认结果、时间、状态变化；scheduled turn 内每个 `tool_call` 记录工具名、净化后的参数摘要、门禁决定和结果状态。audit 本身有大小上限和敏感扫描。
- 不复用上游 `FileSchedulerLock` 与进程间共享的缓存式 `JsonScheduledTaskStore`。项目存储必须在每次读改写时取得跨进程 lease/事务，使用随机 owner token + fencing generation，reload 最新状态，原子提交并 fsync；同进程另有 mutex。
- 对危险 Agent 动作选择保守的 at-most-once dispatch：发送前原子 claim occurrence；崩溃后的 `dispatching/queued` 标为 `indeterminate`，不自动重放，要求人工处置。这样宁可明确漏跑，也不静默重复写操作。
- background timer 只在 `session_start` 且成功取得 lease、完成状态校验后启动；`session_shutdown` 幂等停止 timer、停止接单、等待/标记 in-flight、释放 lease、清 UI 状态。reload/new/resume/fork 使用新 runtime，不复用旧 ctx；不同 session 不自动迁移任务。
- lock 不可用、状态损坏、审计不可写或 scheduler inactive 时，写/删/run 工具必须明确 throw；不能注册后假装 “Triggered”。

## 10. 分级清单

### Must fix（接入前阻断）

1. 禁止直接加载上游 extension；用同进程项目 adapter 独占注册面，并显式过滤上游全部 resources。
2. 为 create/update/delete/run-now 和自动 occurrence 建立真实 UI confirm、精确授权绑定、无 UI fail-closed、prompt 来源标记和敏感/injection 扫描。
3. 替换上游 PID lock 与缓存式多进程 JSON store；建立每次 RMW 的事务/lease、fencing、严格权限、仓库外 dataDir 和崩溃后的 `indeterminate` 语义。
4. 修复单进程 run-now 竞态、inactive 仍暴露能力、disabled/inactive false “Triggered”、missed-run 可见性和 Agent 未 settled 就记 success。
5. 增加任务/文本/频率/并发/预算/输出上限，处理 Node 长 timer 溢出；实际执行 timeout。
6. 让 `workspace-write` 成为 scheduled turn 的实际 `tool_call` allowlist，并与现有 security-gates 叠加；否则删除这个误导字段。

### Should fix

1. 在 adapter 的 lock/override 中把 scheduler、shared、croner 和 integrity 全部精确固定；上游 `^10.0.1` 不能直接进入可重复安装链。
2. 错误通过 throw / `isError` 语义返回；初始化、hook、异步 timer/store 异常写入受限审计，不再全吞。
3. 严格校验合法 JSON 的 schema，限制/淘汰 legacy `tasks.json`，控制 backup/temp 的清理和保留。
4. 对工具 schema 使用 Pi 官方建议的 Google-compatible enum 表达；上游 `Type.Union(Type.Literal(...))` 可移植性较弱。
5. 保存的 model/workspace/timeout 等元数据要么真正绑定并执行，要么从 API/状态中移除，避免虚假承诺。

### Acceptable

1. 精确 0.1.9 的实际 scheduler 可达代码没有网络、shell/子进程、MCP、动态代码执行或直接凭据文件读取。
2. `pi-shared/network`、`threat-patterns` 和 tarball 编译测试未被 scheduler import；死代码没有被误判成当前运行能力。
3. sessionId hash 文件名、session scope 检查、随机 UUID、单实例 `writeTail`、temp+rename 和语法损坏 backup 回退是有益基础，但不足以构成并发/授权边界。
4. background 资源从 `session_start` 启动并在 `session_shutdown` 停止、timer `unref`，方向符合 Pi 官方 lifecycle；具体错误与 in-flight 语义仍须 adapter 修正。
5. 下游 LLM 工具调用仍经过宿主 `tool_call`，现有敏感路径和 shell 门禁不会因 `sendUserMessage` 自动消失。

## 11. 文件与符号证据

| 证据 | 说明 |
|---|---|
| scheduler `package/package.json` | `pi.extensions: ./dist/index.js`；shared 精确 0.1.9；croner 范围 `^10.0.1` |
| scheduler `dist/extension.js:taskSchedulerExtension/loadSettings/runner` | session lifecycle、设置吞错、dataDir、inactive 注册、`sendUserMessage`、`/cron` |
| scheduler `dist/tools.js:createSchedulerTools` | 六工具、无 confirm/上限、workspace-write 仅写元数据、普通文本错误 |
| scheduler `dist/index.js:PersistentTaskScheduler.start/schedule/execute/runNow` | PID lock 使用、timer、missed/crash 修复、fire-and-forget、未等待 Agent |
| scheduler `dist/stores.js:JsonScheduledTaskStore/FileSchedulerLock` | Map 缓存、实例内 writeTail、无条件 unlink、PID-only lock |
| scheduler `dist/json-file.js:readJsonFile/writeJsonFile` | backup、temp+rename、无 mode/fsync/schema |
| shared `dist/settings.js:loadPiSettings/resolveEnvVars/resolveHome` | 固定 settings 读取、env 插值、project trust、默认 home |
| shared `dist/network.js`、`dist/threat-patterns.js` | 已审但 import 图不可达；后者未被用于 scheduler prompt 扫描 |
| croner `dist/croner.js` | 日期/cron/timer 实现；本次精确 10.0.1 无网络/进程依赖 |
| `pi/settings.json` | 当前仅有被对象过滤的 pi-subagents package；没有 scheduler 配置 |
| `scripts/pi-shell.zsh` | 当前配置根与 session/goal env；未设置 `PI_AGENT_HOME` |
| `scripts/lib/security-gates-extension.mjs` | 只在 `tool_call` 检查敏感路径/bash/push，在 `tool_result` 加 reminder |
| `pi/AGENTS.md` | 敏感信息、TDD、subagent、Git 状态等项目约束；它们不是 scheduler 授权记录 |
| Pi `docs/packages.md` | package 完整系统权限、对象过滤 `[]`、依赖安装和独立 module roots |
| Pi `docs/extensions.md` | session_start/shutdown、动态工具注册、tool_call、sendUserMessage、confirm、无 UI 模式语义 |
| Pi `dist/core/extensions/types.d.ts:ExtensionAPI.sendUserMessage` | 0.84.2 返回 `void`，不能代表 Agent 完成 |
| `.gitignore: /var/` | 当前 repo runtime 目录被忽略；推荐仍把 prompt 状态固定在 repo 外，避免物理落入工作区 |

## 12. Review gate

**Gate 结果：BLOCK 直接 settings 加载；CONDITIONAL PASS 仅适用于完成全部 Must fix 的项目自有同进程 adapter。**

没有发现需要为“网络/子进程恶意行为”阻断 0.1.9 精确字节的证据；阻断来自授权、路径、并发、持久性和错误语义。未运行上游 extension、上游测试、Goal Engine，也未安装/修改 settings、extensions、package-lock、stage 或 commit。仓库在审查前已有大量未提交改动；本任务只新增本报告，且未触碰这些既有改动。

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "用 npm pack --ignore-scripts 获取并解包 scheduler/shared 0.1.9 精确 tarball，记录 SHA-512 和成员；审查完整运行时 JS/import 图，并额外审查 scheduler 声明的 croner@10.0.1，明确 shared/settings live、network/threat-patterns/tests dead。"
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "第 4—7 节覆盖六工具与 /cron、存储位置/权限/原子性/锁、同实例/同 session/跨进程语义、崩溃和 missed run、Agent 未 settled、fail-open/fail-closed。"
    },
    {
      "id": "criterion-3",
      "status": "satisfied",
      "evidence": "第 8 节给出唯一推荐：禁用上游 resources，采用项目自有同进程 adapter；明确拒绝直接加载，并说明当前不需要普通进程/RPC 隔离。"
    },
    {
      "id": "criterion-4",
      "status": "satisfied",
      "evidence": "第 9 节给出允许工具、confirm/授权绑定、仓库外 dataDir、0600/0700、扫描、状态、审计、无 UI、session lifecycle、tool policy、事务/lease 最小边界；第 11 节列出文件/符号证据。"
    },
    {
      "id": "criterion-5",
      "status": "satisfied",
      "evidence": "唯一写入 docs/reviews/2026-08-17-pi-task-scheduler-cleanliness.md；未安装到 Pi，未修改 settings/extensions/package-lock，报告为中文。"
    }
  ],
  "changedFiles": [
    "docs/reviews/2026-08-17-pi-task-scheduler-cleanliness.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "npm pack --ignore-scripts @amaster.ai/pi-task-scheduler@0.1.9 && npm pack --ignore-scripts @amaster.ai/pi-shared@0.1.9 && npm pack --ignore-scripts croner@10.0.1（临时目录）",
      "result": "passed",
      "summary": "下载精确 registry tarball；未执行 lifecycle script 或 extension。"
    },
    {
      "command": "tar 解包/列成员 + shasum -a 512 + Python 归档路径/类型/import/危险标记静态断言",
      "result": "passed",
      "summary": "三个 hash 匹配；24/30/8 个安全成员；确认 scheduler 只可达 shared/settings，未发现网络、子进程、eval、MCP 标记。"
    },
    {
      "command": "node --check scheduler/shared/croner 发布 JS",
      "result": "passed",
      "summary": "仅做语法解析，未 import 或执行第三方模块。"
    },
    {
      "command": "git status --short；git diff --cached --name-only；git check-ignore -v var/...；关键文件 SHA-256 前后核对",
      "result": "passed",
      "summary": "确认审查前仓库已有未提交改动、无 staged 文件；/var 被忽略；受保护配置文件未被本任务改变。"
    }
  ],
  "validationOutput": [
    "scheduler SHA-512 35023f0d...c87dab6b；shared SHA-512 5f247ad3...d3048cb5e；croner SHA-512 8b136d00...bcf344da。",
    "静态断言：scheduler reaches pi-shared/settings only；no network/subprocess/eval/MCP markers。",
    "Review gate：BLOCK 直接上游 extension；CONDITIONAL PASS 完成 Must fix 后的同进程项目 adapter。"
  ],
  "residualRisks": [
    "这是发布 JS 的静态只读审查，未执行第三方代码；未验证 npm 发布者身份、Sigstore provenance 或 Git tag 与 tarball 源码对应关系。",
    "scheduler 的 croner 依赖仍声明 ^10.0.1；若未来安装链未精确锁定，解析结果可能超出本次审查。",
    "按边界未读取 user-global settings，实际运行时可能存在未审查的 pi-scheduler dataDir override。",
    "同进程 adapter 不是恶意依赖沙箱；每次依赖升级必须重新审查，未来出现高危能力时再评估操作系统级隔离。",
    "Pi sendUserMessage 没有交付事务/业务成功回执；adapter 只能借助 occurrence 状态和 agent lifecycle 提供保守的 at-most-once/indeterminate 语义。"
  ],
  "noStagedFiles": true,
  "diffSummary": "仅新增一份中文只读安全/架构审查报告，没有生产代码、配置、锁文件或测试改动。",
  "reviewFindings": [
    "blocker: dist/stores.js:FileSchedulerLock - 检查后无条件 unlink，跨进程竞态与同 PID 多实例可形成双 active。",
    "blocker: dist/extension.js:runner + dist/index.js:runNow/execute - run-now fire-and-forget，sendUserMessage 返回 void，未等待 Agent 且可能错误报告 Triggered/success。",
    "blocker: dist/tools.js:createSchedulerTools - 写/删/run 无真实确认、授权绑定、参数总量上限或 prompt 来源/敏感扫描。",
    "blocker: dist/extension.js:resolveConfig + shared/dist/settings.js:loadPiSettings - dataDir 可指向任意目录，env 插值与静默 fallback 不能保证 prompt 不进 Git 工作区。",
    "blocker: dist/index.js:schedule/execute - 长 timer 溢出、await 前并发竞态、missed/crash 无明确安全语义。"
  ],
  "manualNotes": "仓库在任务开始前已有大量未提交且未 staged 的既有改动；本任务未修改或清理它们。"
}
```
