# Bug: external review 缺少项目配置仓库根

## 现象

`external-llm-review` 的命令使用 `${PI_CONFIG_HOME}/skill-overrides/external-llm-review`，但加载 `scripts/pi-shell.zsh` 后并未导出 `PI_CONFIG_HOME`。因此这些命令无法直接解析 reviewer 路径。

## 根因

shell 初始化只导出 Pi 官方配置根变量 `PI_CODING_AGENT_DIR`，其值为仓库中的 `pi/` 子目录；没有单独导出本项目的仓库根变量。

## 影响

用户按 skill 中现有命令配置 provider 或运行 reviewer 时，路径会从空变量开始，导致命令失败或定位到错误位置。

## 修复

在 `scripts/pi-shell.zsh` 导出项目自定义的 `PI_CONFIG_HOME="$_PI_CONFIG_ROOT"`，使其解析为 `~/pi-config` 仓库根；继续将 Pi 官方 `PI_CODING_AGENT_DIR` 保持为 `~/pi-config/pi`。新增 source shell 的集成测试，验证两者的实际值与父子路径关系。

## 防复发

skill 正文明确 `PI_CONFIG_HOME` 是本项目自定义仓库根变量，不是 Pi 官方变量；所有 `${PI_CONFIG_HOME}` 命令路径应在加载 shell 后可直接解析。
