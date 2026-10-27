# 后台任务/subagent 详情"首次打开默认选中项"只读诊断

范围：只定位默认选择与 selection 初始化/刷新，不改快捷键、不重排任务、不改运行状态、不加数据 fallback。
当前基线：Pi `1.4.0`（`package.json`），`src/background-activity/*` 未集成 `docs/patches/2026-10-27-background-activity-footer.patch`（footer5 文件修复）。
本次只写本文件；未修改 production/测试/配置，未访问 credentials/models，未控制任何 run/workspace。

---

## 0. 结论（先给答案）

1. **`open()` 本身不选最后一项。** `src/background-activity/detail-controller.ts:239-248` 的 `open()` 在 `selected` 尚未提交时会 `reconcileSelection()`，后者取 `entries[0]`（当时排序的第一项）。
2. **真正的偏离点是"首次默认选择"被提前到"首个非空快照观察时刻"，而不是"首次用户打开时刻"。** `handleRegistryInvalidated()`（`:287-294`）**不看 `mounted`**，在 `session_start` 当帧和之后每 500ms 轮询、每个 subagent 事件里都会 `refreshEntries()` + `reconcileSelection()`，于是：
   - 关闭态下第一次看到非空 `registry.snapshot()` 时就把 `entries[0]` 记为 `selected`；
   - 而详情列表顺序是动态的（active 按启动序在前、recent 反向在后；run 一完成就从 active 段移到 recent 段尾部），
   - 用户第一次按 Alt+O 时，被提前锁定的那一项已经滑到**末位**，detail footer 首行显示 `N/N`。
3. **"关闭再打开保留选择"当前是成立的**：`close()`（`:255-279`）不清 `selected`，`open()` 按稳定 key 重新对齐，滚动状态（`viewportStart`/`autoFollowState`）也不重置。已用探针证明（见 §5）。
4. 最小修复只落在**根详情壳一层**（`src/background-activity/detail-controller.ts`，约 6 行）：把"播种首项"限制在 `open()`/已挂载期间，关闭态刷新只按 key 对齐、不再提交首个默认值。待集成的 footer 补丁**不含任何选择初始化改动**，两边 hunk 不相交，可独立叠加（§6）。

---

## 1. 真实 production 入口与实际打开顺序

### 1.1 快捷键事实（本任务不改）

- 本仓唯一注册的是 **`Alt+O`**：`packages/pi-subagents-enhanced/extensions/custom-footer.ts:21-24`（`pi.registerShortcut(Key.alt("o"), { handler: (shortcutCtx) => runtime.openBrowser(shortcutCtx) })`）。
- Pi 1.4 上游 `node_modules/@earendil-works/pi-coding-agent/docs/keybindings.md` 把 `Ctrl+O` 定义为展开/折叠工具输出；`docs/usage.md` 同义。
- 因此**由当前源码不能证明 `Ctrl+O` 会打开本详情页**；若用户确实用 `Ctrl+O` 进入，需要运行时 keymap 或 Host 配置证据（本次未取得，见 §8 缺口 2）。本报告只按 `Alt+O` 链论证，验证结论与该差异无关（默认选择逻辑与触发键无关）。

### 1.2 打开调用链（自上而下）

1. `packages/pi-subagents-enhanced/extensions/custom-footer.ts:21-24` → `runtime.openBrowser(shortcutCtx)`。
2. `packages/pi-subagents-enhanced/src/tui/footer-runtime.ts:932-938`：`sessionManager` 守卫 → 当代挂载了根 presenter 时 `openViewDetails(view)`；否则走 package standalone browser（`enterBrowser()`）。
3. `src/background-activity/presenter.ts:369-431`（`openDetails`）：`ctx.mode === "tui"`、终端行数门禁、保存 editor/draft，然后 `ctx.ui.custom(factory, DETAIL_OVERLAY_MOUNT_OPTIONS)`；factory 内 `:413` 调 `shell.open({...})`。
4. `src/background-activity/detail-controller.ts:239-248`：`refreshEntries()`（`:424-460`）→ `reconcileSelection()`（`:462-489`）→ `requestDetail()` → `requestRenderNow()`。
5. presenter 的 detail footer 首行在 `src/background-activity/presenter.ts:307-325` 生成：`n/N` = `entries.findIndex(selected)+1` / `entries.length`。**这就是用户看到的"定位到第几项"。**

> `packages/pi-subagents-enhanced/src/tui/session-browser.ts:357-363` 的 `enter()`（standalone 路径）也在打开时取 `children[0]`，且 `exit()`（`:365-369`）会清空 `selectedKey`。也就是说 standalone 每次打开都取第一项、不保留；根 shell 则保留。两条路径语义不同，见 §7。

### 1.3 决定"第一项是谁"的排序链

| 环节 | 位置 | 事实 |
| --- | --- | --- |
| run 级顺序 | `packages/.../session-browser.ts:407-412` | 非终局 run 先（Map 插入序 = 启动序，**最老在前**），终局 run `reverse()` 后（**最新在前**） |
| child 分组 | 同文件 `:432-441` | `children()` / `activeChildren()` / `recentChildren()` |
| 行投影 | `packages/.../subagent-activity.ts:115-122` | 先 push `activeChildren`（placement=main），再 push `recentChildren` |
| registry 汇总 | `packages/.../background-activity.ts:384-395` | 按 `subagent → bash_async → scheduler` 依次拼接各 source 行 |
| 详情壳条目 | `src/background-activity/detail-controller.ts:424-460` | 直接采用 `registry.snapshot()` 顺序，**不重排**；只把 stale 观察行追加到末尾 |
| 计数展示 | `src/background-activity/presenter.ts:307-325` | `n/N` 用上表 entries 顺序计算 |

由此得到两个直接后果：

- **"第一项" = 第一条 active child**（最老的运行中 run）；没有 active 时 = 最新的已完成 run。
- **一条 run 完成后一定会移到所有 active 行之后**（recent 段在 active 段之后），因此一个"早先被选中的行"在顺序变化后可以正好落到**末位**。

---

## 2. 首个偏离点：选择在"首个非空观察"就被提交

### 2.1 关闭态刷新链（用户按键之前就已经发生）

1. `packages/.../footer-runtime.ts:1013-1017`：`session_start` 末尾 `standaloneFooterFactory = ...` → `startOwnerEpoch()`（presenter 在其中握手挂载）→ `installFooter()` → **`reconcile(owner, epoch)`**。
2. 同文件 `:520-531`：`reconcile` → `persist()`（`:483-494`）→ `notifyActivity()`（`:478-482`）→ 通知 `subagent-activity` 的 runtime 监听者。
3. `packages/.../subagent-activity.ts:132-136`：把失效转发给 registry 的订阅者（`dependencies.subscribe(...)`）。
4. `packages/.../background-activity.ts:340-380`（`register` 的订阅回调）→ `notify()`。
5. `src/background-activity/presenter.ts:280-284`：presenter 创建时 `registry.subscribe(() => { shell.handleRegistryInvalidated(); invalidateFooter(); })`。
6. `src/background-activity/detail-controller.ts:287-294`：

   ```ts
   handleRegistryInvalidated(): void {
     this.refreshEntries();
     this.reconcileSelection();      // ← 不看 mounted：关闭态也提交默认选择
     if (!this.mounted) return;
     ...
   }
   ```
7. `:462-488`（`reconcileSelection`）：`selected === undefined` → `index === -1` → `entries.length > 0` → `nextIndex = max(0, min(selectionIndex=0, len-1)) = 0` → **`selected = entries[0].key`**，同时 `disposeCurrentComponent()` / `resetScroll()`。

同一路径还会被再次触发：`footer-runtime.ts:1008` 每 500ms 轮询 `reconcile`、`:994-1006` 的 `subagent:async-started` / `subagent:async-complete` 均 `persist()`（→ 同一 `notifyActivity()` 链）。**所以在用户第一次按 `Alt+O` 之前，详情壳早已"记住"了一个默认项**，`open()` 只是保留它。

### 2.2 为什么它显示成"最后一项"

两个由源码可直接证明的时序（均用 production 模块复现，见 §5）：

- **P1（历史完成项 + 新任务）**：roster 里已有 1 条已完成 run → 首个非空刷新把 `selected` 定为该 recent 行 → 用户启动新 subagent（新 active run 插到 recent 段之前）→ 首开显示 `2/2`。
- **P2（被播种的 active 行随后完成）**：仅 A 在跑时先被播种（当时 `1/1`）→ A 完成、B 启动 → 重开显示 `2/2`。因为"完成即转到 active 段之后"，只要被播种的行是最老 run 且之后还有仍在跑的 run，它就**必然落在末位**。

### 2.3 首个偏离点的精确定义

- **不是** `open()` 选了末项（它在 `selected` 未提交时选 `entries[0]`，见 §5 场景 1）。
- **也不是** 排序错误（排序由 `session-browser` + `subagent-activity` 的既有合同决定，本任务不重排）。
- **是** `detail-controller.ts:287-289`（关闭态也执行选择对齐）+ `:462-488`（播种条件只有 `selected === undefined`，没有"首次打开"这一事件）：选择被提前提交并从此按 key 粘住，而列表顺序会变化。

---

## 3. 五类时点的事实（区分首次初始化与保留选择）

| 时点 | 触发点 | 代码 | 实际行为 |
| --- | --- | --- | --- |
| 首次选中初始化 | 首个**非空** `refreshEntries()`（挂载与否都算） | `:287-289` → `:462-488` | `selected = entries[0].key`（当时排序第一项）+ `selectionIndex = 0` + `disposeCurrentComponent()` + `resetScroll()`。**这就是缺陷来源：发生在用户打开之前。** |
| 主 footer 渲染时的"预选" | 每帧 `createFooter().render()` | `presenter.ts:294-305`（`selection: shell.selectedKey()`） | **纯只读**：渲染不初始化也不修改选择；`renderActivityLayout` 只用 key 命中着色。当前树（pre-patch）会为已播种的行画 `›`；待集成补丁把选择列整列删除（`layout.ts` 的 `void selection`），预选在主视图**不可见**，但 detail 的 `n/N` 仍反映它。 |
| 用户主动选中 | `‹`/`›` → `navigate` → `selectEntry` | `:496-506`、`:508-522` | 写 `selected` + `selectionIndex`，dispose 旧详情组件，`resetScroll()`（回到"跟随底部"），重新 `requestDetail()`。与"首次默认"完全独立。 |
| 关闭再打开 | `close()`（`:255-279`）→ `open()`（`:239-248`） | 同上 | `close()` **不清** `selected`/`selectionIndex`，也不重置 `viewportStart`/`autoFollowState`；`open()` 的 `reconcileSelection()` 命中同 key → 只刷新 `selectionIndex`，不重置、不 resetScroll。→ **保留用户选择与滚动状态**（除非 key 已消失）。 |
| 原条目消失 | `refreshEntries()` + `reconcileSelection()` | `:462-488` | 有 `selected` 但 key 不在：`nextIndex = max(0, min(selectionIndex, entries.length-1))`，钳制到相邻项并 `resetScroll()`（不按标题复活）；列表变空：`selected = undefined`、`selectionIndex = 0`。已有断言见 `test/background-activity-details.test.mjs:934-953`。 |

补充事实（同一链但不在本需求内）：`handleRegistryInvalidated()` 在挂载期间还会重取详情（`:290-293`），`handleThemeChange()`（`:296-310`）同理；这两条都不改 `selected`。

---

## 4. 最小实现路径（首开第一项 + 重开保留）

### 4.1 设计原则

- "首次默认值"只允许由**打开事件**决定：首次 `open()` 时按**当时**的实际排序取 `entries[0]`。
- 只要 `selected !== undefined`，行为与现状完全一致（按 key 对齐、key 消失钳制相邻）。
- 关闭态刷新不得写 `selected`：既满足"不每次刷新重置 first"，也不影响手动选择与滚动（这两者只在 `navigate`/`selectEntry`/`scroll*` 里改）。

### 4.2 推荐补丁（variant A，最小 diff，约 6 行）

`src/background-activity/detail-controller.ts:287-294`：

```ts
  handleRegistryInvalidated(): void {
    this.refreshEntries();
    // 关闭态且从未提交过选择：不播种。首次 open 才按当时的实际排序取第一项；
    // 否则 session_start 当帧/500ms reconcile/事件刷新会先锁定一个默认项，
    // 而列表顺序随后变化（active 前置、run 完成转 recent 段尾部）会把默认项推到末位。
    if (!this.mounted && this.selected === undefined) {
      this.selectionIndex = 0;
      return;
    }
    this.reconcileSelection();
    if (!this.mounted) return;
    this.requestDetail();
    this.requestRenderNow();
  }
```

等价点检查：

- `open()`（`:244-245`）不变 → 首次打开时 `refreshEntries()` 后 `reconcileSelection()` 播种 `entries[0]`（当时的排序）。
- 已挂载期间行从无到有：`!this.mounted` 不成立 → 仍播种第一项（详情正开着，语义等于"首开那一刻"）。
- `selected !== undefined` 的一切路径不变 → 重开保留、key 消失钳制相邻、空列表清空、挂载期重取详情全部保持。
- 提前 `return` 只跳过 `reconcileSelection()`；其后语句本就被 `if (!this.mounted) return;` 拦住，无行为差。
- 副作用校正：pre-patch 主 footer 不再出现"从未打开却有选中标记"。这与既有断言方向一致（`test/background-activity-details.test.mjs:404` 的"未打开过详情时无选中标记"），也与待集成补丁删除选择列后的行为一致。

### 4.3 备选（variant B，语义更显式，diff 多 2 行）

在 `:195`（`private selectionIndex = 0;`）附近新增 `private selectionCommitted = false;`，把 `reconcileSelection` 改成 `reconcileSelection(options: { seedFirst: boolean })`：

- `open()`：`this.reconcileSelection({ seedFirst: true }); this.selectionCommitted = true;`
- `handleRegistryInvalidated()`：`this.reconcileSelection({ seedFirst: this.mounted });`
- 播种分支条件改为 `this.selected === undefined && options.seedFirst`。

两者语义相同；variant B 把"是否已提交过选择"变成命名状态，便于后续审查，但改动面略大。字段插入点在 `:195` 之后，与待集成补丁的 `@@ -205,6 +241,8 @@`（`viewportStart`/`autoFollowState`/constructor）hunk **不重叠**。

### 4.4 明确不做

- 不改 `session-browser.ts` 任何排序（active 启动序 / recent 最新在前）——"第一项"以现有排序为准。
- 不改 `subagent-activity.ts` 行投影、registry 汇总顺序。
- 不改 `presenter.ts`/`layout.ts`（footer 渲染是只读消费方）。
- 不加数据 fallback、不改 `state`/任务运行状态、不改快捷键。
- 不新增/修改测试（本任务禁止）。

---

## 5. 现场复现（production 模块，未启动真实 Host/provider）

方式：直接 import production 模块 —— `session-browser.ts`（`hydrate`/`trackStarted`/`trackCompleted`）、`subagent-activity.ts`（`createSubagentActivitySource`）、`background-activity.ts`（`createActivityRegistry`）、`src/background-activity/presenter.ts`（`createActivityPresenter`）；`ctx.ui`/overlay 用 DI 替身（只提供 footer 元数据与 `custom` 挂载点，与 `test/background-activity-details.test.mjs` 的 presenter fixture 同构）。行数据来自 **production 的 roster 持久化格式 + 事件入口**，不是手工拼 `ActivityRow`。

输出（原文）：

```text
=== 场景1：无任何历史行，首开前已启动 runB ===
首开: "1/1 ● 新任务B (executor) · 运行中"

=== 场景2：历史仅 1 条已完成；先观察空 roster→A，再启动 B，首开 ===
首开: "2/2 ● 旧任务A (reviewer) · 已完成"
左移后: "1/2 ● 新任务B (executor) · 运行中"
关开后（应保留用户选择）: "1/2 ● 新任务B (executor) · 运行中"

=== 场景3：A 完成后仍有 B 在跑（选择被保留但滑到末项）===
首开（仅 A）: "1/1 ● 任务A (reviewer) · 运行中"
A 完成后重开: "2/2 ● 任务A (reviewer) · 已完成"
```

另一组（只验证 `open()` 本身的语义，等价于"关闭态不播种"的拟修效果）：

```text
首开: "1/2 ● 新任务B (executor) · 运行中"        # 首开时按当时排序取第一项
RIGHT 后: "2/2 ● 旧任务A (reviewer) · 已完成"    # 用户主动选中
关开后保留用户选择: "2/2 ● 旧任务A (reviewer) · 已完成"
关闭态刷新后重开仍保留: "1/2 ● 新任务B (executor) · 运行中"   # 用户此前已左移回第一项，key 不变
```

另有一次纯 registry/shell 探针（不经 presenter）确认：`entries` 顺序 = `registry.snapshot()` 顺序，`runA` 完成后条目变为 `["runB:0","runC:0","runA:0"]`，按 key 保留的 `runA` 落在 index 2（末项）。

结论：**"首开落末项"与"重开保留"两件事都被 production 代码复现**；前者由"提前播种 + 动态顺序"造成，后者是当前刻意行为。

---

## 6. 与待集成 footer 补丁的衔接

补丁：`docs/patches/2026-10-27-background-activity-footer.patch`（含 `src/background-activity/{detail-controller,layout,presenter}.ts` 与两个测试文件）。

### 6.1 应用性检查（只读）

```text
$ git apply --check docs/patches/2026-10-27-background-activity-footer.patch
patch applies cleanly (check only, no write)
```

补丁在 `detail-controller.ts` 的 hunk 起点：`@@ -21`、`@@ -30`、`@@ -88`、`@@ -156`、`@@ -205`（字段/构造函数）、`@@ -311`（`position()` → `renderFooter`/`renderFooterForReserve`）、`@@ -642`（`scrollBounds`）。

### 6.2 合并位置

- 本修复的唯一落点是 `detail-controller.ts:287-294`（`handleRegistryInvalidated`），**补丁未触碰该函数**，与 `@@ -205`、`@@ -311` hunk 均不相交 → 先打补丁再叠修复（或反之）都不需要改对方代码。
- 语义衔接点 1：补丁把 detail footer 渲染搬进壳（`renderFooter` / `renderFooterForReserve` 读 `this.shellEntries` 与 `this.selected`，并新增 `footerReservedBottomRows()`）。这是**纯读取**，因此修复播种时机后 footer 首行自然变成 `1/N`，不需要动补丁代码。
- 语义衔接点 2：补丁从 `layout.ts` 移除主 footer 选择列（`void selection`、`PREFIX_WIDTH` 少 1 列、测试改成"selected key 保留但无选择列"）。修复后"从未打开过详情 → 无选中标记"依然成立；补丁把 `test/background-activity-details.test.mjs` 的原断言改成 `⌘ ` 前缀，与本修复不冲突。
- 语义衔接点 3：补丁的 `positionForFooterRows`/`scrollBounds` 只改高度/滚动预算，不触碰 `viewportStart`/`autoFollowState` 的写入点 → 修复"不重置滚动"的不变量不受影响。

### 6.3 现有断言/验证入口（本次未运行测试，原因见下）

可用的既有验证入口（补丁集成前后都适用）：

```text
node --test test/background-activity-details.test.mjs \
  test/subagent-activity-provider.test.mjs \
  test/subagent-session-viewport.test.mjs \
  test/custom-footer-input.integration.test.mjs \
  test/custom-footer-fullscreen.integration.test.mjs

npm run typecheck                      # typecheck:root + typecheck:subagents-enhanced
npm run verify:subagents-enhanced      # 仅在改动 package/入口校验时
```

相关既有断言（现状树行号）：

- `test/background-activity-details.test.mjs:468`：首开后 detail footer 含 `1/1`（单条）。
- `:900-931`：`openShell()` 后 `selectedKey() === "subagent:a"` 且 `entries()` 顺序为 `subagent:a → r1 → r2 → bash:b → scheduler:s`（**首开=entries[0]**，修复后仍成立）。
- `:934-953`：同 label 异 key 不去重；key 消失钳制相邻项、列表空则 `undefined`（修复后仍成立）。
- `:1088-1097`：detail footer 首行 `1/2 ● 任务M ...`、位置行/键位提示仍在（补丁把该行改成含模型的精确断言）。
- `:404`、`:405-406`（补丁 hunk）：未打开过详情时主 footer 无选中标记 → 与本修复的"关闭态不播种"方向一致。

**本次未运行 `node --test`**：`test/background-activity-details.test.mjs` 文件头明确写明"运行需 unit-runner 授权（占用期间不得执行 node --test）"，且本任务只读诊断、未改动任何源码，测试不是交付物；另有并行 delegate 在同一仓库改 typed resume，避免争用。也未运行 `npm run typecheck`（无源码改动）。

---

## 7. 数据来源分类（缺陷数据来源分类门禁）

**类别 1：预期 production UI 数据未被正确渲染/初始化。**

- 实际入口：package extension 唯一 `Alt+O`（`custom-footer.ts:21-24`）→ `footer-runtime.openBrowser`（`:932-938`）→ 根 presenter `openDetails`（`presenter.ts:369-431`）→ 壳 `open()`（`detail-controller.ts:239-248`）。
- 权威身份/顺序：当前 `sessionManager` 身份门禁后的 typed 事件（`footer-runtime.ts:994-1006`）与 500ms `reconcile`（`:1008`、`:520-531`）→ `SubagentSessionBrowserState`（roster 持久化格式 v1 `hydrate`）→ `ActivitySource.snapshot()` → `ActivityRegistry.snapshot()` → 壳 `refreshEntries()`。行 key 是 `runId:index` 稳定身份，不按 label 复活。
- 首个偏离点：`detail-controller.ts:287-289` + `:462-488` 的"选择初始化时机"，不涉及 raw payload、不涉及 status/model 读取。
- 与测试的区别：现有测试确实用"手工构造 `ActivityRow`"验证合同，但**"首开落末项"的生产可达性由上面的 public/typed 事件与状态机链闭合证明**，不依赖 fixture。本次探针的 `ctx.ui` 是 DI 替身（仅供 footer 元数据与 overlay 挂载），行数据来自 production 的 hydrate/事件入口，不是拼装 projection。

因此应改**选择初始化时机**，不增加兼容分支、不改排序、不改 raw。

---

## 8. 未证实项与缺口（停在已证实事实）

1. 未在真实 Host/TUI 里按 `Alt+O` 观察；用户具体时间线（打开前是否已有 1 条已完成历史、是否有新 run 启动）是据源码推出的最可能情形，未取得用户截图/日志。机制层（提前播种 + 动态顺序 → 末位）已由 production 模块复现。
2. `Ctrl+O` 与本仓 `Alt+O` 的差异未解决：源码只能证明 `Alt+O`。若用户确实用 `Ctrl+O` 打开，需要 Host keymap 配置或运行时证据（本次未取，且本任务不改快捷键）。
3. `shellEntries` 与主 footer 列表并非同一集合：主视图只渲染 `placement === "main"`，recent 折叠为 `◯ recent N`，stale 行只出现在详情末尾分组。本报告的"第一项"以**详情页 `n/N` 计数顺序**（= entries 顺序）为准；若产品期望的"列表"是主 footer 可见行集合，需要产品确认后重新对表。
4. 若产品还希望 standalone browser 路径也"首次第一项 + 重开保留"：`session-browser.ts:357-369` 现在是"每次打开都取 `children[0]`、`exit()` 清空"，改它属于另一处需求（会改变 package 侧合同），本任务未纳入。

---

## 9. 写入边界与 dirty 现场

- 本次只新增本文件 `docs/investigations/2026-10-27-background-detail-initial-selection.md`；未修改 production/测试/配置，未触碰 `docs/patches/**`、`pi/models.json*`、`pi/settings.json`、`docs/reviews/**`，也未触碰 `src/**`、`packages/**`、`test/**`。
- 未对任何 workspace/run 做操作；未修改 Goal 计划；未读取 credentials/models 内容。
- 原有 dirty 现场保持原样（`skill-overrides/playwright/**`、`skill-overrides/writing-plans/SKILL.md`、`docs/bugs/2026-10-27-managed-coding-resume-binding.md`、`docs/investigations/2026-10-27-*.md`、`docs/patches/`、`docs/plans/2026-10-26-goal-runtime-v1.md`、`pi/crashes.json`、`pi/models.json.bak-*`、`skill-overrides/playwright/src/aone-config-readonly.ts`）。未 stash/reset/checkout/worktree 操作。
- 无 staged 文件。诊断探针脚本写在 `/tmp`（仓库外），用完已删除；报告内保留其构造方式与输出原文。
