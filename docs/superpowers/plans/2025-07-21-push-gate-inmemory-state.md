# Push Gate 内存状态机重构计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 push gate 的状态机从文件系统 (`.git/review-markers/*.json`) 迁移到 extension 进程内存，消除会话结束后的状态残留问题。

**Architecture:**
- 状态机逻辑从 647 行的 bash/Python hook 脚本迁移到 `security-gates-extension.mjs` 中的 in-memory Map
- Hook 脚本删除，reviewer 调用直接由新模块 `review-runner.mjs` 处理（spawn `uv run reviewer.py`）
- Git 信息收集（diff hash、文件统计、base ref）由新模块中的辅助函数完成

**Tech Stack:** Node.js (ESM), node:test, child_process

---

### Task 1: 新建 push-review-state 模块（纯内存状态机）

**Files:**
- Create: `scripts/lib/push-review-state.mjs`
- Create: `test/push-review-state.test.mjs`

- [ ] **Step 1: 写状态机的失败测试**

```javascript
// test/push-review-state.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { createPushReviewState } from "../scripts/lib/push-review-state.mjs";

test("首次 push 返回 needs-review round 1", () => {
  const state = createPushReviewState();
  const action = state.determine({ repoKey: "my-repo", diffHash: "abc123" });
  assert.deepEqual(action, { action: "run", round: 1 });
});

test("review 通过后相同 diffHash 返回 allow", () => {
  const state = createPushReviewState();
  state.record({ repoKey: "my-repo", diffHash: "abc123", hasCritical: false, hasImportant: false, round: 1 });
  const action = state.determine({ repoKey: "my-repo", diffHash: "abc123" });
  assert.deepEqual(action, { action: "allow" });
});

test("review 有 critical 且 diffHash 未变返回 deny", () => {
  const state = createPushReviewState();
  state.record({ repoKey: "my-repo", diffHash: "abc123", hasCritical: true, hasImportant: false, round: 1 });
  const action = state.determine({ repoKey: "my-repo", diffHash: "abc123" });
  assert.deepEqual(action, { action: "deny" });
});

test("deny 后 diffHash 变化触发 round 2", () => {
  const state = createPushReviewState();
  state.record({ repoKey: "my-repo", diffHash: "abc123", hasCritical: true, hasImportant: false, round: 1 });
  const action = state.determine({ repoKey: "my-repo", diffHash: "def456" });
  assert.deepEqual(action, { action: "run", round: 2 });
});

test("round 2 仍有问题后第三次 push 放行（budget 耗尽）", () => {
  const state = createPushReviewState();
  state.record({ repoKey: "my-repo", diffHash: "abc123", hasCritical: true, hasImportant: false, round: 1 });
  state.record({ repoKey: "my-repo", diffHash: "def456", hasCritical: true, hasImportant: false, round: 2 });
  const action = state.determine({ repoKey: "my-repo", diffHash: "def456" });
  assert.deepEqual(action, { action: "allow", reason: "budget-exhausted" });
});

test("TTL 过期后重新 review", () => {
  const state = createPushReviewState({ ttlMs: 50 });
  state.record({ repoKey: "my-repo", diffHash: "abc123", hasCritical: false, hasImportant: false, round: 1 });
  // 模拟过期
  state._entries.get("my-repo").timestamp = Date.now() - 100;
  const action = state.determine({ repoKey: "my-repo", diffHash: "abc123" });
  assert.deepEqual(action, { action: "run", round: 1 });
});

test("不同 repo 互不影响", () => {
  const state = createPushReviewState();
  state.record({ repoKey: "repo-a", diffHash: "aaa", hasCritical: true, hasImportant: false, round: 1 });
  const action = state.determine({ repoKey: "repo-b", diffHash: "bbb" });
  assert.deepEqual(action, { action: "run", round: 1 });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/push-review-state.test.mjs`
Expected: FAIL (module not found)

- [ ] **Step 3: 实现状态机**

```javascript
// scripts/lib/push-review-state.mjs
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ROUNDS = 2;

export function createPushReviewState({ ttlMs = DEFAULT_TTL_MS } = {}) {
  const entries = new Map();

  function determine({ repoKey, diffHash }) {
    const entry = entries.get(repoKey);
    if (!entry || Date.now() - entry.timestamp > ttlMs) {
      return { action: "run", round: 1 };
    }
    if (entry.diffHash === diffHash) {
      if (entry.hasCritical || entry.hasImportant) {
        if (entry.round >= MAX_ROUNDS) {
          entries.delete(repoKey);
          return { action: "allow", reason: "budget-exhausted" };
        }
        return { action: "deny" };
      }
      return { action: "allow" };
    }
    // diffHash changed
    if (entry.round >= MAX_ROUNDS && (entry.hasCritical || entry.hasImportant)) {
      entries.delete(repoKey);
      return { action: "allow", reason: "budget-exhausted" };
    }
    if ((entry.hasCritical || entry.hasImportant) && entry.round < MAX_ROUNDS) {
      return { action: "run", round: entry.round + 1 };
    }
    return { action: "run", round: 1 };
  }

  function record({ repoKey, diffHash, hasCritical, hasImportant, round }) {
    entries.set(repoKey, { diffHash, hasCritical, hasImportant, round, timestamp: Date.now() });
  }

  return { determine, record, _entries: entries };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/push-review-state.test.mjs`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/push-review-state.mjs test/push-review-state.test.mjs
git commit -m "feat(push-gate): 新增纯内存 push review 状态机"
```

---

### Task 2: 新建 review-invoker 模块（git 信息收集 + reviewer 调用）

**Deps:** Task 1
**Files:**
- Create: `scripts/lib/review-invoker.mjs`
- Create: `test/review-invoker.test.mjs`

- [ ] **Step 1: 写测试**

```javascript
// test/review-invoker.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { parseSections, shouldExempt } from "../scripts/lib/review-invoker.mjs";

test("parseSections 检测 Critical 段落有内容", () => {
  const text = "### Critical\n\n1. SQL injection in user input\n\n### Minor\n\nNone.";
  const result = parseSections(text);
  assert.equal(result.hasCritical, true);
  assert.equal(result.hasImportant, false);
  assert.equal(result.hasMinor, false);
});

test("parseSections 识别 None/N/A 为无问题", () => {
  const text = "### Critical\n\nNone.\n\n### Important\n\nN/A\n\n### Minor\n\n- typo in readme";
  const result = parseSections(text);
  assert.equal(result.hasCritical, false);
  assert.equal(result.hasImportant, false);
  assert.equal(result.hasMinor, true);
});

test("shouldExempt 小于阈值行数放行", () => {
  assert.equal(shouldExempt({ totalLines: 8, allNonCode: false, hasBinary: false }), true);
});

test("shouldExempt 全非代码文件放行", () => {
  assert.equal(shouldExempt({ totalLines: 500, allNonCode: true, hasBinary: false }), true);
});

test("shouldExempt 二进制文件不豁免", () => {
  assert.equal(shouldExempt({ totalLines: 5, allNonCode: false, hasBinary: true }), false);
});

test("shouldExempt 大代码变更不豁免", () => {
  assert.equal(shouldExempt({ totalLines: 100, allNonCode: false, hasBinary: false }), false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/review-invoker.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现模块**

```javascript
// scripts/lib/review-invoker.mjs
import { execFile } from "node:child_process";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const NON_CODE_EXTS = new Set([".md", ".json", ".txt", ".yml", ".yaml", ".toml", ".csv", ".lock", ".gitignore"]);
const MAX_EXEMPT_LINES = 10;
const NEGATIVE_RE = /^(none\.?|n\/?a|no\s+(\w+\s+)?issues(\s+found)?|nothing\s+to\s+report|✅|无)/i;
const PROVIDER_CHAIN = ["idealab-anthropic", "bailian", "idealab-openai"];
const DEFAULT_TIMEOUT_MS = 540_000;

export function parseSections(text) {
  function hasContent(header) {
    const pattern = new RegExp(`#{1,4}\\s*${header}[^\\n]*\\n(.+?)(?=\\n#{1,4}\\s|$)`, "si");
    const m = text.match(pattern);
    if (!m) return false;
    const body = m[1].trim();
    const firstLine = body.split("\n").find((l) => l.trim())?.trim() ?? "";
    const normalized = firstLine.replace(/^[-*+]\s*/, "").replace(/^[*_` \t]+|[*_` \t]+$/g, "");
    return body.length > 0 && !NEGATIVE_RE.test(normalized);
  }
  return { hasCritical: hasContent("Critical"), hasImportant: hasContent("Important"), hasMinor: hasContent("Minor") };
}

export function shouldExempt({ totalLines, allNonCode, hasBinary }) {
  if (hasBinary) return false;
  if (totalLines < MAX_EXEMPT_LINES) return true;
  if (allNonCode) return true;
  return false;
}

export async function gatherDiffInfo({ cwd }) {
  const git = (...args) => execFileAsync("git", args, { cwd, timeout: 10_000 }).then((r) => r.stdout.trim());

  let baseRef;
  try {
    baseRef = await git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  } catch {
    try {
      baseRef = await git("rev-parse", "--abbrev-ref", "origin/HEAD");
    } catch {
      baseRef = "origin/main";
    }
  }

  const range = `${baseRef}..HEAD`;
  const ahead = await git("rev-list", range, "--count");
  if (ahead === "0") return { exempt: true, reason: "nothing-to-push" };

  const numstat = await git("diff", "--diff-filter=ACM", "--numstat", range);
  let totalLines = 0;
  let allNonCode = true;
  let hasBinary = false;
  let fileCount = 0;

  for (const line of numstat.split("\n").filter(Boolean)) {
    const [add, del, file] = line.split("\t");
    fileCount++;
    if (add === "-") { hasBinary = true; continue; }
    totalLines += parseInt(add, 10) + parseInt(del, 10);
    const ext = "." + (file.split(".").pop() || "").toLowerCase();
    if (!NON_CODE_EXTS.has(ext)) allNonCode = false;
  }

  if (shouldExempt({ totalLines, allNonCode, hasBinary })) return { exempt: true, reason: "small-or-non-code" };

  const diffContent = await git("diff", "--diff-filter=ACM", range);
  const diffHash = createHash("sha256").update(diffContent).digest("hex").slice(0, 16);

  return { exempt: false, baseRef, range, diffHash, fileCount };
}

export async function runReview({ cwd, baseRef, round, reviewerPy, envFile, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  for (const provider of PROVIDER_CHAIN) {
    try {
      const { stdout } = await execFileAsync("uv", [
        "run", "--no-project",
        "--with", "httpx", "--with", "python-dotenv", "--with", "pyyaml",
        "python", reviewerPy, baseRef, "HEAD",
        "--provider", provider,
        "--review-depth", "exhaustive",
        "--review-round", String(round),
        "--max-issues", "25",
      ], { cwd, timeout: timeoutMs, env: { ...process.env, DOTENV_PATH: envFile } });
      if (stdout.trim()) return { output: stdout.trim(), provider };
    } catch {
      continue;
    }
  }
  return { output: null, provider: null };
}

export function buildDenyReason({ reviewOutput, range, cwd, fileCount }) {
  const context = `Review range: ${range}\nReview repo: ${cwd}\nReview file count: ${fileCount}`;
  const digest =
    "## 综合判断 4 步（必须执行）\n" +
    "1. 逐条比对：列出 (A)双方都抓到 (B)只外源抓到 (C)只同族抓到\n" +
    "2. 对(B)做 threat-model 校验：外源常见误报——本机 CLI 输入当不可信、单 task 阻塞标 Critical、误读累积 diff、只看 diff 没看完整源码\n" +
    "3. 对(C)做同族盲点反思：是否涉及训练偏好（生态版本兼容、库 API 名）\n" +
    "4. 综合产出 fix dispatch：双方认可 + 任一方有真实 evidence 的项打包修复\n" +
    "严重度由证据决定，不由谁说了算。\n\n";
  return `🚫 禁止 push。异源 Review 发现需要修复的问题。\n\n${context}\n\n${digest}---\n\n${reviewOutput}`;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/review-invoker.test.mjs`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/review-invoker.mjs test/review-invoker.test.mjs
git commit -m "feat(push-gate): 新增 review-invoker 模块处理 git 信息和 reviewer 调用"
```

---

### Task 3: 重写 security-gates-extension 的 push 拦截逻辑

**Deps:** Task 1, Task 2
**Files:**
- Modify: `scripts/lib/security-gates-extension.mjs`
- Modify: `test/security-gates-extension.test.mjs`

- [ ] **Step 1: 写集成测试**

```javascript
// 追加到 test/security-gates-extension.test.mjs

test("git push 触发内存状态机：首次 run → deny → fix → allow", async () => {
  let reviewCount = 0;
  const handlers = new Map();
  createSecurityGatesExtension({
    on(name, handler) { handlers.set(name, handler); },
  }, {
    gatherDiffInfo: async () => ({ exempt: false, baseRef: "origin/main", range: "origin/main..HEAD", diffHash: "aaa", fileCount: 2 }),
    runReview: async () => {
      reviewCount++;
      return { output: "### Critical\n\n1. Bug found\n\n### Minor\n\nNone.", provider: "test" };
    },
    reviewerPy: "/fake/reviewer.py",
    envFile: "/fake/.env",
  });

  const handler = handlers.get("tool_call");
  const event = { toolName: "bash", input: { command: "git push" } };
  const ctx = { cwd: "/repo" };

  // 首次 push: 运行 review → deny
  const r1 = await handler(event, ctx);
  assert.equal(r1.block, true);
  assert.match(r1.reason, /禁止 push/);
  assert.equal(reviewCount, 1);

  // 相同 diff 再次 push: 从内存状态 deny，不重新 review
  const r2 = await handler(event, ctx);
  assert.equal(r2.block, true);
  assert.equal(reviewCount, 1); // 未增加
});

test("git push 小 diff 豁免不跑 review", async () => {
  let reviewCalled = false;
  const handlers = new Map();
  createSecurityGatesExtension({
    on(name, handler) { handlers.set(name, handler); },
  }, {
    gatherDiffInfo: async () => ({ exempt: true, reason: "small-or-non-code" }),
    runReview: async () => { reviewCalled = true; return { output: null }; },
  });

  const r = await handlers.get("tool_call")(
    { toolName: "bash", input: { command: "git push" } },
    { cwd: "/repo" },
  );
  assert.equal(r, undefined);
  assert.equal(reviewCalled, false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/security-gates-extension.test.mjs`
Expected: 新测试 FAIL（createSecurityGatesExtension 不接受新参数）

- [ ] **Step 3: 重写 extension 的 push 逻辑**

```javascript
// scripts/lib/security-gates-extension.mjs
import { checkShellPolicy, codingReminderFor } from "./shell-policy.mjs";
import { createPushReviewState } from "./push-review-state.mjs";
import { gatherDiffInfo as defaultGatherDiffInfo, runReview as defaultRunReview, parseSections, buildDenyReason } from "./review-invoker.mjs";
import { join } from "node:path";

function isRealGitPush(command) {
  return /(^|[;&|]\s*)(?:\S+=\S+\s+)*git\s+(?:-\S+(?:\s+\S+)?\s+)*push(?:\s|$)/.test(command)
    && !/\bgit\s+(?:-\S+(?:\s+\S+)?\s+)*push\s+[^\n]*--dry-run\b/.test(command)
    && !/EXTERNAL_REVIEW_SKIP=(?:1|true|yes|on)\b/i.test(command);
}

function appendReminder(content, reminder) {
  let appended = false;
  const nextContent = content.map((part) => {
    if (appended || part?.type !== "text" || typeof part.text !== "string") return part;
    appended = true;
    return { ...part, text: `${part.text}\n\n${reminder}` };
  });
  return appended ? nextContent : undefined;
}

export function createSecurityGatesExtension(pi, {
  gatherDiffInfo = defaultGatherDiffInfo,
  runReview = defaultRunReview,
  reviewerPy,
  envFile,
  configRoot = join(import.meta.dirname, "..", ".."),
} = {}) {
  const reviewState = createPushReviewState();

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash" || typeof event.input?.command !== "string") return undefined;
    const cwd = ctx.cwd;
    if (!cwd) return { block: true, reason: "无法取得可信工作目录，安全门禁已按 fail-closed 阻断 bash" };

    const violation = checkShellPolicy({ command: event.input.command, cwd, workspaceRoot: ctx.cwd, env: process.env });
    if (violation) return { block: true, reason: violation.reason };

    if (!isRealGitPush(event.input.command)) return undefined;

    // --- Push gate ---
    const diffInfo = await gatherDiffInfo({ cwd });
    if (diffInfo.exempt) return undefined;

    const repoKey = cwd;
    const decision = reviewState.determine({ repoKey, diffHash: diffInfo.diffHash });

    if (decision.action === "allow") return undefined;
    if (decision.action === "deny") {
      return { block: true, reason: buildDenyReason({ reviewOutput: "(same issues as previous review — fix and commit before pushing)", range: diffInfo.range, cwd, fileCount: diffInfo.fileCount }) };
    }

    // action === "run"
    const resolvedReviewerPy = reviewerPy || join(configRoot, "skill-overrides", "external-llm-review", "reviewer.py");
    const resolvedEnvFile = envFile || join(configRoot, "skill-overrides", "external-llm-review", ".env");
    const { output } = await runReview({ cwd, baseRef: diffInfo.baseRef, round: decision.round, reviewerPy: resolvedReviewerPy, envFile: resolvedEnvFile });

    if (!output) return undefined; // reviewer unavailable, fail-open

    const sections = parseSections(output);
    reviewState.record({ repoKey, diffHash: diffInfo.diffHash, hasCritical: sections.hasCritical, hasImportant: sections.hasImportant, round: decision.round });

    if (sections.hasCritical || sections.hasImportant) {
      return { block: true, reason: buildDenyReason({ reviewOutput: output, range: diffInfo.range, cwd, fileCount: diffInfo.fileCount }) };
    }
    return undefined;
  });

  pi.on("tool_result", (event) => {
    if (event.isError) return undefined;
    const reminder = codingReminderFor({ toolName: event.toolName, input: event.input });
    if (!reminder || !Array.isArray(event.content)) return undefined;
    const content = appendReminder(event.content, reminder);
    if (!content) return undefined;
    return { content, details: event.details, isError: event.isError };
  });
}

export default createSecurityGatesExtension;
```

- [ ] **Step 4: 运行全部测试确认通过**

Run: `node --test test/security-gates-extension.test.mjs`
Expected: 全部 PASS（含新增测试和旧测试）

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/security-gates-extension.mjs test/security-gates-extension.test.mjs
git commit -m "refactor(push-gate): 用内存状态机替换文件系统 marker

状态存于 extension 进程内 Map，会话关闭即清理，无残留。
移除对 external-review-runner.mjs 和 external-review-gate.sh 的依赖。"
```

---

### Task 4: 删除旧文件并清理

**Deps:** Task 3
**Files:**
- Delete: `scripts/hooks/external-review-gate.sh`
- Delete: `scripts/lib/external-review-runner.mjs`
- Delete: `test/external-review-runner.test.mjs`

- [ ] **Step 1: 确认无其他引用**

```bash
grep -r "external-review-gate\|external-review-runner" scripts/ test/ pi/ --include="*.mjs" --include="*.ts" --include="*.json" | grep -v node_modules
```

- [ ] **Step 2: 删除文件**

```bash
rm scripts/hooks/external-review-gate.sh
rm scripts/lib/external-review-runner.mjs
rm test/external-review-runner.test.mjs
```

- [ ] **Step 3: 运行全部测试**

Run: `node --test test/`
Expected: 全部 PASS，无 broken import

- [ ] **Step 4: Commit**

```bash
git add -A scripts/hooks/external-review-gate.sh scripts/lib/external-review-runner.mjs test/external-review-runner.test.mjs
git commit -m "chore(push-gate): 删除文件系统 marker 相关旧实现

- external-review-gate.sh (647 行 bash/python)
- external-review-runner.mjs (子进程 hook 执行器)
- 对应测试"
```

---

### Task 5: 端到端验证

**Deps:** Task 4
**Files:** 无新建

- [ ] **Step 1: 运行完整测试套件**

```bash
node --test test/
```

- [ ] **Step 2: 手动验证 push gate**

```bash
# 做一个小改动 commit 后尝试 push，观察门禁行为
echo "# test" >> /tmp/test-push-gate.md
git add /tmp/test-push-gate.md && git commit -m "test: 验证 push gate"
git push --dry-run  # 应该不触发 review
git push            # 应该触发 review（如果 diff 超过 10 行）
```

- [ ] **Step 3: 确认会话重启后无残留状态**

重启 Pi 会话后 push 相同 commit，应该重新 review（内存已清空）。

---

## 验收标准

- [ ] 无任何文件系统状态（`.git/review-markers/` 不再被写入）
- [ ] 会话关闭 = 状态清空，下次 push 从头开始
- [ ] 状态机逻辑（round/TTL/budget）行为与旧实现一致
- [ ] 所有测试通过
- [ ] push gate 仍然 fail-open（reviewer 不可用时放行）
- [ ] 代码量显著减少（~647 行 hook → ~50 行状态机 + ~80 行 invoker）
