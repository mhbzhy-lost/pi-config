import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("render_graphs exposes Graphviz rendering through the Pi tool contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "render-graphs-tool-"));
  const guide = join(root, "guide.md");
  await writeFile(guide, "# Guide\n\nNo diagrams yet.\n");
  const { renderGraphsTool } = await import(new URL("../src/writing-skills/render-graphs-tool.ts", import.meta.url).href);
  const result = await renderGraphsTool.execute("render-1", { markdownFile: guide });
  assert.match(result.content[0].text, /未找到 dot 代码块/);
  await assert.rejects(readFile(join(root, "diagrams", "sample.svg")));
});
