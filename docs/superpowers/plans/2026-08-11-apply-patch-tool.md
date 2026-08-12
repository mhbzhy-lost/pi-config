# apply_patch 工具移植实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 OpenAI Codex 开源的 `apply_patch` 工具移植为 Pi extension，作为与 `edit`/`write` 共存的可选文件编辑工具。

**Architecture:** 核心算法（patch 解析器、模糊行匹配、文件变更应用）移植为纯 JS 模块放在 `scripts/lib/apply-patch/`，不依赖 Pi 运行时，可独立测试。Pi extension（`pi/extensions/apply-patch.ts`）通过 `pi.registerTool()` 将其注册为 `apply_patch` 工具。源码来自 `github.com/openai/codex`（Apache-2.0），核心参考 `codex-rs/apply-patch/src/`。

**Tech Stack:** Node.js ≥22（内置 test runner）、ESM `.mjs`、TypeScript extension（Pi 自动 transpile）

## Global Constraints

- 许可证：Apache-2.0（Codex），与本项目兼容，无需额外声明
- 测试框架：`node --test "test/**/*.test.mjs"`（项目既有约定）
- 模块格式：ESM（`"type": "module"`）
- 仅实现 `NormalizeToLf` 模式；`PreserveLineEndings` 不移植（YAGNI）
- 不支持 streaming 解析（Pi 工具一次性获得完整输入）
- 不支持 `Environment ID`（Codex 远程环境专用）
- 不修改已有工具（`edit`/`write`/`bash` 等）的行为
- 文件路径：patch 内路径相对于 `cwd` 解析，也接受绝对路径

## DAG 依赖图

```
T1 (parser) ──┐
              ├──→ T3 (apply 引擎) ──→ T4 (Pi extension + 系统提示)
T2 (seek)  ──┘
```

- T1、T2 无依赖，可并发
- T3 依赖 T1 的 `parsePatch` 和 T2 的 `seekSequence`
- T4 依赖 T3 的 `applyPatch`

### Wave 调度组

- **Wave 0**（并发）：T1、T2
- **Wave 1**：T3
- **Wave 2**：T4

---

## 文件结构

| 操作 | 路径 | 职责 |
|------|------|------|
| 新建 | `scripts/lib/apply-patch/parser.mjs` | Patch 文本 → Hunk[] |
| 新建 | `scripts/lib/apply-patch/seek-sequence.mjs` | 4 级降级模糊行匹配 |
| 新建 | `scripts/lib/apply-patch/apply.mjs` | 解析 + 匹配 + 文件系统写入 |
| 新建 | `scripts/lib/apply-patch/index.mjs` | 公共 API 重导出 |
| 新建 | `pi/extensions/apply-patch.ts` | Pi registerTool 集成 |
| 新建 | `test/apply-patch-parser.test.mjs` | 解析器测试 |
| 新建 | `test/apply-patch-seek.test.mjs` | 行匹配测试 |
| 新建 | `test/apply-patch-apply.test.mjs` | 端到端 apply 测试 |
| 修改 | `pi/SYSTEM.qwen.md` | 添加 apply_patch 工具说明 |
| 修改 | `pi/SYSTEM.anthropic.md` | 添加 apply_patch 工具说明 |

---

### Task 1: Patch 解析器

**Deps:** none

**Files:**
- Create: `scripts/lib/apply-patch/parser.mjs`
- Test: `test/apply-patch-parser.test.mjs`

**Interfaces:**
- Produces:

```js
/**
 * @param {string} patchText - 完整 patch 文本（*** Begin Patch ... *** End Patch）
 * @returns {{ hunks: Hunk[] }}
 * @throws {ParseError} 格式不合法时
 */
export function parsePatch(patchText)

// Hunk 类型（用 plain object + type 字段区分）:
// { type: "add",    path: string, contents: string }
// { type: "delete", path: string }
// { type: "update", path: string, movePath: string|null, chunks: UpdateFileChunk[] }

// UpdateFileChunk:
// {
//   changeContext: string|null,   // @@ 后的上下文定位符
//   oldLines: string[],           // 要匹配的原文行（含 context 行）
//   newLines: string[],           // 替换后的新行（含 context 行）
//   contextLineIndices: Array<[number, number]>,  // context 行在 old/new 中的索引对
//   isEndOfFile: boolean          // 是否要求匹配到文件末尾
// }

export class ParseError extends Error {
  constructor(message, lineNumber)  // lineNumber 可选
}
```

**参考源码：** `/tmp/codex-src/codex-rs/apply-patch/src/streaming_parser.rs`（状态机）、`parser.rs`（边界校验 + lenient heredoc 剥离）。移植时去掉 streaming（`push_delta`/`finish`），改为单次全量解析。保留 lenient 模式（heredoc 剥离）。不实现 `Environment ID`。

- [ ] **Step 1: 写解析器失败测试 — 基本 Add/Delete/Update**

```js
// test/apply-patch-parser.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { parsePatch, ParseError } from "../scripts/lib/apply-patch/parser.mjs";

test("parses add file hunk", () => {
  const { hunks } = parsePatch(
    "*** Begin Patch\n*** Add File: hello.txt\n+Hello\n+World\n*** End Patch"
  );
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0], {
    type: "add",
    path: "hello.txt",
    contents: "Hello\nWorld\n",
  });
});

test("parses delete file hunk", () => {
  const { hunks } = parsePatch(
    "*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch"
  );
  assert.deepEqual(hunks, [{ type: "delete", path: "gone.txt" }]);
});

test("parses update file hunk with context", () => {
  const { hunks } = parsePatch(
    "*** Begin Patch\n*** Update File: app.py\n@@\n foo\n-bar\n+baz\n*** End Patch"
  );
  assert.equal(hunks.length, 1);
  const h = hunks[0];
  assert.equal(h.type, "update");
  assert.equal(h.path, "app.py");
  assert.equal(h.movePath, null);
  assert.equal(h.chunks.length, 1);
  assert.deepEqual(h.chunks[0].oldLines, ["foo", "bar"]);
  assert.deepEqual(h.chunks[0].newLines, ["foo", "baz"]);
  assert.deepEqual(h.chunks[0].contextLineIndices, [[0, 0]]);
  assert.equal(h.chunks[0].isEndOfFile, false);
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test test/apply-patch-parser.test.mjs`
Expected: FAIL — `Cannot find module '../scripts/lib/apply-patch/parser.mjs'`

- [ ] **Step 3: 实现解析器**

从 Codex `streaming_parser.rs` 移植状态机，改为行数组单次遍历。关键点：
- 边界校验：首行 `*** Begin Patch`，末行 `*** End Patch`
- Lenient 模式：剥离 `<<'EOF' ... EOF` heredoc 包裹
- 状态：`NotStarted → StartedPatch → AddFile | DeleteFile | UpdateFile → EndedPatch`
- UpdateFile 内：`@@ [context]` 开新 chunk，` `/`+`/`-` 前缀行，`*** End of File` 标记，`*** Move to:` 重命名
- 空行在 update hunk 内视为空 context 行
- `*** Update File:` 无 chunk 时报错 "Update file hunk for path '...' is empty"
- `@@` 后紧跟 `@@` 或 `*** End Patch` 时报错 "Update hunk does not contain any lines"

```js
// scripts/lib/apply-patch/parser.mjs
export class ParseError extends Error {
  constructor(message, lineNumber) {
    super(lineNumber != null ? `line ${lineNumber}: ${message}` : message);
    this.name = "ParseError";
    this.lineNumber = lineNumber;
  }
}

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";
const MOVE_TO = "*** Move to: ";
const EOF_MARKER = "*** End of File";
const CTX = "@@ ";
const EMPTY_CTX = "@@";

export function parsePatch(text) {
  // lenient heredoc 剥离
  let lines = text.trim().split("\n").map(l => l.replace(/\r$/, ""));
  lines = stripHeredoc(lines);
  checkBoundaries(lines);
  const hunks = [];
  let i = 1; // skip BEGIN
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed === END) { i++; break; }
    if (trimmed.startsWith(ADD)) {
      // ... 收集 + 行直到下一个 header
    } else if (trimmed.startsWith(DELETE)) {
      // ... push delete hunk
    } else if (trimmed.startsWith(UPDATE)) {
      // ... 解析 move_to + chunks
    } else {
      throw new ParseError(`'${trimmed}' is not a valid hunk header...`, i + 1);
    }
  }
  return { hunks };
}
// （完整实现约 200 行，按上述状态机逻辑展开）
```

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `node --test test/apply-patch-parser.test.mjs`
Expected: PASS

- [ ] **Step 5: 追加边界和错误测试**

```js
// 追加到 test/apply-patch-parser.test.mjs

test("rejects missing Begin Patch", () => {
  assert.throws(() => parsePatch("bad"), ParseError);
});

test("rejects missing End Patch", () => {
  assert.throws(() => parsePatch("*** Begin Patch\n*** Add File: f\n+x"), ParseError);
});

test("rejects empty update hunk", () => {
  assert.throws(
    () => parsePatch("*** Begin Patch\n*** Update File: f.py\n*** End Patch"),
    (e) => e instanceof ParseError && e.message.includes("empty")
  );
});

test("parses move-to rename", () => {
  const { hunks } = parsePatch(
    "*** Begin Patch\n*** Update File: old.js\n*** Move to: new.js\n@@\n-a\n+b\n*** End Patch"
  );
  assert.equal(hunks[0].movePath, "new.js");
});

test("parses multiple hunks in one patch", () => {
  const { hunks } = parsePatch(
    "*** Begin Patch\n*** Add File: a.txt\n+a\n*** Delete File: b.txt\n*** Update File: c.txt\n@@\n-x\n+y\n*** End Patch"
  );
  assert.equal(hunks.length, 3);
  assert.deepEqual(hunks.map(h => h.type), ["add", "delete", "update"]);
});

test("parses change context (@@ header)", () => {
  const { hunks } = parsePatch(
    "*** Begin Patch\n*** Update File: f.py\n@@ def main():\n-pass\n+return 1\n*** End Patch"
  );
  assert.equal(hunks[0].chunks[0].changeContext, "def main():");
});

test("parses End of File marker", () => {
  const { hunks } = parsePatch(
    "*** Begin Patch\n*** Update File: f.txt\n@@\n+appended\n*** End of File\n*** End Patch"
  );
  assert.equal(hunks[0].chunks[0].isEndOfFile, true);
});

test("strips heredoc wrapper (lenient)", () => {
  const { hunks } = parsePatch(
    "<<'EOF'\n*** Begin Patch\n*** Add File: h.txt\n+hi\n*** End Patch\nEOF"
  );
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].contents, "hi\n");
});

test("parses multiple chunks in one update", () => {
  const { hunks } = parsePatch(
    "*** Begin Patch\n*** Update File: f.txt\n@@\n foo\n-bar\n+BAR\n@@\n baz\n-qux\n+QUX\n*** End Patch"
  );
  assert.equal(hunks[0].chunks.length, 2);
});

test("treats bare empty line in update as empty context", () => {
  const { hunks } = parsePatch(
    "*** Begin Patch\n*** Update File: f.txt\n@@\n before\n\n after\n*** End Patch"
  );
  const c = hunks[0].chunks[0];
  assert.deepEqual(c.oldLines, ["before", "", "after"]);
  assert.deepEqual(c.contextLineIndices, [[0, 0], [1, 1], [2, 2]]);
});
```

- [ ] **Step 6: 运行全部测试确认 GREEN**

Run: `node --test test/apply-patch-parser.test.mjs`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/apply-patch/parser.mjs test/apply-patch-parser.test.mjs
git commit -m "feat(apply-patch): port Codex patch parser to JS"
```

---

### Task 2: 模糊行匹配（seek_sequence）

**Deps:** none

**Files:**
- Create: `scripts/lib/apply-patch/seek-sequence.mjs`
- Test: `test/apply-patch-seek.test.mjs`

**Interfaces:**
- Produces:

```js
/**
 * 在 lines[start..] 中查找 pattern 的起始位置。
 * 4 级降级匹配：精确 → 去尾空白 → 去首尾空白 → Unicode 标点归一化。
 * @param {string[]} lines - 源文件各行
 * @param {string[]} pattern - 要查找的行序列
 * @param {number} start - 起始搜索索引
 * @param {boolean} eof - 若 true，优先从文件末尾匹配
 * @returns {number|null} 匹配起始索引，未找到返回 null
 */
export function seekSequence(lines, pattern, start, eof)
```

**参考源码：** `/tmp/codex-src/codex-rs/apply-patch/src/seek_sequence.rs`。直接移植，含 Unicode 归一化（fancy dashes/quotes/spaces → ASCII）。

- [ ] **Step 1: 写失败测试**

```js
// test/apply-patch-seek.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { seekSequence } from "../scripts/lib/apply-patch/seek-sequence.mjs";

test("exact match", () => {
  assert.equal(seekSequence(["foo", "bar", "baz"], ["bar", "baz"], 0, false), 1);
});

test("returns null when not found", () => {
  assert.equal(seekSequence(["foo", "bar"], ["qux"], 0, false), null);
});

test("returns start for empty pattern", () => {
  assert.equal(seekSequence(["foo"], [], 0, false), 0);
});

test("returns null when pattern longer than lines", () => {
  assert.equal(seekSequence(["one"], ["a", "b", "c"], 0, false), null);
});

test("rstrip match ignores trailing whitespace", () => {
  assert.equal(seekSequence(["foo   ", "bar\t"], ["foo", "bar"], 0, false), 0);
});

test("trim match ignores leading and trailing whitespace", () => {
  assert.equal(seekSequence(["    foo   ", "   bar"], ["foo", "bar"], 0, false), 0);
});

test("unicode normalization matches fancy dashes to ASCII", () => {
  // EN DASH (\u2013) in source, ASCII '-' in pattern
  assert.equal(
    seekSequence(["import \u2013 fast"], ["import - fast"], 0, false),
    0
  );
});

test("unicode normalization matches fancy quotes", () => {
  assert.equal(
    seekSequence(["say \u201Chello\u201D"], ['say "hello"'], 0, false),
    0
  );
});

test("eof flag searches from end first", () => {
  const lines = ["a", "b", "a", "b"];
  // Without eof: finds first occurrence at 0
  assert.equal(seekSequence(lines, ["a", "b"], 0, false), 0);
  // With eof: finds last occurrence at 2
  assert.equal(seekSequence(lines, ["a", "b"], 0, true), 2);
});

test("respects start offset", () => {
  assert.equal(seekSequence(["x", "y", "x"], ["x"], 1, false), 2);
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test test/apply-patch-seek.test.mjs`
Expected: FAIL — `Cannot find module`

- [ ] **Step 3: 实现 seekSequence**

```js
// scripts/lib/apply-patch/seek-sequence.mjs

function normalise(s) {
  return s.trim().replace(
    /[\u2010-\u2015\u2212]/g, "-"
  ).replace(
    /[\u2018\u2019\u201A\u201B]/g, "'"
  ).replace(
    /[\u201C\u201D\u201E\u201F]/g, '"'
  ).replace(
    /[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " "
  );
}

function matchesAt(lines, pattern, i, mode) {
  for (let p = 0; p < pattern.length; p++) {
    const a = lines[i + p];
    const b = pattern[p];
    const ok = mode === 0 ? a === b
      : mode === 1 ? a.trimEnd() === b.trimEnd()
      : mode === 2 ? a.trim() === b.trim()
      : normalise(a) === normalise(b);
    if (!ok) return false;
  }
  return true;
}

export function seekSequence(lines, pattern, start, eof) {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return null;

  const searchStart = eof && lines.length >= pattern.length
    ? lines.length - pattern.length
    : start;

  for (let mode = 0; mode < 4; mode++) {
    for (let i = searchStart; i <= lines.length - pattern.length; i++) {
      if (matchesAt(lines, pattern, i, mode)) return i;
    }
  }
  return null;
}
```

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `node --test test/apply-patch-seek.test.mjs`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/apply-patch/seek-sequence.mjs test/apply-patch-seek.test.mjs
git commit -m "feat(apply-patch): port Codex fuzzy line matcher to JS"
```

---

### Task 3: Apply 引擎（文件系统操作）

**Deps:** T1（`parsePatch`）、T2（`seekSequence`）
- 依赖理由：apply 引擎调用 `parsePatch` 解析 patch 文本，调用 `seekSequence` 定位替换区间

**Files:**
- Create: `scripts/lib/apply-patch/apply.mjs`
- Create: `scripts/lib/apply-patch/index.mjs`
- Test: `test/apply-patch-apply.test.mjs`

**Interfaces:**
- Consumes:
  - `parsePatch(patchText)` from T1 → `{ hunks: Hunk[] }`
  - `seekSequence(lines, pattern, start, eof)` from T2 → `number | null`
- Produces:

```js
/**
 * 解析并应用 patch 到文件系统。
 * @param {string} patchText - 完整 patch 文本
 * @param {string} cwd - 工作目录，用于解析相对路径
 * @returns {Promise<{ added: string[], modified: string[], deleted: string[] }>}
 * @throws {ParseError} patch 格式错误
 * @throws {ApplyError} 文件操作失败（含已成功应用的变更摘要）
 */
export async function applyPatch(patchText, cwd)

export class ApplyError extends Error {
  constructor(message, { applied })  // applied: 已成功应用的文件列表
}
```

**参考源码：** `/tmp/codex-src/codex-rs/apply-patch/src/file_update.rs`（`compute_replacements` + `apply_replacements`）、`lib.rs`（`apply_hunks_to_files`）。用 `node:fs/promises` 替代 `ExecutorFileSystem`。路径解析用 `node:path` 的 `resolve(cwd, hunkPath)`。

- [ ] **Step 1: 写失败测试 — Add/Update/Delete 端到端**

```js
// test/apply-patch-apply.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyPatch, ApplyError } from "../scripts/lib/apply-patch/apply.mjs";

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "apply-patch-test-"));
  try { return await fn(dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test("add file creates file with contents", async () => {
  await withTempDir(async (dir) => {
    const result = await applyPatch(
      "*** Begin Patch\n*** Add File: hello.txt\n+Hello\n+World\n*** End Patch",
      dir
    );
    assert.deepEqual(result.added, ["hello.txt"]);
    assert.equal(await readFile(join(dir, "hello.txt"), "utf8"), "Hello\nWorld\n");
  });
});

test("add file creates parent directories", async () => {
  await withTempDir(async (dir) => {
    await applyPatch(
      "*** Begin Patch\n*** Add File: sub/dir/file.txt\n+deep\n*** End Patch",
      dir
    );
    assert.equal(await readFile(join(dir, "sub/dir/file.txt"), "utf8"), "deep\n");
  });
});

test("update file replaces matched lines", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "app.py"), "foo\nbar\nbaz\n");
    const result = await applyPatch(
      "*** Begin Patch\n*** Update File: app.py\n@@\n foo\n-bar\n+BAR\n*** End Patch",
      dir
    );
    assert.deepEqual(result.modified, ["app.py"]);
    assert.equal(await readFile(join(dir, "app.py"), "utf8"), "foo\nBAR\nbaz\n");
  });
});

test("delete file removes file", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "gone.txt"), "bye");
    const result = await applyPatch(
      "*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch",
      dir
    );
    assert.deepEqual(result.deleted, ["gone.txt"]);
    await assert.rejects(() => readFile(join(dir, "gone.txt")));
  });
});

test("update file with move renames file", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "old.js"), "const x = 1;\n");
    const result = await applyPatch(
      "*** Begin Patch\n*** Update File: old.js\n*** Move to: new.js\n@@\n-const x = 1;\n+const x = 2;\n*** End Patch",
      dir
    );
    assert.deepEqual(result.modified, ["old.js"]);
    await assert.rejects(() => readFile(join(dir, "old.js")));
    assert.equal(await readFile(join(dir, "new.js"), "utf8"), "const x = 2;\n");
  });
});

test("update file with change context locates correct position", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "f.py"), "def a():\n    pass\n\ndef b():\n    pass\n");
    await applyPatch(
      "*** Begin Patch\n*** Update File: f.py\n@@ def b():\n-    pass\n+    return 2\n*** End Patch",
      dir
    );
    const content = await readFile(join(dir, "f.py"), "utf8");
    assert.ok(content.includes("def a():\n    pass"));
    assert.ok(content.includes("def b():\n    return 2"));
  });
});

test("update file with multiple chunks", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "multi.txt"), "foo\nbar\nbaz\nqux\n");
    await applyPatch(
      "*** Begin Patch\n*** Update File: multi.txt\n@@\n foo\n-bar\n+BAR\n@@\n baz\n-qux\n+QUX\n*** End Patch",
      dir
    );
    assert.equal(await readFile(join(dir, "multi.txt"), "utf8"), "foo\nBAR\nbaz\nQUX\n");
  });
});

test("update file appends with End of File", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "f.txt"), "line1\n");
    await applyPatch(
      "*** Begin Patch\n*** Update File: f.txt\n@@\n+line2\n*** End of File\n*** End Patch",
      dir
    );
    assert.equal(await readFile(join(dir, "f.txt"), "utf8"), "line1\nline2\n");
  });
});

test("fuzzy match ignores trailing whitespace", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "f.txt"), "foo   \nbar\n");
    await applyPatch(
      "*** Begin Patch\n*** Update File: f.txt\n@@\n-foo\n+FOO\n bar\n*** End Patch",
      dir
    );
    assert.equal(await readFile(join(dir, "f.txt"), "utf8"), "FOO\nbar\n");
  });
});

test("throws ApplyError when update target not found", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "f.txt"), "aaa\n");
    await assert.rejects(
      () => applyPatch(
        "*** Begin Patch\n*** Update File: f.txt\n@@\n-zzz\n+yyy\n*** End Patch",
        dir
      ),
      (e) => e instanceof ApplyError && e.message.includes("Failed to find")
    );
  });
});

test("throws ApplyError when update file does not exist", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      () => applyPatch(
        "*** Begin Patch\n*** Update File: missing.txt\n@@\n-a\n+b\n*** End Patch",
        dir
      ),
      (e) => e instanceof ApplyError
    );
  });
});

test("multi-file patch applies all operations", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "del.txt"), "x");
    await writeFile(join(dir, "mod.txt"), "old\n");
    const result = await applyPatch(
      "*** Begin Patch\n*** Add File: new.txt\n+new\n*** Delete File: del.txt\n*** Update File: mod.txt\n@@\n-old\n+new\n*** End Patch",
      dir
    );
    assert.deepEqual(result.added, ["new.txt"]);
    assert.deepEqual(result.deleted, ["del.txt"]);
    assert.deepEqual(result.modified, ["mod.txt"]);
  });
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test test/apply-patch-apply.test.mjs`
Expected: FAIL — `Cannot find module`

- [ ] **Step 3: 实现 apply 引擎**

```js
// scripts/lib/apply-patch/apply.mjs
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { parsePatch, ParseError } from "./parser.mjs";
import { seekSequence } from "./seek-sequence.mjs";

export { ParseError };

export class ApplyError extends Error {
  constructor(message, { applied = [] } = {}) {
    super(message);
    this.name = "ApplyError";
    this.applied = applied;
  }
}

export async function applyPatch(patchText, cwd) {
  const { hunks } = parsePatch(patchText);
  if (hunks.length === 0) throw new ApplyError("No files were modified.");

  const added = [], modified = [], deleted = [];

  for (const hunk of hunks) {
    const absPath = resolve(cwd, hunk.path);
    if (hunk.type === "add") {
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, hunk.contents, "utf8");
      added.push(hunk.path);
    } else if (hunk.type === "delete") {
      await rm(absPath);  // 让 ENOENT 自然抛出
      deleted.push(hunk.path);
    } else {
      // update
      const original = await readFile(absPath, "utf8").catch((e) => {
        throw new ApplyError(`Failed to read file to update ${hunk.path}: ${e.message}`);
      });
      const newContent = computeNewContent(original, hunk.chunks, hunk.path);
      if (hunk.movePath) {
        const absDest = resolve(cwd, hunk.movePath);
        await mkdir(dirname(absDest), { recursive: true });
        await writeFile(absDest, newContent, "utf8");
        await rm(absPath);
      } else {
        await writeFile(absPath, newContent, "utf8");
      }
      modified.push(hunk.path);
    }
  }
  return { added, modified, deleted };
}

function computeNewContent(original, chunks, pathLabel) {
  let lines = original.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const replacements = []; // [startIndex, oldLen, newLines[]]
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.changeContext) {
      const idx = seekSequence(lines, [chunk.changeContext], lineIndex, false);
      if (idx === null) {
        throw new ApplyError(
          `Failed to find context '${chunk.changeContext}' in ${pathLabel}`
        );
      }
      lineIndex = idx + 1;
    }

    if (chunk.oldLines.length === 0) {
      // 纯插入：追加到文件末尾
      const insertIdx = lines.length > 0 && lines[lines.length - 1] === ""
        ? lines.length - 1
        : lines.length;
      replacements.push([insertIdx, 0, chunk.newLines]);
      continue;
    }

    let pattern = chunk.oldLines;
    let newSlice = chunk.newLines;
    let found = seekSequence(lines, pattern, lineIndex, chunk.isEndOfFile);

    // 尾部空行重试（与 Codex 行为一致）
    if (found === null && pattern.length > 0 && pattern[pattern.length - 1] === "") {
      pattern = pattern.slice(0, -1);
      if (newSlice.length > 0 && newSlice[newSlice.length - 1] === "") {
        newSlice = newSlice.slice(0, -1);
      }
      found = seekSequence(lines, pattern, lineIndex, chunk.isEndOfFile);
    }

    if (found === null) {
      throw new ApplyError(
        `Failed to find expected lines in ${pathLabel}:\n${chunk.oldLines.join("\n")}`
      );
    }

    replacements.push([found, pattern.length, newSlice]);
    lineIndex = found + pattern.length;
  }

  // 按索引降序应用替换
  replacements.sort((a, b) => a[0] - b[0]);
  for (let i = replacements.length - 1; i >= 0; i--) {
    const [start, oldLen, newLines] = replacements[i];
    lines.splice(start, oldLen, ...newLines);
  }

  if (lines.length === 0 || lines[lines.length - 1] !== "") {
    lines.push("");
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: 创建 index.mjs 重导出**

```js
// scripts/lib/apply-patch/index.mjs
export { parsePatch, ParseError } from "./parser.mjs";
export { seekSequence } from "./seek-sequence.mjs";
export { applyPatch, ApplyError } from "./apply.mjs";
```

- [ ] **Step 5: 运行测试确认 GREEN**

Run: `node --test test/apply-patch-apply.test.mjs`
Expected: ALL PASS

- [ ] **Step 6: 运行全部 apply-patch 测试回归**

Run: `node --test test/apply-patch-*.test.mjs`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/apply-patch/ test/apply-patch-apply.test.mjs
git commit -m "feat(apply-patch): add apply engine with fuzzy matching and multi-file support"
```

---

### Task 4: Pi Extension 注册 + 系统提示更新

**Deps:** T3（`applyPatch`）
- 依赖理由：extension 的 `execute` 函数调用 T3 产出的 `applyPatch(patchText, cwd)`

**Files:**
- Create: `pi/extensions/apply-patch.ts`
- Modify: `pi/SYSTEM.qwen.md`（Tool Usage 段落）
- Modify: `pi/SYSTEM.anthropic.md`（Tool Usage 段落）

**Interfaces:**
- Consumes: `applyPatch(patchText: string, cwd: string)` from `scripts/lib/apply-patch/index.mjs`

- [ ] **Step 1: 创建 Pi extension**

```ts
// pi/extensions/apply-patch.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TOOL_DESCRIPTION = `Apply a structured patch to create, update, or delete files.
The patch uses a file-oriented diff format:

*** Begin Patch
*** Add File: <path>       — create file (+ lines = contents)
*** Delete File: <path>    — remove file
*** Update File: <path>    — modify file (optionally *** Move to: <new path>)
  @@ [context]             — optional class/function locator
  context line             — unchanged (space prefix)
- removed line             — line to remove
+ added line               — line to add
  *** End of File           — anchor to file end
*** End Patch

Matching is fuzzy: trailing/leading whitespace and Unicode punctuation variants are tolerated.
Paths are relative to the working directory. Multiple file operations can be combined in one patch.`;

export default function applyPatchTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "apply_patch",
    label: "apply_patch",
    description: TOOL_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        patch: {
          type: "string",
          description:
            "The complete patch text (*** Begin Patch ... *** End Patch)",
        },
      },
      required: ["patch"],
    },
    async execute(_toolCallId: string, params: { patch: string }, _signal: unknown, _onUpdate: unknown, ctx: { cwd: string }) {
      const { applyPatch } = await import(
        "../../scripts/lib/apply-patch/index.mjs"
      );
      try {
        const result = await applyPatch(params.patch, ctx.cwd);
        const lines: string[] = ["Success. Updated the following files:"];
        for (const p of result.added) lines.push(`A ${p}`);
        for (const p of result.modified) lines.push(`M ${p}`);
        for (const p of result.deleted) lines.push(`D ${p}`);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    },
  } as any);
}
```

- [ ] **Step 2: 更新 SYSTEM.qwen.md 的 Tool Usage 段落**

在 `pi/SYSTEM.qwen.md` 的 `## Using Your Tools` 段落末尾（`- **Background processes:**` 之后）追加：

```markdown
- **apply_patch tool:** For multi-file changes, renames, or when fuzzy matching is beneficial, use `apply_patch` instead of multiple `edit`/`write` calls. It accepts a structured patch (`*** Begin Patch ... *** End Patch`) and applies all operations atomically per file. Read files first to ensure accurate context lines.
```

- [ ] **Step 3: 更新 SYSTEM.anthropic.md 的 Tool Usage 段落**

在 `pi/SYSTEM.anthropic.md` 的 `# Tool Usage` 段落末尾追加同一条：

```markdown
- For multi-file changes, renames, or fuzzy matching, use `apply_patch` (structured patch format) instead of multiple individual tool calls.
```

- [ ] **Step 4: 手动验证 extension 加载**

Run: 启动 Pi 会话，输入 `列出你的可用工具`，确认 `apply_patch` 出现在工具列表中。

- [ ] **Step 5: 手动验证端到端功能**

在 Pi 会话中请求：`用 apply_patch 工具在当前目录创建一个测试文件 test-apply-patch-demo.txt，内容为 hello world`。确认文件被正确创建。

- [ ] **Step 6: 运行全量测试回归**

Run: `npm test`
Expected: ALL PASS（新测试通过，既有测试不受影响）

- [ ] **Step 7: Commit**

```bash
git add pi/extensions/apply-patch.ts pi/SYSTEM.qwen.md pi/SYSTEM.anthropic.md
git commit -m "feat(apply-patch): register as Pi tool and update system prompts"
```
