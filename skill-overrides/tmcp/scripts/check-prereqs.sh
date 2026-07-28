#!/usr/bin/env bash
# TMCP plugin 前置自检(诊断用,不做安装)
# Claude 看到 um tmcp 报错时主动跑此脚本定位

# 不 set -e,要把所有检查都跑完
FAIL=0
NPM_GLOBAL="$HOME/.npm-global"
UM_BIN="$NPM_GLOBAL/bin/um"
NPMRC="$HOME/.npmrc"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=version.sh
source "$SCRIPT_DIR/version.sh"

# 兜底 PATH,让 npm/node 可达
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.npm-global/bin:$PATH"

# 1. node 20+
if command -v node >/dev/null 2>&1; then
  V=$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0)
  if [ "$V" -ge 20 ] 2>/dev/null; then
    echo "✓ node: $(node --version) (>=20)"
  else
    echo "✗ node 版本 $(node --version) 太老,需要 >= v20"
    FAIL=1
  fi
else
  echo "✗ node 未安装(需要 v20+)"
  FAIL=1
fi

# 2. npm prefix(用户级,避免 sudo)
if command -v npm >/dev/null 2>&1; then
  CUR=$(npm config get prefix 2>/dev/null || echo "")
  if [ "$CUR" = "$NPM_GLOBAL" ]; then
    echo "✓ npm prefix: $CUR"
  else
    echo "✗ npm prefix = $CUR(期望 $NPM_GLOBAL,setup.sh 会修)"
    FAIL=1
  fi
else
  echo "✗ npm 未找到(应随 node 一起安装)"
  FAIL=1
fi

# 3. ~/.npmrc 阿里 registry
if [ -f "$NPMRC" ] && grep -q '^@ali:registry=https://registry.anpm.alibaba-inc.com' "$NPMRC"; then
  echo "✓ ~/.npmrc 含 @ali:registry"
else
  echo "✗ ~/.npmrc 缺 @ali:registry(setup.sh 会修)"
  FAIL=1
fi

# 4. ~/.npmrc token
if [ -f "$NPMRC" ] && grep -qE '^//registry\.anpm\.alibaba-inc\.com/:_authToken=[^[:space:]]+' "$NPMRC"; then
  echo "✓ ~/.npmrc 含 anpm token"
else
  echo "✗ ~/.npmrc 缺 anpm token(setup.sh 会用 ncs 自动写入;需先 'ncs login')"
  FAIL=1
fi

# 5. um CLI
if [ -x "$UM_BIN" ] && "$UM_BIN" --version >/dev/null 2>&1; then
  UM_VERSION=$("$UM_BIN" --version 2>/dev/null)
  if tmcp_semver_at_least "$UM_VERSION" "$TMCP_MIN_UM_VERSION"; then
    echo "✓ um CLI: $UM_VERSION (>=$TMCP_MIN_UM_VERSION) @ $UM_BIN"
  else
    echo "✗ um CLI 版本 $UM_VERSION 太老,需要 >=$TMCP_MIN_UM_VERSION(setup.sh 会升级)"
    FAIL=1
  fi
  HAS_UM=1
else
  echo "✗ um CLI 未安装或不可执行"
  FAIL=1
  HAS_UM=0
fi

# 6. um tmcp 子命令
if [ "$HAS_UM" = "1" ]; then
  if "$UM_BIN" tmcp --help >/dev/null 2>&1; then
    echo "✓ um 支持 tmcp 子命令"
  else
    echo "✗ um 装了但不含 tmcp 子命令(版本太老,setup.sh 会升级)"
    FAIL=1
  fi
fi

# 7. BUC 登录
if [ "$HAS_UM" = "1" ]; then
  if "$UM_BIN" whoami >/dev/null 2>&1; then
    echo "✓ BUC 已登录: $("$UM_BIN" whoami 2>/dev/null)"
  else
    echo "✗ BUC 未登录(必须用户在自己 Terminal 跑 '$UM_BIN login')"
    FAIL=1
  fi
fi

# 8. TMCP token
if [ "$HAS_UM" = "1" ]; then
  if "$UM_BIN" tmcp token show >/dev/null 2>&1; then
    echo "✓ TMCP token 已就绪"
  else
    echo "✗ TMCP token 缺失或过期(setup.sh 会自动续)"
    FAIL=1
  fi
fi

echo ""
if [ "$FAIL" = "1" ]; then
  echo "→ 一键修复:bash $(dirname "$0")/setup.sh"
  echo "  注意:um login 必须你在自己 Terminal 跑(浏览器 BUC SSO),Claude 跑会 hang"
  exit 1
else
  echo "前置 OK。如仍有问题跑 '$UM_BIN tmcp doctor' 做更全面体检"
fi
