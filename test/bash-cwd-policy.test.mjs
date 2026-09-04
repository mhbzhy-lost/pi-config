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

test("validateDeclaredBashCwd fails closed for paths outside the workspace", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const outside = await mkdtemp(join(tmpdir(), "bash-cwd-outside-"));
    try {
      await assert.rejects(
        validateDeclaredBashCwd({ cwd: outside, workspaceRoot }),
        /工作区|workspace|cwd/i,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("validateDeclaredBashCwd rejects symlinks that escape the workspace", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const outside = await mkdtemp(join(tmpdir(), "bash-cwd-outside-"));
    const escaped = join(workspaceRoot, "escaped");
    try {
      await symlink(outside, escaped);
      await assert.rejects(
        validateDeclaredBashCwd({ cwd: escaped, workspaceRoot }),
        /工作区|workspace|cwd/i,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
