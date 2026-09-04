import assert from "node:assert/strict";
import test from "node:test";
import { parsePatch, ParseError } from "../src/apply-patch/parser.ts";

test("parses add file hunk", () => {
  const { hunks } = parsePatch(
    "*** Begin Patch\n*** Add File: hello.txt\n+Hello\n+World\n*** End Patch"
  );
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0], {
    type: "add",
    path: "hello.txt",
    contents: "Hello\nWorld\n",
  });
});

test("parses delete file hunk", () => {
  const { hunks } = parsePatch(
    "*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch"
  );
  assert.deepEqual(hunks, [{ type: "delete", path: "gone.txt" }]);
});

test("parses update file hunk with context", () => {
  const { hunks } = parsePatch(
    "*** Begin Patch\n*** Update File: app.py\n@@\n foo\n-bar\n+baz\n*** End Patch"
  );
  assert.equal(hunks.length, 1);
  const h = hunks[0];
  assert.equal(h.type, "update");
  assert.equal(h.path, "app.py");
  assert.equal(h.movePath, null);
  assert.equal(h.chunks.length, 1);
  assert.deepEqual(h.chunks[0].oldLines, ["foo", "bar"]);
  assert.deepEqual(h.chunks[0].newLines, ["foo", "baz"]);
  assert.deepEqual(h.chunks[0].contextLineIndices, [[0, 0]]);
  assert.equal(h.chunks[0].isEndOfFile, false);
});

test("rejects missing Begin Patch", () => {
  assert.throws(() => parsePatch("bad"), ParseError);
});

test("rejects missing End Patch", () => {
  assert.throws(
    () => parsePatch("*** Begin Patch\n*** Add File: f\n+x"),
    ParseError
  );
});

test("rejects empty update hunk", () => {
  assert.throws(
    () => parsePatch("*** Begin Patch\n*** Update File: f.py\n*** End Patch"),
    (e) => e instanceof ParseError && e.message.includes("empty")
  );
});

test("parses move-to rename", () => {
  const { hunks } = parsePatch(
    "*** Begin Patch\n*** Update File: old.js\n*** Move to: new.js\n@@\n-a\n+b\n*** End Patch"
  );
  assert.equal(hunks[0].movePath, "new.js");
});

test("parses multiple hunks in one patch", () => {
  const { hunks } = parsePatch(
    "*** Begin Patch\n*** Add File: a.txt\n+a\n*** Delete File: b.txt\n*** Update File: c.txt\n@@\n-x\n+y\n*** End Patch"
  );
  assert.equal(hunks.length, 3);
  assert.deepEqual(
    hunks.map((h) => h.type),
    ["add", "delete", "update"]
  );
});

test("parses change context (@@ header)", () => {
  const { hunks } = parsePatch(
    "*** Begin Patch\n*** Update File: f.py\n@@ def main():\n-pass\n+return 1\n*** End Patch"
  );
  assert.equal(hunks[0].chunks[0].changeContext, "def main():");
});

test("parses End of File marker", () => {
  const { hunks } = parsePatch(
    "*** Begin Patch\n*** Update File: f.txt\n@@\n+appended\n*** End of File\n*** End Patch"
  );
  assert.equal(hunks[0].chunks[0].isEndOfFile, true);
});

test("strips heredoc wrapper (lenient)", () => {
  const { hunks } = parsePatch(
    "<<'EOF'\n*** Begin Patch\n*** Add File: h.txt\n+hi\n*** End Patch\nEOF"
  );
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].contents, "hi\n");
});

test("parses multiple chunks in one update", () => {
  const { hunks } = parsePatch(
    "*** Begin Patch\n*** Update File: f.txt\n@@\n foo\n-bar\n+BAR\n@@\n baz\n-qux\n+QUX\n*** End Patch"
  );
  assert.equal(hunks[0].chunks.length, 2);
});

test("treats bare empty line in update as empty context", () => {
  const { hunks } = parsePatch(
    "*** Begin Patch\n*** Update File: f.txt\n@@\n before\n\n after\n*** End Patch"
  );
  const c = hunks[0].chunks[0];
  assert.deepEqual(c.oldLines, ["before", "", "after"]);
  assert.deepEqual(c.contextLineIndices, [
    [0, 0],
    [1, 1],
    [2, 2],
  ]);
});

test("rejects invalid hunk header", () => {
  assert.throws(
    () => parsePatch("*** Begin Patch\nbad line\n*** End Patch"),
    (e) => e instanceof ParseError && e.message.includes("not a valid hunk header")
  );
});

test("rejects content after End Patch", () => {
  assert.throws(
    () =>
      parsePatch(
        "*** Begin Patch\n*** Add File: f\n+x\n*** End Patch\nextra"
      ),
    ParseError
  );
});

test("allows trailing whitespace after End Patch", () => {
  const { hunks } = parsePatch(
    "*** Begin Patch\n*** Add File: f\n+x\n*** End Patch\n \t\n"
  );
  assert.equal(hunks.length, 1);
});

test("handles CRLF line endings", () => {
  const { hunks } = parsePatch(
    "*** Begin Patch\r\n*** Update File: f.txt\r\n@@\r\n-old\r\n+new\r\n*** End Patch\r\n"
  );
  assert.deepEqual(hunks[0].chunks[0].oldLines, ["old"]);
  assert.deepEqual(hunks[0].chunks[0].newLines, ["new"]);
});

test("rejects empty hunk after @@ with no lines", () => {
  assert.throws(
    () => parsePatch("*** Begin Patch\n*** Update File: f.txt\n@@\n*** End Patch"),
    (e) => e instanceof ParseError && e.message.includes("does not contain any lines")
  );
});

test("rejects double @@ without lines between", () => {
  assert.throws(
    () => parsePatch("*** Begin Patch\n*** Update File: f.txt\n@@\n@@\n-old\n+new\n*** End Patch"),
    (e) => e instanceof ParseError
  );
});

test("indented update marker is context line not header", () => {
  const { hunks } = parsePatch(
    "*** Begin Patch\n*** Update File: a.txt\n@@\n-old a\n+new a\n *** Update File: b.txt\n@@\n-old b\n+new b\n*** End Patch"
  );
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].chunks.length, 2);
  assert.deepEqual(hunks[0].chunks[0].oldLines, ["old a", "*** Update File: b.txt"]);
});

test("empty patch body returns no hunks", () => {
  const { hunks } = parsePatch("*** Begin Patch\n*** End Patch");
  assert.deepEqual(hunks, []);
});

test("add file with empty content line", () => {
  const { hunks } = parsePatch(
    "*** Begin Patch\n*** Add File: f.txt\n+\n*** End Patch"
  );
  assert.equal(hunks[0].contents, "\n");
});
