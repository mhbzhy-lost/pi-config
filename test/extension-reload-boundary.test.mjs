import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadPiTestRuntime } from "./helpers/pi-runtime.mjs";

const { jiti } = await loadPiTestRuntime(import.meta.url);
const compactToolsModule = await jiti.import("../pi/extensions/compact-tools.ts");

function namedImports(source, specifier) {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`import\\s*\\{([\\s\\S]*?)\\}\\s*from\\s*["']${escaped}["']`));
  if (!match) return [];
  return match[1].split(",").map((name) => name.trim()).filter(Boolean);
}

test("reload-sensitive extension behavior does not depend on newly added MJS exports", async () => {
  const compactTools = await readFile(new URL("../pi/extensions/compact-tools.ts", import.meta.url), "utf8");
  const customFooter = await readFile(new URL("../packages/pi-subagents-enhanced/extensions/custom-footer.ts", import.meta.url), "utf8");

  assert.ok(
    !namedImports(compactTools, "../../src/compact-tools/renderer.ts").includes("installCompactSkillRenderer"),
    "compact-tools must keep the skill installer in its reloadable TypeScript entry",
  );
  assert.ok(
    !namedImports(customFooter, "../src/tui/footer-layout.ts").includes("createFooterComponent"),
    "custom-footer must keep its component factory in its reloadable TypeScript entry",
  );
});

test("collapsed adapter discards wrapped lines from a stale renderer", () => {
  assert.equal(typeof compactToolsModule.collapseCollapsedCallLines, "function");
  const status = " · 88 matches";
  const lines = compactToolsModule.collapseCollapsedCallLines(
    [
      "∗ grep ORANGE_CONFIG in",
      "~/taobao-mobile-workspace/source/megability-debugtools/platforms/android",
      "/megability-debugtools/src/main/java/DynamicAbilityActivity.kt",
    ],
    40,
    status,
    (text) => text.length,
    (text, width) => text.slice(0, width),
  );

  assert.deepEqual(lines, ["∗ grep ORANGE_CONFIG in · 88 matches"]);
  assert.ok(lines[0].length <= 40, JSON.stringify(lines));
});
