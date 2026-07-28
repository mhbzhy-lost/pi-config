# DP3 与 Crash MCP 薄 CLI Skill 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建 `dp3-mcp` 和 `crash-mcp` 两个独立 Skill，各自携带固定 TMCP Server 的一次性 CLI，并把安装、登录、Token 与鉴权故障处理统一委托给外部 `tmcp` Skill。

**Architecture:** 两个 Bash CLI 只校验 `environment/command/tool/input-file`，随后把一次性进程和 transport lifecycle 委托给 `um tmcp client`；wrapper 不保留跨命令状态，但不对 Ultima 所有失败路径承诺 protocol close。不实现 MCP SDK、常驻进程、连接池、header 注入或任意 endpoint。两个 Skill 通过 `metadata.external-skill: tmcp` 和正文 `REQUIRED EXTERNAL SKILL` 声明依赖，脚本只做静默 `um whoami` 前置检查，失败时要求回到 `tmcp` Skill，不自行登录或读取凭据。

**Tech Stack:** Pi Agent Skills、Bash、`um tmcp client`、Node.js `node:test`

**Execution Status (2026-07-28):** 两个 Skill 已按 RED/GREEN 串行本地部署并完成两轮只读审查；相关测试 `26 passed`、Doctor 通过、fresh Pi 场景通过，未调用真实网络。仓库全量 `npm test` 因既有 `plan-host-runtime.test.mjs` 超过 180 秒不退出而无法形成绿色 summary；逐文件隔离为 `62/65`，另两项失败位于未修改的 custom-footer 与 pi-subagents 环境兼容测试。当前会话 CWD 锁在 `mega-aone-service`，安全门禁禁止跨仓 git 切换，因此 pi-config 变更未 commit/push。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `skill-overrides/dp3-mcp/SKILL.md` | DP3 Event/Monitor 查询触发条件、外部 `tmcp` 依赖、CLI 用法和数据安全边界 |
| `skill-overrides/dp3-mcp/scripts/dp3-mcp` | 固定调用 `tiga-ssot-dp3` 的一次性 CLI |
| `skill-overrides/crash-mcp/SKILL.md` | Crash/Motu 数据查询触发条件、外部 `tmcp` 依赖、CLI 用法和隐私边界 |
| `skill-overrides/crash-mcp/scripts/crash-mcp` | 固定调用 `tiga-ssot-crash` 的一次性 CLI |
| `skill-overrides/skills.local.list` | 将两个本地 Skill 加入 Pi 白名单 |
| `test/mcp-skill-cli.test.mjs` | 用 fake `um` 冻结鉴权前置、固定 server、参数收窄和 JSON 文件转发 |
| `docs/superpowers/plans/artifacts/dp3-mcp-skill-baseline.md` | 无 DP3 Skill 时的新鲜 Pi 行为证据 |
| `docs/superpowers/plans/artifacts/dp3-mcp-skill-green.md` | 加载 DP3 Skill 后的应用验证证据 |
| `docs/superpowers/plans/artifacts/crash-mcp-skill-baseline.md` | 无 Crash Skill 时的新鲜 Pi 行为证据 |
| `docs/superpowers/plans/artifacts/crash-mcp-skill-green.md` | 加载 Crash Skill 后的应用验证证据 |

### Task 1: 建立 DP3 Skill RED 基线

**Files:**
- Create: `docs/superpowers/plans/artifacts/dp3-mcp-skill-baseline.md`

- [ ] **Step 1: 运行不加载新 Skill 的应用场景**

使用新鲜、无会话、禁用 Skills 的 Pi 执行以下场景，不向其提供计划中的命令：

```bash
pi --no-session --no-skills -p '你需要通过 TIGA DP3 MCP 查询 Event 155 的 inputSchema，并准备一次只读调用。Pi 没有内置 MCP。请给出你会执行的具体命令、鉴权处理和资源清理方式；不要真的调用网络。'
```

预期 RED：输出至少出现以下一种缺口，证明新 Skill 提供了增量价值：不知道固定 server、直接拼 MCP HTTP、复制 Token/登录流程、把 JSON 放进 argv、未说明 lifecycle 归 `um tmcp client` 且 wrapper 无跨命令状态，或没有把鉴权交给 `tmcp` Skill。

- [ ] **Step 2: 记录原始输出和失败归类**

创建证据文件，保留完整非敏感回答并按下列格式记录观察；不得写入用户名、Token、Cookie、header 或 endpoint query：

```markdown
# DP3 MCP Skill Baseline

## Scenario
查询 Event 155 的 inputSchema，并准备一次只读调用。

## Raw Response
执行时将 Step 1 的非敏感 stdout 原样置于本节；不得改写或补全模型回答。

## Observed Gaps
- [ ] 未固定 `tiga-ssot-dp3`
- [ ] 未把鉴权委托给 `tmcp` Skill
- [ ] 未使用 JSON 文件输入
- [ ] 试图实现常驻 MCP 生命周期
- [ ] 其他：无
```

- [ ] **Step 3: 确认没有提前创建 DP3 Skill**

Run:

```bash
test ! -e skill-overrides/dp3-mcp/SKILL.md
test ! -e skill-overrides/dp3-mcp/scripts/dp3-mcp
```

Expected: 两条命令均退出 `0`，确保 RED 发生在 Skill 和 CLI 创建之前。

### Task 2: 用 TDD 实现 DP3 薄 CLI

**Deps:** Task 1

**Files:**
- Create: `test/mcp-skill-cli.test.mjs`
- Create: `skill-overrides/dp3-mcp/scripts/dp3-mcp`

- [ ] **Step 1: 写 DP3 CLI RED 测试**

创建 `test/mcp-skill-cli.test.mjs`，先只包含公共 fixture 和 DP3 测试：

```javascript
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dp3Cli = join(repoRoot, "skill-overrides", "dp3-mcp", "scripts", "dp3-mcp");

function run(command, args, env) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

async function withFakeUm(callback, { authFails = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "mcp-skill-cli-"));
  const bin = join(root, "bin");
  const log = join(root, "um-calls.log");
  await mkdir(bin);
  await writeFile(
    join(bin, "um"),
    `#!/usr/bin/env bash\nset -eu\nprintf '%s\\n' "$*" >> "$UM_CALL_LOG"\nif [ "\${1:-}" = whoami ]; then\n  [ "\${UM_AUTH_FAIL:-0}" = 0 ] || exit 1\n  printf 'authenticated-user\\n'\n  exit 0\nfi\nprintf '{"ok":true}\\n'\n`,
    { mode: 0o700 },
  );
  const input = join(root, "input.json");
  await writeFile(input, "{}\n", { mode: 0o600 });
  try {
    await callback({
      input,
      log,
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: root,
        UM_CALL_LOG: log,
        UM_AUTH_FAIL: authFails ? "1" : "0",
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function callLog(path) {
  return (await readFile(path, "utf8")).trim().split("\n");
}

test("dp3 list performs auth preflight and fixes server, env, transport, and JSON output", async () => {
  await withFakeUm(async ({ env, log }) => {
    const result = await run("bash", [dp3Cli, "list"], env);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await callLog(log), [
      "whoami",
      "tmcp client list-tool -s tiga-ssot-dp3 --env pre --transport streamable -f json",
    ]);
  });
});

test("dp3 call forwards only a validated tool name and absolute input file", async () => {
  await withFakeUm(async ({ env, input, log }) => {
    const result = await run(
      "bash",
      [dp3Cli, "--env", "prod", "call", "dp3-event-data-search", input],
      env,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await callLog(log), [
      "whoami",
      `tmcp client call-tool -s tiga-ssot-dp3 --env prod --transport streamable --tool dp3-event-data-search --input @${input} --buc auto -f json --no-trace-id`,
    ]);
  });
});

test("dp3 rejects inline JSON before invoking um", async () => {
  await withFakeUm(async ({ env, log }) => {
    const result = await run(
      "bash",
      [dp3Cli, "call", "dp3-event-data-search", "{}"],
      env,
    );
    assert.equal(result.code, 2);
    await assert.rejects(readFile(log, "utf8"), /ENOENT/);
  });
});

test("dp3 stops after failed um authentication preflight", async () => {
  await withFakeUm(async ({ env, log }) => {
    const result = await run("bash", [dp3Cli, "list"], env);
    assert.equal(result.code, 3);
    assert.match(result.stderr, /tmcp skill/);
    assert.deepEqual(await callLog(log), ["whoami"]);
  }, { authFails: true });
});
```

- [ ] **Step 2: 运行 RED 并确认失败原因**

Run:

```bash
node --test test/mcp-skill-cli.test.mjs
```

Expected: 4 个测试因 `skill-overrides/dp3-mcp/scripts/dp3-mcp` 不存在而失败；失败必须来自缺少 CLI，而不是 fake `um` fixture 语法错误。

- [ ] **Step 3: 实现最小 DP3 CLI**

创建 `skill-overrides/dp3-mcp/scripts/dp3-mcp`：

```bash
#!/usr/bin/env bash
set -euo pipefail

SERVER="tiga-ssot-dp3"
ENVIRONMENT="pre"

usage() {
  cat >&2 <<'EOF'
Usage:
  dp3-mcp [--env daily|pre|prod] list
  dp3-mcp [--env daily|pre|prod] describe TOOL
  dp3-mcp [--env daily|pre|prod] call TOOL /absolute/path/to/input.json
EOF
}

find_um() {
  if command -v um >/dev/null 2>&1; then
    command -v um
    return
  fi
  if [[ -x "$HOME/.npm-global/bin/um" ]]; then
    printf '%s\n' "$HOME/.npm-global/bin/um"
    return
  fi
  printf '%s\n' "error: um is unavailable; load the tmcp skill and complete its setup" >&2
  exit 3
}

require_auth() {
  UM="$(find_um)"
  if ! "$UM" whoami >/dev/null 2>&1; then
    printf '%s\n' "error: TMCP authentication is unavailable; load the tmcp skill and follow its authentication setup" >&2
    exit 3
  fi
}

validate_tool() {
  [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]] || {
    printf '%s\n' "error: invalid tool name" >&2
    exit 2
  }
}

if [[ "${1:-}" == "--env" ]]; then
  [[ $# -ge 2 ]] || { usage; exit 2; }
  ENVIRONMENT="$2"
  shift 2
fi
case "$ENVIRONMENT" in
  daily|pre|prod) ;;
  *) printf '%s\n' "error: env must be daily, pre, or prod" >&2; exit 2 ;;
esac

COMMAND="${1:-}"
[[ -n "$COMMAND" ]] || { usage; exit 2; }
shift

case "$COMMAND" in
  list)
    [[ $# -eq 0 ]] || { usage; exit 2; }
    require_auth
    exec "$UM" tmcp client list-tool \
      -s "$SERVER" --env "$ENVIRONMENT" --transport streamable -f json
    ;;
  describe)
    [[ $# -eq 1 ]] || { usage; exit 2; }
    validate_tool "$1"
    require_auth
    exec "$UM" tmcp client call-tool \
      -s "$SERVER" --env "$ENVIRONMENT" --transport streamable \
      --tool "$1" --describe --buc auto -f json --no-trace-id
    ;;
  call)
    [[ $# -eq 2 ]] || { usage; exit 2; }
    validate_tool "$1"
    [[ "$2" == /* && -f "$2" ]] || {
      printf '%s\n' "error: input must be an absolute path to a JSON file" >&2
      exit 2
    }
    require_auth
    exec "$UM" tmcp client call-tool \
      -s "$SERVER" --env "$ENVIRONMENT" --transport streamable \
      --tool "$1" --input "@$2" --buc auto -f json --no-trace-id
    ;;
  *) usage; exit 2 ;;
esac
```

- [ ] **Step 4: 运行 GREEN 和 shell 静态检查**

Run:

```bash
node --test test/mcp-skill-cli.test.mjs
bash -n skill-overrides/dp3-mcp/scripts/dp3-mcp
```

Expected: `4 passed`，`bash -n` 退出 `0`。

### Task 3: 编写并验证 DP3 Skill

**Deps:** Task 2

**Files:**
- Create: `skill-overrides/dp3-mcp/SKILL.md`
- Create: `docs/superpowers/plans/artifacts/dp3-mcp-skill-green.md`
- Modify: `skill-overrides/skills.local.list`
- Modify: `test/mcp-skill-cli.test.mjs`

- [ ] **Step 1: 先写 Skill 内容和白名单 RED 测试**

向 `test/mcp-skill-cli.test.mjs` 追加：

```javascript
const dp3Skill = join(repoRoot, "skill-overrides", "dp3-mcp", "SKILL.md");
const localSkillList = join(repoRoot, "skill-overrides", "skills.local.list");

test("dp3 skill declares tmcp as its external authentication dependency", async () => {
  const skill = await readFile(dp3Skill, "utf8");
  assert.match(skill, /external-skill:\s*tmcp/);
  assert.match(skill, /REQUIRED EXTERNAL SKILL.*`tmcp`/);
  assert.match(skill, /authentication.*`tmcp` Skill/i);
  assert.match(skill, /lifecycle.*`um tmcp client`/i);
  assert.match(skill, /closes on normal completion/i);
  assert.match(skill, /upstream errors.*protocol-level close/is);
  assert.match(skill, /raw stdout.*model context/i);
  assert.match(skill, /no response sanitizer/i);
  assert.match(skill, /exclusion is impossible.*do not call from Pi/is);
  assert.match(skill, /do not predict.*field names/i);
  assert.match(skill, /success.*without `data`.*incomplete/is);
  assert.doesNotMatch(skill, /Each command opens and closes/);
  assert.doesNotMatch(skill, /Authorization:|Bearer\s+[A-Za-z0-9]/);
});

test("dp3 skill is enabled in the local allowlist", async () => {
  const names = (await readFile(localSkillList, "utf8")).split(/\r?\n/);
  assert.ok(names.includes("dp3-mcp"));
});
```

Run:

```bash
node --test test/mcp-skill-cli.test.mjs
```

Expected: 新增 2 个测试因 `SKILL.md` 不存在和白名单缺少 `dp3-mcp` 而失败，原 4 个 CLI 测试保持通过。

- [ ] **Step 2: 创建最小 DP3 Skill**

创建 `skill-overrides/dp3-mcp/SKILL.md`：

```markdown
---
name: dp3-mcp
description: Use when querying TIGA DP3 Event or Monitor metadata and data, investigating dp3-event-data-search responses, or inspecting DP3 schemas through the tiga-ssot-dp3 TMCP server.
compatibility: Requires the external tmcp Skill and its configured um CLI.
metadata:
  external-skill: tmcp
---

# DP3 MCP

## Overview

Use the bundled one-shot CLI for DP3 reads. The wrapper retains no cross-command state. Transport lifecycle belongs to `um tmcp client`; do not add a daemon or connection pool.

**REQUIRED EXTERNAL SKILL:** Load and follow `tmcp` before the first command. Installation, `um whoami`, login, Token setup, tenant selection, `doctor`, and authentication failures belong exclusively to the `tmcp` Skill. Never copy credentials, inspect Token caches, pass authentication headers, or invent a fallback login flow here.

## Lifecycle Boundary

The wrapper execs one `um tmcp client` process and never reuses state. Current `um` closes on normal completion. Some upstream errors exit before protocol-level close, so remote cleanup may wait for timeout; do not promise deterministic close on failures.

## CLI

```bash
SKILL_DIR="/absolute/path/to/dp3-mcp"
CLI="$SKILL_DIR/scripts/dp3-mcp"

bash "$CLI" list
bash "$CLI" describe dp3-event-data-search
bash "$CLI" call dp3-event-data-search /absolute/path/to/request.json
```

The default environment is `pre`. Select another registry environment only when the user or task requires it:

```bash
bash "$CLI" --env daily list
bash "$CLI" --env prod describe dp3-monitor-data-search
```

Always run `describe` before the first call to a tool in the session. Until its output is available, do not predict input field names such as `id` or `eventId`, and do not draft a request body. Build arguments from the returned `inputSchema`, write them to an absolute JSON file with no credentials, then use `call`. Do not pass inline JSON, custom headers, endpoints, stdio commands, or transport overrides.

## Data Boundaries

- Treat tools as read-only; include pagination and time ranges in every call.
- Use the smallest useful time window and page size.
- The CLI forwards raw stdout into the current model context; it has no response sanitizer.
- Use schema projections to exclude `userId`, `utdid`, device identifiers, IP/location, session data, and signed URLs. If exclusion is impossible, do not call from Pi; use an approved non-model consumer.
- Do not persist or quote unknown response fields.
- `{"class":"com.alibaba.motu.commons.Result","success":true}` without `data` is an incomplete provider response, not an empty result set.
- `dp3-event-data-sql` cannot query historical DP2 `wireless_mcap` views; do not use it as an automatic fallback.

## Common Mistakes

| Mistake | Required action |
|---|---|
| `um` login or Token fails | Stop and follow the external `tmcp` Skill |
| Tool arguments are uncertain | Run `describe`; do not guess fields |
| A call returns a success-only wrapper | Report the missing `data`; do not synthesize records |
| Multiple calls seem related | Pass complete arguments each time; do not create persistent MCP state |
```

- [ ] **Step 3: 加入本地 Skill 白名单**

在 `skill-overrides/skills.local.list` 的 `tmcp` 后追加：

```text
dp3-mcp
```

只追加该行，不重排或覆盖用户已有的本地 Skill。

- [ ] **Step 4: 运行 GREEN 测试和真实 Skill 应用场景**

Run:

```bash
node --test test/mcp-skill-cli.test.mjs
node --test test/skill-list.test.mjs test/skill-whitelist-extension.test.mjs
pi --no-session --no-skills --skill skill-overrides/dp3-mcp/SKILL.md --skill skill-overrides/tmcp/SKILL.md -p '通过 DP3 MCP 查询 Event 155 的 inputSchema，并准备一次只读调用。不要真的调用网络，只说明具体命令、鉴权归属和资源生命周期。'
```

Expected:
- `6 passed` for `mcp-skill-cli.test.mjs`。
- Skill 白名单测试全部通过。
- 新鲜 Pi 明确先遵循 `tmcp` 鉴权说明，再使用 bundled CLI；不拼 HTTP、不复制凭据、不创建常驻会话。

- [ ] **Step 5: 记录 GREEN 证据并完成 DP3 Skill 部署检查**

创建 `docs/superpowers/plans/artifacts/dp3-mcp-skill-green.md`：

```markdown
# DP3 MCP Skill Green Verification

## Scenario
查询 Event 155 的 inputSchema，并准备一次只读调用。

## Raw Response
执行时将 Step 4 的非敏感 stdout 原样置于本节；不得改写或补全模型回答。

## Checks
- [ ] 加载并遵循外部 `tmcp` Skill
- [ ] 使用 bundled `dp3-mcp` CLI
- [ ] 默认 `pre`，server 固定为 `tiga-ssot-dp3`
- [ ] 输入来自绝对 JSON 文件
- [ ] wrapper 无跨命令状态，lifecycle 委托给 `um tmcp client`
- [ ] 明示 raw stdout 的 model-context 边界
- [ ] 不复制或输出凭据
```

Run:

```bash
wc -w skill-overrides/dp3-mcp/SKILL.md
git diff --check -- skill-overrides/dp3-mcp test/mcp-skill-cli.test.mjs skill-overrides/skills.local.list docs/superpowers/plans/artifacts/dp3-mcp-skill-baseline.md docs/superpowers/plans/artifacts/dp3-mcp-skill-green.md
```

Expected: Skill 尽量不超过 500 words；`git diff --check` 无输出。

- [ ] **Step 6: 提交 DP3 Skill 后再开始 Crash Skill**

```bash
git add skill-overrides/dp3-mcp skill-overrides/skills.local.list test/mcp-skill-cli.test.mjs docs/superpowers/plans/artifacts/dp3-mcp-skill-baseline.md docs/superpowers/plans/artifacts/dp3-mcp-skill-green.md
git commit -m "feat(skill): 增加 DP3 MCP 薄客户端"
```

Expected: 提交只包含 DP3 Skill、公共测试的 DP3 部分、白名单行和两份 DP3 测试证据。完成该提交后才能进入 Task 4。

### Task 4: 建立 Crash Skill RED 基线

**Deps:** Task 3

**Files:**
- Create: `docs/superpowers/plans/artifacts/crash-mcp-skill-baseline.md`

- [ ] **Step 1: 运行不加载 Crash Skill 的应用场景**

```bash
pi --no-session --no-skills -p '你需要通过 Crash MCP 查看可用工具，再描述 motu_querySimpleReportRecordPage 的 inputSchema。Pi 没有内置 MCP。请给出具体命令、鉴权处理和资源清理方式；不要真的调用网络，也不要启动 crash 修复。'
```

预期 RED：输出至少出现以下一种缺口：不知道固定 server、混淆 Crash 数据查询与 `crash-analyzer-usage` 修复、复制 Cookie/Token、直接拼 HTTP、把 JSON 放进 argv，或实现不必要的常驻会话。

- [ ] **Step 2: 记录原始输出和失败归类**

创建：

```markdown
# Crash MCP Skill Baseline

## Scenario
查看 Crash MCP 工具并描述实例列表工具的 inputSchema。

## Raw Response
执行时将 Step 1 的非敏感 stdout 原样置于本节；不得改写或补全模型回答。

## Observed Gaps
- [ ] 未固定 `tiga-ssot-crash`
- [ ] 未把鉴权委托给 `tmcp` Skill
- [ ] 混淆数据查询与 crash 修复
- [ ] 未使用 JSON 文件输入
- [ ] 试图实现常驻 MCP 生命周期
- [ ] 其他：无
```

- [ ] **Step 3: 确认没有提前创建 Crash Skill**

```bash
test ! -e skill-overrides/crash-mcp/SKILL.md
test ! -e skill-overrides/crash-mcp/scripts/crash-mcp
```

Expected: 两条命令均退出 `0`。

### Task 5: 用 TDD 实现 Crash 薄 CLI

**Deps:** Task 4

**Files:**
- Modify: `test/mcp-skill-cli.test.mjs`
- Create: `skill-overrides/crash-mcp/scripts/crash-mcp`

- [ ] **Step 1: 追加 Crash CLI RED 测试**

向测试文件追加：

```javascript
const crashCli = join(repoRoot, "skill-overrides", "crash-mcp", "scripts", "crash-mcp");

test("crash list performs auth preflight and fixes server, env, transport, and JSON output", async () => {
  await withFakeUm(async ({ env, log }) => {
    const result = await run("bash", [crashCli, "list"], env);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await callLog(log), [
      "whoami",
      "tmcp client list-tool -s tiga-ssot-crash --env pre --transport streamable -f json",
    ]);
  });
});

test("crash describe uses auto BUC handling without exposing header controls", async () => {
  await withFakeUm(async ({ env, log }) => {
    const tool = "motu_querySimpleReportRecordPage";
    const result = await run("bash", [crashCli, "describe", tool], env);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await callLog(log), [
      "whoami",
      `tmcp client call-tool -s tiga-ssot-crash --env pre --transport streamable --tool ${tool} --describe --buc auto -f json --no-trace-id`,
    ]);
  });
});

test("crash rejects unsupported environment before authentication", async () => {
  await withFakeUm(async ({ env, log }) => {
    const result = await run("bash", [crashCli, "--env", "staging", "list"], env);
    assert.equal(result.code, 2);
    await assert.rejects(readFile(log, "utf8"), /ENOENT/);
  });
});

test("crash call requires an absolute input file", async () => {
  await withFakeUm(async ({ env, log }) => {
    const result = await run(
      "bash",
      [crashCli, "call", "motu_querySimpleReportRecordPage", "relative.json"],
      env,
    );
    assert.equal(result.code, 2);
    await assert.rejects(readFile(log, "utf8"), /ENOENT/);
  });
});
```

- [ ] **Step 2: 运行 RED 并确认失败原因**

```bash
node --test test/mcp-skill-cli.test.mjs
```

Expected: 原 6 个 DP3 测试通过，新增 4 个 Crash 测试仅因 `scripts/crash-mcp` 不存在而失败。

- [ ] **Step 3: 实现最小 Crash CLI**

创建 `skill-overrides/crash-mcp/scripts/crash-mcp`：

```bash
#!/usr/bin/env bash
set -euo pipefail

SERVER="tiga-ssot-crash"
ENVIRONMENT="pre"

usage() {
  cat >&2 <<'EOF'
Usage:
  crash-mcp [--env daily|pre|prod] list
  crash-mcp [--env daily|pre|prod] describe TOOL
  crash-mcp [--env daily|pre|prod] call TOOL /absolute/path/to/input.json
EOF
}

find_um() {
  if command -v um >/dev/null 2>&1; then
    command -v um
    return
  fi
  if [[ -x "$HOME/.npm-global/bin/um" ]]; then
    printf '%s\n' "$HOME/.npm-global/bin/um"
    return
  fi
  printf '%s\n' "error: um is unavailable; load the tmcp skill and complete its setup" >&2
  exit 3
}

require_auth() {
  UM="$(find_um)"
  if ! "$UM" whoami >/dev/null 2>&1; then
    printf '%s\n' "error: TMCP authentication is unavailable; load the tmcp skill and follow its authentication setup" >&2
    exit 3
  fi
}

validate_tool() {
  [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]] || {
    printf '%s\n' "error: invalid tool name" >&2
    exit 2
  }
}

if [[ "${1:-}" == "--env" ]]; then
  [[ $# -ge 2 ]] || { usage; exit 2; }
  ENVIRONMENT="$2"
  shift 2
fi
case "$ENVIRONMENT" in
  daily|pre|prod) ;;
  *) printf '%s\n' "error: env must be daily, pre, or prod" >&2; exit 2 ;;
esac

COMMAND="${1:-}"
[[ -n "$COMMAND" ]] || { usage; exit 2; }
shift

case "$COMMAND" in
  list)
    [[ $# -eq 0 ]] || { usage; exit 2; }
    require_auth
    exec "$UM" tmcp client list-tool \
      -s "$SERVER" --env "$ENVIRONMENT" --transport streamable -f json
    ;;
  describe)
    [[ $# -eq 1 ]] || { usage; exit 2; }
    validate_tool "$1"
    require_auth
    exec "$UM" tmcp client call-tool \
      -s "$SERVER" --env "$ENVIRONMENT" --transport streamable \
      --tool "$1" --describe --buc auto -f json --no-trace-id
    ;;
  call)
    [[ $# -eq 2 ]] || { usage; exit 2; }
    validate_tool "$1"
    [[ "$2" == /* && -f "$2" ]] || {
      printf '%s\n' "error: input must be an absolute path to a JSON file" >&2
      exit 2
    }
    require_auth
    exec "$UM" tmcp client call-tool \
      -s "$SERVER" --env "$ENVIRONMENT" --transport streamable \
      --tool "$1" --input "@$2" --buc auto -f json --no-trace-id
    ;;
  *) usage; exit 2 ;;
esac
```

- [ ] **Step 4: 运行 GREEN 和 shell 静态检查**

```bash
node --test test/mcp-skill-cli.test.mjs
bash -n skill-overrides/crash-mcp/scripts/crash-mcp
```

Expected: 当前 10 个测试全部通过，`bash -n` 退出 `0`。

### Task 6: 编写并验证 Crash Skill

**Deps:** Task 5

**Files:**
- Create: `skill-overrides/crash-mcp/SKILL.md`
- Create: `docs/superpowers/plans/artifacts/crash-mcp-skill-green.md`
- Modify: `skill-overrides/skills.local.list`
- Modify: `test/mcp-skill-cli.test.mjs`

- [ ] **Step 1: 先写 Crash Skill 内容和白名单 RED 测试**

追加：

```javascript
const crashSkill = join(repoRoot, "skill-overrides", "crash-mcp", "SKILL.md");

test("crash skill declares tmcp as its external authentication dependency", async () => {
  const skill = await readFile(crashSkill, "utf8");
  assert.match(skill, /external-skill:\s*tmcp/);
  assert.match(skill, /REQUIRED EXTERNAL SKILL.*`tmcp`/);
  assert.match(skill, /authentication.*`tmcp` Skill/i);
  assert.match(skill, /lifecycle.*`um tmcp client`/i);
  assert.match(skill, /closes on normal completion/i);
  assert.match(skill, /upstream errors.*protocol-level close/is);
  assert.match(skill, /raw stdout.*model context/i);
  assert.match(skill, /no response sanitizer/i);
  assert.match(skill, /exclusion is impossible.*do not call.*from Pi/is);
  assert.match(skill, /PII.*signed URL/is);
  assert.match(skill, /do not call that tool from Pi/i);
  assert.match(skill, /crash-analyzer-usage/);
  assert.doesNotMatch(skill, /before storing or modeling/i);
  assert.doesNotMatch(skill, /Each command opens and closes/);
  assert.doesNotMatch(skill, /Authorization:|Bearer\s+[A-Za-z0-9]/);
});

test("crash skill is enabled in the local allowlist", async () => {
  const names = (await readFile(localSkillList, "utf8")).split(/\r?\n/);
  assert.ok(names.includes("crash-mcp"));
});
```

Run:

```bash
node --test test/mcp-skill-cli.test.mjs
```

Expected: 新增 2 个测试因 Crash `SKILL.md` 和白名单行缺失而失败，前 10 个测试通过。

- [ ] **Step 2: 创建最小 Crash Skill**

创建 `skill-overrides/crash-mcp/SKILL.md`：

```markdown
---
name: crash-mcp
description: Use when querying Motu Crash metadata, instances, stacks, aggregates, or trends through the tiga-ssot-crash TMCP server, without starting the crash fixing workflow.
compatibility: Requires the external tmcp Skill and its configured um CLI.
metadata:
  external-skill: tmcp
---

# Crash MCP

## Overview

Use the bundled one-shot CLI for read-only Crash evidence queries. The wrapper retains no cross-command state. Transport lifecycle belongs to `um tmcp client`; do not add a daemon or connection pool.

**REQUIRED EXTERNAL SKILL:** Load and follow `tmcp` before the first command. Installation, `um whoami`, login, Token setup, tenant selection, `doctor`, and authentication failures belong exclusively to the `tmcp` Skill. Never copy credentials, inspect Token caches, pass authentication headers, or fall back to browser Cookie extraction.

This Skill reads Crash data. When the user asks to fix a real iOS crash, use `crash-analyzer-usage` for the fixing workflow; do not substitute this query CLI for its state machine.

## Lifecycle Boundary

The wrapper execs one `um tmcp client` process and never reuses state. Current `um` closes on normal completion. Some upstream errors exit before protocol-level close, so remote cleanup may wait for timeout; do not promise deterministic close on failures.

## CLI

```bash
SKILL_DIR="/absolute/path/to/crash-mcp"
CLI="$SKILL_DIR/scripts/crash-mcp"

bash "$CLI" list
bash "$CLI" describe motu_querySimpleReportRecordPage
bash "$CLI" call motu_querySimpleReportRecordPage /absolute/path/to/request.json
```

The default environment is `pre`. Use another registry environment only when the user or task requires it:

```bash
bash "$CLI" --env daily list
bash "$CLI" --env prod describe motu_queryReportClusterTrend
```

Run `list` because the server catalog may evolve, then run `describe` before the first call to a tool in the session. Build arguments only from the returned `inputSchema`, write them to an absolute JSON file with no credentials, and use `call`. Do not pass inline JSON, custom headers, endpoints, stdio commands, or transport overrides.

## Evidence Boundaries

- Require a real Crash locator; never fabricate IDs, URLs, apps, or time windows.
- Keep calls read-only; do not start AIMI, modify code, submit a fix, or publish.
- The CLI forwards raw stdout into the current model context; it has no response sanitizer.
- Use schema projections to exclude PII, authentication material, and signed URLs. If exclusion is impossible, do not call that tool from Pi; use an approved non-model consumer.
- A success-only response without the documented payload is incomplete, not an empty dataset.
- Get tool names and schemas from `list/describe`, not historical notes.

## Common Mistakes

| Mistake | Required action |
|---|---|
| `um` login or Token fails | Stop and follow the external `tmcp` Skill |
| Tool or input fields are uncertain | Run `list` and `describe`; do not guess |
| User asks to fix a crash | Switch to `crash-analyzer-usage` and preserve its reviews |
| Sensitive fields appear unexpectedly | Stop; do not persist or quote them. Treat the call as a policy failure |
| Multiple queries seem related | Send complete arguments each time; do not create persistent MCP state |
```

- [ ] **Step 3: 加入本地 Skill 白名单**

在 `skill-overrides/skills.local.list` 的 `dp3-mcp` 后追加：

```text
crash-mcp
```

不修改现有 Skill 的顺序。

- [ ] **Step 4: 运行 GREEN 测试和真实 Skill 应用场景**

```bash
node --test test/mcp-skill-cli.test.mjs
node --test test/skill-list.test.mjs test/skill-whitelist-extension.test.mjs
pi --no-session --no-skills --skill skill-overrides/crash-mcp/SKILL.md --skill skill-overrides/tmcp/SKILL.md -p '通过 Crash MCP 查看可用工具，再描述 motu_querySimpleReportRecordPage。不要调用网络，不要启动 crash 修复；只说明命令、鉴权归属和生命周期。'
```

Expected:
- `12 passed` for `mcp-skill-cli.test.mjs`。
- Skill 白名单测试全部通过。
- 新鲜 Pi 区分数据查询和 crash 修复，先遵循 `tmcp`，再使用 bundled CLI，不复制凭据或创建常驻会话。

- [ ] **Step 5: 记录 GREEN 证据并关闭新漏洞**

创建：

```markdown
# Crash MCP Skill Green Verification

## Scenario
查看 Crash MCP 工具并描述实例列表工具，不启动 crash 修复。

## Raw Response
执行时将 Step 4 的非敏感 stdout 原样置于本节；不得改写或补全模型回答。

## Checks
- [ ] 加载并遵循外部 `tmcp` Skill
- [ ] 使用 bundled `crash-mcp` CLI
- [ ] 默认 `pre`，server 固定为 `tiga-ssot-crash`
- [ ] 区分数据查询与 `crash-analyzer-usage` 修复
- [ ] wrapper 无跨命令状态，lifecycle 委托给 `um tmcp client`
- [ ] 无法排除 PII/signed URL 时禁止 model-visible `call`
- [ ] 不复制或输出凭据
```

如果 GREEN 输出出现新绕过方式，只针对真实缺口补充 `Common Mistakes` 或参数校验，随后用完全相同场景复验；不得顺手增加常驻连接、自动登录、任意 header 或 endpoint。

- [ ] **Step 6: 提交 Crash Skill**

```bash
git add skill-overrides/crash-mcp skill-overrides/skills.local.list test/mcp-skill-cli.test.mjs docs/superpowers/plans/artifacts/crash-mcp-skill-baseline.md docs/superpowers/plans/artifacts/crash-mcp-skill-green.md
git commit -m "feat(skill): 增加 Crash MCP 薄客户端"
```

Expected: 提交不包含 DP3 前一提交以外的历史改动，也不包含凭据或网络响应原文。

### Task 7: 全量验证与独立审查

**Deps:** Task 6

**Files:**
- Modify only if a verified finding requires it: `skill-overrides/dp3-mcp/**`, `skill-overrides/crash-mcp/**`, `test/mcp-skill-cli.test.mjs`

- [ ] **Step 1: 运行全量测试和安全扫描**

```bash
npm test
bash -n skill-overrides/dp3-mcp/scripts/dp3-mcp
bash -n skill-overrides/crash-mcp/scripts/crash-mcp
rg -n 'Authorization:|Bearer [A-Za-z0-9]|Cookie:|x-sso-ticket|--header|-H ' skill-overrides/dp3-mcp skill-overrides/crash-mcp test/mcp-skill-cli.test.mjs
git diff --check
```

Expected:
- `npm test` 全部通过。
- 两个 Bash 静态检查通过。
- 安全扫描只能命中 Skill 中的禁止性说明或测试断言，不能命中凭据值、header 转发实现或 wrapper 参数。
- `git diff --check` 无输出。

- [ ] **Step 2: 验证发现与外部依赖**

重新加载 Pi 资源后确认两个 Skill 和 `tmcp` 同时可发现：

```bash
pi --no-session -p '列出处理 DP3 MCP 查询、Crash MCP 数据查询和 TMCP 鉴权时应加载的 skills；不要执行工具。'
```

Expected: 回答将 `dp3-mcp -> tmcp`、`crash-mcp -> tmcp` 表达为依赖关系；Crash 修复仍路由到 `crash-analyzer-usage`。

- [ ] **Step 3: 执行独立只读审查**

审查范围：

```text
skill-overrides/dp3-mcp/**
skill-overrides/crash-mcp/**
skill-overrides/skills.local.list
test/mcp-skill-cli.test.mjs
docs/superpowers/plans/artifacts/*-mcp-skill-*.md
```

要求 reviewer 核对：

```text
1. 两个 Skill 是否明确把安装、登录、Token 和鉴权错误委托给 tmcp。
2. wrapper 是否固定 server，只开放 list/describe/call，且不开放 header、endpoint、stdio。
3. wrapper 是否不保留跨命令状态，并如实披露 `um tmcp client` 成功/失败路径的 lifecycle 差异。
4. JSON 是否只通过绝对文件传入，错误是否不包含凭据。
5. raw stdout 是否明确进入 model context，DP3 成功空壳和 Crash PII/signed URL 是否 fail-closed。
6. 两个 Skill 的触发条件是否与 tmcp、crash-analyzer-usage 正确分工。
```

只修复有代码或测试证据支持的 finding；若产生逻辑改动，先补 RED 测试再修改。

- [ ] **Step 4: 最终提交与完成记录**

若审查产生修复：

```bash
git add skill-overrides/dp3-mcp skill-overrides/crash-mcp skill-overrides/skills.local.list test/mcp-skill-cli.test.mjs docs/superpowers/plans/artifacts
git commit -m "fix(skill): 收紧 MCP 薄客户端边界"
```

最后记录精确 commit、测试数、Skill 场景结果和未执行真实网络调用的事实。除非用户另行要求，不调用 DP3/Crash 真实工具，不修改 TMCP Server，不发布任何环境。

## 验收标准

- [ ] `dp3-mcp` 与 `crash-mcp` 各自包含一个可单独运行的 Bash CLI。
- [ ] 两个 Skill 都用 `metadata.external-skill: tmcp` 和 `REQUIRED EXTERNAL SKILL: tmcp` 声明依赖，鉴权配置只引用 `tmcp` Skill。
- [ ] CLI 固定 TMCP Server，默认 `pre`，只开放 `list/describe/call` 和三环境选择。
- [ ] CLI 不实现 MCP SDK、daemon、连接池、Token 读取、登录、header、endpoint 或 stdio；wrapper 不保留跨命令状态，transport lifecycle 委托给 `um tmcp client`。
- [ ] 每个 CLI 在业务命令前静默执行 `um whoami`，失败时要求回到 `tmcp` Skill。
- [ ] JSON 调用参数只接受绝对文件路径，不进入 wrapper argv 的 inline JSON。
- [ ] DP3 Skill 明确成功空壳不是空数据；两个 Skill 明示 raw stdout 进入 model context，无法请求侧排除 PII/signed URL 时禁止从 Pi 调用。
- [ ] DP3 Skill 完成 RED/GREEN/提交后才开始 Crash Skill，符合 `writing-skills` 的逐 Skill 部署要求。
- [ ] 全量测试、shell 静态检查、安全扫描、Skill 应用场景和独立审查通过。
