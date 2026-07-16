# Pi Superpowers Skill 白名单实现计划

> **供执行代理使用：** 严格按任务复选框逐项执行。任何逻辑变更必须先加载 `test-driven-development` Skill，并遵循 RED-GREEN-REFACTOR。未经用户单独授权，不创建 Git commit。

**目标：** 将 Superpowers 5.1.0 作为固定版本的 `vendor/superpowers` 子模块引入，在不加载整包插件的前提下，仅把五个白名单 Skill 安装到 Pi 专属目录 `~/.pi/agent/skills`。

**架构：** `agents/skills.list` 是唯一暴露白名单；源解析优先使用本仓 `skills/<name>`，不存在时回退到 `vendor/superpowers/skills/<name>`。Node.js 同步器以受管 manifest 记录本仓创建的软链，只更新或删除能够证明归本仓管理的链接；`doctor` 只读检查安装状态。所有实现和测试均属于 `pi-config`，不得读取 `claude-config`。

**技术栈：** Node.js 22.19+、Node 内置 test runner、ES modules、Git submodule、文件系统软链。

---

## 范围边界

本计划包含：

- 初始化 `pi-config` Git 仓库和最小 Node.js 工程。
- 固定 `vendor/superpowers` 到 `v5.1.0`。
- 建立五项 Skill 白名单。
- 实现白名单解析、Skill 源解析和选择性软链同步。
- 实现受管 manifest、冲突保护和白名单移除清理。
- 实现只读 `doctor`。
- 建立安装、白名单和文件边界的自动化测试。

本计划不包含：

- 安装 Pi coding agent。
- 创建 Pi `AGENTS.md`、system prompt 或 model/provider 配置。
- 修改 Superpowers Skill 内容。
- 引入 Superpowers 整包插件、hooks 或其他 Skill。
- 引入 plan-runner、subagent、MCP、memory 或安全 Extension。
- 与 `claude-config` 建立软链、submodule、脚本调用或运行时依赖。

## 文件结构

| 路径 | 职责 |
|---|---|
| `.gitignore` | 忽略本机和 Node 生成物 |
| `.gitmodules` | 由 Git 记录 Superpowers 子模块来源 |
| `package.json` | 固定 Node 版本并暴露测试、同步、诊断命令 |
| `agents/skills.list` | 唯一 Skill 暴露白名单 |
| `skills/README.md` | 说明本仓同名 Skill 覆盖 vendor 的约定 |
| `vendor/superpowers/` | 固定到 `v5.1.0` 的上游子模块 |
| `scripts/lib/skill-sync.mjs` | 白名单解析、源解析、同步和诊断核心逻辑 |
| `scripts/sync-skills.mjs` | 同步 CLI，默认写入 `~/.pi/agent/skills` |
| `scripts/doctor.mjs` | 只读诊断 CLI |
| `test/helpers/skill-fixture.mjs` | 测试临时仓库和 Skill fixture |
| `test/skill-list.test.mjs` | 白名单语法和源优先级测试 |
| `test/skill-sync.test.mjs` | 软链、manifest、冲突和清理测试 |
| `test/doctor.test.mjs` | 只读诊断测试 |
| `README.md` | 安装、升级、同步和安全边界说明 |

### Task 1：初始化仓库并固定 Superpowers 5.1.0

**Files:**
- Create: `.gitignore`
- Create: `package.json`
- Create: `agents/skills.list`
- Create: `skills/README.md`
- Create: `.gitmodules`（由 `git submodule add` 生成）
- Create: `vendor/superpowers`（Git submodule）

- [ ] **Step 1：初始化 Git 仓库**

Run in `/Users/leshi.zhy/pi-config`:

```bash
git init -b main
```

Expected: 输出包含 `Initialized empty Git repository`，`git branch --show-current` 输出 `main`。

- [ ] **Step 2：创建最小工程文件**

创建 `.gitignore`：

```gitignore
.DS_Store
node_modules/
```

创建 `package.json`：

```json
{
  "name": "pi-config",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22.19.0"
  },
  "scripts": {
    "test": "node --test \"test/**/*.test.mjs\"",
    "sync:skills": "node scripts/sync-skills.mjs",
    "doctor": "node scripts/doctor.mjs"
  }
}
```

创建 `agents/skills.list`：

```text
# Pi 全局 Skill 白名单。
# 只有此文件列出的 Skill 才能链接到 ~/.pi/agent/skills。

systematic-debugging
test-driven-development
receiving-code-review
writing-plans
writing-skills
```

创建 `skills/README.md`：

```markdown
# 本仓 Skill 覆盖

仅当 Pi 需要不同于固定 vendor 版本的行为时，才在这里放置完整的
`<name>/SKILL.md` 目录。

源优先级：

1. `skills/<name>/SKILL.md`
2. `vendor/superpowers/skills/<name>/SKILL.md`

只安装 `agents/skills.list` 中列出的名称。
```

- [ ] **Step 3：添加并固定 Superpowers 子模块**

Run in `/Users/leshi.zhy/pi-config`:

```bash
git submodule add https://github.com/obra/superpowers.git vendor/superpowers
```

Run with workdir `/Users/leshi.zhy/pi-config/vendor/superpowers`:

```bash
git checkout v5.1.0
```

Expected: `package.json` 中版本为 `5.1.0`，工作树处于 `v5.1.0` 对应的 detached HEAD。

- [ ] **Step 4：验证白名单源完整**

Run in `/Users/leshi.zhy/pi-config`:

```bash
test -f vendor/superpowers/skills/systematic-debugging/SKILL.md && test -f vendor/superpowers/skills/test-driven-development/SKILL.md && test -f vendor/superpowers/skills/receiving-code-review/SKILL.md && test -f vendor/superpowers/skills/writing-plans/SKILL.md && test -f vendor/superpowers/skills/writing-skills/SKILL.md
```

Expected: exit code `0`，无输出。

### Task 2：实现白名单解析和 Skill 源解析

**Deps:** Task 1

**Files:**
- Create: `test/helpers/skill-fixture.mjs`
- Create: `test/skill-list.test.mjs`
- Create: `scripts/lib/skill-sync.mjs`

- [ ] **Step 1：编写 fixture helper**

创建 `test/helpers/skill-fixture.mjs`：

```javascript
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-config-skills-"));
  await mkdir(join(root, "agents"), { recursive: true });
  await mkdir(join(root, "skills"), { recursive: true });
  await mkdir(join(root, "vendor", "superpowers", "skills"), { recursive: true });
  return root;
}

export async function addSkill(root, source, name, marker = source) {
  const directory = source === "local"
    ? join(root, "skills", name)
    : join(root, "vendor", "superpowers", "skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: fixture\n---\n\n${marker}\n`,
  );
  return directory;
}

export async function writeSkillList(root, content) {
  const path = join(root, "agents", "skills.list");
  await writeFile(path, content);
  return path;
}
```

- [ ] **Step 2：编写失败测试**

创建 `test/skill-list.test.mjs`：

```javascript
import assert from "node:assert/strict";
import { readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { addSkill, createFixture, writeSkillList } from "./helpers/skill-fixture.mjs";
import { parseSkillList, resolveSkillSource } from "../scripts/lib/skill-sync.mjs";

test("parseSkillList strips comments while preserving order", () => {
  const result = parseSkillList("# comment\nsystematic-debugging # selected\n\nwriting-plans\n");
  assert.deepEqual(result, ["systematic-debugging", "writing-plans"]);
});

test("parseSkillList rejects duplicates", () => {
  assert.throws(
    () => parseSkillList("writing-plans\nwriting-plans\n"),
    /duplicate skill: writing-plans/,
  );
});

test("parseSkillList rejects names outside the Agent Skills naming subset", () => {
  for (const name of ["../escape", "Writing-Plans", "writing_plans", "-writing", "writing--plans"]) {
    assert.throws(() => parseSkillList(`${name}\n`), /invalid skill name/);
  }
});

test("resolveSkillSource prefers a local override over vendor", async () => {
  const root = await createFixture();
  try {
    await addSkill(root, "vendor", "writing-plans", "vendor");
    const local = await addSkill(root, "local", "writing-plans", "local");
    assert.equal(await resolveSkillSource(root, "writing-plans"), await realpath(local));
    assert.match(await readFile(join(local, "SKILL.md"), "utf8"), /local/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveSkillSource falls back to vendor and fails closed when absent", async () => {
  const root = await createFixture();
  try {
    const vendor = await addSkill(root, "vendor", "systematic-debugging");
    assert.equal(await resolveSkillSource(root, "systematic-debugging"), await realpath(vendor));
    await assert.rejects(
      resolveSkillSource(root, "missing-skill"),
      /missing SKILL.md for allowlisted skill: missing-skill/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3：运行测试并确认 RED**

Run:

```bash
 node --test test/skill-list.test.mjs
```

Expected: FAIL，错误包含 `ERR_MODULE_NOT_FOUND`，因为 `scripts/lib/skill-sync.mjs` 尚不存在。

- [ ] **Step 4：实现最小解析逻辑**

创建 `scripts/lib/skill-sync.mjs`：

```javascript
import { access, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseSkillList(content) {
  const names = [];
  const seen = new Set();

  for (const rawLine of content.split(/\r?\n/u)) {
    const name = rawLine.replace(/#.*$/u, "").trim();
    if (!name) continue;
    if (!SKILL_NAME_PATTERN.test(name)) {
      throw new Error(`invalid skill name: ${name}`);
    }
    if (seen.has(name)) {
      throw new Error(`duplicate skill: ${name}`);
    }
    seen.add(name);
    names.push(name);
  }

  return names;
}

async function hasReadableSkill(directory) {
  try {
    await access(join(directory, "SKILL.md"), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveSkillSource(repoRoot, name) {
  const candidates = [
    join(repoRoot, "skills", name),
    join(repoRoot, "vendor", "superpowers", "skills", name),
  ];

  for (const candidate of candidates) {
    if (await hasReadableSkill(candidate)) return realpath(candidate);
  }

  throw new Error(`missing SKILL.md for allowlisted skill: ${name}`);
}

export async function loadDesiredSkills(repoRoot, listPath) {
  const names = parseSkillList(await readFile(listPath, "utf8"));
  const desired = new Map();
  for (const name of names) {
    desired.set(name, await resolveSkillSource(repoRoot, name));
  }
  return desired;
}
```

- [ ] **Step 5：运行测试并确认 GREEN**

Run:

```bash
 node --test test/skill-list.test.mjs
```

Expected: 5 tests PASS。

### Task 3：实现选择性 Skill 同步

**Deps:** Task 2

**Files:**
- Create: `test/skill-sync.test.mjs`
- Modify: `scripts/lib/skill-sync.mjs`
- Create: `scripts/sync-skills.mjs`

- [ ] **Step 1：编写只暴露白名单的失败测试**

创建 `test/skill-sync.test.mjs`：

```javascript
import assert from "node:assert/strict";
import { lstat, readFile, readlink, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { addSkill, createFixture, writeSkillList } from "./helpers/skill-fixture.mjs";
import { syncSkills } from "../scripts/lib/skill-sync.mjs";

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function resolvedLink(path) {
  return realpath(resolve(join(path, ".."), await readlink(path)));
}

test("syncSkills links only allowlisted skills and writes a manifest", async () => {
  const root = await createFixture();
  const agentDir = join(root, "home", ".pi", "agent");
  try {
    const selected = await addSkill(root, "vendor", "systematic-debugging");
    await addSkill(root, "vendor", "unlisted-skill");
    const listPath = await writeSkillList(root, "systematic-debugging\n");

    const result = await syncSkills({ repoRoot: root, agentDir, listPath });

    const installed = join(agentDir, "skills", "systematic-debugging");
    assert.equal(await resolvedLink(installed), await realpath(selected));
    assert.equal(await pathExists(join(agentDir, "skills", "unlisted-skill")), false);
    assert.deepEqual(result, { linked: ["systematic-debugging"], removed: [], unchanged: [] });

    const manifest = JSON.parse(await readFile(join(agentDir, ".pi-config-managed-skills.json"), "utf8"));
    assert.equal(manifest.version, 1);
    assert.equal(manifest.skills["systematic-debugging"], await realpath(selected));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("syncSkills is idempotent", async () => {
  const root = await createFixture();
  const agentDir = join(root, "agent");
  try {
    await addSkill(root, "vendor", "writing-plans");
    const listPath = await writeSkillList(root, "writing-plans\n");
    await syncSkills({ repoRoot: root, agentDir, listPath });
    const result = await syncSkills({ repoRoot: root, agentDir, listPath });
    assert.deepEqual(result, { linked: [], removed: [], unchanged: ["writing-plans"] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2：运行测试并确认 RED**

Run:

```bash
 node --test test/skill-sync.test.mjs
```

Expected: FAIL，错误包含 `does not provide an export named 'syncSkills'`。

- [ ] **Step 3：实现同步和 manifest 基础逻辑**

在 `scripts/lib/skill-sync.mjs` 追加：

```javascript
import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { lstat, mkdir, readlink, rename, symlink, unlink, writeFile } from "node:fs/promises";

export const DEFAULT_AGENT_DIR = join(homedir(), ".pi", "agent");
const MANIFEST_NAME = ".pi-config-managed-skills.json";

async function statOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readManifest(agentDir) {
  const path = join(agentDir, MANIFEST_NAME);
  const stat = await statOrNull(path);
  if (!stat) return { version: 1, skills: {} };
  const value = JSON.parse(await readFile(path, "utf8"));
  if (value.version !== 1 || !value.skills || Array.isArray(value.skills)) {
    throw new Error(`invalid managed skills manifest: ${path}`);
  }
  return value;
}

async function writeManifest(agentDir, manifest) {
  const path = join(agentDir, MANIFEST_NAME);
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function resolvedLinkTarget(path) {
  const target = await readlink(path);
  return realpath(resolve(dirname(path), target));
}

async function createRelativeLink(source, destination) {
  const temporary = `${destination}.tmp-${process.pid}`;
  await unlink(temporary).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  await symlink(relative(dirname(destination), source), temporary, "dir");
  await rename(temporary, destination);
}

export async function syncSkills({ repoRoot, agentDir = DEFAULT_AGENT_DIR, listPath = join(repoRoot, "agents", "skills.list") }) {
  const desired = await loadDesiredSkills(repoRoot, listPath);
  await mkdir(join(agentDir, "skills"), { recursive: true });
  const manifest = await readManifest(agentDir);
  const result = { linked: [], removed: [], unchanged: [] };

  for (const [name, source] of desired) {
    const destination = join(agentDir, "skills", name);
    const stat = await statOrNull(destination);
    if (stat) {
      if (!stat.isSymbolicLink() || await resolvedLinkTarget(destination) !== source) {
        throw new Error(`refusing to replace unmanaged skill destination: ${destination}`);
      }
      result.unchanged.push(name);
      manifest.skills[name] = source;
      continue;
    }
    await createRelativeLink(source, destination);
    manifest.skills[name] = source;
    result.linked.push(name);
  }

  await writeManifest(agentDir, manifest);
  return result;
}
```

实现时将文件顶部已有的 `join`、`readFile` 等 import 合并为单一 import，禁止保留重复绑定。

- [ ] **Step 4：创建同步 CLI**

创建 `scripts/sync-skills.mjs`：

```javascript
#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { DEFAULT_AGENT_DIR, syncSkills } from "./lib/skill-sync.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = process.env.PI_AGENT_DIR || DEFAULT_AGENT_DIR;

try {
  const result = await syncSkills({ repoRoot, agentDir });
  for (const name of result.linked) console.log(`[linked] ${name}`);
  for (const name of result.unchanged) console.log(`[ok] ${name}`);
  for (const name of result.removed) console.log(`[removed] ${name}`);
} catch (error) {
  console.error(`[error] ${error.message}`);
  process.exitCode = 1;
}
```

- [ ] **Step 5：运行测试并确认 GREEN**

Run:

```bash
 node --test test/skill-sync.test.mjs
```

Expected: 2 tests PASS。

### Task 4：加入受管更新、冲突保护和白名单清理

**Deps:** Task 3

**Files:**
- Modify: `test/skill-sync.test.mjs`
- Modify: `scripts/lib/skill-sync.mjs`

- [ ] **Step 1：追加失败测试**

在 `test/skill-sync.test.mjs` 追加：

```javascript
import { mkdir, symlink, writeFile } from "node:fs/promises";

test("syncSkills refuses to overwrite an unmanaged directory", async () => {
  const root = await createFixture();
  const agentDir = join(root, "agent");
  try {
    await addSkill(root, "vendor", "writing-skills");
    const listPath = await writeSkillList(root, "writing-skills\n");
    await mkdir(join(agentDir, "skills", "writing-skills"), { recursive: true });
    await assert.rejects(
      syncSkills({ repoRoot: root, agentDir, listPath }),
      /refusing to replace unmanaged skill destination/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("syncSkills refuses to overwrite an unmanaged symlink", async () => {
  const root = await createFixture();
  const agentDir = join(root, "agent");
  try {
    await addSkill(root, "vendor", "writing-skills");
    const listPath = await writeSkillList(root, "writing-skills\n");
    const foreign = await addSkill(root, "local", "foreign-skill");
    await mkdir(join(agentDir, "skills"), { recursive: true });
    await symlink(foreign, join(agentDir, "skills", "writing-skills"), "dir");
    await assert.rejects(
      syncSkills({ repoRoot: root, agentDir, listPath }),
      /refusing to replace unmanaged skill destination/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("syncSkills replaces a previously managed vendor link with a local override", async () => {
  const root = await createFixture();
  const agentDir = join(root, "agent");
  try {
    await addSkill(root, "vendor", "writing-plans");
    const listPath = await writeSkillList(root, "writing-plans\n");
    await syncSkills({ repoRoot: root, agentDir, listPath });
    const local = await addSkill(root, "local", "writing-plans");

    const result = await syncSkills({ repoRoot: root, agentDir, listPath });

    assert.equal(await resolvedLink(join(agentDir, "skills", "writing-plans")), await realpath(local));
    assert.deepEqual(result, { linked: ["writing-plans"], removed: [], unchanged: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("syncSkills removes a managed link after it leaves the allowlist", async () => {
  const root = await createFixture();
  const agentDir = join(root, "agent");
  try {
    await addSkill(root, "vendor", "writing-plans");
    const listPath = await writeSkillList(root, "writing-plans\n");
    await syncSkills({ repoRoot: root, agentDir, listPath });
    await writeFile(listPath, "");

    const result = await syncSkills({ repoRoot: root, agentDir, listPath });

    assert.equal(await pathExists(join(agentDir, "skills", "writing-plans")), false);
    assert.deepEqual(result, { linked: [], removed: ["writing-plans"], unchanged: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("syncSkills does not remove a stale manifest entry whose destination was replaced", async () => {
  const root = await createFixture();
  const agentDir = join(root, "agent");
  try {
    await addSkill(root, "vendor", "writing-plans");
    const listPath = await writeSkillList(root, "writing-plans\n");
    await syncSkills({ repoRoot: root, agentDir, listPath });
    const destination = join(agentDir, "skills", "writing-plans");
    await rm(destination);
    await mkdir(destination);
    await writeFile(listPath, "");

    await assert.rejects(
      syncSkills({ repoRoot: root, agentDir, listPath }),
      /refusing to remove modified managed skill destination/,
    );
    assert.equal((await lstat(destination)).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("syncSkills does not adopt a pre-existing correct symlink", async () => {
  const root = await createFixture();
  const agentDir = join(root, "agent");
  try {
    const source = await addSkill(root, "vendor", "writing-plans");
    const listPath = await writeSkillList(root, "writing-plans\n");
    const destination = join(agentDir, "skills", "writing-plans");
    await mkdir(join(agentDir, "skills"), { recursive: true });
    await symlink(source, destination, "dir");

    const result = await syncSkills({ repoRoot: root, agentDir, listPath });
    const manifest = JSON.parse(await readFile(join(agentDir, ".pi-config-managed-skills.json"), "utf8"));

    assert.deepEqual(result, { linked: [], removed: [], unchanged: ["writing-plans"] });
    assert.equal(manifest.skills["writing-plans"], undefined);
    await writeFile(listPath, "");
    await syncSkills({ repoRoot: root, agentDir, listPath });
    assert.equal(await resolvedLink(destination), await realpath(source));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

合并顶部 import，避免同一模块出现重复 import 声明。

- [ ] **Step 2：运行测试并确认 RED**

Run:

```bash
node --test test/skill-sync.test.mjs
```

Expected: unmanaged collision 测试 PASS；managed override、白名单清理和修改保护测试 FAIL。

- [ ] **Step 3：先做全量 preflight，再执行变更**

在 `scripts/lib/skill-sync.mjs` 中加入并由 `syncSkills()` 调用以下函数：

```javascript
async function preflightDestination(destination, expectedSource, managedSource, operation) {
  const stat = await statOrNull(destination);
  if (!stat) return "missing";
  if (!stat.isSymbolicLink()) {
    const action = operation === "remove" ? "remove modified managed" : "replace unmanaged";
    throw new Error(`refusing to ${action} skill destination: ${destination}`);
  }

  const current = await resolvedLinkTarget(destination).catch(() => null);
  if (current === expectedSource) {
    return managedSource === current ? "managed-current" : "external-current";
  }
  if (managedSource && current === managedSource) return "managed-replace";

  const action = operation === "remove" ? "remove modified managed" : "replace unmanaged";
  throw new Error(`refusing to ${action} skill destination: ${destination}`);
}
```

将 `syncSkills()` 替换为以下流程，保留 Task 3 已定义的 helper：

```javascript
export async function syncSkills({ repoRoot, agentDir = DEFAULT_AGENT_DIR, listPath = join(repoRoot, "agents", "skills.list") }) {
  const desired = await loadDesiredSkills(repoRoot, listPath);
  await mkdir(join(agentDir, "skills"), { recursive: true });
  const manifest = await readManifest(agentDir);
  const desiredStates = new Map();
  const staleStates = new Map();

  for (const [name, source] of desired) {
    const destination = join(agentDir, "skills", name);
    desiredStates.set(
      name,
      await preflightDestination(destination, source, manifest.skills[name], "install"),
    );
  }

  for (const [name, managedSource] of Object.entries(manifest.skills)) {
    if (desired.has(name)) continue;
    const destination = join(agentDir, "skills", name);
    staleStates.set(
      name,
      await preflightDestination(destination, managedSource, managedSource, "remove"),
    );
  }

  const result = { linked: [], removed: [], unchanged: [] };

  for (const [name, source] of desired) {
    const destination = join(agentDir, "skills", name);
    const state = desiredStates.get(name);
    if (state === "managed-current" || state === "external-current") {
      result.unchanged.push(name);
    } else {
      if (state === "managed-replace") await unlink(destination);
      await createRelativeLink(source, destination);
      result.linked.push(name);
    }
    if (state !== "external-current") manifest.skills[name] = source;
  }

  for (const [name, state] of staleStates) {
    if (state !== "missing") await unlink(join(agentDir, "skills", name));
    delete manifest.skills[name];
    result.removed.push(name);
  }

  await writeManifest(agentDir, manifest);
  return result;
}
```

- [ ] **Step 4：运行同步测试并确认 GREEN**

Run:

```bash
node --test test/skill-sync.test.mjs
```

Expected: 8 tests PASS。

- [ ] **Step 5：运行全部现有测试**

Run:

```bash
npm test
```

Expected: `skill-list` 和 `skill-sync` 全部 PASS。

### Task 5：实现只读 doctor

**Deps:** Task 4

**Files:**
- Create: `test/doctor.test.mjs`
- Modify: `scripts/lib/skill-sync.mjs`
- Create: `scripts/doctor.mjs`

- [ ] **Step 1：编写 doctor 失败测试**

创建 `test/doctor.test.mjs`：

```javascript
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { addSkill, createFixture, writeSkillList } from "./helpers/skill-fixture.mjs";
import { inspectSkills, syncSkills } from "../scripts/lib/skill-sync.mjs";

test("inspectSkills reports a clean synchronized installation", async () => {
  const root = await createFixture();
  const agentDir = join(root, "agent");
  try {
    await addSkill(root, "vendor", "systematic-debugging");
    const listPath = await writeSkillList(root, "systematic-debugging\n");
    await syncSkills({ repoRoot: root, agentDir, listPath });
    assert.deepEqual(await inspectSkills({ repoRoot: root, agentDir, listPath }), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectSkills reports missing and conflicting destinations without modifying them", async () => {
  const root = await createFixture();
  const agentDir = join(root, "agent");
  try {
    await addSkill(root, "vendor", "systematic-debugging");
    await addSkill(root, "vendor", "writing-plans");
    const listPath = await writeSkillList(root, "systematic-debugging\nwriting-plans\n");
    await mkdir(join(agentDir, "skills", "writing-plans"), { recursive: true });

    const issues = await inspectSkills({ repoRoot: root, agentDir, listPath });

    assert.deepEqual(issues, [
      `missing skill link: ${join(agentDir, "skills", "systematic-debugging")}`,
      `skill destination is not a symlink: ${join(agentDir, "skills", "writing-plans")}`,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2：运行测试并确认 RED**

Run:

```bash
node --test test/doctor.test.mjs
```

Expected: FAIL，错误包含 `does not provide an export named 'inspectSkills'`。

- [ ] **Step 3：实现只读检查**

在 `scripts/lib/skill-sync.mjs` 追加：

```javascript
export async function inspectSkills({ repoRoot, agentDir = DEFAULT_AGENT_DIR, listPath = join(repoRoot, "agents", "skills.list") }) {
  const desired = await loadDesiredSkills(repoRoot, listPath);
  const issues = [];

  for (const [name, source] of desired) {
    const destination = join(agentDir, "skills", name);
    const stat = await statOrNull(destination);
    if (!stat) {
      issues.push(`missing skill link: ${destination}`);
      continue;
    }
    if (!stat.isSymbolicLink()) {
      issues.push(`skill destination is not a symlink: ${destination}`);
      continue;
    }
    const current = await resolvedLinkTarget(destination).catch(() => null);
    if (current !== source) {
      issues.push(`skill link points to unexpected source: ${destination}`);
    }
  }

  return issues;
}
```

- [ ] **Step 4：创建 doctor CLI**

创建 `scripts/doctor.mjs`：

```javascript
#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { DEFAULT_AGENT_DIR, inspectSkills } from "./lib/skill-sync.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = process.env.PI_AGENT_DIR || DEFAULT_AGENT_DIR;

try {
  const issues = await inspectSkills({ repoRoot, agentDir });
  if (issues.length === 0) {
    console.log("[ok] Pi Skill allowlist is synchronized");
  } else {
    for (const issue of issues) console.error(`[error] ${issue}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`[error] ${error.message}`);
  process.exitCode = 1;
}
```

- [ ] **Step 5：运行测试并确认 GREEN**

Run:

```bash
node --test test/doctor.test.mjs
```

Expected: 2 tests PASS。

### Task 6：补齐独立安装文档和端到端验证

**Deps:** Task 1, Task 2, Task 3, Task 4, Task 5

**Files:**
- Create: `README.md`
- Modify: `test/skill-sync.test.mjs`

- [ ] **Step 1：增加真实白名单完整性测试**

在 `test/skill-sync.test.mjs` 追加：

```javascript
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { loadDesiredSkills } from "../scripts/lib/skill-sync.mjs";

test("repository allowlist resolves exactly five Superpowers skills", async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const desired = await loadDesiredSkills(repoRoot, join(repoRoot, "agents", "skills.list"));
  assert.deepEqual([...desired.keys()], [
    "systematic-debugging",
    "test-driven-development",
    "receiving-code-review",
    "writing-plans",
    "writing-skills",
  ]);
  for (const source of desired.values()) {
    assert.match(source, /vendor\/superpowers\/skills\//u);
  }
});
```

将顶部已有的 `node:path` import 合并为 `dirname`、`join`、`resolve` 的单一 import。

- [ ] **Step 2：运行测试并确认测试能够约束仓库配置**

Run:

```bash
node --test test/skill-sync.test.mjs
```

Expected: 9 tests PASS；如果子模块未初始化或任一白名单 Skill 不存在，则 FAIL。

- [ ] **Step 3：编写独立使用文档**

创建 `README.md`：

```markdown
# pi-config

Pi Coding Agent 的独立配置与周边运行时。

本仓不读取或链接 `claude-config`。Superpowers 由本仓独立 vendor，且只暴露
明确列入白名单的 Skills。

## 环境要求

- Git
- Node.js 22.19 或更高版本

## 初始化

```bash
git submodule update --init --recursive
npm test
npm run sync:skills
npm run doctor
```

默认安装目录是 `~/.pi/agent`。隔离测试方式：

```bash
PI_AGENT_DIR="$(mktemp -d)/agent" npm run sync:skills
```

## Skill 选择

`agents/skills.list` 是唯一暴露白名单。源解析顺序：

1. `skills/<name>/SKILL.md`
2. `vendor/superpowers/skills/<name>/SKILL.md`

不安装 Superpowers plugin 和未列入白名单的 Skills。

## 受管文件

同步器将链接记录在 `~/.pi/agent/.pi-config-managed-skills.json`。只有当前目标
与记录匹配的链接才会被更新或删除。未知文件、目录和软链会被保留并报告错误。

## 升级 Superpowers

1. 在 `vendor/superpowers` 中检出目标上游 tag 或 commit。
2. 检查 `agents/skills.list` 中每个 Skill 的变化。
3. 运行 `npm test`。
4. 使用隔离的 `PI_AGENT_DIR` 运行同步。
5. 人工确认后再更新 submodule gitlink。

安装过程中禁止自动升级 Superpowers。
```

- [ ] **Step 4：运行全量测试**

Run:

```bash
npm test
```

Expected: 所有测试 PASS，无 skipped、pending 或 cancelled 测试。

- [ ] **Step 5：在隔离目录执行同步和诊断**

Run in one shell:

```bash
TEMP_AGENT_DIR="$(mktemp -d)/agent" && PI_AGENT_DIR="$TEMP_AGENT_DIR" npm run sync:skills && PI_AGENT_DIR="$TEMP_AGENT_DIR" npm run doctor && PI_AGENT_DIR="$TEMP_AGENT_DIR" node --input-type=module -e 'import { readdir } from "node:fs/promises"; import { join } from "node:path"; const entries = await readdir(join(process.env.PI_AGENT_DIR, "skills"), { withFileTypes: true }); const links = entries.filter((entry) => entry.isSymbolicLink()); if (links.length !== 5) throw new Error(`expected 5 skill links, got ${links.length}`);'
```

Expected:

```text
[linked] systematic-debugging
[linked] test-driven-development
[linked] receiving-code-review
[linked] writing-plans
[linked] writing-skills
[ok] Pi Skill allowlist is synchronized
```

最终 `test` exit code 为 `0`，隔离目录中恰好存在 5 个 Skill 软链。

- [ ] **Step 6：确认仓库没有 `claude-config` 依赖**

Run:

```bash
node --input-type=module -e 'import { readFile, readdir } from "node:fs/promises"; import { extname, join } from "node:path"; const roots = ["agents", "skills", "scripts", "test"]; const checked = new Set([".json", ".list", ".md", ".mjs", ".sh"]); async function scan(path) { for (const entry of await readdir(path, { withFileTypes: true })) { const child = join(path, entry.name); if (entry.isDirectory()) await scan(child); else if (checked.has(extname(entry.name)) && (await readFile(child, "utf8")).includes("claude-config")) throw new Error(`forbidden repository dependency in ${child}`); } } for (const root of roots) await scan(root);'
```

Expected: exit code `0`。`README.md` 只允许出现“不依赖”的边界说明，代码、配置和脚本中不得出现该路径或仓库名。

## 自审结果

- 需求覆盖：已覆盖独立 vendor、仅 Superpowers、五项白名单、Pi 专属安装目录、非全量暴露、受管清理和测试。
- 边界覆盖：明确排除 Pi runtime、AGENTS、Skill 改写及其他周边能力，确保本计划可独立交付。
- 安全覆盖：白名单解析严格校验；所有源在写入前解析；所有目标在任何修改前完成 preflight；未知目标 fail closed。
- 类型一致性：`syncSkills()`、`inspectSkills()`、`loadDesiredSkills()` 的参数均为 `{ repoRoot, agentDir, listPath }`；测试与 CLI 使用一致。
- 独立性：运行时只读取本仓、`~/.pi/agent` 和显式测试目录，不读取另一个配置仓。
- 提交策略：计划不包含 commit 步骤；如需提交，执行前由用户另行授权。
