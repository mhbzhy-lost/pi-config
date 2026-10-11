import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyPatch, ApplyError } from "../src/apply-patch/apply.ts";

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "apply-patch-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// 记录型 fake queue：断言单路径操作进入注入的 withFileMutationQueue，并原样执行回调。
function recordingQueue() {
  const queuedPaths = [];
  const withFileMutationQueue = async (filePath, fn) => {
    queuedPaths.push(filePath);
    return await fn();
  };
  return { deps: { withFileMutationQueue }, queuedPaths };
}

// 哨兵型 fake queue：调用回调前向目标文件追加一行。
// 只有当 read 也发生在 queue 回调内部时，哨兵行才会保留在最终内容中；
// 若只锁 write（read 在 queue 外），哨兵会被按旧内容计算的写入覆盖丢失。
function sentinelQueue() {
  const queuedPaths = [];
  const withFileMutationQueue = async (filePath, fn) => {
    queuedPaths.push(filePath);
    await appendFile(filePath, "queue-sentinel\n", "utf8");
    return await fn();
  };
  return { deps: { withFileMutationQueue }, queuedPaths };
}

test("add file creates file with contents", async () => {
  await withTempDir(async (dir) => {
    const { deps, queuedPaths } = recordingQueue();
    const result = await applyPatch(
      "*** Begin Patch\n*** Add File: hello.txt\n+Hello\n+World\n*** End Patch",
      dir,
      deps
    );
    assert.deepEqual(result.added, ["hello.txt"]);
    assert.equal(await readFile(join(dir, "hello.txt"), "utf8"), "Hello\nWorld\n");
    // add 的 mkdir/write 完整进入单路径 queue 回调，路径 key 为解析后的目标文件。
    assert.deepEqual(queuedPaths, [join(dir, "hello.txt")]);
  });
});

test("add file creates parent directories", async () => {
  await withTempDir(async (dir) => {
    const { deps, queuedPaths } = recordingQueue();
    await applyPatch(
      "*** Begin Patch\n*** Add File: sub/dir/file.txt\n+deep\n*** End Patch",
      dir,
      deps
    );
    assert.equal(await readFile(join(dir, "sub/dir/file.txt"), "utf8"), "deep\n");
    // 父目录创建与写入同属一个 queue 回调，单路径一次排队。
    assert.deepEqual(queuedPaths, [join(dir, "sub/dir/file.txt")]);
  });
});

test("update file replaces matched lines", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "app.py"), "foo\nbar\nbaz\n");
    const { deps, queuedPaths } = sentinelQueue();
    const result = await applyPatch(
      "*** Begin Patch\n*** Update File: app.py\n@@\n foo\n-bar\n+BAR\n*** End Patch",
      dir,
      deps
    );
    assert.deepEqual(result.modified, ["app.py"]);
    // 哨兵行保留：read 与 write 同在 queue 回调内部，不是只锁 write。
    assert.equal(
      await readFile(join(dir, "app.py"), "utf8"),
      "foo\nBAR\nbaz\nqueue-sentinel\n"
    );
    assert.deepEqual(queuedPaths, [join(dir, "app.py")]);
  });
});

test("delete file removes file", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "gone.txt"), "bye");
    const { deps, queuedPaths } = recordingQueue();
    const result = await applyPatch(
      "*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch",
      dir,
      deps
    );
    assert.deepEqual(result.deleted, ["gone.txt"]);
    await assert.rejects(() => readFile(join(dir, "gone.txt")));
    // delete 的 rm 完整进入单路径 queue 回调。
    assert.deepEqual(queuedPaths, [join(dir, "gone.txt")]);
  });
});

test("update file with move renames file", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "old.js"), "const x = 1;\n");
    const { deps, queuedPaths } = recordingQueue();
    const result = await applyPatch(
      "*** Begin Patch\n*** Update File: old.js\n*** Move to: new.js\n@@\n-const x = 1;\n+const x = 2;\n*** End Patch",
      dir,
      deps
    );
    assert.deepEqual(result.modified, ["old.js"]);
    await assert.rejects(() => readFile(join(dir, "old.js")));
    assert.equal(await readFile(join(dir, "new.js"), "utf8"), "const x = 2;\n");
    // move 保持旧业务行为且不进入单路径 queue；此处仅证明不入队，不构成 move 的队列覆盖。
    assert.deepEqual(queuedPaths, []);
  });
});

test("update file with change context locates correct position", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "f.py"), "def a():\n    pass\n\ndef b():\n    pass\n");
    const { deps, queuedPaths } = recordingQueue();
    await applyPatch(
      "*** Begin Patch\n*** Update File: f.py\n@@ def b():\n-    pass\n+    return 2\n*** End Patch",
      dir,
      deps
    );
    const content = await readFile(join(dir, "f.py"), "utf8");
    assert.ok(content.includes("def a():\n    pass"));
    assert.ok(content.includes("def b():\n    return 2"));
    assert.deepEqual(queuedPaths, [join(dir, "f.py")]);
  });
});

test("update file with multiple chunks", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "multi.txt"), "foo\nbar\nbaz\nqux\n");
    const { deps, queuedPaths } = recordingQueue();
    await applyPatch(
      "*** Begin Patch\n*** Update File: multi.txt\n@@\n foo\n-bar\n+BAR\n@@\n baz\n-qux\n+QUX\n*** End Patch",
      dir,
      deps
    );
    assert.equal(
      await readFile(join(dir, "multi.txt"), "utf8"),
      "foo\nBAR\nbaz\nQUX\n"
    );
    // 同一文件的多个 chunk 在同一个 hunk 的单路径 queue 回调内一次性生效。
    assert.deepEqual(queuedPaths, [join(dir, "multi.txt")]);
  });
});

test("update file appends with End of File", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "f.txt"), "line1\n");
    const { deps, queuedPaths } = recordingQueue();
    await applyPatch(
      "*** Begin Patch\n*** Update File: f.txt\n@@\n+line2\n*** End of File\n*** End Patch",
      dir,
      deps
    );
    assert.equal(await readFile(join(dir, "f.txt"), "utf8"), "line1\nline2\n");
    assert.deepEqual(queuedPaths, [join(dir, "f.txt")]);
  });
});

test("fuzzy match ignores trailing whitespace", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "f.txt"), "foo   \nbar\n");
    const { deps, queuedPaths } = recordingQueue();
    await applyPatch(
      "*** Begin Patch\n*** Update File: f.txt\n@@\n-foo\n+FOO\n bar\n*** End Patch",
      dir,
      deps
    );
    assert.equal(await readFile(join(dir, "f.txt"), "utf8"), "FOO\nbar\n");
    assert.deepEqual(queuedPaths, [join(dir, "f.txt")]);
  });
});

test("throws ApplyError when update target not found", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "f.txt"), "aaa\n");
    const { deps, queuedPaths } = recordingQueue();
    await assert.rejects(
      () =>
        applyPatch(
          "*** Begin Patch\n*** Update File: f.txt\n@@\n-zzz\n+yyy\n*** End Patch",
          dir,
          deps
        ),
      (e) => e instanceof ApplyError && e.message.includes("Failed to find")
    );
    // 匹配失败发生在 queue 回调内部，错误经 queue 原样传播。
    assert.deepEqual(queuedPaths, [join(dir, "f.txt")]);
  });
});

test("throws ApplyError when update file does not exist", async () => {
  await withTempDir(async (dir) => {
    const { deps, queuedPaths } = recordingQueue();
    await assert.rejects(
      () =>
        applyPatch(
          "*** Begin Patch\n*** Update File: missing.txt\n@@\n-a\n+b\n*** End Patch",
          dir,
          deps
        ),
      (e) => e instanceof ApplyError
    );
    // readFile 失败发生在 queue 回调内部，错误经 queue 原样传播。
    assert.deepEqual(queuedPaths, [join(dir, "missing.txt")]);
  });
});

test("multi-file patch applies all operations", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "del.txt"), "x");
    await writeFile(join(dir, "mod.txt"), "old\n");
    const { deps, queuedPaths } = recordingQueue();
    const result = await applyPatch(
      "*** Begin Patch\n*** Add File: new.txt\n+new\n*** Delete File: del.txt\n*** Update File: mod.txt\n@@\n-old\n+new\n*** End Patch",
      dir,
      deps
    );
    assert.deepEqual(result.added, ["new.txt"]);
    assert.deepEqual(result.deleted, ["del.txt"]);
    assert.deepEqual(result.modified, ["mod.txt"]);
    // 每个 hunk 一次单路径排队，顺序与 patch hunk 顺序一致。
    assert.deepEqual(queuedPaths, [
      join(dir, "new.txt"),
      join(dir, "del.txt"),
      join(dir, "mod.txt"),
    ]);
  });
});

test("throws on empty patch", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      () => applyPatch("*** Begin Patch\n*** End Patch", dir),
      (e) => e instanceof ApplyError && e.message.includes("No files")
    );
  });
});

test("unicode fuzzy match in file update", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "u.py"), "import asyncio  # local \u2013 dep\n");
    const { deps, queuedPaths } = recordingQueue();
    await applyPatch(
      "*** Begin Patch\n*** Update File: u.py\n@@\n-import asyncio  # local - dep\n+import asyncio  # HELLO\n*** End Patch",
      dir,
      deps
    );
    assert.equal(
      await readFile(join(dir, "u.py"), "utf8"),
      "import asyncio  # HELLO\n"
    );
    assert.deepEqual(queuedPaths, [join(dir, "u.py")]);
  });
});
