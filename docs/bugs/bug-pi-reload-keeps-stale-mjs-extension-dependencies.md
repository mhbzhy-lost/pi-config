# Bug：Pi Reload 保留旧 MJS 依赖导致扩展新导出不可用

## 1. 现象

修改 `compact-tools.ts` 和 `custom-footer.ts`，同时给其 `.mjs` helper 增加新导出后，执行 `/reload` 报 `installCompactSkillRenderer is not a function` 和 `createFooterComponent is not a function`。彻底重启 Pi 后错误消失。

## 2. 影响

用户无法依赖 `/reload` 应用扩展更新；两个 `session_start` handler 抛错后，Skill 样式和自定义 Footer 均无法正常安装。

## 3. 稳定复现

1. 在 Pi 进程中先加载不含新导出的 `.mjs` helper。
2. 不退出进程，为 helper 增加导出，并让 `.ts` 扩展入口调用它。
3. 执行 `/reload`。
4. 新入口被执行，但拿到旧 `.mjs` namespace，新导出为 `undefined`。

## 4. 证据

Pi 0.81.1 的 extension loader 在 reload 时调用 `clearExtensionCache()`，并为 jiti 设置 `moduleCache: false`；但 Node 路径没有设置 `tryNative: false`。`.mjs` 依赖因此可由原生 ESM 加载并保留在进程缓存中。新进程 smoke test通过，而同进程 `/reload` 失败，与该缓存边界一致。

## 5. 根因

扩展更新把 reload 必需的新行为放进了原生 ESM helper，并假设 Pi 清理入口缓存时也会清理传递依赖。实际 `/reload` 只保证扩展入口重新加载，不保证原生 `.mjs` 依赖 namespace 更新。

## 6. 修复与验证策略

新增且必须热更新的 Skill 安装和 Footer 组件逻辑放回 `.ts` 扩展入口；`.mjs` 仅保留 reload 前已经存在、签名稳定的 helper 调用和独立单元测试。增加入口依赖边界测试，禁止再次从 `.mjs` 引入这两个新增导出，并运行同进程 reload fixture、单元测试和扩展加载 smoke test。
