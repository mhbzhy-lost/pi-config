typeset -g _PI_CONFIG_ROOT="${${(%):-%N}:A:h:h}"
typeset -g _PI_CONFIG_UPSTREAM_PI="${PI_REAL_BIN:-${commands[pi]:-}}"

export PI_CODING_AGENT_DIR="$_PI_CONFIG_ROOT/pi"
export PI_CODING_AGENT_SESSION_DIR="${PI_CODING_AGENT_SESSION_DIR:-$_PI_CONFIG_ROOT/var/sessions}"

pi() {
  if [[ -z "$_PI_CONFIG_UPSTREAM_PI" || ! -x "$_PI_CONFIG_UPSTREAM_PI" ]]; then
    print -u2 -- "pi executable not found; set PI_REAL_BIN"
    return 1
  fi

  "$_PI_CONFIG_UPSTREAM_PI" --no-skills "$@"
}

pi-full() (
  local restored=0
  _pi_full_restore() {
    if (( ! restored )); then
      printf '\033[?1049l'
      restored=1
    fi
  }

  trap _pi_full_restore EXIT HUP INT TERM
  printf '\033[?1049h\033[2J\033[H'
  pi "$@"
)
