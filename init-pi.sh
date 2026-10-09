#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PI_VERSION="1.0.4"
PI_PACKAGE="@earendil-works/pi-coding-agent@$PI_VERSION"
NPM_REGISTRY="https://registry.npmjs.org"
BASIC_MEMORY_VERSION="0.22.1"
ZSHRC_PATH="${ZDOTDIR:-$HOME}/.zshrc"
SHELL_INTEGRATION="$SCRIPT_DIR/scripts/pi-shell.zsh"
PI_LAUNCHER="$SCRIPT_DIR/scripts/pi-launcher.zsh"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

for required_command in git node npm zsh uv; do
  require_command "$required_command"
done

node_version="$(node -p 'process.versions.node')"
IFS=. read -r node_major node_minor node_patch <<< "$node_version"
if (( node_major < 22 || (node_major == 22 && node_minor < 19) )); then
  printf 'Node.js 22.19.0 or newer is required; found %s\n' "$(node --version)" >&2
  exit 1
fi

node "$SCRIPT_DIR/scripts/setup-subagent-runtime-deps.ts" --check-upgrade

# 仓库root拥有physical Host安装；不再修改global Pi。
export PI_HOST_ROOT="$SCRIPT_DIR/node_modules/@earendil-works/pi-coding-agent"
NPM_CONFIG_REGISTRY="$NPM_REGISTRY" npm_config_cache="$SCRIPT_DIR/var/tmp/npm-cache" npm --no-audit --no-fund --prefix "$SCRIPT_DIR" ci --ignore-scripts
pi_binary="$PI_HOST_ROOT/dist/cli.js"
export PI_REAL_BIN="$pi_binary"
export PI_PACKAGE_DIR="$PI_HOST_ROOT"
export PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT="$PI_HOST_ROOT"

NPM_CONFIG_REGISTRY="$NPM_REGISTRY" npm_config_cache="$SCRIPT_DIR/var/tmp/npm-cache" npm --no-audit --no-fund --prefix "$SCRIPT_DIR" run setup:subagents-enhanced

node "$SCRIPT_DIR/scripts/sync-skills.ts"
node "$SCRIPT_DIR/scripts/ensure-pi-settings.ts"

chmod +x "$PI_LAUNCHER"

mkdir -p "$(dirname -- "$ZSHRC_PATH")"
node - "$ZSHRC_PATH" "$SHELL_INTEGRATION" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [zshrcPath, integrationPath] = process.argv.slice(2);
const start = "# >>> pi-config >>>";
const end = "# <<< pi-config <<<";
let content = "";
let mode = 0o644;
if (fs.existsSync(zshrcPath)) {
  content = fs.readFileSync(zshrcPath, "utf8");
  mode = fs.statSync(zshrcPath).mode & 0o777;
}

const output = [];
let inManagedBlock = false;
for (const line of content.split(/\r?\n/)) {
  if (line === start) {
    inManagedBlock = true;
    continue;
  }
  if (inManagedBlock) {
    if (line === end) inManagedBlock = false;
    continue;
  }
  if (line.includes(integrationPath) && /\bsource\b/.test(line)) continue;
  output.push(line);
}
while (output.length > 0 && output.at(-1) === "") output.pop();

const shellQuote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
output.push("", start, `[[ -f ${shellQuote(integrationPath)} ]] && source ${shellQuote(integrationPath)}`, end, "");

const tempPath = path.join(path.dirname(zshrcPath), `.${path.basename(zshrcPath)}.${process.pid}.tmp`);
fs.writeFileSync(tempPath, output.join("\n"), { mode });
fs.renameSync(tempPath, zshrcPath);
fs.chmodSync(zshrcPath, mode);
NODE
printf '[ok] registered Pi shell integration in %s\n' "$ZSHRC_PATH"

# Install Basic Memory CLI
uv tool install --force "basic-memory==$BASIC_MEMORY_VERSION"

(
  unset PI_SUBAGENT_CHILD PI_SUBAGENT_FANOUT_CHILD PI_SUBAGENT_PARENT_SESSION PI_ROOT_SUBAGENT_BROKER_ENABLED
  cd -- "$SCRIPT_DIR"
  npm test
  npm run doctor
  PI_REAL_BIN="$pi_binary" npm run test:integration
  review_tests="$SCRIPT_DIR/skill-overrides/external-llm-review/tests"
  if [[ -d "$review_tests" ]]; then
    uv run --no-project --with httpx --with python-dotenv --with pyyaml \
      python -m unittest discover -s "$review_tests"
  else
    printf "[info] external-llm-review tests directory is absent; no tests run\n"
  fi
)

printf '[ok] Pi initialization complete\n'
printf 'Open a new terminal or run: source %s\n' "$ZSHRC_PATH"
