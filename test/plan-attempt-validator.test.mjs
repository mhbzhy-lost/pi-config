import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { validateAttemptResult } from "../scripts/lib/plan/attempt-validator.mjs";

const execFile = promisify(execFileCallback);

function nodeCommand(source = "") {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
}

async function git(cwd, ...args) {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-attempt-validator-"));
  await git(root, "init", "--initial-branch=main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test User");
  await writeFile(path.join(root, "README.md"), "base\n");
  await git(root, "add", "README.md");
  await git(root, "commit", "-m", "base");
  const baseCommit = await git(root, "rev-parse", "HEAD");
  return {
    root,
    baseCommit,
    lease: {
      planId: "plan-1",
      taskId: "task-1",
      attemptId: "attempt-1",
      baseCommit,
      path: root,
      stateRoot: root,
    },
  };
}

async function withRepository(fn) {
  const repo = await repository();
  try {
    await fn(repo);
  } finally {
    await rm(repo.root, { recursive: true, force: true });
  }
}

async function commitFile(root, file, content = "change\n") {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content);
  await git(root, "add", file);
  await git(root, "commit", "-m", `change ${file}`);
  return git(root, "rev-parse", "HEAD");
}

test("accepts exactly one clean descendant commit and records command evidence", async () => {
  await withRepository(async ({ root, lease, baseCommit }) => {
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "test"));
    await writeFile(path.join(root, "src", "a.mjs"), "export default 1;\n");
    await writeFile(path.join(root, "test", "a.test.mjs"), "test\n");
    await git(root, "add", "src/a.mjs", "test/a.test.mjs");
    await git(root, "commit", "-m", "attempt result");
    const resultCommit = await git(root, "rev-parse", "HEAD");

    const result = await validateAttemptResult({
      lease,
      allowedPaths: ["src/**", "test/a.test.mjs"],
      verification: [{ id: "contract:verification:1", command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('ok')"` }],
    });

    assert.equal(result.accepted, true);
    assert.equal(result.attemptId, "attempt-1");
    assert.equal(result.baseCommit, baseCommit);
    assert.equal(result.resultCommit, resultCommit);
    assert.deepEqual(result.changedPaths, ["src/a.mjs", "test/a.test.mjs"]);
    assert.match(result.diffSha256, /^[a-f0-9]{64}$/);
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].kind, "command");
    assert.equal(result.evidence[0].commandId, "contract:verification:1");
    assert.equal(result.evidence[0].exitCode, 0);
    assert.equal(await readFile(result.evidence[0].stdoutPath, "utf8"), "ok");
  });
});

test("rejects no commit, a non-descendant HEAD, and multi-commit or merge results", async () => {
  await withRepository(async ({ root, lease }) => {
    assert.equal((await validateAttemptResult({ lease, allowedPaths: ["src/**"], verification: [] })).code, "NO_RESULT_COMMIT");
  });

  await withRepository(async ({ root, lease }) => {
    await git(root, "checkout", "--orphan", "unrelated");
    await git(root, "rm", "-rf", ".");
    await writeFile(path.join(root, "other.txt"), "other\n");
    await git(root, "add", "other.txt");
    await git(root, "commit", "-m", "unrelated");
    assert.equal((await validateAttemptResult({ lease, allowedPaths: ["other.txt"], verification: [] })).code, "NON_DESCENDANT_HEAD");
  });

  await withRepository(async ({ root, lease }) => {
    await commitFile(root, "src/a.txt");
    await commitFile(root, "src/b.txt");
    assert.equal((await validateAttemptResult({ lease, allowedPaths: ["src/**"], verification: [] })).code, "INVALID_COMMIT_COUNT");
  });

  await withRepository(async ({ root, lease, baseCommit }) => {
    await git(root, "checkout", "-b", "side", baseCommit);
    await commitFile(root, "src/side.txt");
    await git(root, "checkout", "main");
    await commitFile(root, "src/main.txt");
    await git(root, "merge", "--no-ff", "side", "-m", "merge result");
    assert.equal((await validateAttemptResult({ lease, allowedPaths: ["src/**"], verification: [] })).code, "INVALID_COMMIT_COUNT");
  });
});

test("rejects dirty tracked and untracked files", async () => {
  for (const kind of ["tracked", "untracked"]) {
    await withRepository(async ({ root, lease }) => {
      await commitFile(root, "src/a.txt");
      await writeFile(path.join(root, kind === "tracked" ? "src/a.txt" : "untracked.txt"), "dirty\n");
      const result = await validateAttemptResult({ lease, allowedPaths: ["src/**"], verification: [] });
      assert.equal(result.code, "DIRTY_WORKTREE", kind);
    });
  }
});

test("rejects out-of-scope paths and requires both sides of a rename to be owned", async () => {
  await withRepository(async ({ root, lease }) => {
    await commitFile(root, "outside.txt");
    const result = await validateAttemptResult({ lease, allowedPaths: ["src/**"], verification: [] });
    assert.equal(result.code, "PATH_NOT_OWNED");
    assert.deepEqual(result.paths, ["outside.txt"]);
  });

  await withRepository(async ({ root, lease }) => {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "old.txt"), "base rename\n");
    await git(root, "add", "src/old.txt");
    await git(root, "commit", "-m", "rename base");
    lease.baseCommit = await git(root, "rev-parse", "HEAD");
    await mkdir(path.join(root, "outside"));
    await git(root, "mv", "src/old.txt", "outside/new.txt");
    await git(root, "commit", "-m", "rename out");
    const result = await validateAttemptResult({ lease, allowedPaths: ["outside/**"], verification: [] });
    assert.equal(result.code, "PATH_NOT_OWNED");
    assert.deepEqual(result.paths, ["src/old.txt"]);
  });
});

test("rejects symlink escapes and every .git ownership declaration", async () => {
  await withRepository(async ({ root, lease }) => {
    await mkdir(path.join(root, "src"));
    await symlink("/tmp", path.join(root, "src", "escape"));
    await git(root, "add", "src/escape");
    await git(root, "commit", "-m", "symlink escape");
    assert.equal((await validateAttemptResult({ lease, allowedPaths: ["src/**"], verification: [] })).code, "SYMLINK_ESCAPE");
  });

  await withRepository(async ({ root, lease }) => {
    await commitFile(root, "src/a.txt");
    assert.equal((await validateAttemptResult({ lease, allowedPaths: [".git/**", "src/**"], verification: [] })).code, "INVALID_ALLOWED_PATH");
  });
});

test("rejects failed controlled verification and preserves stdout and stderr evidence", async () => {
  await withRepository(async ({ root, lease }) => {
    await commitFile(root, "src/a.txt");
    const result = await validateAttemptResult({
      lease,
      allowedPaths: ["src/**"],
      verification: [{ id: "package:test", command: `${JSON.stringify(process.execPath)} -e "process.stderr.write('failed');process.exit(3)"` }],
    });
    assert.equal(result.accepted, false);
    assert.equal(result.code, "VERIFICATION_FAILED");
    assert.equal(result.evidence[0].exitCode, 3);
    assert.equal(await readFile(result.evidence[0].stderrPath, "utf8"), "failed");
  });
});

test("fails a structured verification timeout with bounded evidence and no delayed side effect", async () => {
  await withRepository(async ({ root, lease }) => {
    await commitFile(root, "src/a.txt");
    const marker = path.join(root, "timeout.marker");
    const result = await validateAttemptResult({
      lease,
      allowedPaths: ["src/**"],
      verification: [{
        id: "plan:timeout",
        command: nodeCommand(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, ''), 1000)`),
        cwd: ".",
        timeoutMs: 10,
      }],
    });

    assert.equal(result.accepted, false);
    assert.equal(result.code, "VERIFICATION_FAILED");
    assert.notEqual(result.evidence[0].exitCode, 0);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await assert.rejects(readFile(marker));
  });
});

test("runs structured verification in a safe relative cwd with a timeout", async () => {
  await withRepository(async ({ root, lease }) => {
    await commitFile(root, "src/a.txt");
    await mkdir(path.join(root, "src", "subdir"));
    const result = await validateAttemptResult({
      lease, allowedPaths: ["src/**"],
      verification: [{ id: "plan:test", command: nodeCommand("require('node:fs').writeFileSync('marker', '')"), cwd: "src/subdir", timeoutMs: 1_000 }],
    });
    assert.equal(result.accepted, true);
    assert.equal(await readFile(path.join(root, "src", "subdir", "marker"), "utf8"), "");
  });
});

test("rejects unsafe structured verification before writing evidence or executing", async () => {
  await withRepository(async ({ root, lease }) => {
    await commitFile(root, "src/a.txt");
    for (const entry of [
      { cwd: "../outside", timeoutMs: 1 }, { cwd: "/tmp", timeoutMs: 1 }, { cwd: "src\\bad", timeoutMs: 1 },
      { cwd: "src//bad", timeoutMs: 1 }, { cwd: "src", timeoutMs: 0 }, { cwd: "src", timeoutMs: Infinity },
    ]) await assert.rejects(validateAttemptResult({
      lease, allowedPaths: ["src/**"], verification: [{ id: "plan:test", command: "touch should-not-run", ...entry }],
    }), /cwd or timeout/i);
    await assert.rejects(readFile(path.join(root, "should-not-run")));
  });
});

test("rejects unregistered command strings instead of executing task prose", async () => {
  await withRepository(async ({ root, lease }) => {
    await commitFile(root, "src/a.txt");
    await assert.rejects(
      validateAttemptResult({ lease, allowedPaths: ["src/**"], verification: ["echo unsafe"] }),
      /controlled verification/i,
    );
  });
});
