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

# ---- pi-web 局域网共享：tmux 包裹 + server 自启 ----
typeset -g _PI_WEB_PORT="${PI_WEB_PORT:-7681}"

# 探活 pi-web server；未跑则后台拉起（端口被占时 server 启动失败自退，天然幂等）。
# 可选 PI_WEB_TOKEN 环境变量作为访问令牌。
_pi_ensure_web_server() {
  command -v curl >/dev/null 2>&1 || return 0
  command -v node >/dev/null 2>&1 || return 0
  if curl -fsS -m 1 "http://127.0.0.1:${_PI_WEB_PORT}/api/sessions" >/dev/null 2>&1; then
    return 0
  fi
  local -a token_args=()
  [[ -n "${PI_WEB_TOKEN:-}" ]] && token_args=(--token "$PI_WEB_TOKEN")
  nohup node "${_PI_CONFIG_ROOT}/scripts/pi-web.ts" --port "${_PI_WEB_PORT}" "${token_args[@]}" \
    >>"${TMPDIR:-/tmp}/pi-web-server.log" 2>&1 &!
  local ip
  ip="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
  if [[ -n "$ip" ]]; then
    print -P "%F{cyan}pi-web 已自动启动，手机访问 http://${ip}:${_PI_WEB_PORT}%f"
  fi
}

# tmux 全局 TUI 调优（幂等）：Esc 低延迟、真彩色、修饰键穿透（pi 官方 tmux 建议）
_pi_tmux_tune() {
  tmux set-option -s escape-time 10 >/dev/null 2>&1 || true
  tmux set-option -as terminal-overrides ',*:RGB' >/dev/null 2>&1 || true
  tmux set-option -g extended-keys on >/dev/null 2>&1 || true
  tmux set-option -g extended-keys-format csi-u >/dev/null 2>&1 || true
  # mouse on：备用屏应用（pi fullscreen）自带滚轮处理，tmux 默认转发；主屏会话走 copy-mode，
  # 并重绑为逐行滚动（默认 5 行，触屏不跟手）。多命令必须整条单参数传入。
  tmux set-option -g mouse on >/dev/null 2>&1 || true
  # 恢复出厂默认：备用屏应用（pi）转发滚轮自滚，主屏会话进 copy-mode；
  # 手写同款 if-shell 绑定时嵌套 format 求值异常，故用 unbind 回落到默认。
  tmux unbind-key -T root WheelUpPane >/dev/null 2>&1 || true
  tmux bind-key -T copy-mode WheelUpPane 'select-pane ; send-keys -X -N 1 scroll-up' >/dev/null 2>&1 || true
  tmux bind-key -T copy-mode WheelDownPane 'select-pane ; send-keys -X -N 1 scroll-down' >/dev/null 2>&1 || true
  tmux bind-key -T copy-mode-vi WheelUpPane 'select-pane ; send-keys -X -N 1 scroll-up' >/dev/null 2>&1 || true
  tmux bind-key -T copy-mode-vi WheelDownPane 'select-pane ; send-keys -X -N 1 scroll-down' >/dev/null 2>&1 || true
}

# 按当前目录生成 tmux 会话名：pi-<目录名>-<路径哈希4>-<序号>，同目录多开自动递增
_pi_session_name() {
  local base hash prefix n
  base="${PWD:t}"
  base="${base//[^A-Za-z0-9_-]/_}"
  [[ -n "$base" ]] || base=root
  hash="$(printf '%s' "$PWD" | md5 -q 2>/dev/null)"
  [[ -n "$hash" ]] || hash="$(printf '%s' "$PWD" | md5sum 2>/dev/null | cut -c1-4)"
  hash="${hash:0:4}"
  prefix="pi-${base}-${hash}"
  n=1
  while tmux has-session -t "${prefix}-${n}" 2>/dev/null; do
    (( n += 1 ))
  done
  print -r -- "${prefix}-${n}"
}

pi() {
  # 版本/帮助类快速参数不进 tmux，直接透传；其余（含无参数）均走 tmux 共享模式
  if [[ $# -gt 0 && ' --version -V --help -h ' == *" $1 "* ]]; then
    _pi_config_invoke --tui-mode fullscreen "$@"
    return
  fi
  # 已在 tmux 内：维持原路径（此会话本身就能被手机经 pi-web 列表接入）
  if [[ -n "${TMUX:-}" ]]; then
    _pi_config_invoke --tui-mode fullscreen "$@"
    return
  fi
  # tmux 不可用时降级为原路径
  if ! command -v tmux >/dev/null 2>&1; then
    _pi_config_invoke --tui-mode fullscreen "$@"
    return
  fi
  _pi_ensure_web_server
  _pi_tmux_tune
  local cols rows name
  cols="${COLUMNS:-$(tput cols 2>/dev/null)}"
  rows="${LINES:-$(tput lines 2>/dev/null)}"
  cols="${cols:-100}"
  rows="${rows:-30}"
  name="$(_pi_session_name)"
  tmux new-session -s "$name" -x "$cols" -y "$rows" \
    "$_PI_CONFIG_ROOT/scripts/pi-launcher.zsh" --tui-mode fullscreen "$@"
}

  # 精简版只读探索模式：不加载上下文文件和普通 extensions，显式加载 search/browser
  # 与 tool_search；launcher 追加的 session-owner extension
# 在 --no-extensions 下仍会加载。
pi-lite() {
  _pi_config_invoke \
    -nc \
    -na \
    --no-extensions \
    --no-prompt-templates \
    -e "$_PI_CONFIG_ROOT/src/search/search.ts" \
    -e "$_PI_CONFIG_ROOT/src/browser/browser.ts" \
    -e builtin:tool-search \
    --tools read,bash,tool_search,search,browser \
    "$@"
}
