# Pi 配置根与无软链 Skill 白名单实现计划

> **供执行代理使用：** 严格按任务复选框逐项执行。任何逻辑变更必须先加载 `test-driven-development` Skill，并遵循 RED-GREEN-REFACTOR。未经用户单独授权，不创建 Git commit。

**目标：** 将仓库内 `pi/` 作为 `PI_CODING_AGENT_DIR`，由 Pi Extension 直接注入五个白名单 Superpowers Skill，删除软链接和受管 manifest 机制。

**架构：** `bin/pi` 固定配置根为本仓 `pi/`，固定 session 根为本仓忽略的 `var/sessions/`，并通过 `--no-skills` 关闭 Pi 对 `~/.agents/skills`、全局和项目 Skill 的默认发现。`pi/extensions/skill-whitelist.ts` 在 `resources_discover` 事件中读取仓库根 `agents/skills.list`，优先解析 `skill-overrides/<name>`，回退到 `vendor/superpowers/skills/<name>`，将精确目录直接返回给 Pi，不复制、不链接文件。

**技术栈：** Node.js 22.19+、Node 内置 test runner、ES modules、Pi TypeScript Extension、Bash 启动包装器。

---

## 范围边界

本计划包含：

- 新建仓内 Pi 配置根 `pi/`。
- 用 `resources_discover` Extension 替换 Skill 软链接同步。
- 将本仓 Skill 覆盖目录从 `skills/` 改为 `skill-overrides/`，避免 Pi 自动扫描。
- 新建强制 `--no-skills` 的 `bin/pi` 包装器。
- 删除 manifest、同步 CLI 和软链接相关测试。
- 简化 `doctor` 为白名单、Extension 和配置根检查。
- 隔离 Pi 认证、包缓存、临时文件和 session 状态。

本计划不包含：

- 安装 Pi coding agent。
- 编写 `pi/AGENTS.md` 的全局行为规则。
- 配置 provider、model、prompt、theme、memory 或安全 Extension。
- 自动加载项目 `.pi/skills` 或 `.agents/skills`。
- 修改 Superpowers vendor 内容。

## 最终文件结构

| 路径 | 职责 |
|---|---|
| `agents/skills.list` | 唯一 Skill 暴露白名单 |
| `skill-overrides/README.md` | 本仓同名 Skill 覆盖约定 |
| `scripts/lib/skill-whitelist.mjs` | 名称校验、白名单解析和源解析 |
| `scripts/lib/skill-whitelist-extension.mjs` | 可测试的 Extension factory |
| `pi/extensions/skill-whitelist.ts` | Pi 自动发现的 TypeScript Extension 入口 |
| `pi/settings.json` | 受版本控制的 Pi 全局设置起点 |
| `bin/pi` | 固定配置根、session 根和 `--no-skills` 的启动入口 |
| `scripts/doctor.mjs` | 只读检查白名单和配置根 |
| `test/skill-list.test.mjs` | 白名单和源解析测试 |
| `test/skill-whitelist-extension.test.mjs` | Extension 注入测试 |
| `test/pi-launcher.test.mjs` | 包装器环境和参数测试 |
| `test/doctor.test.mjs` | doctor 测试 |
| `README.md` | 使用、边界和升级说明 |

### Task 1：建立 Extension 白名单注入链路

**Files:**
- Move: `skills/README.md` → `skill-overrides/README.md`
- Move: `scripts/lib/skill-sync.mjs` → `scripts/lib/skill-whitelist.mjs`
- Modify: `test/skill-list.test.mjs`
- Create: `test/skill-whitelist-extension.test.mjs`
- Create: `scripts/lib/skill-whitelist-extension.mjs`
- Create: `pi/extensions/skill-whitelist.ts`
- Create: `pi/settings.json`

- [ ] **Step 1：编写 Extension 失败测试**

创建 `test/skill-whitelist-extension.test.mjs`：

```javascript
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import createSkillWhitelistExtension from "../scripts/lib/skill-whitelist-extension.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("extension contributes exactly the allowlisted Superpowers skill directories", async () => {
  const handlers = new Map();
  createSkillWhitelistExtension({
    on(name, handler) {
      handlers.set(name, handler);
    },
  });

  assert.deepEqual([...handlers.keys()], ["resources_discover"]);
  const result = await handlers.get("resources_discover")(
    { cwd: repoRoot, reason: "startup" },
    {},
  );

  assert.deepEqual(result.skillPaths, [
    join(repoRoot, "vendor", "superpowers", "skills", "systematic-debugging"),
    join(repoRoot, "vendor", "superpowers", "skills", "test-driven-development"),
    join(repoRoot, "vendor", "superpowers", "skills", "receiving-code-review"),
    join(repoRoot, "vendor", "superpowers", "skills", "writing-plans"),
    join(repoRoot, "vendor", "superpowers", "skills", "writing-skills"),
  ]);
});

test("Pi extension entry delegates to the tested factory", async () => {
  const entry = await import("../pi/extensions/skill-whitelist.ts");
  assert.equal(entry.default, createSkillWhitelistExtension);
});
```

- [ ] **Step 2：运行测试并确认 RED**

Run:

```bash
node --test test/skill-whitelist-extension.test.mjs
```

Expected: FAIL，错误包含 `ERR_MODULE_NOT_FOUND`，因为 factory 和 Extension 入口尚不存在。

- [ ] **Step 3：迁移白名单核心命名和覆盖目录**

执行文件移动后，将 `scripts/lib/skill-whitelist.mjs` 中的本仓候选源从：

```javascript
join(repoRoot, "skills", name)
```

改为：

```javascript
join(repoRoot, "skill-overrides", name)
```

删除该文件中的以下同步专属内容，只保留 `parseSkillList()`、`resolveSkillSource()`、
`loadDesiredSkills()` 及其只读 helper：

- `DEFAULT_AGENT_DIR`
- manifest 读写
- symlink 解析和创建
- preflight
- `syncSkills()`
- `inspectSkills()`

更新 `test/skill-list.test.mjs` 的 import：

```javascript
import { parseSkillList, resolveSkillSource } from "../scripts/lib/skill-whitelist.mjs";
```

更新 `test/helpers/skill-fixture.mjs`，将 local fixture 目录改为：

```javascript
join(root, "skill-overrides", name)
```

并让 `createFixture()` 创建：

```javascript
await mkdir(join(root, "skill-overrides"), { recursive: true });
```

- [ ] **Step 4：实现可测试 Extension factory**

创建 `scripts/lib/skill-whitelist-extension.mjs`：

```javascript
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { loadDesiredSkills } from "./skill-whitelist.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const listPath = join(repoRoot, "agents", "skills.list");

export default function createSkillWhitelistExtension(pi) {
  pi.on("resources_discover", async () => {
    const desired = await loadDesiredSkills(repoRoot, listPath);
    return { skillPaths: [...desired.values()] };
  });
}
```

创建 `pi/extensions/skill-whitelist.ts`：

```typescript
export { default } from "../../scripts/lib/skill-whitelist-extension.mjs";
```

创建 `pi/settings.json`：

```json
{}
```

- [ ] **Step 5：运行测试并确认 GREEN**

Run:

```bash
node --test test/skill-list.test.mjs test/skill-whitelist-extension.test.mjs
```

Expected: 7 tests PASS。

### Task 2：建立固定配置根的 Pi 启动包装器

**Deps:** Task 1

**Files:**
- Create: `test/pi-launcher.test.mjs`
- Create: `bin/pi`

- [ ] **Step 1：编写包装器失败测试**

创建 `test/pi-launcher.test.mjs`：

```javascript
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("launcher fixes Pi config roots and disables default skill discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-launcher-"));
  try {
    const output = join(root, "invocation.json");
    const fakePi = join(root, "pi-real");
    await writeFile(fakePi, `#!/usr/bin/env bash\nnode -e 'require("fs").writeFileSync(process.env.OUTPUT, JSON.stringify({ config: process.env.PI_CODING_AGENT_DIR, sessions: process.env.PI_CODING_AGENT_SESSION_DIR, args: process.argv.slice(1) }))' -- "$@"\n`);
    await chmod(fakePi, 0o755);

    const result = spawnSync(join(repoRoot, "bin", "pi"), ["--model", "test/model"], {
      encoding: "utf8",
      env: { ...process.env, PI_REAL_BIN: fakePi, OUTPUT: output },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), {
      config: join(repoRoot, "pi"),
      sessions: join(repoRoot, "var", "sessions"),
      args: ["--no-skills", "--model", "test/model"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2：运行测试并确认 RED**

Run:

```bash
node --test test/pi-launcher.test.mjs
```

Expected: FAIL，错误为 `bin/pi` 不存在。

- [ ] **Step 3：实现包装器**

创建 `bin/pi` 并设置 executable bit：

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
UPSTREAM_PI="${PI_REAL_BIN:-}"

if [[ -z "$UPSTREAM_PI" ]]; then
  UPSTREAM_PI="$(command -v pi || true)"
fi

if [[ -z "$UPSTREAM_PI" ]]; then
  printf '%s\n' "pi executable not found; set PI_REAL_BIN" >&2
  exit 1
fi

UPSTREAM_DIR="$(cd -- "$(dirname -- "$UPSTREAM_PI")" && pwd -P)"
UPSTREAM_REAL="$UPSTREAM_DIR/$(basename -- "$UPSTREAM_PI")"
SELF_REAL="$SCRIPT_DIR/$(basename -- "${BASH_SOURCE[0]}")"

if [[ "$UPSTREAM_REAL" == "$SELF_REAL" ]]; then
  printf '%s\n' "PI_REAL_BIN resolves to the pi-config wrapper" >&2
  exit 1
fi

export PI_CODING_AGENT_DIR="$REPO_ROOT/pi"
export PI_CODING_AGENT_SESSION_DIR="${PI_CODING_AGENT_SESSION_DIR:-$REPO_ROOT/var/sessions}"

exec "$UPSTREAM_PI" --no-skills "$@"
```

Run:

```bash
chmod +x bin/pi
```

- [ ] **Step 4：运行测试并确认 GREEN**

Run:

```bash
node --test test/pi-launcher.test.mjs
```

Expected: 1 test PASS。

### Task 3：删除软链接运行时并简化 doctor

**Deps:** Task 1, Task 2

**Files:**
- Delete: `scripts/sync-skills.mjs`
- Delete: `test/skill-sync.test.mjs`
- Modify: `scripts/doctor.mjs`
- Modify: `test/doctor.test.mjs`
- Modify: `test/package-scripts.test.mjs`
- Modify: `package.json`

- [ ] **Step 1：先把 doctor 测试改为新契约**

将 `test/doctor.test.mjs` 替换为：

```javascript
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { inspectWhitelist } from "../scripts/doctor.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("inspectWhitelist accepts the repository Pi configuration", async () => {
  assert.deepEqual(await inspectWhitelist(repoRoot), []);
});

test("Pi config root does not contain an auto-discovered skills directory", async () => {
  const issues = await inspectWhitelist(repoRoot);
  assert.equal(issues.includes(`unexpected auto-discovery directory: ${join(repoRoot, "pi", "skills")}`), false);
});
```

将 `test/package-scripts.test.mjs` 的断言扩展为：

```javascript
assert.deepEqual(packageJson.scripts, {
  test: 'node --test "test/**/*.test.mjs"',
  doctor: "node scripts/doctor.mjs",
});
```

- [ ] **Step 2：运行测试并确认 RED**

Run:

```bash
node --test test/doctor.test.mjs test/package-scripts.test.mjs
```

Expected: FAIL，因为旧 doctor 仍导入已迁移模块且 package 仍包含 `sync:skills`。

- [ ] **Step 3：实现只读白名单 doctor**

将 `scripts/doctor.mjs` 替换为：

```javascript
#!/usr/bin/env node
import { pathToFileURL, fileURLToPath } from "node:url";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadDesiredSkills } from "./lib/skill-whitelist.mjs";

export async function inspectWhitelist(repoRoot) {
  const issues = [];
  const listPath = join(repoRoot, "agents", "skills.list");
  const desired = await loadDesiredSkills(repoRoot, listPath);
  if (desired.size !== 5) issues.push(`expected 5 allowlisted skills, got ${desired.size}`);

  for (const required of [
    join(repoRoot, "pi", "settings.json"),
    join(repoRoot, "pi", "extensions", "skill-whitelist.ts"),
    join(repoRoot, "bin", "pi"),
  ]) {
    try {
      await access(required, constants.R_OK);
    } catch {
      issues.push(`missing required Pi config file: ${required}`);
    }
  }

  try {
    await access(join(repoRoot, "pi", "skills"));
    issues.push(`unexpected auto-discovery directory: ${join(repoRoot, "pi", "skills")}`);
  } catch {}

  return issues;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const issues = await inspectWhitelist(repoRoot);
    if (issues.length === 0) console.log("[ok] Pi Skill allowlist extension is ready");
    else {
      for (const issue of issues) console.error(`[error] ${issue}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`[error] ${error.message}`);
    process.exitCode = 1;
  }
}
```

将 `package.json` scripts 改为：

```json
{
  "test": "node --test \"test/**/*.test.mjs\"",
  "doctor": "node scripts/doctor.mjs"
}
```

删除 `scripts/sync-skills.mjs` 和 `test/skill-sync.test.mjs`。

- [ ] **Step 4：运行测试并确认 GREEN**

Run:

```bash
npm test
```

Expected: 所有保留测试 PASS，测试输出不再包含 manifest 或 symlink 同步测试。

### Task 4：隔离运行时状态并更新使用文档

**Deps:** Task 1, Task 2, Task 3

**Files:**
- Modify: `.gitignore`
- Modify: `README.md`
- Modify: `skills/README.md`（移动后路径为 `skill-overrides/README.md`）

- [ ] **Step 1：更新 Git 忽略边界**

将 `.gitignore` 改为：

```gitignore
.DS_Store
node_modules/

/pi/auth.json
/pi/trust.json
/pi/npm/
/pi/git/
/pi/tmp/
/var/
```

- [ ] **Step 2：更新覆盖目录文档**

确保 `skill-overrides/README.md` 内容为：

```markdown
# 本仓 Skill 覆盖

仅当 Pi 需要不同于固定 vendor 版本的行为时，才在这里放置完整的
`<name>/SKILL.md` 目录。

源优先级：

1. `skill-overrides/<name>/SKILL.md`
2. `vendor/superpowers/skills/<name>/SKILL.md`

只有 `agents/skills.list` 中列出的名称会由白名单 Extension 注入 Pi。
```

- [ ] **Step 3：重写 README 使用说明**

`README.md` 必须说明：

```markdown
# pi-config

Pi Coding Agent 的独立配置与周边运行时。仓库内 `pi/` 是 Pi 全局配置根，
仓库根用于维护脚本、测试、文档和 vendor。

## 环境要求

- Git
- Node.js 22.19 或更高版本
- Pi Coding Agent；也可以通过 `PI_REAL_BIN` 指定可执行文件

## 初始化

```bash
git submodule update --init --recursive
npm test
npm run doctor
```

使用本仓包装器启动：

```bash
./bin/pi
```

包装器固定：

- `PI_CODING_AGENT_DIR=<repo>/pi`
- 默认 `PI_CODING_AGENT_SESSION_DIR=<repo>/var/sessions`
- `--no-skills`，关闭 Pi 默认 Skill 发现

`pi/extensions/skill-whitelist.ts` 随后通过 `resources_discover` 只注入
`agents/skills.list` 中列出的 Skill。它不复制或创建软链接。

## Skill 选择

源解析顺序：

1. `skill-overrides/<name>/SKILL.md`
2. `vendor/superpowers/skills/<name>/SKILL.md`

禁止绕过 `bin/pi` 直接启动 Pi，否则 `~/.agents/skills` 或项目 Skills 可能被默认发现。

## 升级 Superpowers

1. 在 `vendor/superpowers` 检出目标 tag 或 commit。
2. 检查白名单中五个 Skill 的变化。
3. 运行 `npm test` 和 `npm run doctor`。
4. 人工确认后更新 submodule gitlink。
```

- [ ] **Step 4：运行全量验证**

Run:

```bash
npm test
npm run doctor
git diff --check
```

Expected: 所有测试 PASS；doctor 输出 `[ok] Pi Skill allowlist extension is ready`；diff check 无输出。

- [ ] **Step 5：验证 Extension 不使用软链接且配置根独立**

Run:

```bash
node --input-type=module -e 'import factory from "./scripts/lib/skill-whitelist-extension.mjs"; const handlers = new Map(); factory({ on: (name, handler) => handlers.set(name, handler) }); const result = await handlers.get("resources_discover")({ reason: "startup", cwd: process.cwd() }, {}); if (result.skillPaths.length !== 5) throw new Error(`expected 5 skills, got ${result.skillPaths.length}`); if (result.skillPaths.some((path) => path.includes("/pi/skills/"))) throw new Error("unexpected auto-discovery path"); console.log("[ok] extension resolved 5 direct Skill paths");'
```

Expected: 输出 `[ok] extension resolved 5 direct Skill paths`。

## 自审结果

- 需求覆盖：仓库内 `pi/` 是专用配置根；仓库根仍可承载仓库专属配置。
- 白名单覆盖：Pi 默认 Skill 发现由包装器关闭，Extension 只注入五个白名单路径。
- 无软链接：最终实现没有同步 CLI、manifest、symlink 创建或清理逻辑。
- 独立性：不读取 `claude-config`，不依赖真实 `~/.pi/agent`。
- 状态隔离：认证、trust、包缓存、临时文件和 sessions 均不进入 Git。
- 类型一致性：Extension factory 始终通过 `resources_discover` 返回 `{ skillPaths: string[] }`。
- 提交策略：计划不包含 commit 步骤；如需提交，执行前由用户另行授权。
