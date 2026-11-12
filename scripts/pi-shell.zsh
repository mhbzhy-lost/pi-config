typeset -g _PI_CONFIG_ROOT="${${(%):-%N}:A:h:h}"

export PI_CONFIG_HOME="$_PI_CONFIG_ROOT"
export PI_CODING_AGENT_DIR="$_PI_CONFIG_ROOT/pi"
export PI_CODING_AGENT_SESSION_DIR="${PI_CODING_AGENT_SESSION_DIR:-$_PI_CONFIG_ROOT/var/sessions}"
# 时的用户覆盖通道。若优先级颠倒，用户 shell 中残留的旧仓导出值会泄漏进新仓会话
# （docs/bugs/2026-09-29-pi-shell-inherits-cross-repo-state-roots.md）。
export PI_CODING_GOAL_DIR="${PI_CODING_AGENT_GOAL_DIR:-${PI_CODING_GOAL_DIR:-$_PI_CONFIG_ROOT/var/goals}}"
export PI_CODING_WORKSPACE_DIR="${PI_CODING_AGENT_WORKSPACE_DIR:-${PI_CODING_WORKSPACE_DIR:-$_PI_CONFIG_ROOT/var/workspaces}}"

_pi_config_invoke() {
  "$_PI_CONFIG_ROOT/scripts/pi-launcher.zsh" "$@"
}

pi() {
  # _pi_config_invoke "$@"
  _pi_config_invoke --tui-mode fullscreen "$@"
}

# 精简版只读探索模式：不加载上下文文件和普通 extensions，显式加载 progressive tools、
# tool_search 与工具调用时间注入，因此可按需发现 search/browser；launcher 追加的 session-owner extension
# 在 --no-extensions 下仍会加载。
pi-lite() {
  _pi_config_invoke \
    -nc \
    -na \
    --no-extensions \
    --no-prompt-templates \
    -e "$_PI_CONFIG_ROOT/src/progressive-tools/progressive-tools.ts" \
    -e builtin:tool-search \
    -e "$_PI_CONFIG_ROOT/src/tool-timing/tool-timing.ts" \
    --tools read,bash,tool_search \
    "$@"
}
