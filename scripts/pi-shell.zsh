typeset -g _PI_CONFIG_ROOT="${${(%):-%N}:A:h:h}"

export PI_CONFIG_HOME="$_PI_CONFIG_ROOT"
export PI_CODING_AGENT_DIR="$_PI_CONFIG_ROOT/pi"
export PI_CODING_AGENT_SESSION_DIR="${PI_CODING_AGENT_SESSION_DIR:-$_PI_CONFIG_ROOT/var/sessions}"
export PI_CODING_GOAL_DIR="${PI_CODING_GOAL_DIR:-$_PI_CONFIG_ROOT/var/goals}"
export PI_CODING_WORKSPACE_DIR="${PI_CODING_WORKSPACE_DIR:-$_PI_CONFIG_ROOT/var/workspaces}"

_pi_config_invoke() {
  "$_PI_CONFIG_ROOT/scripts/pi-launcher.zsh" --no-skills "$@"
}

pi() {
  _pi_config_invoke "$@"
}

pi-inline() {
  _pi_config_invoke --tui-mode regular "$@"
}

pi-full() {
  _pi_config_invoke --tui-mode fullscreen "$@"
}

# 精简版只读探索模式：不加载上下文文件/extensions/skills 发现与 prompt 模板，
# 仅显式挂载 exa-search 与 playwright 两个 skill，且只保留 read/bash 工具。
# 依赖：两个 skill 均为纯 bash 驱动的 python3 脚本，不依赖任何 extension；
# launcher 显式追加的 session-owner extension 在 --no-extensions 下仍会加载。
pi-lite() {
  _pi_config_invoke \
    -nc \
    -na \
    --no-extensions \
    --no-prompt-templates \
    --skill "$_PI_CONFIG_ROOT/skill-overrides/exa-search/SKILL.md" \
    --skill "$_PI_CONFIG_ROOT/skill-overrides/playwright/SKILL.md" \
    --tools read,bash \
    "$@"
}
