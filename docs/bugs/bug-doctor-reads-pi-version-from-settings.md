# Doctor 从 Settings 读取不存在的 Pi 版本

## 现象

实际 `pi --version` 为 `0.80.6`，但 `npm run doctor` 报 `unexpected Pi version: unknown`。

## 影响范围

所有正常配置均会被 doctor 误报；测试 fixture 因人为写入 `settings.version` 而掩盖生产失败。

## 复现步骤

保留真实 `pi/settings.json`（仅含 `lastChangelogVersion` 等设置），执行 `npm run doctor`。doctor 读取不存在的 `version` 字段并报告 unknown。

## 根因

Pi 版本属于可执行文件属性，不是 settings schema 字段。Task 14 的实现为了保持纯文件检查，错误引入了虚构配置字段；健康 fixture 同步虚构该字段，导致测试与真实环境分叉。

## 修复方案

doctor 默认执行 `${PI_REAL_BIN:-pi} --version` 获取实际版本，并允许测试注入 `readPiVersion` 以保持 fixture 确定性。settings 继续只检查文件存在，不承载版本。

## 验证方式

单元测试分别注入 `0.80.6` 与错误版本，断言接受或精确报错；真实 `npm run doctor` 不再报告 Pi version unknown。
