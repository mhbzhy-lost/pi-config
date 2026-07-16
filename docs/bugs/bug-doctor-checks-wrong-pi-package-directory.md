# Doctor 检查错误的 Pi Package 目录

## 现象

`pi install npm:pi-subagents@0.34.0` 成功后，doctor 仍报告 `missing Pi package: pi-subagents@0.34.0`。

## 影响范围

所有通过正式 `init-pi.sh`/Pi package manager 安装的环境都会被误报；手工伪造 `pi/node_modules` 的测试 fixture 才会通过。

## 复现步骤

设置 `PI_CODING_AGENT_DIR=<repo>/pi`，执行 `pi install npm:pi-subagents@0.34.0`，确认包位于 `pi/npm/node_modules/pi-subagents`，随后执行 `npm run doctor`。

## 根因

doctor 与 init fake 沿用了普通 npm prefix 的假设，检查 `pi/node_modules/pi-subagents`；Pi 0.80.6 package manager 实际维护独立的 `pi/npm/package.json` 和 `pi/npm/node_modules`。

## 修复方案

doctor 按 Pi 真实 package root `pi/npm/node_modules/pi-subagents` 检查精确版本、metadata extension 与可读入口；测试 fixture 和 init fake 同步真实布局，不增加旧路径兼容分支。

## 验证方式

健康 fixture 使用真实目录后通过；正式执行 `pi install` 后 `npm run doctor` 返回成功并仅输出已知 limitation warnings。
