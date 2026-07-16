#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PI_VERSION="0.80.6"
PI_PACKAGE="@earendil-works/pi-coding-agent@$PI_VERSION"
PI_SUBAGENTS_VERSION="0.34.0"
ZSHRC_PATH="${ZDOTDIR:-$HOME}/.zshrc"
SHELL_INTEGRATION="$SCRIPT_DIR/scripts/pi-shell.zsh"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

for required_command in git node npm zsh uv; do
  require_command "$required_command"
done

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$node_major" -lt 22 ]]; then
  printf 'Node.js 22 or newer is required; found %s\n' "$(node --version)" >&2
  exit 1
fi

git -C "$SCRIPT_DIR" submodule update --init --recursive

pi_binary="${PI_REAL_BIN:-$(command -v pi || true)}"
installed_version=""
if [[ -n "$pi_binary" && -x "$pi_binary" ]]; then
  installed_version="$($pi_binary --version 2>/dev/null || true)"
fi
if [[ "$installed_version" != "$PI_VERSION" ]]; then
  npm install -g --ignore-scripts "$PI_PACKAGE"
  pi_binary="${PI_REAL_BIN:-$(command -v pi || true)}"
fi
if [[ -z "$pi_binary" || ! -x "$pi_binary" ]]; then
  printf 'Pi executable not found after installing %s\n' "$PI_PACKAGE" >&2
  exit 1
fi

PI_CODING_AGENT_DIR="$SCRIPT_DIR/pi" "$pi_binary" install "npm:pi-subagents@$PI_SUBAGENTS_VERSION"

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

(
  cd -- "$SCRIPT_DIR"
  npm test
  npm run doctor
  PI_REAL_BIN="$pi_binary" npm run test:integration
  uv run --no-project --with httpx --with python-dotenv --with pyyaml \
    python -m unittest discover -s skill-overrides/external-llm-review/tests
)

printf '[ok] Pi initialization complete\n'
printf 'Open a new terminal or run: source %s\n' "$ZSHRC_PATH"
