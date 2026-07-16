import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import test from "node:test";
import {
  checkShellPolicy,
  codingReminderFor,
  scanPendingPlanTodos,
} from "../scripts/lib/shell-policy.mjs";

const workspaceRoot = process.cwd();
const cwd = join(workspaceRoot, "test");

function policy(command, overrides = {}) {
  return checkShellPolicy({ command, cwd, workspaceRoot, ...overrides });
}

function assertBlocked(command, code, reason, overrides) {
  const violation = policy(command, overrides);
  assert.deepEqual(violation?.block, true, command);
  assert.equal(violation?.code, code, command);
  assert.match(violation?.reason ?? "", reason, command);
}

test("blocks rm targets outside the workspace and permits known workspace paths", () => {
  assertBlocked("rm -rf /Users/shared", "RM_OUTSIDE_WORKSPACE", /workspace 外 rm/);
  assertBlocked("rm -rf ../../other", "RM_OUTSIDE_WORKSPACE", /workspace 外 rm/);
  assert.equal(policy("rm -rf ./helpers"), undefined);
  assert.equal(policy("rm -rf /Users/leshi.zhy/pi-config/test/helpers"), undefined);
});

test("uses cd context and unwraps sudo command and env before checking rm", () => {
  assertBlocked("cd /Users/shared && rm -rf cache", "RM_OUTSIDE_WORKSPACE", /workspace 外 rm/);
  assertBlocked("sudo rm -rf /Users/shared", "RM_OUTSIDE_WORKSPACE", /workspace 外 rm/);
  assertBlocked("command rm -rf /Users/shared", "RM_OUTSIDE_WORKSPACE", /workspace 外 rm/);
  assertBlocked("env MODE=test rm -rf /Users/shared", "RM_OUTSIDE_WORKSPACE", /workspace 外 rm/);
  assert.equal(policy("cd /Users/leshi.zhy/pi-config/test && rm -rf helpers"), undefined);
});

test("fails closed for symlinks and shell-expanded or indeterminate rm targets", () => {
  assert.equal(policy("rm -rf missing-workspace-target"), undefined);
  assertBlocked("rm -rf $HOME/cache", "RM_TARGET_UNCERTAIN", /无法确定 rm 目标/);
  assertBlocked("rm -rf ~/cache", "RM_TARGET_UNCERTAIN", /无法确定 rm 目标/);
  assertBlocked("rm -rf *", "RM_TARGET_UNCERTAIN", /无法确定 rm 目标/);
  assertBlocked("rm -rf -- $(pwd)", "RM_TARGET_UNCERTAIN", /无法确定 rm 目标/);
});

test("allows rm in the system temporary directory", () => {
  assert.equal(policy("rm -rf /tmp/build-123"), undefined);
  assert.equal(policy(`rm -rf ${join(tmpdir(), "build-123")}`), undefined);
  assert.equal(policy("rm -rf /private/tmp/build-123"), undefined);
});

test("blocks a sibling of the canonical temporary directory", () => {
  const canonicalTemp = realpathSync(tmpdir());
  const sibling = join(dirname(canonicalTemp), "shell-policy-not-temp");
  assertBlocked(`rm -rf ${sibling}`, "RM_OUTSIDE_WORKSPACE", /workspace 外 rm/);
});

test("blocks invalid commit messages from inline, file, amend, and skip forms", () => {
  assert.equal(policy('git commit -m "feat: 添加登录校验"'), undefined);
  assertBlocked('git commit -m "feature: 添加登录校验"', "COMMIT_MESSAGE_INVALID", /type/);
  assertBlocked('git commit -m "feat: add login validation"', "COMMIT_MESSAGE_INVALID", /中文/);
  assertBlocked('git commit -m "feat: 添加登录校验。"', "COMMIT_MESSAGE_INVALID", /句号/);
  assertBlocked('git commit -m "fix: 修复了登录问题"', "COMMIT_MESSAGE_INVALID", /过去时/);
  assertBlocked('git commit -m "fix: 修改"', "COMMIT_MESSAGE_INVALID", /信息量/);
  assertBlocked('git commit -m "feat: 添加登录校验\n\nCo-authored-by: AI"', "COMMIT_MESSAGE_INVALID", /AI 署名/);
  assertBlocked("git commit --message=$'feat: 添加登录校验'", "COMMIT_MESSAGE_INVALID", /message/);
  assertBlocked("git commit -F .git/COMMIT_EDITMSG", "COMMIT_MESSAGE_REQUIRED", /message/);
  assertBlocked("git commit --amend --no-edit", "COMMIT_MESSAGE_REQUIRED", /message/);
  assert.equal(policy('GIT_COMMIT_HOOK_SKIP=1 git commit -m "feat: 添加登录校验"'), undefined);
});

test("blocks git push when the caller repository has pending plan TODOs, including read errors", async () => {
  const repo = await mkdtemp(join(tmpdir(), "shell-policy-repo-"));
  try {
    await mkdir(join(repo, "docs", "plans"), { recursive: true });
    const plan = join(repo, "docs", "plans", "release.md");
    await writeFile(plan, "# Release\nTODO: finish verification\n");
    assert.deepEqual(scanPendingPlanTodos(repo), [{ file: plan, text: "TODO: finish verification" }]);
    assertBlocked("git push", "PUSH_PENDING_PLAN_TODOS", /TODO/, { cwd: repo, workspaceRoot: repo });
    assert.equal(policy("git push --dry-run", { cwd: repo, workspaceRoot: repo }), undefined);

    await writeFile(plan, "# Release\ncomplete\n");
    await chmod(plan, 0o000);
    const invalidPlans = join(repo, "docs", "plans");
    await rm(invalidPlans, { recursive: true, force: true });
    await writeFile(invalidPlans, "not a directory");
    const unreadable = scanPendingPlanTodos(repo);
    assert.equal(unreadable.length, 1);
    assert.equal(unreadable[0].file, invalidPlans);
    assert.match(unreadable[0].text, /读取失败/);
    assertBlocked("git push", "PUSH_PENDING_PLAN_TODOS", /读取失败/, { cwd: repo, workspaceRoot: repo });
  } finally {
    await chmod(join(repo, "docs", "plans", "release.md"), 0o600).catch(() => {});
    await rm(repo, { recursive: true, force: true });
  }
});

test("finds plan TODOs only in the caller repository", async () => {
  const repo = await mkdtemp(join(tmpdir(), "shell-policy-caller-"));
  try {
    await mkdir(join(repo, "docs", "plans"), { recursive: true });
    await writeFile(join(repo, "docs", "plans", "one.md"), "TODO: caller only\n");
    assert.deepEqual(scanPendingPlanTodos(repo), [{
      file: join(repo, "docs", "plans", "one.md"),
      text: "TODO: caller only",
    }]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("recognizes git commands reached through cd and git -C", () => {
  assertBlocked('cd /tmp/repo && git commit -m "fix: 修复问题"', "GIT_CWD_FORBIDDEN", /cd/);
  assertBlocked('git -C /tmp/repo commit -m "fix: 修复问题"', "GIT_C_FORBIDDEN", /git -C/);
});

test("blocks cd followed by git regardless of git subcommand validity", () => {
  assertBlocked('cd /tmp && git status', "GIT_CWD_FORBIDDEN", /cd/);
  assertBlocked('cd /tmp && git commit -m "feat: 添加提交校验"', "GIT_CWD_FORBIDDEN", /cd/);
});

test("blocks git -C regardless of commit message validity", () => {
  assertBlocked('git -C /tmp status', "GIT_C_FORBIDDEN", /git -C/);
  assertBlocked('git -C /tmp commit -m "feat: 添加提交校验"', "GIT_C_FORBIDDEN", /git -C/);
});

test("commit skip only bypasses commit validation", () => {
  assert.equal(policy('GIT_COMMIT_HOOK_SKIP=1 git commit -m "bad: english"'), undefined);
  assertBlocked('GIT_COMMIT_HOOK_SKIP=1 rm -rf /Users/shared', "RM_OUTSIDE_WORKSPACE", /workspace 外 rm/);
  assertBlocked('GIT_COMMIT_HOOK_SKIP=1 cd /tmp && git status', "GIT_CWD_FORBIDDEN", /cd/);
});

test("allows symlinks whose canonical target remains in a temporary root", async () => {
  const root = await mkdtemp(join(tmpdir(), "shell-policy-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "shell-policy-outside-"));
  try {
    const link = join(root, "escape");
    await symlink(outside, link);
    assert.equal(policy(`rm -rf ${link}/`, { cwd: root, workspaceRoot: root }), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("blocks nonexistent home targets outside the workspace and below a symlink ancestor", async () => {
  const root = await mkdtemp(join(tmpdir(), "shell-policy-boundary-"));
  const outside = await mkdtemp(join(homedir(), ".shell-policy-outside-"));
  try {
    await symlink(outside, join(root, "escape"));
    assertBlocked(`rm -rf ${join(homedir(), ".shell-policy-missing-target")}`, "RM_OUTSIDE_WORKSPACE", /workspace 外 rm/, { cwd: root, workspaceRoot: root });
    assertBlocked("rm -rf escape/missing", "RM_OUTSIDE_WORKSPACE", /workspace 外 rm/, { cwd: root, workspaceRoot: root });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("does not segment shell separators inside quotes", () => {
  assert.equal(policy('git commit -m "feat: 增加; 完成回调 && 记录 || AI"'), undefined);
});

test("aligns commit subject and AI signature rules with the convention", () => {
  assert.equal(policy('git commit -m "feat: 增加完成回调!"'), undefined);
  assert.equal(policy('git commit -m "docs: 更新 claude-config 中 AI 配置"'), undefined);
  assertBlocked('git commit -m "feat: 增加回调\n\nCo-Authored-By: Cursor"', "COMMIT_MESSAGE_INVALID", /AI 署名/);
  assertBlocked('git commit -m "feat: 增加回调\n\nGenerated with Claude"', "COMMIT_MESSAGE_INVALID", /AI 署名/);
  assertBlocked('git commit -m "feat: 增加回调\n\nAI-assisted"', "COMMIT_MESSAGE_INVALID", /AI 署名/);
  assertBlocked('git commit -m "fix: 修改"', "COMMIT_MESSAGE_INVALID", /信息量/);
});

test("matches only anchored plan TODOs and recognizes git global options for push", async () => {
  const repo = await mkdtemp(join(tmpdir(), "shell-policy-push-"));
  try {
    await mkdir(join(repo, "docs", "plans"), { recursive: true });
    await writeFile(join(repo, "docs", "plans", "release.md"), "示例 TODO: 不应匹配\n- TODO: 需要完成\n");
    assert.deepEqual(scanPendingPlanTodos(repo), [{ file: join(repo, "docs", "plans", "release.md"), text: "TODO: 需要完成" }]);
    assertBlocked("git --no-pager push", "PUSH_PENDING_PLAN_TODOS", /TODO/, { cwd: repo, workspaceRoot: repo });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("returns coding reminders only for source edits", () => {
  assert.match(codingReminderFor({ toolName: "write", input: { path: "src/app.mjs" } }) ?? "", /test-driven-development/);
  assert.equal(codingReminderFor({ toolName: "write", input: { path: "README.md" } }), undefined);
  assert.equal(codingReminderFor({ toolName: "bash", input: { command: "npm test" } }), undefined);
  assert.equal(codingReminderFor({ toolName: "write", input: { file_path: "src/app.ts" } })?.includes("test-driven-development"), true);
  for (const path of ["src/app.test.ts", "src/app.spec.ts", "src/app_test.py", "src/test.ts", "tests/app.ts", "test/app.ts", "__tests__/app.ts"]) {
    assert.equal(codingReminderFor({ toolName: "write", input: { path } }), undefined, path);
  }
});
