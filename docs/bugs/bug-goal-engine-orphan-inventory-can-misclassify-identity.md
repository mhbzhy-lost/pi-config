# Bug: Goal Engine Orphan Inventory 可误分类身份（Task4A）

## 表现
1. `inspectOrphanedExecutorWorkspace` 先用 `existsSync` 读取 `workspaceExists/leaseExists/branchExists`。当路径命中 `ELOOP`/`EACCES` 等 stat 错误时，`existsSync` 仅返回 `false`，三项位可被误解析为 `000`，最终返回 `kind: "none"`，把实际存在的 orphan workspace 误报为无。
2. `persisted` 租约验收阶段只校验部分字段，随后把整份对象 `...lease` 回传，`leasePath`、未声明字段、甚至字段类型异常可随 `verified` 一并泄露到上层。该行为在异常 envelope 下制造“unknown 被当作 verified”缺口。
3. 租约持久字段（`path`、`originRoot`、`stateRoot`）未要求 lexical `absolute`，通过 `path.resolve`/`realpathSync` 的过程会依赖运行时 `process.cwd`，在不同进程环境可能产生不同结果，形成 ambient cwd 相关 identity 漂移。
4. Canonical 校验与 Git 检查间未形成 pinning：前者做的是一组“现状快照”一致性比较，后者再次进入 `inspectExecutorWorkspace` 时使用 `lease` 的原始字段并复验分支/HEAD。若 lease 含 alias 变体或可变字段，可能出现 canonical 结果与实际 inspection 结果分歧（TOCTOU 窗口）。

## 影响
- 清理/回收路径在实际资源存在时被错误判断为 `none`，导致 orphan 资源长期悬挂或重复分配。
- `verified` 状态可能携带未受控 envelope（含 `leasePath`、未知字段），使后续处理基于错误身份执行，破坏 `goal-engine` 回收与审计边界。
- `process.cwd` 不稳定带来的 pathname alias 漂移，使同一资源在不同运行环境下产生不同分类，审计与复现不可重现。
- canonical 与 Git 侧检查语义不一致，放大身份错配风险，可能放行错误 workspace 或拒绝合法恢复（false positive/negative）。

## 根因
- `inspectOrphanedExecutorWorkspace` 的身份判定把“读时不确定性（stat/路径失败）”与“确证不存在”混淆，并未对入库 envelope 做 exact schema 与 exact field-set 验证；同时缺少 canonical 字段与 Git inspection 的二次一致性复核。根因可统一为：把不确定性或非精确 envelope 当作可信身份状态。

## 触发条件
1. 在 `inspectOrphanedExecutorWorkspace` 调用期间，`expected workspace/lease` 路径发生 `ELOOP` 或 `EACCES`，且三项资源位都落为 `false`。
2. 持久 lease 文件被篡改为包含额外字段（如 `leasePath`、注入元数据）或将字段改为非对象类型。
3. lease 持久字段为相对路径，或 `stateRoot/originRoot/path` 记录为可被 `process.cwd` 影响的语义。
4. 同一 invocation 中，canonical 检查使用别名路径通过，但 Git inspection 复核读取到未 pin 的 lease 字段并出现分支/HEAD 匹配差异。

## 修复方案
1. 资源探测将 `existsSync` 替换为显式 `lstatSync`/`statSync` 语义的分类探针：只对 `ENOENT` 视为缺失；对 `ELOOP`、`EACCES`、`ENOTDIR`、`EIO` 等返回 `unverified`（保留已知证据），禁止归并为 none。
2. `lease` 入参必须为 plain object 且字段集合精确白名单（`goalId/taskId/attempt/originRoot/stateRoot/path/branch/baseCommit/originRef/ownerToken/createdAt`）；除该集合外任何字段（包括 `leasePath`）一律视为异常并直接 `unverified`。
3. `path/originRoot/stateRoot` 以 absolute lexical 持久字段为前置条件；relative 值直接拒绝，避免依赖 `process.cwd` 的 ambient 解析；读取时仅用于显示，不作为身份真值。
4. 引入 canonical pinned inspection：先将 persisted 字段规范化为 canonical absolute snapshot，再以该 snapshot 调用 inspection，并在返回前做二次复验（`path/originRoot` 与 `branch/HEAD` 复核），确保 canonical 检查与 Git inspection 使用同一 pinned identity。
5. 只承诺 fail-closed 的双阶段校验与可重复验证，不宣称跨进程数学单事务。

## 验证方案
1. 构造真实 `ELOOP` 场景（如构建 symlink 环形成循环）与受限权限触发 `EACCES` 的 fixture，调用 orphan inventory；要求返回 `unverified` 且不得回归为 `none`。
2. 构造非对象租约（`string/object` 非法 JSON）、`leasePath` 注入、未知字段注入、`goal/taskId/path/originRoot/stateRoot` 改为相对路径（relative envelope）四组用例，逐项断言结果为 `unverified` 并保留 `observed/error`。
3. 针对 alias 漂移建立确定性 inspector barrier：在同一 inode 上分别使用 canonical alias 与原始查询路径做完整资源探测，要求两次 canonical snapshot 与 `inspectExecutorWorkspace` 的 `branch/HEAD/clean/descendant` 结果一致，且返回 lease 为 pinned exact 字段集。
4. 整体验证禁止使用 `sleep` 或 `poll`；以事件性 fixture 一次性触发，并在无并发等待的条件下完成断言。