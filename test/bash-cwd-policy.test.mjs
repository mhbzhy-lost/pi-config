import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateDeclaredBashCwd } from "../src/bash-cwd/policy.ts";

async function withWorkspace(run) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "bash-cwd-policy-"));
  try {
    await run(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

test("validateDeclaredBashCwd resolves relative directories within the workspace", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const nested = join(workspaceRoot, "packages", "app");
    await mkdir(nested, { recursive: true });

    assert.equal(await validateDeclaredBashCwd({ cwd: "packages/app", workspaceRoot }), await realpath(nested));
  });
});

test("validateDeclaredBashCwd rejects missing paths and files", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const file = join(workspaceRoot, "file.txt");
    await writeFile(file, "not a directory");

    await assert.rejects(
      validateDeclaredBashCwd({ cwd: "missing", workspaceRoot }),
      /cwd|目录|存在/i,
    );
    await assert.rejects(
      validateDeclaredBashCwd({ cwd: file, workspaceRoot }),
      /cwd|目录/i,
    );
  });
});

test("validateDeclaredBashCwd accepts an existing directory outside the workspace", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const outside = await mkdtemp(join(tmpdir(), "bash-cwd-outside-"));
    try {
      assert.equal(await validateDeclaredBashCwd({ cwd: outside, workspaceRoot }), await realpath(outside));
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("validateDeclaredBashCwd resolves symlinks to their real directory", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const outside = await mkdtemp(join(tmpdir(), "bash-cwd-outside-"));
    const escaped = join(workspaceRoot, "escaped");
    try {
      await symlink(outside, escaped);
      assert.equal(await validateDeclaredBashCwd({ cwd: escaped, workspaceRoot }), await realpath(outside));
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("isWithinWorkspace reports canonical containment independently", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const nested = join(workspaceRoot, "nested");
    await mkdir(nested);
    assert.equal((await import("../src/bash-cwd/policy.ts")).isWithinWorkspace(workspaceRoot, nested), true);
    assert.equal((await import("../src/bash-cwd/policy.ts")).isWithinWorkspace(workspaceRoot, await mkdtemp(join(tmpdir(), "bash-cwd-other-"))), false);
  });
});
