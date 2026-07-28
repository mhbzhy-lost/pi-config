#!/usr/bin/env bash
# TMCP plugin 一键 setup
# 检查并补齐:Node → npm 用户级 prefix → ~/.npmrc 阿里 registry/token
#           → @ali/ultima 安装 → BUC 登录引导 → TMCP token
# 幂等可重入,已就绪步骤自动跳过。
#
# 不做的事(plugin 物理上做不到):
#  - 装 Node:Claude Bash 无 sudo + 跨平台差异大;只能给链接
#  - 跑 um login / ncs login:浏览器 SSO 必须用户在自己 Terminal 完成,Claude 跑会 hang

set -e

REGISTRY="https://registry.anpm.alibaba-inc.com"
NPMRC="$HOME/.npmrc"
NPM_GLOBAL="$HOME/.npm-global"
UM_BIN="$NPM_GLOBAL/bin/um"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=version.sh
source "$SCRIPT_DIR/version.sh"

# 兜底 PATH,让 npm/node/ncs 在 Claude minimal PATH 里也能找到
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.npm-global/bin:$PATH"

say() { echo "$@"; }
warn() { echo "$@" >&2; }

say "▶ TMCP plugin setup —— 检查并补齐前置..."
say ""

# ---- Step 1: node 20+ -----------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  warn "✗ 未找到 node。请先装 Node 20+(LTS):"
  warn "  macOS:  https://nodejs.org 下载 .pkg(装到 /usr/local/bin/node,不要用 nvm)"
  warn "  Linux:  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs"
  warn "  装完回 Claude 重跑此脚本。"
  exit 1
fi
NODE_MAJOR=$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 20 ] 2>/dev/null; then
  warn "✗ Node 版本 $(node --version) 太老,需要 >= v20"
  warn "  升级:macOS 走 https://nodejs.org;nvm 用户跑 'nvm install 20 && nvm alias default 20'"
  exit 1
fi
say "✓ node: $(node --version)"

# ---- Step 2: npm + 用户级 prefix(避免 sudo)-----------------------------
if ! command -v npm >/dev/null 2>&1; then
  warn "✗ npm 未找到(node 装好通常自带 npm,检查 node 安装)"
  exit 1
fi
CUR_PREFIX="$(npm config get prefix 2>/dev/null || true)"
if [ "$CUR_PREFIX" != "$NPM_GLOBAL" ]; then
  say "▶ 设置 npm 用户级 prefix → $NPM_GLOBAL(避免 sudo)"
  mkdir -p "$NPM_GLOBAL/bin"
  npm config set prefix "$NPM_GLOBAL" >/dev/null
fi
say "✓ npm prefix: $(npm config get prefix)"

# ---- Step 3: ~/.npmrc 阿里 registry + _authToken --------------------------
need_registry=1
need_token=1
[ -f "$NPMRC" ] && grep -q '^@ali:registry=https://registry.anpm.alibaba-inc.com' "$NPMRC" && need_registry=0
[ -f "$NPMRC" ] && grep -qE '^//registry\.anpm\.alibaba-inc\.com/:_authToken=[^[:space:]]+' "$NPMRC" && need_token=0

if [ $need_registry -eq 1 ]; then
  say "▶ 配置 @ali:registry → $REGISTRY"
  npm config set @ali:registry "$REGISTRY" >/dev/null
else
  say "✓ ~/.npmrc 已含 @ali:registry"
fi

if [ $need_token -eq 1 ]; then
  say "▶ ~/.npmrc 缺 anpm token,尝试用 ncs 获取..."
  if ! command -v ncs >/dev/null 2>&1; then
    warn ""
    warn "✗ ncs CLI 未安装,plugin 无法自动拿 npm token。"
    warn "  请在你自己的 Terminal(不是 Claude)执行:"
    warn ""
    warn "    brew install ncs        # macOS;Linux 内网下载"
    warn "    ncs login               # 浏览器 BUC SSO"
    warn ""
    warn "  完成后回 Claude 重跑此脚本即可。"
    exit 1
  fi
  if ! ncs whoami >/dev/null 2>&1; then
    warn ""
    warn "✗ ncs 未登录。请在你自己的 Terminal 跑:"
    warn ""
    warn "    ncs login"
    warn ""
    warn "  完成后回 Claude 重跑此脚本。"
    exit 1
  fi
  # 用 ncs 拿 token(子命令名兼容老 ncs)
  TOKEN=""
  for cmd in 'ncs npm-token' 'ncs token --type npm' 'ncs npm token'; do
    TOKEN=$($cmd 2>/dev/null | tr -d '[:space:]') && [ -n "$TOKEN" ] && break
    TOKEN=""
  done
  if [ -z "$TOKEN" ]; then
    warn "✗ ncs 拿 token 失败,试试 'ncs --help' 看你的版本支持哪个子命令,然后手动:"
    warn "    npm config set //registry.anpm.alibaba-inc.com/:_authToken <token>"
    exit 1
  fi
  # 用 npm config 写入,避免手撸 .npmrc 跟其他工具(tnpm switcher 等)冲突
  npm config set //registry.anpm.alibaba-inc.com/:_authToken "$TOKEN" >/dev/null
  say "✓ anpm token 已通过 ncs 写入"
else
  say "✓ ~/.npmrc 已含 anpm token"
fi

# ---- Step 4: 装 um(若未装或版本不对)-------------------------------------
need_install=0
if [ ! -x "$UM_BIN" ]; then
  need_install=1
elif ! "$UM_BIN" --version >/dev/null 2>&1; then
  need_install=1
elif ! tmcp_semver_at_least "$("$UM_BIN" --version 2>/dev/null)" "$TMCP_MIN_UM_VERSION"; then
  warn "⚠ um $("$UM_BIN" --version 2>/dev/null) 低于 $TMCP_MIN_UM_VERSION,尝试升级..."
  need_install=1
elif ! "$UM_BIN" tmcp --help >/dev/null 2>&1; then
  warn "⚠ um 已装但不支持 tmcp 子命令,尝试升级..."
  need_install=1
fi

if [ $need_install -eq 1 ]; then
  say "▶ 安装 @ali/ultima@latest(要求 >=$TMCP_MIN_UM_VERSION,可能需要 30-90 秒)..."
  if ! npm install -g @ali/ultima@latest 2>&1; then
    warn "✗ npm install 失败,常见原因:"
    warn "  - 内网/VPN 不通:测 'curl -sf $REGISTRY/'"
    warn "  - token 过期:在自己 Terminal 重跑 'ncs login' 后再来"
    warn "  - 权限:确认 'npm config get prefix' = $NPM_GLOBAL"
    exit 1
  fi
fi
[ -x "$UM_BIN" ] || { warn "✗ um 装完仍不存在,检查 npm prefix 设置"; exit 1; }
UM_VERSION=$("$UM_BIN" --version 2>/dev/null || true)
if ! tmcp_semver_at_least "$UM_VERSION" "$TMCP_MIN_UM_VERSION"; then
  warn "✗ um 安装后版本仍为 ${UM_VERSION:-unknown},需要 >=$TMCP_MIN_UM_VERSION"
  exit 1
fi
say "✓ um CLI: $UM_VERSION (>=$TMCP_MIN_UM_VERSION) @ $UM_BIN"

# ---- Step 5: BUC 登录(必须用户参与,plugin 只引导)-----------------------
if ! "$UM_BIN" whoami >/dev/null 2>&1; then
  warn ""
  warn "▶ BUC 未登录,这一步必须你来跑(我跑会 hang):"
  warn ""
  warn "  $UM_BIN login"
  warn ""
  warn "  浏览器会弹 BUC SSO,完成工号 + 二次验证后回 Claude 重跑此脚本验证。"
  warn "  SSH/容器:um 0.2.x 不支持纯 CLI 登录,先在有 GUI 的机器 'um login',然后拷 ~/.um/ 整目录"
  exit 2
fi
say "✓ BUC: $("$UM_BIN" whoami 2>/dev/null)"

# ---- Step 6: TMCP token ---------------------------------------------------
if ! "$UM_BIN" tmcp token show >/dev/null 2>&1; then
  say "▶ 获取 TMCP token..."
  if ! "$UM_BIN" tmcp token 2>&1; then
    warn "✗ TMCP token 获取失败,跑 '$UM_BIN tmcp doctor' 看详情"
    exit 1
  fi
fi
say "✓ TMCP token 已就绪"

say ""
say "✓ TMCP plugin 已就绪。直接说 'um tmcp xxx' 即可,plugin wrapper 会自动找到 um。"
say "  - 健康检查:bash $(dirname "$0")/check-prereqs.sh"
say "  - 全面体检:um tmcp doctor"
