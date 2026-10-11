typeset -g _PI_CONFIG_ROOT="${${(%):-%N}:A:h:h}"

export PI_CONFIG_HOME="$_PI_CONFIG_ROOT"
export PI_CODING_AGENT_DIR="$_PI_CONFIG_ROOT/pi"
export PI_CODING_AGENT_SESSION_DIR="${PI_CODING_AGENT_SESSION_DIR:-$_PI_CONFIG_ROOT/var/sessions}"
# 时的用户覆盖通道。若优先级颠倒，用户 shell 中残留的旧仓导出值会泄漏进新仓会话
# （docs/bugs/2026-09-29-pi-shell-inherits-cross-repo-state-roots.md）。
export PI_CODING_GOAL_DIR="${PI_CODING_AGENT_GOAL_DIR:-${PI_CODING_GOAL_DIR:-$_PI_CONFIG_ROOT/var/goals}}"
export PI_CODING_WORKSPACE_DIR="${PI_CODING_AGENT_WORKSPACE_DIR:-${PI_CODING_WORKSPACE_DIR:-$_PI_CONFIG_ROOT/var/workspaces}}"

# 普通入口使用 Pi 原生 Skill 发现，不隐式传 --no-skills；
# 用户显式 --no-skills 经 "$@" 原样转发，pi-lite 在自身分支显式禁用。
_pi_config_invoke() {
  "$_PI_CONFIG_ROOT/scripts/pi-launcher.zsh" "$@"
}

pi() {
  # _pi_config_invoke "$@"
  _pi_config_invoke --tui-mode fullscreen "$@"
}

pi-inline() {
  _pi_config_invoke --tui-mode regular "$@"
}

pi-full() {
  pi "$@"
}

# 精简版只读探索模式：不加载上下文文件/extensions/skills 发现与 prompt 模板，
# 仅显式挂载 exa-search 与 playwright 两个 skill，且只保留 read/bash 工具。
# 依赖：exa-search 使用 Python CLI，playwright 使用 Node TypeScript SDK 入口，均不依赖 extension；
# launcher 显式追加的 session-owner extension 在 --no-extensions 下仍会加载。
pi-lite() {
  _pi_config_invoke \
    --no-skills \
    -nc \
    -na \
    --no-extensions \
    --no-prompt-templates \
    --skill "$_PI_CONFIG_ROOT/skill-overrides/exa-search/SKILL.md" \
    --skill "$_PI_CONFIG_ROOT/skill-overrides/playwright/SKILL.md" \
    --tools read,bash \
    "$@"
}
