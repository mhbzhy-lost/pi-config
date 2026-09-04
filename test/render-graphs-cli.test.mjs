import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("render-graphs CLI runs directly from its TypeScript entrypoint", () => {
  const result = spawnSync(process.execPath, ["skill-overrides/writing-skills/render-graphs.ts"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: node render-graphs\.ts/);
});
