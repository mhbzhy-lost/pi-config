# Pi 0.80.6 安装与真实集成测试计划

> **供执行代理使用：** 严格按任务复选框逐项执行。未经用户单独授权，不创建 Git commit。

**目标：** 安装固定版本 Pi `0.80.6`，通过真实 RPC 启动证明 `bin/pi --no-skills` 关闭默认 Skill 发现后，白名单 Extension 仍精确加载五个 Superpowers Skill。

**架构：** 使用官方 npm 包全局安装 Pi，包装器继续通过 `PI_REAL_BIN` 调用真实二进制。独立集成测试以 RPC 模式启动 Pi，发送 `get_commands`，从真实 Pi 返回的 `source: "skill"` 命令中断言只有五个白名单 Skill；测试使用 dummy OpenAI key、`--offline` 和 `--no-session`，不发起模型请求、不写 session。Pi 可能初始化被忽略的 `pi/auth.json`，测试不得清理该凭据文件。

**技术栈：** npm、`@earendil-works/pi-coding-agent@0.80.6`、Node.js 22.19+、Pi JSONL RPC、Node 内置 test runner。

---

## 文件结构

| 路径 | 职责 |
|---|---|
| `test/pi-runtime.integration.mjs` | 真实 Pi RPC Skill 加载验证 |
| `test/package-scripts.test.mjs` | 固定独立集成测试命令 |
| `package.json` | 暴露 `test:integration` |
| `README.md` | 安装和真实验证说明 |

### Task 1：安装并固定真实 Pi 0.80.6

**Files:**
- Modify: 用户全局 npm 安装目录（不写入仓库）

- [ ] **Step 1：确认安装前状态**

Run:

```bash
command -v pi || true
```

记录当前输出；不存在或版本不同均继续下一步。

- [ ] **Step 2：使用官方包安装精确版本**

Run:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.80.6
```

Expected: npm 成功安装，不执行 dependency lifecycle scripts。

- [ ] **Step 3：验证二进制和版本**

Run:

```bash
PI_REAL_BIN="$(command -v pi)" && test -x "$PI_REAL_BIN" && "$PI_REAL_BIN" --version
```

Expected: 输出 `0.80.6`。

### Task 2：增加真实 RPC 集成测试

**Deps:** Task 1

**Files:**
- Create: `test/pi-runtime.integration.mjs`
- Modify: `test/package-scripts.test.mjs`
- Modify: `package.json`

- [ ] **Step 1：编写真实 RPC 测试**

创建 `test/pi-runtime.integration.mjs`：

```javascript
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wrapper = join(repoRoot, "bin", "pi");
const piBinary = process.env.PI_REAL_BIN;

test("real Pi RPC loads exactly the five allowlisted skills", () => {
  assert.ok(piBinary, "PI_REAL_BIN must point to Pi 0.80.6");

  const result = spawnSync(
    wrapper,
    [
      "--mode", "rpc",
      "--no-session",
      "--offline",
      "--provider", "openai",
      "--model", "gpt-4o",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PI_REAL_BIN: piBinary,
        OPENAI_API_KEY: "integration-test-not-used",
      },
      input: `${JSON.stringify({ id: "commands", type: "get_commands" })}\n`,
      timeout: 15000,
    },
  );

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);

  const records = result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const response = records.find(
    (record) => record.type === "response" && record.command === "get_commands",
  );
  assert.ok(response, `missing get_commands response in: ${result.stdout}`);
  assert.equal(response.success, true);

  const skills = response.data.commands
    .filter((command) => command.source === "skill")
    .map((command) => command.name);
  assert.deepEqual(skills, [
    "skill:systematic-debugging",
    "skill:test-driven-development",
    "skill:receiving-code-review",
    "skill:writing-plans",
    "skill:writing-skills",
  ]);
});
```

- [ ] **Step 2：直接运行真实测试**

Run:

```bash
PI_REAL_BIN="$(command -v pi)" node --test test/pi-runtime.integration.mjs
```

Expected: 1 test PASS。该测试是对已安装外部 runtime 的集成验证，不修改生产逻辑，显式豁免先 RED。

- [ ] **Step 3：先更新 package script 契约测试并确认 RED**

将 `test/package-scripts.test.mjs` 的期望改为：

```javascript
assert.deepEqual(packageJson.scripts, {
  test: 'node --test "test/**/*.test.mjs"',
  "test:integration": "node --test test/pi-runtime.integration.mjs",
  doctor: "node scripts/doctor.mjs",
});
```

Run:

```bash
node --test test/package-scripts.test.mjs
```

Expected: FAIL，实际 scripts 尚缺少 `test:integration`。

- [ ] **Step 4：增加独立集成测试命令并确认 GREEN**

将 `package.json` scripts 改为：

```json
{
  "test": "node --test \"test/**/*.test.mjs\"",
  "test:integration": "node --test test/pi-runtime.integration.mjs",
  "doctor": "node scripts/doctor.mjs"
}
```

Run:

```bash
node --test test/package-scripts.test.mjs
```

Expected: PASS。

### Task 3：文档和最终验证

**Deps:** Task 1, Task 2

**Files:**
- Modify: `README.md`

- [ ] **Step 1：补充固定版本安装说明**

在 README 环境要求后增加：

````markdown
## 安装 Pi

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.80.6
pi --version
```

本仓当前只验证 Pi `0.80.6`。升级 Pi 前必须重新运行单元测试和真实集成测试。
````

- [ ] **Step 2：补充真实集成测试说明**

在初始化命令中增加：

```bash
PI_REAL_BIN="$(command -v pi)" npm run test:integration
```

说明该测试会：

- 使用 `--offline`，不执行启动网络请求。
- 使用 `--no-session`，不保存 session。
- 不向模型发送 prompt。
- 通过 RPC `get_commands` 断言只加载五个白名单 Skill。

- [ ] **Step 3：执行全部验证**

Run:

```bash
npm test
npm run doctor
PI_REAL_BIN="$(command -v pi)" npm run test:integration
git diff --check
```

Expected: 单元测试、doctor、1 项真实 Pi 集成测试全部通过；diff check 无输出。

- [ ] **Step 4：确认真实运行未产生仓库状态文件**

Run:

```bash
git status --short --branch
```

Expected: 不出现未忽略的运行时文件；直接检查确认 `var/sessions` 不存在。`pi/auth.json` 可能由 Pi 初始化且必须保持 Git 忽略，禁止测试删除或覆盖。

## 自审结果

- 版本固定：安装和验证均针对 `0.80.6`。
- 真实链路：测试经过 `bin/pi`、真实 CLI、Extension loader、`resources_discover`、Skill loader 和 RPC。
- 白名单证明：RPC 返回恰好五个 `source: "skill"` 命令，可发现 `~/.agents/skills` 泄漏。
- 无模型调用：不发送 prompt，dummy key 不被使用。
- 状态边界：offline、no-session 不写 session；Pi 允许初始化被忽略的本地 `auth.json`，测试不清理凭据状态。
- 提交策略：计划不包含 commit 步骤；如需提交，执行前由用户另行授权。
