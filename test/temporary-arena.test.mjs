import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTemporaryArenaSync } from "./helpers/temporary-arena.mjs";

test("temporary arena dispose is idempotent and removes children before its canonical parent", () => {
  const arena = createTemporaryArenaSync("temporary-arena-test-");
  const first = arena.mkdtempSync("first-");
  const second = arena.mkdtempSync("second-");
  const removals = [];
  arena.onDispose((path) => removals.push(path));

  arena.disposeSync();
  arena.disposeSync();

  assert.deepEqual(removals, [second, first]);
  assert.equal(existsSync(arena.path), false);
});

test("temporary arena removes a linked child without touching its external target", () => {
  const arena = createTemporaryArenaSync("temporary-arena-link-");
  const outside = mkdtempSync(join(tmpdir(), "temporary-arena-outside-"));
  const target = join(outside, "keep.txt");
  writeFileSync(target, "keep\n");
  const link = join(arena.path, "outside-link");
  symlinkSync(outside, link, "dir");

  try {
    arena.disposeSync();
    assert.equal(existsSync(link), false);
    assert.equal(readFileSync(target, "utf8"), "keep\n");
    assert.equal(lstatSync(outside).isDirectory(), true);
  } finally {
    // This intentionally external test sentinel is not owned by the arena.
    rmSync(outside, { recursive: true, force: true });
  }
});
