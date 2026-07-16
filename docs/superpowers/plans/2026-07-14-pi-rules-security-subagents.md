# Pi 全局规则、安全门禁与 Subagent 迁移实施计划

> **执行说明：** 本计划只允许 Subagent-Driven 或 Inline Execution；用户已明确禁止使用 Plan-Runner。所有逻辑变更严格执行 RED→GREEN，Skill 迁移按 `writing-skills` 做行为验证。

**Goal:** 将 OpenCode 配置仓中的全局规则与 Qwen Prompt、安全门禁、executor/Spark 后台 Subagent 三块能力迁移到独立的 `pi-config`。

**Architecture:** `pi/AGENTS.md` 与 `pi/SYSTEM.md` 分离通用规则和 Qwen 模型 Prompt；安全规则和 Subagent 运行时都采用“可单测的 `scripts/lib/*.mjs` 核心 + 极薄 `pi/extensions/*.ts` 入口”。Subagent 使用独立 Pi JSON 子进程、后台 job 状态文件和完成消息，不复刻 OpenCode session API。

**Tech Stack:** Pi Coding Agent 0.80.6、TypeScript Extension API、Node.js 22 ESM、Node test runner、Python/uv external reviewer、zsh/Bash。

---

## 范围与非目标

- 本计划迁移 `AGENTS.md`、Qwen system prompt、`git-commit-convention`、`subagent-dispatch`、`external-llm-review`。
- 本计划迁移 workspace 外 `rm`、commit message、`cd/git -C`、未完成计划 push、coding reminder、external review push gate。
- 本计划实现 `executor` 与 `spark` 两个后台 Subagent；模型分别固定为 `openai/gpt-5.6-terra` 与 `openai/gpt-5.3-codex-spark`。
- 不使用或迁移 Plan-Runner、MCP、Memory、cache proxy、Dynamic Workflow、OpenCode session/state。
- 不迁移 OpenCode 凭据；缺少 `openai` 或 external reviewer 凭据时给出明确诊断，不静默换模型。
- 不提交 Git commit；用户尚未授权 commit。

## 文件结构

| 文件 | 职责 |
|---|---|
| `pi/AGENTS.md` | Pi 全局行为规则与 Skill 触发纪律 |
| `pi/SYSTEM.md` | Qwen 3.7 Max 专用 system prompt |
| `skill-overrides/*/SKILL.md` | 本仓维护的三个自定义 Skill，随对应能力逐项启用 |
| `scripts/lib/shell-policy.mjs` | 纯函数形式的 bash/rm/git/plan 策略 |
| `scripts/lib/security-gates-extension.mjs` | 将纯策略接入 Pi `tool_call/tool_result` |
| `pi/extensions/security-gates.ts` | 安全门禁 Extension 入口 |
| `scripts/hooks/external-review-gate.sh` | 与客户端无关的 push external review 状态机 |
| `scripts/lib/external-review-runner.mjs` | 异步执行 review hook、脱敏和 fail-open |
| `pi/agents/*.md` | executor/Spark profile |
| `scripts/lib/subagent-agents.mjs` | profile 解析与校验 |
| `scripts/lib/subagent-jobs.mjs` | 子进程、后台 job、状态持久化与完成通知 |
| `scripts/lib/subagent-extension.mjs` | `task` / `task_status` 工具注册 |
| `pi/extensions/subagent.ts` | Subagent Extension 入口 |

## DAG

```text
Task 1 -> Task 2 ---------> Task 6 -> Task 7 -> Task 8
      \-> Task 3 -> Task 4 -> Task 5 --------/
```

### Task 1：建立三块迁移契约

**Files:**
- Create: `test/global-rules.test.mjs`
- Create: `test/migration-contract.test.mjs`
- Modify: `test/doctor.test.mjs`
- Modify: `test/pi-runtime.integration.mjs`

- [ ] **Step 1：写全局规则与 Skill 白名单失败测试**

```js
test("Pi loads migrated global rules and Qwen prompt", async () => {
  const agents = await readFile(join(repoRoot, "pi", "AGENTS.md"), "utf8");
  const system = await readFile(join(repoRoot, "pi", "SYSTEM.md"), "utf8");
  assert.match(agents, /任何产生逻辑变更.*test-driven-development/s);
  assert.match(agents, /docs\/bugs\/bug-/);
  assert.match(system, /Analyze surrounding code, tests, and configuration first/);
  assert.doesNotMatch(system, /You are OpenCode/);
});
```

- [ ] **Step 2：写 Extension 发现失败断言**

在 `migration-contract.test.mjs` 断言最终 Skill 列表为八项，并通过 fake `ExtensionAPI` 断言注册 `task`、`task_status`；把真实 RPC 集成测试的最终期望改为八项 Skills。该契约在 Task 8 才整体转绿。

- [ ] **Step 3：运行 RED**

Run: `node --test test/global-rules.test.mjs test/migration-contract.test.mjs test/doctor.test.mjs test/pi-runtime.integration.mjs`

Expected: FAIL，缺少 `pi/AGENTS.md`、`pi/SYSTEM.md`、三个 Skill 与两个 Subagent tool。

### Task 2：迁移全局规则、Qwen Prompt 与 commit Skill

**Deps:** Task 1

**Files:**
- Create: `pi/AGENTS.md`
- Create: `pi/SYSTEM.md`
- Create: `skill-overrides/git-commit-convention/SKILL.md`
- Modify: `agents/skills.list`
- Modify: `scripts/doctor.mjs`
- Test: `test/global-rules.test.mjs`

- [ ] **Step 1：迁移并适配全局规则**

以 `claude-config/userconf/AGENTS.md` 为语义来源创建 `pi/AGENTS.md`，保留 TDD、Bug 六要素、提交规范、中文人审、headless Playwright、Skill 优先级和 review 验证规则；删除 OpenCode 路径、Plan-Runner 执行选项和不存在的工具描述。Subagent 规则改为：所有 `task` 必须 `background: true`，编码默认 executor，单文件快速任务使用 spark。

- [ ] **Step 2：迁移并适配 Qwen Prompt**

以 `claude-config/userconf/prompts/qwen37.txt` 为语义来源创建 `pi/SYSTEM.md`：把身份改为 Pi，保留 conventions、先检查依赖、最小修改、Todo、验证、Git 安全和简洁输出；删除 OpenCode docs URL、OpenCode tool 名称和“少于四行”的绝对限制。

- [ ] **Step 3：迁移 commit Skill**

复制 `claude-config/userconf/skills/git-commit-convention/SKILL.md`，把“OpenCode 插件”改为“Pi security-gates Extension”；保留格式和主观约束，不改业务规则。

- [ ] **Step 4：更新白名单和 doctor**

把 `git-commit-convention` 加入 `agents/skills.list`；`inspectWhitelist()` 不再硬编码数量 `5`，而是从仓库白名单读取并逐个解析来源。Task 5 与 Task 7 再分别加入 external review 和 subagent Skill。

- [ ] **Step 5：运行 GREEN**

Run: `node --test test/global-rules.test.mjs test/doctor.test.mjs test/skill-list.test.mjs test/skill-whitelist-extension.test.mjs`

Expected: PASS。`migration-contract.test.mjs` 仍因后续能力缺失而保持 RED，不纳入本 Task 的 GREEN 命令。

### Task 3：实现本地安全策略纯函数

**Deps:** Task 1

**Files:**
- Create: `scripts/lib/shell-policy.mjs`
- Create: `test/shell-policy.test.mjs`

- [ ] **Step 1：写 workspace 外 rm RED**

覆盖普通路径、`cd`、`sudo/command/env` wrapper、symlink、shell expansion、工作区内路径和系统临时目录。核心断言：

```js
const violation = checkShellPolicy({ command: "rm -rf /Users/shared", cwd, workspaceRoot });
assert.equal(violation.block, true);
assert.equal(violation.code, "RM_OUTSIDE_WORKSPACE");
assert.match(violation.reason, /workspace 外 rm/);
```

- [ ] **Step 2：写 commit message RED**

覆盖合法 Conventional Commit、非法 type、无中文、句号、过去时、零信息 subject、AI 署名、`-m/--message/$'...'`、`-F`、`--amend --no-edit` 和 `GIT_COMMIT_HOOK_SKIP=1`。

- [ ] **Step 3：写 Git/plan RED**

覆盖 `cd && git`、`git -C`、`git push --dry-run` 和 `docs/plans/**/*.md` 中 `TODO:`。扫描器必须只读调用方 repo，不读取 `pi-config` 自身计划目录。

- [ ] **Step 4：运行 RED**

Run: `node --test test/shell-policy.test.mjs`

Expected: FAIL，模块不存在。

- [ ] **Step 5：实现最小纯函数 API**

API 固定为：`checkShellPolicy({ command, cwd, workspaceRoot, env })` 返回 `undefined` 或 `{ block: true, code, reason }`；`scanPendingPlanTodos(repoRoot)` 返回 `{ file, text }[]`；`codingReminderFor({ toolName, input })` 返回 reminder string 或 `undefined`。

从 OpenCode 插件迁移算法，不依赖 OpenCode input/output 结构。所有不确定删除目标 fail-closed；plan 文件读取错误保留文件路径并阻断 push。

- [ ] **Step 6：运行 GREEN**

Run: `node --test test/shell-policy.test.mjs`

Expected: PASS。

### Task 4：接入 Pi 安全门禁 Extension

**Deps:** Task 3

**Files:**
- Create: `scripts/lib/security-gates-extension.mjs`
- Create: `pi/extensions/security-gates.ts`
- Create: `test/security-gates-extension.test.mjs`

- [ ] **Step 1：写 Pi 事件适配 RED**

```js
const handlers = new Map();
createSecurityGatesExtension({
  on: (name, handler) => handlers.set(name, handler),
});
const result = await handlers.get("tool_call")(
  { toolName: "bash", input: { command: "rm -rf /Users/shared" } },
  { cwd: workspace },
);
assert.equal(result.block, true);
assert.match(result.reason, /workspace 外 rm/);
```

同时断言 `tool_result` 对非测试源码 edit/write 追加 TDD/Bug 提醒，但不改写错误结果和二进制内容。

- [ ] **Step 2：运行 RED**

Run: `node --test test/security-gates-extension.test.mjs`

Expected: FAIL，factory 不存在。

- [ ] **Step 3：实现事件适配**

`tool_call` 使用 `event.input.command` 与 `ctx.cwd` 调用纯策略并返回 `{ block, reason }`；`tool_result` 返回新的 text content，不原地破坏 Pi 事件对象。非交互/RPC 与 TUI 行为必须一致。

- [ ] **Step 4：创建 TypeScript 薄入口**

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSecurityGatesExtension } from "../../scripts/lib/security-gates-extension.mjs";

export default function securityGates(pi: ExtensionAPI) {
  createSecurityGatesExtension(pi);
}
```

- [ ] **Step 5：运行 GREEN**

Run: `node --test test/security-gates-extension.test.mjs test/shell-policy.test.mjs`

Expected: PASS。

### Task 5：迁移 external review push gate

**Deps:** Task 2, Task 3, Task 4

**Files:**
- Create: `skill-overrides/external-llm-review/reviewer.py`
- Create: `skill-overrides/external-llm-review/SKILL.md`
- Create: `skill-overrides/external-llm-review/_config.py`
- Create: `skill-overrides/external-llm-review/_provider.py`
- Create: `skill-overrides/external-llm-review/_healthcheck.py`
- Create: `skill-overrides/external-llm-review/providers/*.yaml`
- Create: `skill-overrides/external-llm-review/.env.example`
- Create: `skill-overrides/external-llm-review/tests/test_reviewer.py`
- Create: `scripts/hooks/external-review-gate.sh`
- Create: `scripts/lib/external-review-runner.mjs`
- Create: `test/external-review-runner.test.mjs`
- Modify: `.gitignore`
- Modify: `init-pi.sh`
- Modify: `agents/skills.list`
- Modify: `scripts/lib/security-gates-extension.mjs`
- Modify: `test/security-gates-extension.test.mjs`

- [ ] **Step 1：复制受控源文件**

只复制 `claude-config/userconf/skills/external-llm-review` 中上述显式文件，禁止复制 `.env`、`.venv`、`__pycache__`、`.DS_Store`。复制 `claude-config/shared/hooks/external-review-gate.sh` 到 `scripts/hooks/`。

复制 Skill 后将根路径改为 `$PI_CODING_AGENT_DIR/../skill-overrides/external-llm-review`，并把 `external-llm-review` 加入白名单；除路径与客户端名称外不改评审决策语义。

- [ ] **Step 2：写路径独立性 RED**

测试扫描所有迁移文件，拒绝 `CLAUDE_CONFIG_HOME`、`userconf/skills`、`~/.config/opencode`；断言 `.env`、`.venv` 和 reviewer logs 均被 Git 忽略。

- [ ] **Step 3：写 runner RED**

使用 fake hook 覆盖 allow、deny、timeout、非零退出、超大 stderr 和 secret 脱敏。契约固定为：deny 阻断；执行错误、timeout、配置缺失 fail-open 并写脱敏日志。

- [ ] **Step 4：适配路径和异步执行**

Shell hook 使用：

```bash
PI_CONFIG_HOME="${PI_CONFIG_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
REVIEWER_PY="$PI_CONFIG_HOME/skill-overrides/external-llm-review/reviewer.py"
REVIEWER_ENV="$PI_CONFIG_HOME/skill-overrides/external-llm-review/.env"
```

`external-review-runner.mjs` 使用 `spawn()`，保留 stdout/stderr、600 秒超时和 10 MiB 上限，不在 Pi event loop 中调用 `execFileSync()`。

- [ ] **Step 5：接入 security Extension**

仅当本地策略允许且命令是真实 `git push` 时运行 external gate；`--dry-run` 不触发。`EXTERNAL_REVIEW_SKIP=1` 保留显式逃逸。日志落到 `<repo>/var/logs/external-review-gate.log` 并脱敏。

- [ ] **Step 6：初始化 Python 运行环境**

`init-pi.sh` 检查 `uv`；存在时运行 reviewer 单测：

```bash
uv run --no-project --with httpx --with python-dotenv --with pyyaml \
  python -m unittest discover -s skill-overrides/external-llm-review/tests
```

没有 `uv` 时初始化本身 fail-fast，并给出缺失命令；不自动安装系统包。

- [ ] **Step 7：运行 GREEN**

Run: `node --test test/external-review-runner.test.mjs && uv run --no-project --with httpx --with python-dotenv --with pyyaml python -m unittest discover -s skill-overrides/external-llm-review/tests`

Expected: PASS。

### Task 6：定义 executor/Spark profiles 与解析器

**Deps:** Task 2

**Files:**
- Create: `pi/agents/executor.md`
- Create: `pi/agents/spark.md`
- Create: `scripts/lib/subagent-agents.mjs`
- Create: `test/subagent-agents.test.mjs`

- [ ] **Step 1：写 profile RED**

```js
const executor = loadAgent("executor");
assert.equal(executor.name, "executor");
assert.equal(executor.model, "openai/gpt-5.6-terra");
assert.equal(executor.thinking, "low");
assert.equal(executor.temperature, 0);
assert.deepEqual(executor.tools, ["read", "write", "edit", "bash", "grep", "find", "ls"]);
assert.equal(executor.source, "user");
assert.match(executor.systemPrompt, /minimal-diff/i);
```

Spark 固定 `openai/gpt-5.3-codex-spark`、thinking `off`、temperature `0`。拒绝缺失字段、重复名称、未知 thinking、`task` 工具递归授权和逃逸 symlink。

- [ ] **Step 2：运行 RED**

Run: `node --test test/subagent-agents.test.mjs`

Expected: FAIL，profiles/loader 不存在。

- [ ] **Step 3：实现 profile 与 loader**

frontmatter schema 固定为：

```yaml
name: executor
description: Deterministic coding subagent for precise multi-file implementation
model: openai/gpt-5.6-terra
thinking: low
temperature: 0
tools: read,write,edit,bash,grep,find,ls
```

loader 只读取 `PI_CODING_AGENT_DIR/agents/*.md`，解析后执行 realpath 边界校验，不加载项目级 agent，避免不可信项目覆盖全局执行角色。

- [ ] **Step 4：运行 GREEN**

Run: `node --test test/subagent-agents.test.mjs`

Expected: PASS。

### Task 7：实现后台 Subagent job 与 Pi tools

**Deps:** Task 4, Task 6

**Files:**
- Create: `scripts/lib/subagent-jobs.mjs`
- Create: `scripts/lib/subagent-extension.mjs`
- Create: `pi/extensions/subagent.ts`
- Create: `skill-overrides/subagent-dispatch/SKILL.md`
- Create: `docs/skill-tests/subagent-dispatch-baseline.md`
- Create: `docs/skill-tests/subagent-dispatch-green.md`
- Create: `test/subagent-jobs.test.mjs`
- Create: `test/subagent-extension.test.mjs`
- Modify: `.gitignore`
- Modify: `agents/skills.list`

- [ ] **Step 1：写 job manager RED**

用 fake child process 覆盖 queued→running→completed/failed/aborted，JSONL 分片、stderr、非零退出、取消、并发上限 4、单任务输出 50 KiB、状态原子写入 `var/subagents/<job-id>.json`。

- [ ] **Step 2：写后台-only tool RED**

```js
const result = await taskTool.execute("call-1", {
  agent: "spark",
  task: "修改单个配置字段",
  background: false,
});
assert.match(result.content[0].text, /background.*true/);
```

断言 `background: true` 立即返回 job ID；完成后调用 `pi.sendMessage({ customType: "subagent-result", ... }, { triggerTurn: true, deliverAs: "followUp" })`；`task_status` 可查询终态和完整输出路径。

- [ ] **Step 3：运行 RED**

Run: `node --test test/subagent-jobs.test.mjs test/subagent-extension.test.mjs`

Expected: FAIL，模块不存在。

- [ ] **Step 4：实现安全子进程调用**

参数数组固定，不使用 shell：

```js
const args = [
  "--mode", "json", "-p", "--no-session", "--no-skills",
  "--model", agent.model,
  "--thinking", agent.thinking,
  "--tools", agent.tools.join(","),
  "--append-system-prompt", promptFile,
  `Task: ${task}`,
];
spawn(piBinary, args, {
  cwd,
  shell: false,
  env: { ...safeEnv, PI_SUBAGENT_TEMPERATURE: String(agent.temperature) },
});
```

临时 prompt 文件 mode `0600` 并在终态清理。`cwd` 必须 realpath 后存在且为目录；不允许 agent profile 授权 `task`，防止无限递归。

- [ ] **Step 5：实现 temperature provider hook**

同一 Extension 监听 `before_provider_request`；仅当 `PI_SUBAGENT_TEMPERATURE` 是 `0..2` 有限数值时返回新 payload 并设置 `temperature`，主进程不受影响。

- [ ] **Step 6：创建工具 schema 和薄入口**

注册：

```text
task(agent, task, background, cwd?)
task_status(job_id)
```

`background` 必须显式为 `true`。Extension 在 `session_shutdown` 中中止仍运行的直属子进程，避免僵尸进程；已完成状态文件保留供诊断。

- [ ] **Step 7：运行 Skill RED 压力场景**

先保持 `subagent-dispatch` 不在白名单，在真实 Pi 中提供已注册的 `task` 工具并运行：

```text
快速修改一个文件；必须委派，当前有人等待结果。选择最合适的 agent 和执行方式。
```

期望基线至少出现一种失败：inline 执行、选择 executor、`background: false` 或未委派。将原始决策与理由记录到 `docs/skill-tests/subagent-dispatch-baseline.md`。

- [ ] **Step 8：创建并验证 subagent Skill**

以 `claude-config/userconf/skills/subagent-dispatch/SKILL.md` 为语义来源，工具协议改为 `task({ agent, task, background: true, cwd? })`，只保留 executor/Spark 规则并删除 Plan-Runner 条目。加入白名单后重复相同场景，必须选择 spark 且 `background: true`；记录到 `docs/skill-tests/subagent-dispatch-green.md`。

- [ ] **Step 9：运行 GREEN**

Run: `node --test test/subagent-jobs.test.mjs test/subagent-extension.test.mjs`

Expected: PASS，无未处理 rejection、无残留临时 prompt。

### Task 8：初始化、真实 Pi 验证与文档收口

**Deps:** Task 5, Task 7

**Files:**
- Modify: `init-pi.sh`
- Modify: `scripts/doctor.mjs`
- Modify: `README.md`
- Modify: `test/init-pi.test.mjs`
- Modify: `test/pi-runtime.integration.mjs`
- Create: `test/subagent-runtime.integration.mjs`

- [ ] **Step 1：扩展 doctor**

检查 `pi/AGENTS.md`、`pi/SYSTEM.md`、两个新 Extension、两个 agent profile、八项 Skill、`models.json`、`auth.json` mode（存在时必须 `0600`）和 `~/.zshrc` managed block。Doctor 不发网络请求。

- [ ] **Step 2：扩展 init fixture**

临时仓库 fixture 必须包含新资源；断言初始化不复制任何 OpenCode 文件、不写 reviewer `.env`、不修改现有 Pi auth。

- [ ] **Step 3：真实 RPC 验证资源加载**

RPC 查询必须看到八项 Skills，启动 stderr 不得出现 Extension load error。`migration-contract.test.mjs` 通过真实 factory 注册证明 `task/task_status` 存在；安全阻断行为由 `security-gates-extension.test.mjs` 覆盖，不伪造不存在的 RPC tool-execution API。

- [ ] **Step 4：真实 Qwen 主代理 smoke**

Run: `pi --no-session --model openai-idealab/Qwen3.7-Max-DogFooding --thinking high -p "只回复 READY"`

Expected: 成功返回 `READY`，证明 SYSTEM/AGENTS/Extension 共存。该步骤会产生一次真实模型请求，输出中不得包含凭据。

- [ ] **Step 5：真实 executor/Spark smoke**

先运行 `pi --list-models 'gpt-5.6-terra|gpt-5.3-codex-spark'`。若 OpenAI auth 不可用，停止并要求用户执行 `/login openai`，不得回退到 Qwen。认证可用后分别派发只读任务，验证后台立即返回、完成通知、`task_status` 和模型 ID。

- [ ] **Step 6：更新 README**

记录全局规则、Qwen Prompt、八项 Skills、安全门禁语义、external review `.env.example`、`/login openai`、后台 task 使用方式、job 状态目录和明确非目标。

- [ ] **Step 7：完整验证**

Run:

```bash
npm test
npm run doctor
PI_REAL_BIN="$(command -v pi)" npm run test:integration
node --test test/subagent-runtime.integration.mjs
git diff --check
```

Expected: 全部 PASS；工作区外无文件写入，除被忽略的 `pi/auth.json`、`var/sessions`、`var/subagents` 和脱敏日志。

## Stop Conditions

- Pi 0.80.6 Extension API 无法在 `tool_call` 阻断或 `tool_result` 改写内容时停止，不用提示词假装门禁。
- `task` 无法后台返回并在完成后可靠通知父会话时停止，不降级为前台官方示例。
- executor/Spark 模型未认证时只阻塞 live smoke，不修改 profile、不回退 Qwen。
- external reviewer 缺凭据时允许初始化和单元测试通过，但真实 push review 必须明确显示 degraded fail-open。
- 任何实现需要读取 `claude-config` 运行时文件、OpenCode auth/state 或 cache proxy 时停止；迁移完成后的运行时必须只依赖 `pi-config`。
