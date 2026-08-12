import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyPatch, ApplyError } from "../scripts/lib/apply-patch/apply.mjs";

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "apply-patch-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
    assert.equal(
      await readFile(join(dir, "multi.txt"), "utf8"),
      "foo\nBAR\nbaz\nQUX\n"
    );
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
      () =>
        applyPatch(
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
      () =>
        applyPatch(
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
    await applyPatch(
      "*** Begin Patch\n*** Update File: u.py\n@@\n-import asyncio  # local - dep\n+import asyncio  # HELLO\n*** End Patch",
      dir
    );
    assert.equal(
      await readFile(join(dir, "u.py"), "utf8"),
      "import asyncio  # HELLO\n"
    );
  });
});
