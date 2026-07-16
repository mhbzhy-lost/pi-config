# Bug：Subagent Agent Loader 边界校验缺陷

## 1. 现象

Subagent profile loader 在部分平台可能错误判断 realpath 是否位于 agent 根目录内；未配置 `PI_CODING_AGENT_DIR` 时还会读取相对 `agents` 目录；部分 Pi 合法 thinking 等级被错误拒绝。

## 2. 影响

路径边界判断失效会削弱不可信 profile 的隔离保证。相对路径回退会让运行目录影响 profile 来源。合法的 Pi thinking 配置无法加载，导致子代理启动失败。

## 3. 稳定复现

调用 `isPathWithin()` 判断包含父目录前缀的路径；未传 `agentDir` 且环境变量缺失或为空；profile 的 thinking 为 `minimal`、`medium`、`xhigh` 或 `max`。

## 4. 证据

新增 RED 测试证明 `delimiter` 无法识别 `../outside` 路径组件；删除 `PI_CODING_AGENT_DIR` 后旧默认值会读取相对 `agents/`；`minimal/medium/xhigh/max` profile 会被旧枚举拒绝。

## 5. 根因

实现把 `node:path` 的 `delimiter` 当作路径组件分隔符使用；`delimiter` 是环境变量列表分隔符，而路径组件分隔符应为 `sep`。默认参数先将空变量拼接为 `agents`。thinking 枚举只覆盖了部分 Pi 0.80.6 合法等级。

## 6. 修复与验证策略

使用 `sep` 做路径边界判断；在解析默认目录前显式校验环境变量；枚举 Pi 0.80.6 的全部合法 thinking 等级。保持 symlink、越界 realpath 与 task 工具的拒绝策略。

新增 `isPathWithin()` 的路径边界测试、缺失与空环境变量测试，以及所有合法 thinking 等级的加载测试；继续执行既有 exact profile、symlink、task 与非法 thinking 测试，共 11 项。
