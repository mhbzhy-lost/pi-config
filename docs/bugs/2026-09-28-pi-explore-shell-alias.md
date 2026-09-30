# pi-explore shell 命令缺失

## 现象
在 clone 内执行 `zsh -f -c 'source scripts/pi-shell.zsh; pi-explore --version'` 时退出码为 127，stderr 为 `command not found: pi-explore`。`test/pi-shell.test.mjs` 的精确用例同样失败。

## 数据来源与双列归因
- production 配置来源：`scripts/pi-shell.zsh`（HEAD）。文件实际只定义 `pi-lite()`，没有题约定的 `pi-explore()`。
- 测试来源：`test/pi-shell.test.mjs:172` 通过 zsh 真实 source 该文件，再调用 `pi-explore`，不是手工拼接 shell 函数。
- `zsh -f` 不读取用户启动文件；因此不存在用户配置污染。`PI_REAL_BIN` 仅用于 fake launcher，且失败发生在调用 launcher 之前。
- 归类：预期 production 配置未正确处理（production 缺陷），不是测试污染。

## 首个偏离点
`source scripts/pi-shell.zsh` 完成后，`whence -f pi-explore` 返回空，而 `whence -f pi-lite` 返回函数定义。测试约定、README/历史提交目标命名为 `pi-explore`，但 HEAD 配置函数名为 `pi-lite`。

## 生成调用链
`test/pi-shell.test.mjs` → `spawnSync("zsh", ["-f", "-c", "source .../scripts/pi-shell.zsh; pi-explore --version"])` → zsh source → `scripts/pi-shell.zsh` 仅注册 `pi-lite` → zsh 命令解析失败（127）。

## 修复与验证
将配置入口从 `pi-lite` 改为 `pi-explore`，保持原有参数与 launcher 调用不变；随后用上述 zsh 命令和 shell 专项测试验证。

## 用户决策（2026-09-29，晚于 R2a 修复）

统一命名定为 **pi-lite**（覆盖 R2a 的 pi-explore 方向；主仓未提交改动同为此方向）。新仓已回退 R2a 改名：`scripts/pi-shell.zsh` 函数改回 `pi-lite()`，`test/pi-shell.test.mjs` 同步（TDD：测试先改 RED → 函数改名 GREEN，9/9）。本记录保留 R2a 的历史事实不动。新仓工作区现与主仓未提交状态在命名上收敛，T12 merge 此项无冲突。
