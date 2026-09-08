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
