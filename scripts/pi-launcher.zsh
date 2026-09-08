#!/usr/bin/env zsh
emulate -LR zsh
setopt err_return no_unset pipe_fail

root=${${(%):-%N}:A:h:h}
launcher_path=${(%):-%N:A}
if [[ -n "${PI_REAL_BIN:-}" ]]; then
  [[ "$PI_REAL_BIN" == /* ]] || { print -u2 -- "PI_REAL_BIN must be an absolute executable path"; exit 1; }
  real_bin=${PI_REAL_BIN:A}
else
  real_bin=$(whence -p pi 2>/dev/null) || { print -u2 -- "pi executable not found; set PI_REAL_BIN"; exit 1; }
  real_bin=${real_bin:A}
fi
[[ -f "$real_bin" && -x "$real_bin" && "$real_bin" != "$launcher_path" ]] || { print -u2 -- "pi executable not found; set PI_REAL_BIN"; exit 1; }

decision_dir=$(mktemp -d "${TMPDIR:-/tmp}/pi-session-owner.XXXXXXXX") || exit 1
chmod 700 "$decision_dir" || { rmdir "$decision_dir"; exit 1; }
cleanup() { rm -rf -- "$decision_dir" }
trap cleanup EXIT HUP INT TERM

private_file() {
  local path=$1 metadata uid mode
  [[ -f "$path" && ! -L "$path" ]] || return 1
  if [[ "$(/usr/bin/uname -s)" == Darwin ]]; then metadata=$(/usr/bin/stat -f '%u %Lp' -- "$path")
  else metadata=$(/usr/bin/stat -c '%u %a' -- "$path"); fi
  uid=${metadata%% *}; mode=${metadata##* }
  [[ "$uid" == "$EUID" && "$mode" == 600 ]]
}
private_directory() {
  local path=$1 metadata uid mode
  [[ -d "$path" && ! -L "$path" ]] || return 1
  if [[ "$(/usr/bin/uname -s)" == Darwin ]]; then metadata=$(/usr/bin/stat -f '%u %Lp' -- "$path")
  else metadata=$(/usr/bin/stat -c '%u %a' -- "$path"); fi
  uid=${metadata%% *}; mode=${metadata##* }
  [[ "$uid" == "$EUID" && "$mode" == 700 ]]
}
private_text() {
  local path="$decision_dir/$1"
  private_file "$path" || return 1
  REPLY=$(<"$path")
  [[ "$REPLY" != *$'\n'* && "$REPLY" != *$'\r'* ]]
}

stdin_tty=0; stdout_tty=0
[[ -t 0 ]] && stdin_tty=1
[[ -t 1 ]] && stdout_tty=1
node "$root/scripts/pi-session-owner.ts" prepare --pid "$$" --cwd "$PWD" --stdin-tty "$stdin_tty" --stdout-tty "$stdout_tty" --decision-dir "$decision_dir" --pi-binary "$real_bin" -- "$@" >/dev/null || exit 1

private_directory "$decision_dir" || { print -u2 -- "Pi launch decision is invalid"; exit 1; }
private_text action || { print -u2 -- "Pi launch decision is invalid"; exit 1; }
action=$REPLY
case "$action" in
  blocked) print -u2 -- 'Pi session 已阻断：目标正被其他 Pi 使用。请回到原窗口；或运行普通 `pi` 新建 session；关闭占用窗口后重试 `pi -c`。'; exit 1 ;;
  bypass)
    unset PI_SESSION_OWNER_ID PI_SESSION_OWNER_REGISTRY
    cleanup; trap - EXIT HUP INT TERM
    exec "$real_bin" "$@"
    ;;
  pass|pin-session) ;;
  *) print -u2 -- "Pi launch decision is invalid"; exit 1 ;;
esac
private_text owner-id || { print -u2 -- "Pi launch decision is invalid"; exit 1; }
owner_id=$REPLY
[[ "$owner_id" =~ '^[A-Za-z0-9][A-Za-z0-9._-]{7,159}$' ]] || { print -u2 -- "Pi launch decision is invalid"; exit 1; }

args=("$@")
if [[ "$action" == pin-session ]]; then
  private_text continue-arg-index || { print -u2 -- "Pi launch decision is invalid"; exit 1; }
  continue_index=$REPLY
  [[ "$continue_index" =~ '^[0-9]+$' && "$continue_index" -lt ${#args} ]] || { print -u2 -- "Pi launch decision is invalid"; exit 1; }
  [[ "${args[$((continue_index + 1))]}" == -c || "${args[$((continue_index + 1))]}" == --continue ]] || { print -u2 -- "Pi launch decision is invalid"; exit 1; }
  session_file="$decision_dir/session-path"
  private_file "$session_file" || { print -u2 -- "Pi launch decision is invalid"; exit 1; }
  exec {session_fd}<"$session_file"
  IFS= read -r -d '' -u $session_fd session_path || { exec {session_fd}<&-; print -u2 -- "Pi launch decision is invalid"; exit 1; }
  if IFS= read -r -d '' -u $session_fd extra; then
    exec {session_fd}<&-; print -u2 -- "Pi launch decision is invalid"; exit 1
  elif [[ -n "$extra" ]]; then
    exec {session_fd}<&-; print -u2 -- "Pi launch decision is invalid"; exit 1
  fi
  exec {session_fd}<&-
  [[ -n "$session_path" && -e "$session_path" ]] || { print -u2 -- "Pi launch decision is invalid"; exit 1; }
  rewritten=()
  for (( index = 1; index <= ${#args}; index += 1 )); do
    (( index == continue_index + 1 )) || rewritten+=("${args[index]}")
  done
  args=(--session "$session_path" "${rewritten[@]}")
fi
export PI_SESSION_OWNER_ID="$owner_id"
export PI_SESSION_OWNER_REGISTRY="${PI_SESSION_OWNER_REGISTRY:-${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/pi-session-owner-${EUID}}"
cleanup; trap - EXIT HUP INT TERM
exec "$real_bin" -e "$root/pi/extensions/session-owner.ts" "${args[@]}"
