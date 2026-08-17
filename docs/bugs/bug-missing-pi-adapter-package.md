# Bug: Pi settings 引用了缺失的本地 adapter package

## 路径解析与缺失状态

`pi/settings.json` 的 `packages` 数组包含相对字符串 `../../.r2c/integrations/pi-adapter`。相对 `pi/settings.json` 所在目录解析后，其目标为 `/Users/mhbzhy/.r2c/integrations/pi-adapter`。该路径当前不存在，且不是悬空软链接。

仓库中没有该 adapter 的源代码或安装器；`init-pi.sh` 也不能恢复它。因此该本地 package 引用在本仓不可恢复。

## 当前行为与影响

Pi 0.84.2 会静默跳过缺失的本地 package，所以当前实际加载结果未因该引用而增加 adapter 功能。配置却保留了无效入口，容易让维护者误以为 session trace adapter 已被安装，并使未来诊断产生歧义。

## 删除方案

仅从 `pi/settings.json` 的 `packages` 数组删除精确字符串 `../../.r2c/integrations/pi-adapter`；保留 `npm:pi-subagents@0.45.2` 及所有其他设置。未来若需要 session trace，必须通过可信 collector 安装器重新安装，而不创建占位目录或伪造 adapter。

## RED 记录

在删除配置前执行 `node --test test/pi-adapter-settings.test.mjs`：共 2 项，1 项通过、1 项失败。失败项为 `Pi settings omit the missing local adapter package`，其 `settings.packages.includes("../../.r2c/integrations/pi-adapter")` 仍为真，确认测试覆盖了悬空配置。
