import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function namedImports(source, specifier) {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`import\\s*\\{([\\s\\S]*?)\\}\\s*from\\s*["']${escaped}["']`));
  if (!match) return [];
  return match[1].split(",").map((name) => name.trim()).filter(Boolean);
}

test("reload-sensitive extension behavior does not depend on newly added MJS exports", async () => {
  const compactTools = await readFile(new URL("../pi/extensions/compact-tools.ts", import.meta.url), "utf8");
  const customFooter = await readFile(new URL("../pi/extensions/custom-footer.ts", import.meta.url), "utf8");

  assert.ok(
    !namedImports(compactTools, "../../scripts/lib/compact-tools-renderer.mjs").includes("installCompactSkillRenderer"),
    "compact-tools must keep the skill installer in its reloadable TypeScript entry",
  );
  assert.ok(
    !namedImports(customFooter, "../../scripts/lib/custom-footer-layout.mjs").includes("createFooterComponent"),
    "custom-footer must keep its component factory in its reloadable TypeScript entry",
  );
});
