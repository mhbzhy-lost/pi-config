import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "../packages/pi-subagents-enhanced/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { compileDispatchIR } = await jiti.import("../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts");

function withWritePaths(writePaths) {
  return compileDispatchIR({
    title: "writePaths grammar",
    agent: "executor",
    task: "Validate writePaths grammar. Read-only verification.",
    writePaths,
    acceptance: { criteria: ["Grammar is enforced."] },
  }, { cwd: "/repo" });
}

test("valid v2 writePaths normalize correctly", () => {
  for (const [input, expected] of [["README.md", "README.md"], ["  src/index.ts  ", "src/index.ts"], ["src/**", "src/**"], ["src", "src"]]) {
    assert.deepEqual(withWritePaths([input]).writePaths, [expected]);
  }
});

const CASES = [
  ["/**", /must not be "/], ["/Users/me/repo/src/a.ts", /must be repo-relative/],
  ["C:/repo/a.ts", /must be repo-relative/], ["\\\\server\\share\\a.ts", /must be repo-relative/],
  ["src\\a.ts", /POSIX separators/], ["src\u0000a.ts", /must not contain NUL/],
  ["src/", /unsafe path segment|unsupported glob\/path/], ["src/*", /unsupported glob/], ["src/**/*.ts", /unsupported glob/],
  ["./src/a.ts", /unsafe path segment/], ["src/../a.ts", /unsafe path segment/], ["src//a.ts", /unsafe path segment/],
];

test("invalid paths use INVALID_PATH and identify the top-level writePaths index", () => {
  for (const [input, re] of CASES) assert.throws(() => withWritePaths([input]), (error) => {
    assert.equal(error.code, "INVALID_PATH");
    assert.match(error.message, re);
    assert.match(error.message, /writePaths\[0\]/);
    return true;
  });
});

test("path errors identify the failing writePaths index", () => {
  assert.throws(() => withWritePaths(["src/ok.ts", "/abs/bad.ts"]), (error) => error.keypath === "writePaths[1]");
});
