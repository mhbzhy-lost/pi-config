import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProgressEvents, tailEventsFile } from "../pi/extensions/async-progress-watcher.ts";

test("parseProgressEvents summarizes turn and tool activity", () => {
  const lines = [
    JSON.stringify({ type: "turn_start" }),
    JSON.stringify({ type: "tool_execution_start", tool: "bash" }),
    JSON.stringify({ type: "tool_execution_end", tool: "bash", durationMs: 3200 }),
    JSON.stringify({ type: "turn_end" }),
  ];
  const result = parseProgressEvents(lines, { turnCount: 0 });
  assert.equal(result.summary, "turn 1 | bash (3.2s)");
  assert.equal(result.state.turnCount, 1);
});

test("parseProgressEvents handles message tokens", () => {
  const lines = [
    JSON.stringify({ type: "turn_start" }),
    JSON.stringify({ type: "message_end", usage: { totalTokens: 42000 } }),
  ];
  const result = parseProgressEvents(lines, { turnCount: 0 });
  assert.match(result.summary, /turn 1/);
  assert.match(result.summary, /42k tok/);
});

test("parseProgressEvents returns null for no meaningful events", () => {
  const lines = [
    JSON.stringify({ type: "session_info_changed" }),
  ];
  const result = parseProgressEvents(lines, { turnCount: 0 });
  assert.equal(result, null);
});

test("tailEventsFile reads only new lines since last offset", async () => {
  const tmpFile = join(tmpdir(), `test-events-${Date.now()}.jsonl`);
  await writeFile(tmpFile, '{"type":"turn_start"}\n{"type":"turn_end"}\n');
  const { lines, offset } = await tailEventsFile(tmpFile, 0);
  assert.equal(lines.length, 2);
  await appendFile(tmpFile, '{"type":"turn_start"}\n');
  const result2 = await tailEventsFile(tmpFile, offset);
  assert.equal(result2.lines.length, 1);
  assert.ok(result2.offset > offset);
  await rm(tmpFile);
});

test("tailEventsFile returns empty for no new content", async () => {
  const tmpFile = join(tmpdir(), `test-events-empty-${Date.now()}.jsonl`);
  await writeFile(tmpFile, '{"type":"turn_start"}\n');
  const { offset } = await tailEventsFile(tmpFile, 0);
  const result = await tailEventsFile(tmpFile, offset);
  assert.equal(result.lines.length, 0);
  assert.equal(result.offset, offset);
  await rm(tmpFile);
});

test("startWatching delivers progress summary on events.jsonl update", async () => {
  const tmpFile = join(tmpdir(), `test-watcher-${Date.now()}.jsonl`);
  await writeFile(tmpFile, "");
  const summaries = [];
  const { startWatching } = await import("../pi/extensions/async-progress-watcher.ts");
  const watcher = startWatching(tmpFile, (summary) => {
    summaries.push(summary);
  });

  try {
    await appendFile(tmpFile, [
      JSON.stringify({ type: "turn_start" }),
      JSON.stringify({ type: "tool_execution_start", tool: "bash" }),
      JSON.stringify({ type: "tool_execution_end", tool: "bash", durationMs: 1500 }),
      JSON.stringify({ type: "turn_end" }),
    ].join("\n") + "\n");

    // Allow the 5s polling fallback to deliver the update if fs.watch does not.
    await new Promise((resolve) => setTimeout(resolve, 6000));

    assert.ok(summaries.length > 0, "should have received at least one progress summary");
    assert.match(summaries[0], /turn 1/);
    assert.match(summaries[0], /bash/);
  } finally {
    watcher.stop();
    await rm(tmpFile, { force: true });
  }
}, 7000);
