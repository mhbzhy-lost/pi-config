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
