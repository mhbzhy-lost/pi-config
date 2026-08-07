typeset -g _PI_CONFIG_ROOT="${${(%):-%N}:A:h:h}"
typeset -g _PI_CONFIG_UPSTREAM_PI="${PI_REAL_BIN:-${commands[pi]:-}}"

export PI_CODING_AGENT_DIR="$_PI_CONFIG_ROOT/pi"
export PI_CODING_AGENT_SESSION_DIR="${PI_CODING_AGENT_SESSION_DIR:-$_PI_CONFIG_ROOT/var/sessions}"
export PI_CODING_GOAL_DIR="${PI_CODING_GOAL_DIR:-$_PI_CONFIG_ROOT/var/goals}"

_pi_config_invoke() {
  if [[ -z "$_PI_CONFIG_UPSTREAM_PI" || ! -x "$_PI_CONFIG_UPSTREAM_PI" ]]; then
    print -u2 -- "pi executable not found; set PI_REAL_BIN"
    return 1
  fi

  "$_PI_CONFIG_UPSTREAM_PI" --no-skills "$@"
}

_pi_config_alt_screen() (
  local restored=0
  _pi_config_restore_screen() {
    if (( ! restored )); then
      printf '\033[?1049l'
      restored=1
    fi
  }

  trap _pi_config_restore_screen EXIT HUP INT TERM
  printf '\033[?1049h\033[2J\033[H'
  _pi_config_invoke "$@"
)

pi() {
  local mode="${PI_ALT_SCREEN:-never}"
  if [[ "$mode" == "always" || ( "$mode" == "auto" && -t 0 && -t 1 ) ]]; then
    _pi_config_alt_screen "$@"
  else
    _pi_config_invoke "$@"
  fi
}

pi-inline() {
  _pi_config_invoke "$@"
}

pi-full() {
  _pi_config_alt_screen "$@"
}
