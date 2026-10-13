# scheduler store 注入切片（adapter）：接线暂停记录

日期：2026-10-13
状态：**接线已撤回，处于可加载基线；缺陷尚未修复。**
范围：本切片曾按 `/tmp/scheduler-delete-repair-contract.md` 第 4.4 节在 `src/task-scheduler/adapter.ts` 注入 per-session store getter；因 store 切片（`src/task-scheduler/store.ts`）暂停、模块缺席导致静态 import 使 Host reload 与全仓 typecheck 失败，已按指示撤回本次引入的全部接线 delta，恢复可加载基线。精确接线 diff 与配套 3 个测试保存于 `/tmp/scheduler-adapter-pending-store.patch`（经 `git apply --check` 验证可对本基线重放），待 store 安全合同另行派发后实施。

## 一、缺陷背景：D1–D3 为 production 可达独立缺陷（未修复）

以下结论来自 `/tmp/scheduler-delete-orphan-diagnosis.md` 与 `/tmp/scheduler-delete-repair-contract.md` 的真实上游公开入口复现（`node /tmp/scheduler-delete-repro.mjs`，7/7 PASS；仅 /tmp 隔离文件、固定非真实 prompt、合法 sessionId、远期 interval 保证真实 timer 不触发、触发一律经公开 `runNow` 受控入口），根因定位在 pinned 0.1.9 `dist/stores.js` / `dist/index.js`：

| 缺陷 | 现象 | 源码根因 |
| --- | --- | --- |
| D1 | 跨实例删除后，活跃实例仍 get 到任务并继续触发，run 完成后写回盘面复活 | `JsonScheduledTaskStore.load()` 一次性快照永不刷新（stores.js:54,63）；execute 读自身陈旧 Map（index.js:223） |
| D2 | 陈旧快照双向破坏：对另一任务的公开 update 使已删任务复活；跨实例顺序 update 必然失更新 | 每次 mutator 整文件 last-writer-wins（stores.js:72 save 无条件），无锁/CAS/合并 |
| D3 | 失败（no-op）mutator 仍整文件写回：对不存在任务 delete 返回 false 却把陈旧快照整体写盘，抹掉盘面全部任务 | stores.js:68-77 `updateState`：mutator 返回 false 不阻止 `save()` |

用户个案 provenance 仍未证实，缺陷登记与个案解耦，不归因。**当前仓库没有任何针对 D1–D3 的修复生效。**

拓扑澄清：上述复现为同 PID 双实例（双 active）的合成拓扑，仅佐证共享 store 算法缺陷本身，不等同实际 Host 现场；生产中真正共享 store 的正常可达前提是两个 Host 同时 resume 同一 session 文件（resume 保留 header.id，new/fork 生成新 ID），正常单 Host 单实例不触发双 store 问题，第二 Host 通常 inactive 但工具照注册可写、sessionPath 相同。

## 二、store 切片暂停原因（上游锁不满足 mutator 互斥）

store 切片发现上游 `FileSchedulerLock` 不满足 mutator 可靠互斥：`acquire()` 的 read/无持有者判断 → 无条件 `unlinkSync` → `wx` 原子创建之间存在竞态窗口，且同 pid 重入不互斥（stores.js:87-96）。锁集成暂停，unsafe 默认实现不会恢复。因此本切片的注入对象 `RefreshingScheduledTaskStore`（接口 `new RefreshingScheduledTaskStore(filePath)`）暂无可用实现，接线随之暂停。

## 三、config.store 真实注入面与 session store path 约定（pinned 0.1.9 dist 实测事实，供后续实施）

`pi/npm/node_modules/@amaster.ai/pi-task-scheduler/dist/extension.js`（版本锚点：`pi/npm/package.json` 锁定 `@amaster.ai/pi-task-scheduler@0.1.9`）：

```js
function resolveConfig(raw) {
    const resolved = { dataDir: raw?.dataDir?.trim() || path.join(resolveHome(), 'data') };
    if (raw?.store) resolved.store = raw.store;      // :16-17 注入对象直接透传
    ...
}
// session_start 内：
const config = resolveConfig({ ...fileConfig, ...injectedConfig });   // :41 spread 时 getter 求值
const store = config.store ?? new JsonScheduledTaskStore(sessionStorePath);  // :52 注入优先
if (!config.store && !existsSync(sessionStorePath)) { ...legacy 迁移... }    // :53 注入 store 时迁移整体跳过
const lock = config.lock ?? new FileSchedulerLock(...scheduler-<key>.lock);  // :63 lock 仍由上游自建
```

路径约定（extension.js:34-36,51,63）：`storageKey = sha256(sessionId)`；store 为 `<dataDir>/tasks-<storageKey>.json`；lock 为 `<dataDir>/scheduler-<storageKey>.lock`。

**legacy 迁移差异的风险声明（不得宣称无风险）**：一旦注入 `config.store`，上游将整体跳过 legacy `tasks.json` 迁移（extension.js:53 条件 `!config.store`）。本仓 adapter 的 dataDir 是 per-repo 哈希目录（`repositoryDataDir`），正常部署下不存在上游 legacy 的 home 级 `tasks.json`，该差异预期无实际影响；但这一结论仅基于目录结构推断，**尚未经风险评估确认，不作为无风险结论使用**。恢复接线前需对该差异做显式评估（含：是否存在历史遗留写入该目录的 legacy 文件、跳过迁移对升级路径的影响）。

## 四、已撤回的接线设计（待重新实施）

被撤回的 delta（完整内容见 `/tmp/scheduler-adapter-pending-store.patch`）：

1. `src/task-scheduler/adapter.ts`：新增 `import { RefreshingScheduledTaskStore } from "./store.ts"`；在既有 `dataDir` getter 旁新增同构 enumerable `store` getter——`sessionCtx.sessionManager.getSessionId()` → sha256 → `join(repositoryDataDir(sessionCwd, env), "tasks-<key>.json")`，返回 `new RefreshingScheduledTaskStore(path)`；`sessionCtx` 缺席时抛错 fail closed。
2. `test/task-scheduler-adapter.test.mjs`：3 个测试——①注入 config.store path guard（路径约定/instanceof/enumerable/session 外 fail closed）；②每 session_start 新实例、不同 session 不同 hash、同 session 重建实例同路径；③真实 pinned 上游入口相容（空 store → `scheduler: active`、四工具边界不变、lock 仍由上游自建自释放、legacy 迁移跳过、空 store 零写盘）。

时序设计（重新实施时仍然成立）：facade `on` 包装器在调用上游 handler 前设 `sessionCwd`/`sessionCtx`，`session_shutdown` 前清空二者；上游对 config 的唯一消费点在 `session_start` 内，getter 每 session 恰好求值一次。

## 五、不扩展边界（重新实施时同样适用）

- 不在 adapter 另加第二轮询；不在 adapter 读取 task 文件内容；
- 不变更 footer 字符串、工具 allowlist（四工具）、`sendUserMessage` 文案、安全边界（scanPersistent/boundedResult）、session lifecycle、RPC status；
- 不修改 vendored 上游 `pi/npm/node_modules/**` 与 `pi/extensions/task-scheduler.ts`，不改变调度执行语义；
- 不注入 `lock`/`scheduler`；只读刷新与文件互斥由 store 切片实现，本切片不实现其内部语义。

## 六、撤回后验证

撤回已完成并验证（可加载基线恢复）：

- `node --test test/task-scheduler-adapter.test.mjs test/task-scheduler-package-isolation.test.mjs`：全过（adapter 测试恢复为既有 dirty 版本，不再依赖 store.ts）。
- `npm run typecheck:root`：通过（TS2307 消失）。
- `git diff --check`：通过。

测试与验证边界：不调用真实 scheduler 工具/真实任务/网络/daemon/子进程，不访问凭据/settings/models/session 全文；仅使用隔离临时路径、公开入口与合法 task 字段。真实上游入口测试读取 home/config 目录 pi-scheduler settings section 属上游 session_start 固有行为（与既有 runtime integration 测试同暴露面）。
