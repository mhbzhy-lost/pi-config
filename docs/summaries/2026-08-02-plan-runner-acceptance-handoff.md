# Plan Runner 最终验收 Handoff

日期：2026-08-02

## 1. 当前结论

- Plan Runner validated code baseline：`f7615444e7a86956c3b9647389c32678c6ee9ba3`
- baseline提交：`f761544 fix(plan): 恢复 non-resumable Runner 会话`
- 仓库HEAD可以在baseline之上增加不触及Harness受保护输入的纯文档提交；真实Harness证据仍只归属`f761544`。
- Plan Runner 功能、迁移、真实 Harness 和独立复审均已完成。
- 唯一未关闭项是本机真实配置缺少 `crash-analyzer-usage/SKILL.md`，导致 doctor 门禁失败。
- 因仍有失败门禁，Todo `#65` 和总验收 `#35` 不能形式关闭。

当前 Todo 依赖：

```text
#35 验证扁平 Runtime Harness
  <- #65 完成 Harness 迁移与累计门禁
       <- #66 恢复 crash analyzer Skill
```

`#34`、`#64` 已完成。`#65` 当前应保持 `pending`，`#66` 是下一项实际工作。

## 2. 已完成范围

当前实现保持以下架构边界：

```text
领域拓扑：Main -> Plan Runner -> Executor
运行时拓扑：Root -> [Plan Runner generations, Executors]
```

已完成并验证的主要能力：

- `pi-plan.v3`、`plan-ir.v3`、revision、event 和 amendment。
- Root-owned flat RPC runtime，已删除 Standalone Host 和旧 shared RPC client。
- stable logical caller、actual generation alias、grant/token stale fence。
- official terminal proof 驱动的 completion、revival 和 shutdown。
- Supervisor owner 隔离、Attention durable reply、ACK、未 ACK 重放。
- live lifecycle continuation、counted debt、single-flight revival。
- active Runner 为 `non-resumable` 时，从同 logical caller、同 canonical session 的最近可信 predecessor 恢复会话。
- 双 Plan、四 Executor、四 Attention、四 Attempt、八个 Gate 的真实运行。
- amendment event 已持久化但 current pointer 未切换时的同 Root 崩溃恢复。
- Root 关闭前 official-terminal quiescence，以及关闭后的完整 actual run 集合一致性。

## 3. 已有权威证据

### 3.1 累计门禁

| 门禁 | 结果 |
| --- | --- |
| 固定 socket Root broker suite | `144/144` |
| 普通测试 suite | `1114/1114` |
| real-Pi Root startup | `1/1` |
| pi-subagents compatibility | `30/30` |
| migration/package contract | `21/21` |
| 最终独立复审 | `0 Critical / 0 Important` |

### 3.2 真实 Harness

`f761544` 已唯一运行以下命令：

```bash
PI_REAL_BIN="$(command -v pi)" npm run test:plan-harness
```

结果：

- `2/2` 通过，exit `0`，总耗时 `31.276s`。
- amendment Harness：`23.524s`。
- dual-Plan flat runtime Harness：`28.858s`。
- stderr 为空。
- 成功 fixture 已删除。
- 无 Harness 进程残留。

证据文件：

- `.pi-subagents/artifacts/verification/task65-f761544-plan-harness-green.md`
- `.pi-subagents/artifacts/verification/task65-f761544-plan-harness.stdout.log`
- `.pi-subagents/artifacts/verification/task65-f761544-plan-harness.stderr.log`

归档 hash：

```text
stdout 754eea7b48d2a04c1b8e13fa79da1ba33b884f13d4746ea6ea583e66efe60b2c
stderr e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

### 3.3 真实 Harness 的不可重跑约束

`f761544` 的真实 Harness 已运行一次，禁止在该提交上再次运行。

原因不是节省时间，而是保留“一个validated code baseline对应一次真实运行”的证据语义。若重复运行，后一次结果会混淆第一次运行的进程、fixture和归档身份。

不触及`harness_inputs`的纯文档descendant不需要也不得重跑Harness；它们只能复用`f761544`的代码证据，不能声称自己的仓库HEAD运行过Harness。仅恢复本机Skill、且未修改Plan Runner生产代码或Harness oracle时，同样直接复用上述权威证据。

### 3.4 Harness 输入指纹

真实 Harness 读取的是当前 worktree 文件，不只读取 Git HEAD。复用旧证据前必须同时锁定：

- 仓库内生产代码、provider、fixture、support oracle 和 package script。
- 被 `.gitignore` 排除、但由 `subagent-runtime.ts` 直接加载的 pinned runtime dependency tree。
- 实际 Pi 和 Node runtime。

`f761544` GREEN 后补录的环境指纹：

```text
pi binary: /opt/homebrew/bin/pi
pi version: 0.83.0
node version: v26.0.0
pi-subagents version: 0.37.2
pi/npm/node_modules tree SHA-256: 6292aa7c5559caebff0699ce06727c1099a9c91ff3bec067a4d0d99d049e4ffd
```

整树 hash 的计算方式固定为：

```bash
(
  cd pi/npm/node_modules
  find . -type f -print0 \
    | LC_ALL=C sort -z \
    | xargs -0 shasum -a 256 \
    | shasum -a 256
)
```

该指纹是 worktree 连续性门禁，不能代替真实 Harness 结果。

- 受保护仓库输入变化时，必须走第 6 节的新冻结 HEAD 路径。
- pinned runtime指纹意外变化时，不得进入Harness，必须先恢复第 3.4 节的固定runtime。
- 主动升级Pi、Node或`pi/npm/node_modules`不属于本handoff的验收范围；必须先通过Goal amendment批准，更新compatibility合同，并从受信制品或锁文件建立新的runtime基线，不能把现场目录自hash后直接宣布为新基线。

## 4. 唯一剩余阻塞

`skill-overrides/skills.local.list` 第 5 行启用了：

```text
crash-analyzer-usage
```

但当前工作区缺少：

```text
skill-overrides/crash-analyzer-usage/SKILL.md
```

当前失败结果：

| 命令 | 当前结果 |
| --- | --- |
| `npm run doctor` | exit `1` |
| `node --test test/doctor.test.mjs` | `8/15`，7 个失败 |
| `node --test test/skill-whitelist-extension.test.mjs` | `1/2`，1 个失败 |

所有失败都归因于同一错误：

```text
missing SKILL.md for allowlisted skill: crash-analyzer-usage
```

此问题属于真实本机配置完整性，不是 Plan Runner 行为回归。

禁止用以下方式制造假 GREEN：

- 不得删除 `skills.local.list` 中的 `crash-analyzer-usage`。
- 不得给 doctor 注入隔离的 `PI_CODING_AGENT_DIR`。
- 不得创建只有 frontmatter 或空内容的伪 Skill。
- 不得跳过失败测试后声称累计门禁通过。

## 5. 推荐验收路径：只恢复真实 Skill

这是当前最短且证据最强的路径。

### Step 1：接管 Todo

保持一次只有一个 `in_progress` Todo：

1. 将 `#66` 从 `pending` 更新为 `in_progress`。
2. 保持 `#65` 为 `pending`，并继续 blocked by `#66`。
3. 保持 `#35` 为 `pending`，并继续 blocked by `#65`。

### Step 2：恢复真实 Skill

从该 Skill 的真实受管来源恢复完整目录，至少应存在真实的：

```text
skill-overrides/crash-analyzer-usage/SKILL.md
```

恢复后先检查：

```bash
rg -n '^crash-analyzer-usage$' skill-overrides/skills.local.list
test -f skill-overrides/crash-analyzer-usage/SKILL.md
sed -n '1,80p' skill-overrides/crash-analyzer-usage/SKILL.md
```

通过标准：

- allowlist 条目仍存在。
- `SKILL.md` 来自真实来源，不是为通过 doctor 临时创建的占位文件。
- 不修改 Plan Runner 生产代码、Harness 或测试 oracle。

### Step 3：运行剩余 doctor 门禁

doctor 必须读取真实本机配置：

```bash
npm run doctor
node --test test/doctor.test.mjs
node --test test/skill-whitelist-extension.test.mjs
```

预期结果：

- `npm run doctor` exit `0`。
- `test/doctor.test.mjs` 为 `15/15`。
- `test/skill-whitelist-extension.test.mjs` 为 `2/2`。

不得使用 `--test-force-exit`，也不得通过环境变量隐藏真实配置。

### Step 4：证明旧 Harness 证据仍适用

以下Step 4命令应在同一个shell中顺序执行，并启用fail-fast。先定义真实 Harness 的仓库受保护输入。该集合覆盖两个 Harness 的直接 import、Pi 启动 extension、递归生产依赖、deterministic provider、fixture、cleanup 和 quiescence oracle：

```bash
set -euo pipefail
validated_code_baseline="f7615444e7a86956c3b9647389c32678c6ee9ba3"
harness_inputs=(
  package.json
  scripts/setup-plan-runtime-deps.mjs
  scripts/lib/plan
  scripts/lib/subagent-dispatch
  scripts/probes/pi-subagents-compat.mjs
  pi/extensions/subagent-runtime.ts
  pi/extensions/plan-launcher.ts
  pi/child-extensions
  test/fixtures/deterministic-provider.mjs
  test/fixtures/deterministic-provider-state.mjs
  test/fixtures/plan-harness
  test/support/flat-plan-attention-driver.mjs
  test/support/flat-plan-run-quiescence.mjs
  test/support/plan-e2e-process-cleanup.mjs
  test/plan-flat-runtime-harness.integration.mjs
  test/plan-amendment-harness.integration.mjs
)

git merge-base --is-ancestor "$validated_code_baseline" HEAD
git diff --cached --quiet
git diff --quiet "$validated_code_baseline" -- "${harness_inputs[@]}"

test -z "$(git ls-files --others --exclude-standard -- "${harness_inputs[@]}")"
```

`git merge-base --is-ancestor`允许只增加无关纯文档提交；受保护输入仍必须与validated baseline精确一致。全局index必须为空，避免证据归属被任何待提交内容污染。tracked/untracked worktree检查仍限定到Harness输入范围，因此不会要求清理无关的unstaged或untracked用户内容。

再锁定 ignored pinned runtime：

```bash
set -euo pipefail
test "$(command -v pi)" = "/opt/homebrew/bin/pi"
test "$(pi --version)" = "0.83.0"
test "$(node --version)" = "v26.0.0"
test "$(node -p "require('./pi/npm/node_modules/pi-subagents/package.json').version")" = "0.37.2"

runtime_sha="$(
  (
    cd pi/npm/node_modules
    find . -type f -print0 \
      | LC_ALL=C sort -z \
      | xargs -0 shasum -a 256 \
      | shasum -a 256
  ) | awk '{print $1}'
)"
test "$runtime_sha" = "6292aa7c5559caebff0699ce06727c1099a9c91ff3bec067a4d0d99d049e4ffd"
```

然后确认归档身份与内容未变：

```bash
set -euo pipefail
test "$(shasum -a 256 .pi-subagents/artifacts/verification/task65-f761544-plan-harness.stdout.log | awk '{print $1}')" \
  = "754eea7b48d2a04c1b8e13fa79da1ba33b884f13d4746ea6ea583e66efe60b2c"
test "$(shasum -a 256 .pi-subagents/artifacts/verification/task65-f761544-plan-harness.stderr.log | awk '{print $1}')" \
  = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
```

两个test都必须返回0。

最后确认无活跃 Harness 进程：

```bash
set -euo pipefail
harness_processes() {
  ps -axo comm=,command= \
    | awk '$1 ~ /^(node|pi)$/ && $0 ~ /pi-plan-flat-(runtime|amendment)|plan-flat-runtime-harness|plan-amendment-harness/ { print }'
}
test -z "$(harness_processes)"
```

预期无输出。这里不要并行运行包含相同字符串的其他检查命令，以免进程扫描误报。历史失败fixture可能来自其他已归档运行，因此不要求全局临时目录为空；第 6 节使用pre/post精确集合比较，不会删除无关现场。

### Step 5：关闭验收 Todo

仅在 Step 3 和 Step 4 全部通过后，按顺序更新：

1. `#66`：`in_progress -> completed`。
2. `#65`：`pending -> in_progress -> completed`。
3. `#35`：`pending -> in_progress -> completed`。

关闭 `#65` 时记录：

- validated code baseline `f7615444e7a86956c3b9647389c32678c6ee9ba3`。
- 当前repository HEAD，以及其相对baseline仅包含非受保护输入变更的证明。
- Harness `2/2` 唯一运行证据路径。
- 累计门禁结果。
- doctor `15/15`、whitelist `2/2` 和 CLI exit `0`。
- review `0 Critical / 0 Important`。
- post-run 无残留。

若当前会话提供 `goal_*` typed tools，再通过 Goal Engine 追加证据并关闭目标。不要手工修改 `.state/goal-contract/**` 来绕过事件溯源状态机。

## 6. 仓库输入变更后的验收路径：必须产生新冻结 HEAD

若恢复 Skill 之外，受保护仓库输入集合中的任意文件发生变化，旧 Harness 证据不足以验收新状态。受保护输入集合必须至少包含：

- `package.json` 和 `scripts/setup-plan-runtime-deps.mjs`
- `scripts/lib/subagent-dispatch/**`、`scripts/lib/plan/**`
- `scripts/probes/pi-subagents-compat.mjs`
- `pi/extensions/subagent-runtime.ts`、`pi/extensions/plan-launcher.ts`
- `pi/child-extensions/**`
- `test/fixtures/deterministic-provider*.mjs`
- `test/fixtures/plan-harness/**`
- 三个 Harness support oracle
- 两个真实 Harness integration 文件

`pi/npm/node_modules/**`不是可在本流程内变更的仓库输入，而是第 3.4 节固定的外部runtime invariant。其hash不匹配时停止验收；只有另行批准runtime升级并从受信来源建立新基线后，才能为升级目标编写新的handoff。

此时必须：

1. 行为问题先写中文六要素 `docs/bugs/bug-<摘要>.md`。
2. 加载 `test-driven-development` Skill。
3. 先提交 tests-only RED，再写最小 GREEN。
4. 完成独立复审，Critical 和 Important 必须为 0。
5. 将 production GREEN 提交为新的冻结 HEAD。
6. 在新 HEAD 上重新运行全部累计门禁。
7. 全部门禁通过后，只运行一次新 HEAD 的真实 Harness。

### 6.1 累计门禁顺序

固定 socket suite 必须单独串行运行：

```bash
node --test test/root-subagent-broker.test.mjs
```

普通 `*.test.mjs` 排除固定 socket 和真实配置 doctor，用小批次串行执行：

```bash
find test -type f -name '*.test.mjs' \
  ! -name 'root-subagent-broker.test.mjs' \
  ! -name 'doctor.test.mjs' \
  ! -name 'skill-whitelist-extension.test.mjs' \
  -print \
  | sort \
  | xargs -n 40 node --test
```

然后运行：

```bash
PI_REAL_BIN="$(command -v pi)" \
  node --test test/subagent-runtime-root-broker-startup.integration.mjs

PI_REAL_BIN="$(command -v pi)" \
  node --test test/pi-subagents-compat.test.mjs test/pi-subagents-runtime.integration.mjs

node --test \
  test/migration-contract.test.mjs \
  test/package-scripts.test.mjs \
  test/plan-runtime-migration.test.mjs

npm run doctor
node --test test/doctor.test.mjs
node --test test/skill-whitelist-extension.test.mjs
```

旧 HEAD 的参考计数是 `144 + 1114 + 1 + 30 + 21`。新测试可使计数增加，但不得减少既有覆盖，也不得有 failed、cancelled 或 skipped failure。

不要直接依赖一次 `npm test` 完成全部验收。完整 suite 超过单次时限，且固定 socket suite 必须独立串行。

### 6.2 新 HEAD 的确定性 preflight

以下preflight必须与真实 Harness 在同一个shell中执行。它允许无关dirty worktree存在，但受保护输入必须与新 HEAD 精确相等。

```bash
set -euo pipefail
frozen="$(git rev-parse HEAD)"
short_sha="$(git rev-parse --short=7 HEAD)"
artifact_root=".pi-subagents/artifacts/verification"
stdout="$artifact_root/task65-${short_sha}-plan-harness.stdout.log"
stderr="$artifact_root/task65-${short_sha}-plan-harness.stderr.log"
pre_fixtures="$artifact_root/task65-${short_sha}-pre-fixtures.txt"
post_fixtures="$artifact_root/task65-${short_sha}-post-fixtures.txt"
pre_sockets="$artifact_root/task65-${short_sha}-pre-sockets.txt"
post_sockets="$artifact_root/task65-${short_sha}-post-sockets.txt"
hashes="$artifact_root/task65-${short_sha}-plan-harness.sha256"
new_fixtures="$artifact_root/task65-${short_sha}-new-fixtures.txt"
removed_fixtures="$artifact_root/task65-${short_sha}-removed-fixtures.txt"
new_sockets="$artifact_root/task65-${short_sha}-new-sockets.txt"
removed_sockets="$artifact_root/task65-${short_sha}-removed-sockets.txt"
processes_before_cleanup="$artifact_root/task65-${short_sha}-processes-before-cleanup.txt"
processes_after_cleanup="$artifact_root/task65-${short_sha}-processes-after-cleanup.txt"
cleanup_log="$artifact_root/task65-${short_sha}-identity-cleanup.log"
failure_report="$artifact_root/task65-${short_sha}-plan-harness-failure.md"
harness_tmp="$(node -p "require('node:os').tmpdir()")"
socket_root="/tmp/pi-root-subagent-$(id -u)"

harness_inputs=(
  package.json
  scripts/setup-plan-runtime-deps.mjs
  scripts/lib/plan
  scripts/lib/subagent-dispatch
  scripts/probes/pi-subagents-compat.mjs
  pi/extensions/subagent-runtime.ts
  pi/extensions/plan-launcher.ts
  pi/child-extensions
  test/fixtures/deterministic-provider.mjs
  test/fixtures/deterministic-provider-state.mjs
  test/fixtures/plan-harness
  test/support/flat-plan-attention-driver.mjs
  test/support/flat-plan-run-quiescence.mjs
  test/support/plan-e2e-process-cleanup.mjs
  test/plan-flat-runtime-harness.integration.mjs
  test/plan-amendment-harness.integration.mjs
)

mkdir -p "$artifact_root"
git diff --check HEAD -- "${harness_inputs[@]}"
git diff --cached --quiet
git diff --quiet HEAD -- "${harness_inputs[@]}"
test -z "$(git ls-files --others --exclude-standard -- "${harness_inputs[@]}")"
test "$(git rev-parse HEAD)" = "$frozen"

test -z "$(find "$artifact_root" -maxdepth 1 -type f -name "task65-${short_sha}-*" -print)"

pi_bin="$(command -v pi)"
pi_version="$(pi --version)"
node_version="$(node --version)"
subagents_version="$(node -p "require('./pi/npm/node_modules/pi-subagents/package.json').version")"
test "$pi_bin" = "/opt/homebrew/bin/pi"
test "$pi_version" = "0.83.0"
test "$node_version" = "v26.0.0"
test "$subagents_version" = "0.37.2"

runtime_sha="$(
  (
    cd pi/npm/node_modules
    find . -type f -print0 \
      | LC_ALL=C sort -z \
      | xargs -0 shasum -a 256 \
      | shasum -a 256
  ) | awk '{print $1}'
)"
test "$runtime_sha" = "6292aa7c5559caebff0699ce06727c1099a9c91ff3bec067a4d0d99d049e4ffd"

harness_processes() {
  ps -axo comm=,command= \
    | awk '$1 ~ /^(node|pi)$/ && $0 ~ /pi-plan-flat-(runtime|amendment)|plan-flat-runtime-harness|plan-amendment-harness/ { print }'
}
test -z "$(harness_processes)"

test ! -e test/plan-parallel-harness.integration.mjs
test ! -e scripts/lib/subagents-rpc-client.mjs
test ! -e test/subagents-rpc-client.test.mjs

find "$harness_tmp" -maxdepth 1 -type d \
  \( -name 'pi-plan-flat-amendment-*' -o -name 'pi-plan-flat-runtime-*' \) \
  -print | LC_ALL=C sort >"$pre_fixtures"

if test -d "$socket_root"; then
  find "$socket_root" -maxdepth 1 -type s -print | LC_ALL=C sort >"$pre_sockets"
else
  : >"$pre_sockets"
fi
```

preflight通过标准：

- review 为 `0 Critical / 0 Important`。
- HEAD已冻结且全局index为空；无关路径只允许保持unstaged或untracked dirty。
- 所有受保护tracked输入与HEAD一致，受保护范围没有untracked输入。
- ignored pinned runtime整树hash匹配。
- 该HEAD的日志和快照目标均为全新路径。
- 没有活跃Harness进程。
- fixture和socket已有集合已快照，不要求删除其他会话的历史现场。
- retired文件继续不存在。

### 6.3 新 HEAD 只运行一次真实 Harness

紧接上述preflight，在同一shell中执行。只对Harness命令临时关闭fail-fast，获得exit后立即恢复；所有post-capture命令单独累计状态：

```bash
set +e
PI_REAL_BIN="$pi_bin" npm run test:plan-harness \
  >"$stdout" 2>"$stderr"
harness_status=$?
set -e

post_capture_status=0
if ! find "$harness_tmp" -maxdepth 1 -type d \
  \( -name 'pi-plan-flat-amendment-*' -o -name 'pi-plan-flat-runtime-*' \) \
  -print | LC_ALL=C sort >"$post_fixtures"; then
  post_capture_status=1
fi

if test -d "$socket_root"; then
  if ! find "$socket_root" -maxdepth 1 -type s -print \
    | LC_ALL=C sort >"$post_sockets"; then
    post_capture_status=1
  fi
elif ! : >"$post_sockets"; then
  post_capture_status=1
fi

if ! shasum -a 256 "$stdout" "$stderr" >"$hashes"; then
  post_capture_status=1
fi
if ! harness_processes >"$processes_before_cleanup"; then
  post_capture_status=1
fi
if test -s "$processes_before_cleanup"; then
  post_capture_status=1
fi

difference_status=0
if ! comm -13 "$pre_fixtures" "$post_fixtures" >"$new_fixtures"; then difference_status=1; fi
if ! comm -23 "$pre_fixtures" "$post_fixtures" >"$removed_fixtures"; then difference_status=1; fi
if ! comm -13 "$pre_sockets" "$post_sockets" >"$new_sockets"; then difference_status=1; fi
if ! comm -23 "$pre_sockets" "$post_sockets" >"$removed_sockets"; then difference_status=1; fi
if test "$difference_status" -ne 0; then post_capture_status=1; fi
if ! cmp -s "$pre_fixtures" "$post_fixtures"; then post_capture_status=1; fi
if ! cmp -s "$pre_sockets" "$post_sockets"; then post_capture_status=1; fi

printf 'frozen_head=%s\nharness_exit=%s\npost_capture=%s\n' \
  "$frozen" "$harness_status" "$post_capture_status"

if test "$harness_status" -ne 0 || test "$post_capture_status" -ne 0; then
  cleanup_status=0
  if test -s "$processes_before_cleanup"; then
    set +e
    node --input-type=module - "$new_fixtures" >"$cleanup_log" 2>&1 <<'NODE'
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  processesReferencing,
  terminateDetachedRunsUnder,
} from "./test/support/plan-e2e-process-cleanup.mjs";

const fixtures = (await readFile(process.argv[2], "utf8"))
  .split("\n")
  .filter(Boolean);
for (const fixture of fixtures) {
  const runtimeTmp = join(fixture, "tmp");
  await terminateDetachedRunsUnder(runtimeTmp);
  const residual = await processesReferencing(fixture, runtimeTmp);
  if (residual.length) {
    throw new Error(`identity-safe cleanup left processes for ${fixture}: ${JSON.stringify(residual)}`);
  }
}
NODE
    cleanup_status=$?
    set -e
  elif ! : >"$cleanup_log"; then
    cleanup_status=1
  fi

  if ! harness_processes >"$processes_after_cleanup"; then
    cleanup_status=1
  fi
  if test -s "$processes_after_cleanup"; then
    cleanup_status=1
  fi

  if ! {
    printf '# Task 65 `%s` Plan Harness 失败\n\n' "$short_sha"
    printf -- '- Frozen HEAD: `%s`\n' "$frozen"
    printf -- '- Harness exit: `%s`\n' "$harness_status"
    printf -- '- Post-capture status: `%s`\n' "$post_capture_status"
    printf -- '- Identity cleanup status: `%s`\n' "$cleanup_status"
    printf -- '- Stdout: `%s`\n' "$stdout"
    printf -- '- Stderr: `%s`\n' "$stderr"
    printf -- '- Hashes: `%s`\n' "$hashes"
    printf -- '- New fixtures: `%s`\n' "$new_fixtures"
    printf -- '- Removed fixtures: `%s`\n' "$removed_fixtures"
    printf -- '- New sockets: `%s`\n' "$new_sockets"
    printf -- '- Removed sockets: `%s`\n' "$removed_sockets"
    printf -- '- Processes before cleanup: `%s`\n' "$processes_before_cleanup"
    printf -- '- Processes after cleanup: `%s`\n' "$processes_after_cleanup"
    printf -- '- Cleanup log: `%s`\n\n' "$cleanup_log"
    printf '该HEAD已经运行，不得重跑。保持`#65/#35`未完成。\n'
  } >"$failure_report"; then
    post_capture_status=1
  fi

  final_status="$harness_status"
  if test "$final_status" -eq 0; then final_status=1; fi
  exit "$final_status"
fi
```

无论GREEN或RED，该HEAD都不得重跑。pre/post快照保留了运行前已有的无关fixture和socket身份，不得通过全局删除制造相等。

- GREEN时变量和fail-fast状态保留在当前shell，继续执行第 6.5 节的闭环检查。
- RED或post-capture失败时，上述命令先归档hash、四类集合差异、cleanup前后进程和中文failure报告，再退出。identity-safe cleanup只处理本次新增fixture，失败现场本身不删除；模糊PID或目录名不得授权信号。

### 6.4 新 Harness 的通过标准

dual-Plan Harness 必须证明：

- 两个 Plan 均达到 `validated`。
- 四个 Attention request 均按 durable identity 回复。
- 四个 Attempt 均成功并完成 integration。
- 八个 Gate 全部通过。
- initial actual runs 始终存在，seen run 集合只增不减。
- 完整 actual run 集合持续 6.5 秒 official-terminal quiescence。
- Root 关闭后 runId 到 asyncDir 的集合精确不变。
- 所有 PID 为 `ESRCH`，socket 被删除，无进程残留。

amendment Harness 必须证明：

- crash tool 对目标 run 只调用一次 official `drainRun()`。
- active proof 为 `non-resumable` 时，只使用同 logical、同 canonical session、严格更早且最近的 resumable predecessor 作为 resume source。
- active generation 继续拥有 generation、debt、handoff 和 grant fence。
- revision 2 已持久化且 current pointer 最终切换到 revision 2。
- 旧 Attempt 完成 supersede proof 和 release，新 revision 两个任务均 dispatch、integrate。
- 四个 Gate 全部通过。
- 全部 actual runs 具有 official terminal proof，Root close 后 PID 死亡且无本次运行残留。

### 6.5 新 HEAD 的 GREEN 收尾与 Todo 闭环

只有`harness_status=0`且`post_capture_status=0`时执行：

```bash
test "$harness_status" -eq 0
test "$post_capture_status" -eq 0
test "$(git rev-parse HEAD)" = "$frozen"
git diff --check HEAD -- "${harness_inputs[@]}"
git diff --cached --quiet
git diff --quiet HEAD -- "${harness_inputs[@]}"
test -z "$(git ls-files --others --exclude-standard -- "${harness_inputs[@]}")"
test ! -s "$stderr"
test -s "$hashes"
test ! -e "$failure_report"

runtime_sha_after="$(
  (
    cd pi/npm/node_modules
    find . -type f -print0 \
      | LC_ALL=C sort -z \
      | xargs -0 shasum -a 256 \
      | shasum -a 256
  ) | awk '{print $1}'
)"
test "$runtime_sha_after" = "$runtime_sha"

rg -q 'same Root flat amendment crash Harness revives the canonical Plan Runner' "$stdout"
rg -q 'flat Root runtime Harness reaches two validated Plan Runner happy paths' "$stdout"
rg -q 'pass 2' "$stdout"
rg -q 'fail 0' "$stdout"

cmp "$pre_fixtures" "$post_fixtures"
cmp "$pre_sockets" "$post_sockets"
test ! -s "$processes_before_cleanup"
test -z "$(harness_processes)"
```

通过标准：

- stdout包含两个指定Harness和`pass 2`、`fail 0`。
- stderr为空，stdout/stderr hash已单独归档。
- 受保护worktree输入在运行后仍与冻结HEAD一致，ignored runtime整树hash未变化。
- fixture集合与preflight精确相等，证明成功fixture已删除且未动历史fixture。
- socket集合与preflight精确相等；两个Harness内部还分别验证自身Root socket已删除。
- cleanup前进程证据为空，重新扫描仍无活跃Harness进程。

随后创建`.pi-subagents/artifacts/verification/task65-<short-sha>-plan-harness-green.md`，记录完整HEAD、唯一运行声明、命令、exit、duration、stdout/stderr hash、累计门禁、review、`pi_bin`、`pi_version`、`node_version`、`subagents_version`、`runtime_sha`、pre/post集合比较和无残留结果。

最后按同一顺序关闭Todo：

1. doctor已经GREEN时，`#66 -> completed`。
2. `#65 -> in_progress -> completed`，附新HEAD GREEN证据。
3. `#35 -> in_progress -> completed`。

任一post-run检查失败时不得关闭Todo，也不得把Harness exit `0`单独解释为最终验收完成。

## 7. 工作区保护

当前工作区本来就是 dirty worktree。验收时不得清理、回退或误暂存以下用户或并行会话内容：

- `.state/**`
- `docs/superpowers/plans/2026-07-29-plan-runner-flat-rpc-remove-thin-host.md`
- `pi/settings.json`
- `skill-overrides/exa-search/**`
- 其他未跟踪 bug、plan 和 Goal Contract 文档

同时保持以下红线：

- 不读取或使用 `/Users/leshi.zhy/Desktop/123123`。
- 不广域搜索 `/Users/leshi.zhy`。
- 不修改 `pi/npm/node_modules/pi-subagents/**`。
- 不加载 `fanout-child`，不 re-root，不恢复 Standalone fallback。
- official terminal proof 是唯一 terminal 权威，不能用 ACK、status、signal、PID 死亡或普通 artifact 状态替代。

## 8. 异常处理

### doctor 仍报同一 Skill 缺失

保持 `#66 in_progress`，不要关闭 `#65/#35`。确认恢复来源和路径，不修改 Plan Runner。

### doctor 出现新的错误

将其视为新的独立问题。先保存完整命令、exit code 和 stderr；如需修改逻辑，先写中文六要素并执行 TDD。

### 发现 Plan Runner 代码被并行修改

旧 HEAD 证据不能授权新代码。不要回退对方改动；审查差异，重新建立 RED/GREEN/review/新冻结 HEAD 的证据链。

### 新 HEAD Harness 失败

不重跑同一 HEAD。归档 stdout、stderr、failure 报告和 preserved fixture，确认无活进程后再进入下一轮修复。

## 9. 最终关闭报告模板

```markdown
Plan Runner 最终验收完成。

- Validated code baseline: `<full sha with the unique Harness run>`
- Repository HEAD: `<current descendant or the same sha>`
- Review: `0 Critical / 0 Important`
- Fixed socket: `<pass>/<total>`
- Ordinary suite: `<pass>/<total>`
- Real-Pi startup: `<pass>/<total>`
- Compatibility: `<pass>/<total>`
- Migration contract: `<pass>/<total>`
- Doctor CLI: exit `0`
- Doctor tests: `15/15`
- Skill whitelist: `2/2`
- Real Harness: `2/2`，该 HEAD 唯一运行
- Evidence: `<green evidence path>`
- Cleanup: 无活跃Harness进程；fixture/socket pre/post身份集合精确相等
- Todos: `#66`、`#65`、`#35` 已按依赖顺序关闭
```

完成标准不是“Plan 状态看起来正常”，而是代码门禁、真实配置 doctor、权威 Harness 证据、official terminal proof、无残留和 Todo 状态同时收敛。
