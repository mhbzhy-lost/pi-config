import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("shell integration makes bare pi use the repository configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-shell-"));
  try {
    const output = join(root, "invocation.json");
    const fakePi = join(root, "pi-real");
    await writeFile(
      fakePi,
      `#!/usr/bin/env bash\nnode -e 'require("fs").writeFileSync(process.env.OUTPUT, JSON.stringify({ config: process.env.PI_CODING_AGENT_DIR, sessions: process.env.PI_CODING_AGENT_SESSION_DIR, args: process.argv.slice(1) }))' -- "$@"\n`,
    );
    await chmod(fakePi, 0o755);

    const result = spawnSync(
      "zsh",
      ["-f", "-c", `source ${join(repoRoot, "scripts", "pi-shell.zsh")}; pi --version`],
      {
        encoding: "utf8",
        env: { ...process.env, PI_REAL_BIN: fakePi, OUTPUT: output },
      },
    );

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), {
      config: join(repoRoot, "pi"),
      sessions: join(repoRoot, "var", "sessions"),
      args: ["--no-skills", "--version"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
