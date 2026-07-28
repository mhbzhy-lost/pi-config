# Bug：pi-subagents Watchdog 递归哈希大型 Submodule

## 1. 现象

在 `~/mega-aone-service` 新建 Pi 进程时，启动需要约一分钟并出现持续高 CPU 和高内存占用；每次执行 `/reload` 都会重复出现相同延迟。相同 Pi 配置在轻量目录中启动正常。

## 2. 影响

该仓库中的 Pi 冷启动、扩展重载和新会话初始化不可用或明显卡顿。一次无 session、离线冷启动的峰值内存约为 1.84GB；延迟与模型网络、session replay 和普通上下文文件加载无关。

## 3. 稳定复现

1. 使用固定了 `pi-subagents@0.35.1` 的当前 Pi 配置进入 `~/mega-aone-service`。
2. 保持 `plugins/crash_analyzer` submodule 工作区为 dirty 状态。
3. 离线启动无 session 的 Pi，或在已有 Pi 中执行 `/reload`。
4. `pi-subagents` extension factory 和 `session_start` 阶段稳定出现数十秒延迟及高 CPU、高内存占用。

## 4. 证据

禁用 extensions、skills、prompt templates、themes 和 context files 后，目标仓库启动仅需 0.68 秒；同一完整配置在 `/tmp` 启动约 1.15 秒。`PI_TIMING=1` 显示 `pi-subagents` 0.35.1 factory 单独约 22.97 秒。`git status --porcelain=v1 -z --untracked-files=all` 本身仅需 0.23 秒，但 0.35.1 的 `computeWatchdogRepoChangeSignature()` 需要 29.4 秒、峰值内存 1.78GB。目标 submodule `plugins/crash_analyzer` 为 Git mode `160000`，目录大小 8.0GB，包含 103,656 个文件。

升级后的真实 standalone RPC 门禁还显示 0.37.0 在原 RPC v1 方法集合中新增了 `steer`。原集成测试使用数组全等判断，因这个向后兼容的新增方法失败；兼容性评估器实际只要求 Plan Harness 依赖的必需方法存在，因此真实门禁也应采用相同的子集契约。

## 5. 根因

`pi-subagents@0.35.1` 的 main watchdog 在 extension 构造和 `session_start` 时都会建立仓库变更签名，即使 watchdog 默认关闭也不跳过。Git 将 dirty submodule 表示为单个修改目录后，该版本的 `hashPath()` 未识别嵌套 Git 工作树，而是递归读取目录内所有文件并计算 SHA-256。因此启动和 `/reload` 都会重复扫描 8.0GB submodule；仓库总体积只是放大条件，旧版 watchdog 的无界递归才是根因。

## 6. 修复与验证策略

将固定依赖升级到 `pi-subagents@0.37.0`。该版本包含 0.36.0 引入的针对性修复：watchdog 关闭时跳过仓库签名，启用时通过 Git 检查嵌套工作树，并限制签名哈希的文件大小、总字节数和条目数。同步初始化脚本、Plan Runtime 安装命令、Doctor 和兼容性门禁的精确版本；真实 RPC 测试按必需方法子集验收，允许 RPC v1 增加向后兼容的方法。最后在 `~/mega-aone-service` 使用无 session、离线 RPC 冷启动复测 extension factory、总耗时和峰值内存；不通过隐藏 submodule dirty 状态规避问题。

## 7. 验证结果

活动配置和安装目录均为 `pi-subagents@0.37.0`。版本与兼容性单测 29 项通过，真实 standalone RPC/async/Supervisor 门禁 3 项通过，扩展 reload 边界与紧凑 renderer 回归 30 项通过。在 `~/mega-aone-service` 使用当前完整配置离线冷启动时，总墙钟为 0.97 秒，`pi-subagents` factory 为 3ms，峰值内存约 211MB；通过公开 SDK 调用与 TUI `/reload` 相同的 `session.reload()` 耗时 145ms，extension errors 为 0。
