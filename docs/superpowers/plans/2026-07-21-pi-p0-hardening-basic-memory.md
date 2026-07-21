# Pi P0 收口、最高危禁止与 Basic Memory 接入实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 恢复 Pi 配置仓可验收基线，以三类硬禁止覆盖最高危操作，并通过专用本地工具接入 Basic Memory。

**Architecture:** 保留现有 `security-gates` Extension，不新增通用权限层；把敏感路径、不可逆 Git、危险 shell 包装器作为纯函数策略接入。Basic Memory 使用官方 `basic-memory tool` CLI 的参数数组调用，专用 Extension 只暴露 search/read/build-context/recent/write，强制 `--local`，不开放 delete/reset/cloud/MCP 通用桥。

**Tech Stack:** Node.js 22、Pi Extension API、TypeBox、Node test runner、Basic Memory CLI 0.22.1、Bash、Python unittest

**范围外：** 通用 `allow/ask/deny` 权限引擎、全链路 secret redaction、Memory 自动写入、LSP、通用 MCP、Web/Server、Plan pause/resume、OpenCode 配置迁移。

## Execution Contract

```json
{
  "schemaVersion": "pi-plan.v1",
  "verification": [
    "npm test",
    "npm run doctor",
    "uv run --no-project --with httpx --with python-dotenv --with pyyaml python -m unittest discover -s skill-overrides/external-llm-review/tests",
    "basic-memory doctor --local",
    "git diff --check"
  ],
  "requiredGates": ["deterministic", "plan-audit", "external-review", "final-completeness"]
}
```

---

### Task 1: 记录根因并冻结决策边界

**Files:**
- Create: `docs/bugs/bug-pi-runtime-contract-drift.md`
- Modify: `docs/pi-vs-opencode-gap-assessment-2026-07-21.md`

- [ ] **Step 1: 写迁移契约漂移 Bug 六要素**

在 Bug 文档中明确记录：现象、影响、时间线、根因、促成因素、修复与防复发。根因至少覆盖 `b7a922e` 后旧 Skill/SYSTEM 路径、Pi 版本、Anthropic temperature 测试和 Plan external-review 语义四项，不把 6 个失败写成一个模糊的“测试过期”。

- [ ] **Step 2: 把用户决策写回评估报告**

在路线图前增加“已批准范围”：P0 全部执行；通用权限层、统一可观测性与完整 Memory/Knowledge 延后；最高危硬禁止仅含凭据文件访问、不可逆 Git/工作区外删除、危险包装器绕过；Basic Memory 仅本地专用工具。

- [ ] **Step 3: 检查文档格式**

Run: `git diff --check -- docs/bugs/bug-pi-runtime-contract-drift.md docs/pi-vs-opencode-gap-assessment-2026-07-21.md`
Expected: PASS，无输出。

- [ ] **Step 4: Commit**

```bash
git add docs/bugs/bug-pi-runtime-contract-drift.md docs/pi-vs-opencode-gap-assessment-2026-07-21.md
git commit -m "docs(decision): 记录 Pi 收口范围"
```

### Task 2: 修复 Skill、Prompt、版本与初始化契约漂移

**Deps:** Task 1

**Files:**
- Modify: `test/doctor.test.mjs`
- Modify: `test/global-rules.test.mjs`
- Modify: `test/migration-contract.test.mjs`
- Modify: `test/skill-whitelist-extension.test.mjs`
- Modify: `test/init-pi.test.mjs`
- Modify: `scripts/doctor.mjs`
- Modify: `scripts/lib/model-system-prompt.mjs`
- Modify: `README.md`
- Modify: `init-pi.sh`

- [ ] **Step 1: 先把测试改成唯一真实契约**

测试必须断言：主清单为 `skill-overrides/skills.list`，本地清单为 `skill-overrides/skills.local.list`；模型提示文件为 `SYSTEM.qwen.md` 与 `SYSTEM.anthropic.md`；Pi 版本为 `0.80.10`；全局 Skill 为 10 项，本地 Skill 为 4 项。增加 Peach 模型命中 Qwen 兼容提示的失败测试：

```js
test("replaces system prompt for the configured Peach compatibility model", async () => {
  const pi = createMockPi();
  createModelSystemPromptExtension(pi);
  const result = await pi.handlers.get("before_agent_start")(
    { systemPrompt: "generic", systemPromptOptions: {} },
    { model: { provider: "openai-idealab", id: "Peach-07-17-DogFooding" } },
  );
  assert.match(result.systemPrompt, /Stop Rules/);
});
```

- [ ] **Step 2: 运行定向测试并确认 RED**

Run: `node --test test/doctor.test.mjs test/global-rules.test.mjs test/migration-contract.test.mjs test/skill-whitelist-extension.test.mjs test/init-pi.test.mjs test/model-system-prompt.test.mjs`
Expected: FAIL，至少包含 doctor 旧路径、`0.80.6` 和 Peach 未命中。

- [ ] **Step 3: 最小修复真实入口**

将 doctor 与测试统一调用：

```js
const listPath = join(repoRoot, "skill-overrides", "skills.list");
const localListPath = join(repoRoot, "skill-overrides", "skills.local.list");
const desired = await loadDesiredSkills(repoRoot, listPath, localListPath);
```

将版本常量统一为 `0.80.10`。将 Qwen 兼容匹配改为配置模型的明确集合，不做任意 Peach 通配：

```js
const PROVIDER_PROMPT_MAP = {
  "openai-idealab": {
    pattern: /^(?:Qwen.*|Peach-07-17-DogFooding)$/i,
    file: "SYSTEM.qwen.md",
  },
  "anthropic-idealab": { pattern: /claude/i, file: "SYSTEM.anthropic.md" },
};
```

- [ ] **Step 4: 更新 README 与初始化断言**

README 只描述 `skill-overrides/skills.list`、`skills.local.list`、Pi `0.80.10` 和当前模型；删除“精确八个 Skill”与旧 Qwen model 命令。`init-pi.sh` 的 `PI_VERSION` 和 fixture 断言同步为 `0.80.10`。

- [ ] **Step 5: 验证 GREEN**

Run: `node --test test/doctor.test.mjs test/global-rules.test.mjs test/migration-contract.test.mjs test/skill-whitelist-extension.test.mjs test/init-pi.test.mjs test/model-system-prompt.test.mjs`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add README.md init-pi.sh scripts/doctor.mjs scripts/lib/model-system-prompt.mjs test/doctor.test.mjs test/global-rules.test.mjs test/migration-contract.test.mjs test/skill-whitelist-extension.test.mjs test/init-pi.test.mjs test/model-system-prompt.test.mjs
git commit -m "fix(runtime): 统一 Pi 运行契约"
```

### Task 3: 统一 Reviewer 与 Plan Gate 完成语义

**Deps:** Task 1

**Files:**
- Modify: `skill-overrides/external-llm-review/tests/test_reviewer.py`
- Modify: `test/plan-gates.test.mjs`
- Modify: `scripts/lib/plan/gates.mjs`
- Modify: `docs/pi-plan-execution-capsule.md`
- Create: `test/anthropic-request-rewriter.test.mjs`

- [ ] **Step 1: 修正 Anthropic payload 测试契约**

Anthropic provider 的测试应显式断言不发送 temperature，而不是把 OpenAI 参数强加给 Anthropic：

```python
payload = provider.build_payload(messages=messages, spec={"temperature": 0.3})
self.assertNotIn("temperature", payload)
```

- [ ] **Step 2: 先把 Plan unavailable 测试改成 fail-closed**

```js
test("unavailable external-review blocks plan validation", async (t) => {
  // 沿用现有 repository/acceptedProjection fixture
  const result = await runPlanGates({
    cwd,
    baseCommit: "HEAD~1",
    projection: acceptedProjection(head),
    commands: [nodeCommand()],
    audit: async () => ({ findings: [] }),
    externalReview: async () => ({ available: false, findings: [] }),
  });
  assert.equal(result.validated, false);
  assert.equal(result.attempts.find((a) => a.type === "external-review").status, "unavailable");
  assert.equal(result.attempts.find((a) => a.type === "final-completeness").status, "failed");
});
```

- [ ] **Step 3: 运行测试确认 RED**

Run: `node --test test/plan-gates.test.mjs && uv run --no-project --with httpx --with python-dotenv --with pyyaml python -m unittest discover -s skill-overrides/external-llm-review/tests`
Expected: Node FAIL 于 unavailable 仍 validated；Python PASS。

- [ ] **Step 4: 收紧 Plan 完成判定**

`complete()` 和最终 validated 只能接受 `passed`：

```js
function complete(projection, attempts, inspection) {
  return [...projection.tasks.values()].every((task) => task.status === "accepted")
    && [...projection.attempts.values()].every((item) => !["dispatch-requested", "active"].includes(item.status))
    && clean(inspection)
    && attempts.slice(0, 3).every((item) => item.status === "passed");
}

const validated = attempts.every((result) => result.status === "passed");
return { validated, lifecycle: validated ? "verifying" : "running", attempts };
```

顶层 push Gate 的 provider-unavailable fail-open 保持不变，并在文档中明确它与 Plan `validated` 的差异。

- [ ] **Step 5: 为 Anthropic request rewriter 增加直接测试**

覆盖四个行为：alias model ID 重写、metadata user ID、adaptive thinking、cache marker；使用 mock Pi 捕获 `before_provider_request`，不得发真实网络请求。

- [ ] **Step 6: 验证 GREEN**

Run: `node --test test/plan-gates.test.mjs test/anthropic-request-rewriter.test.mjs && uv run --no-project --with httpx --with python-dotenv --with pyyaml python -m unittest discover -s skill-overrides/external-llm-review/tests`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add skill-overrides/external-llm-review/tests/test_reviewer.py test/plan-gates.test.mjs scripts/lib/plan/gates.mjs docs/pi-plan-execution-capsule.md test/anthropic-request-rewriter.test.mjs
git commit -m "fix(gates): 收紧计划验证完成语义"
```

### Task 4: 增加三类最高危硬禁止

**Deps:** Task 1

**Files:**
- Modify: `test/shell-policy.test.mjs`
- Modify: `test/security-gates-extension.test.mjs`
- Modify: `scripts/lib/shell-policy.mjs`
- Modify: `scripts/lib/security-gates-extension.mjs`

- [ ] **Step 1: 为不可逆 Git 与包装器绕过写失败测试**

必须阻断：`git reset --hard`、`git clean -fd`、`git clean -fdx`、`git checkout -- file`、`git restore --worktree file`；以及 `sh -c 'rm -rf /Users/shared'`、换行/管道中出现的同类危险命令。普通 `git reset file`、`git clean -nfd`、workspace 内普通删除继续允许。

- [ ] **Step 2: 为敏感路径访问写失败测试**

`read/write/edit` 必须阻断：`pi/auth.json`、`~/.local/share/opencode/auth.json`、`~/.local/share/opencode/mcp-auth.json`、任意 `.env`/`.env.*`；允许 `.env.example`、`.env.sample`、`.env.template`。测试必须使用绝对路径、相对路径和 symlink ancestor 三种形式。

- [ ] **Step 3: 运行测试确认 RED**

Run: `node --test test/shell-policy.test.mjs test/security-gates-extension.test.mjs`
Expected: FAIL 于新增危险命令和敏感路径未被阻断。

- [ ] **Step 4: 实现纯函数硬禁止**

新增并导出 `checkSensitivePath`，只接受明确高危集合：

```js
const SAFE_ENV_SUFFIX = /\.env\.(?:example|sample|template)$/i;
const SENSITIVE_BASENAME = /^(?:auth|mcp-auth)\.json$/i;

export function checkSensitivePath({ toolName, input, cwd }) {
  if (!["read", "write", "edit"].includes(toolName)) return undefined;
  const raw = input?.path ?? input?.filePath ?? input?.file_path ?? input?.filename;
  if (!raw) return violation("SENSITIVE_PATH_UNCERTAIN", "敏感文件工具调用缺少可信路径");
  const candidate = canonicalCandidate(resolve(cwd, expandTilde(raw))); 
  if (!candidate) return violation("SENSITIVE_PATH_UNCERTAIN", "无法确认敏感文件路径");
  const normalized = candidate.replaceAll("\\", "/");
  if (SAFE_ENV_SUFFIX.test(normalized)) return undefined;
  if (/(?:^|\/)\.env(?:\.[^/]+)?$/i.test(normalized)) return violation("SENSITIVE_ENV_FILE", "禁止 Agent 访问环境凭据文件");
  if (SENSITIVE_BASENAME.test(normalized.split("/").at(-1)) && /(?:^|\/)(?:pi|opencode)(?:\/|$)/i.test(normalized)) {
    return violation("SENSITIVE_AUTH_FILE", "禁止 Agent 访问认证凭据文件");
  }
  return undefined;
}
```

`security-gates-extension` 在 bash policy 前对所有工具调用执行该检查。Shell parser 只扩展危险命令识别，不建设通用 parser：识别换行/单管道；对 `sh|bash|zsh -c` 的字符串递归检查一次；增加 `checkDestructiveGit()`。

- [ ] **Step 5: 验证 GREEN 与无回归**

Run: `node --test test/shell-policy.test.mjs test/security-gates-extension.test.mjs`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/shell-policy.mjs scripts/lib/security-gates-extension.mjs test/shell-policy.test.mjs test/security-gates-extension.test.mjs
git commit -m "feat(security): 禁止最高危文件与命令操作"
```

### Task 5: 接入 Basic Memory 本地专用工具

**Deps:** Task 4

**Files:**
- Create: `scripts/lib/basic-memory-extension.mjs`
- Create: `pi/extensions/basic-memory.ts`
- Create: `test/basic-memory-extension.test.mjs`

- [ ] **Step 1: 写工具注册与参数失败测试**

Mock Pi 必须只观察到五个工具：`memory_search`、`memory_read`、`memory_context`、`memory_recent`、`memory_write`。断言所有命令都以 `basic-memory tool` 开头并包含 `--local`，参数通过数组传递；不得注册 delete/reset/cloud/generic MCP 工具。

- [ ] **Step 2: 写持久写入秘密拒绝测试**

以下内容必须在启动进程前拒绝：private key header、`api_key=...`、`token: ...`、`password=...`、`Bearer ...`、`sk-...`。普通架构决策、URL 和短单词 `token` 不应误判。

```js
assert.equal(containsLikelySecret("API token rotates weekly"), false);
assert.equal(containsLikelySecret("api_key=sk-abcdefghijklmnop"), true);
assert.equal(containsLikelySecret("-----BEGIN PRIVATE KEY-----"), true);
```

- [ ] **Step 3: 运行测试确认 RED**

Run: `node --test test/basic-memory-extension.test.mjs`
Expected: FAIL，模块不存在。

- [ ] **Step 4: 实现五个 typed tools**

Extension 工厂使用 `pi.exec("basic-memory", args, { signal, timeout: 30000 })`，结果超过 50KB 时截断并明确标记。固定命令映射：

```js
const COMMANDS = {
  memory_search: (p) => ["tool", "search-notes", p.query, "--local", ...(p.project ? ["--project", p.project] : [])],
  memory_read: (p) => ["tool", "read-note", p.identifier, "--local", ...(p.project ? ["--project", p.project] : [])],
  memory_context: (p) => ["tool", "build-context", p.query, "--local", ...(p.project ? ["--project", p.project] : [])],
  memory_recent: (p) => ["tool", "recent-activity", "--local", ...(p.project ? ["--project", p.project] : [])],
  memory_write: (p) => ["tool", "write-note", "--title", p.title, "--folder", p.folder, "--content", p.content, "--local", ...(p.project ? ["--project", p.project] : [])],
};
```

`memory_write` 不提供 `--overwrite`；冲突必须返回 Basic Memory 原始错误，让用户显式处理。所有 tool descriptions 说明“本地持久存储，不得写入凭据或秘密”。

- [ ] **Step 5: 增加 Pi Extension 入口**

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBasicMemoryExtension } from "../../scripts/lib/basic-memory-extension.mjs";

export default function basicMemory(pi: ExtensionAPI) {
  createBasicMemoryExtension(pi);
}
```

- [ ] **Step 6: 验证 GREEN**

Run: `node --test test/basic-memory-extension.test.mjs`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/basic-memory-extension.mjs pi/extensions/basic-memory.ts test/basic-memory-extension.test.mjs
git commit -m "feat(memory): 接入本地 Basic Memory 工具"
```

### Task 6: 把 Basic Memory 纳入初始化与 doctor

**Deps:** Task 5

**Files:**
- Modify: `test/init-pi.test.mjs`
- Modify: `test/doctor.test.mjs`
- Modify: `test/pi-runtime.integration.mjs`
- Modify: `init-pi.sh`
- Modify: `scripts/doctor.mjs`
- Modify: `README.md`

- [ ] **Step 1: 写安装与 doctor 失败测试**

fixture 必须记录 `uv tool install --force basic-memory==0.22.1`；doctor 注入 `readBasicMemoryVersion` 后，`0.22.1` 无 issue，missing/其他版本产生明确 issue；真实 RPC 的 active tools 包含五个 memory 工具。

- [ ] **Step 2: 运行定向测试确认 RED**

Run: `node --test test/init-pi.test.mjs test/doctor.test.mjs test/pi-runtime.integration.mjs`
Expected: FAIL 于未安装、未诊断或未注册 memory tools。

- [ ] **Step 3: 实现可复现安装和诊断**

在 `init-pi.sh` 增加：

```bash
BASIC_MEMORY_VERSION="0.22.1"
uv tool install --force "basic-memory==$BASIC_MEMORY_VERSION"
```

在 doctor 通过 `basic-memory --version` 解析精确版本，并检查 `pi/extensions/basic-memory.ts` 可读。不得读取 Basic Memory 笔记内容，不得执行 `reset/reindex/cloud`。

- [ ] **Step 4: 更新 README**

环境要求增加 `uv`；说明五个工具、本地强制路由、默认 project 解析、秘密拒绝和未开放操作。提供 `basic-memory status --local --json` 与 `basic-memory doctor --local` 诊断命令。

- [ ] **Step 5: 验证 GREEN**

Run: `node --test test/init-pi.test.mjs test/doctor.test.mjs test/pi-runtime.integration.mjs && npm run doctor`
Expected: PASS，doctor 仅保留已知 limitation warning。

- [ ] **Step 6: Commit**

```bash
git add init-pi.sh scripts/doctor.mjs README.md test/init-pi.test.mjs test/doctor.test.mjs test/pi-runtime.integration.mjs
git commit -m "build(memory): 固定 Basic Memory 安装版本"
```

### Task 7: 完整验证与证据收口

**Deps:** Task 6

**Files:**
- Modify: `docs/pi-vs-opencode-gap-assessment-2026-07-21.md`

- [ ] **Step 1: 运行全量 Node 测试**

Run: `npm test`
Expected: PASS，0 failed。

- [ ] **Step 2: 运行 doctor 与真实 Pi 集成**

Run: `npm run doctor && npm run test:integration && npm run test:subagents && npm run test:plan`
Expected: PASS；若真实 provider 凭据不可用，只允许测试明确标记的 offline/unavailable 路径，不得删除验证。

- [ ] **Step 3: 运行 Python reviewer 测试与 Basic Memory 健康检查**

Run: `uv run --no-project --with httpx --with python-dotenv --with pyyaml python -m unittest discover -s skill-overrides/external-llm-review/tests && basic-memory doctor --local && basic-memory status --local --json`
Expected: PASS；status 返回合法 JSON。

- [ ] **Step 4: 验证安全负例**

Run: `node --test test/shell-policy.test.mjs test/security-gates-extension.test.mjs test/basic-memory-extension.test.mjs`
Expected: PASS，确认凭据路径、不可逆 Git、包装器绕过和 Memory secret ingress 都被阻断。

- [ ] **Step 5: 更新评估报告证据**

将原 `221/227` 和 doctor 失败标为“修复前证据”，追加修复后命令、版本和结果；不得删除历史问题记录。

- [ ] **Step 6: 检查工作区与最终 Commit**

Run: `git diff --check && git status --short`
Expected: 无格式错误，只包含本计划预期文件。

```bash
git add docs/pi-vs-opencode-gap-assessment-2026-07-21.md
git commit -m "docs(assessment): 更新 Pi 收口验证证据"
```
