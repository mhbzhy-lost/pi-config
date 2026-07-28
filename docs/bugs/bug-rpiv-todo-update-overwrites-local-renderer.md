# Bug：RPIV Todo 升级覆盖本地紧凑 Renderer

## 1. 现象

升级 `@juicesharp/rpiv-todo` 到 2.1.0 后，Todo 调用重新使用上游默认卡片样式；原有 `∗ todo + ... · ○ pending` 单行展示、可读 action 名称和结果摘要全部失效。

## 2. 影响

Todo 与其他 compact tools 的视觉层级不再一致，频繁 create/update 会重新占用两行和整块背景；已有样式测试直接读取安装目录，7 项契约在升级后全部失败。

## 3. 稳定复现

1. 在 `pi/npm/node_modules/@juicesharp/rpiv-todo` 内修改 `todo.ts` 和 `view/format.ts`，加入 self shell 与紧凑 renderer。
2. 执行会重装该依赖的 `pi update` 或 npm install，使包升级到 2.1.0。
3. 运行 `node --test test/todo-compact-result.test.mjs`，稳定得到 7 项失败；启动 Pi 后调用 `todo`，稳定恢复上游卡片样式。

## 4. 证据

当前 `view/format.ts` 的修改时间与 2.1.0 安装时间一致，且已不再导出 `TODO_CALL_PREFIX`、`formatCompactAction()` 和 `formatCompactResultSummary()`。Git 忽略整个 `pi/npm/`，所以此前 renderer 修改和测试目标都没有进入受版本控制的生产边界。Pi 0.82.1 的扩展解析规则明确让本地扩展优先于 package extension，同名工具采用首个注册；最小实验也确认 2.1.0 的 `registerTodoTool()` 可捕获包含 schema、execute 和 renderer 的完整工具定义。

## 5. 根因

自定义样式被实现为 npm 安装产物的原地修改，而不是仓库自有扩展。包管理器重装时会按发布包内容整体替换安装目录，因此样式丢失是该方案的必然结果，不是新版 Todo renderer API 不兼容。现有测试又直接导入被忽略的安装文件，只能发现覆盖，不能提供持久修复。

## 6. 修复与验证策略

新增仓库自有 `todo-compact-renderer.ts`：通过 2.1.0 的 `registerTodoTool()` 捕获并复用上游工具定义，仅替换 `renderShell`、`renderCall` 和 `renderResult`。紧凑格式函数与 reload-sensitive 状态保留在该 TypeScript 扩展中，不修改 `node_modules`。先将现有 7 项测试改为验证自有扩展并确认 RED，再实现 renderer；最后验证同名工具优先级、真实 Todo execute、`/reload` 边界和 Pi 全扩展加载。
