import assert from "node:assert/strict";
import test from "node:test";
import { seekSequence } from "../scripts/lib/apply-patch/seek-sequence.mjs";

test("exact match", () => {
  assert.equal(seekSequence(["foo", "bar", "baz"], ["bar", "baz"], 0, false), 1);
});

test("returns null when not found", () => {
  assert.equal(seekSequence(["foo", "bar"], ["qux"], 0, false), null);
});

test("returns start for empty pattern", () => {
  assert.equal(seekSequence(["foo"], [], 0, false), 0);
});

test("returns null when pattern longer than lines", () => {
  assert.equal(seekSequence(["one"], ["a", "b", "c"], 0, false), null);
});

test("rstrip match ignores trailing whitespace", () => {
  assert.equal(seekSequence(["foo   ", "bar\t"], ["foo", "bar"], 0, false), 0);
});

test("trim match ignores leading and trailing whitespace", () => {
  assert.equal(seekSequence(["    foo   ", "   bar"], ["foo", "bar"], 0, false), 0);
});

test("unicode normalization matches fancy dashes to ASCII", () => {
  assert.equal(
    seekSequence(["import \u2013 fast"], ["import - fast"], 0, false),
    0
  );
});

test("unicode normalization matches fancy quotes", () => {
  assert.equal(
    seekSequence(["say \u201Chello\u201D"], ['say "hello"'], 0, false),
    0
  );
});

test("unicode normalization matches non-breaking space", () => {
  assert.equal(
    seekSequence(["a\u00A0b"], ["a b"], 0, false),
    0
  );
});

test("eof flag searches from end first", () => {
  const lines = ["a", "b", "a", "b"];
  assert.equal(seekSequence(lines, ["a", "b"], 0, false), 0);
  assert.equal(seekSequence(lines, ["a", "b"], 0, true), 2);
});

test("respects start offset", () => {
  assert.equal(seekSequence(["x", "y", "x"], ["x"], 1, false), 2);
});

test("exact match preferred over fuzzy", () => {
  const lines = ["foo  ", "foo"];
  // Exact match at index 1 should win over rstrip match at index 0
  assert.equal(seekSequence(lines, ["foo"], 0, false), 1);
});

test("multi-line pattern with mixed matching", () => {
  const lines = ["  hello  ", "world", "  foo"];
  assert.equal(seekSequence(lines, ["hello", "world"], 0, false), 0);
});
