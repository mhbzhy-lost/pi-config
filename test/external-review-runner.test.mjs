import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runExternalReview } from "../scripts/lib/external-review-runner.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const migratedFiles = [
  "skill-overrides/external-llm-review/SKILL.md",
  "skill-overrides/external-llm-review/reviewer.py",
  "skill-overrides/external-llm-review/_config.py",
  "skill-overrides/external-llm-review/_provider.py",
  "skill-overrides/external-llm-review/_healthcheck.py",
  "scripts/hooks/external-review-gate.sh",
];

async function makeHook(source) {
  const directory = await mkdtemp(join(tmpdir(), "external-review-runner-"));
  const hookPath = join(directory, "hook.sh");
  await writeFile(hookPath, source, { mode: 0o755 });
  return { directory, hookPath };
}

test("migrated external review files are path independent and reviewer state is ignored", async () => {
  for (const file of migratedFiles) {
    const content = await readFile(join(repoRoot, file), "utf8");
    assert.doesNotMatch(content, /CLAUDE_CONFIG_HOME|userconf\/skills|~\/\.config\/opencode/);
  }

  const gitignore = await readFile(join(repoRoot, ".gitignore"), "utf8");
  assert.match(gitignore, /external-llm-review\/\.env/);
  assert.match(gitignore, /external-llm-review\/\.venv/);
  assert.match(gitignore, /external-review-gate\.log/);
});

test("external review deny blocks with sanitized diagnostics", async (t) => {
  const { directory, hookPath } = await makeHook(
    '#!/usr/bin/env bash\nread request\nprintf "token=super-secret\\n" >&2\nprintf \'{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"Critical finding"}}\'',
  );
  t.after(() => rm(directory, { recursive: true, force: true }));

  const result = await runExternalReview({ hookPath, command: "git push origin main", cwd: directory, timeoutMs: 1_000, logPath: join(directory, "gate.log") });

  assert.equal(result.block, true);
  assert.match(result.reason, /Critical finding/);
  assert.doesNotMatch(result.reason, /super-secret/);
  assert.doesNotMatch(await readFile(join(directory, "gate.log"), "utf8"), /super-secret/);
  assert.deepEqual(result.findings, [{ severity: "Critical", message: "Critical finding" }]);
  assert.equal(result.available, true);
});

test("external review sends the Bash command to a shell hook", async (t) => {
  const { directory, hookPath } = await makeHook(
    '#!/usr/bin/env bash\nread request\ncase "$request" in *\'"tool_name":"Bash"\'*,*\'"command":"git push origin main"\'*) printf \'{"hookSpecificOutput":{"permissionDecision":"allow"}}\' ;; *) exit 9 ;; esac',
  );
  t.after(() => rm(directory, { recursive: true, force: true }));

  const result = await runExternalReview({ hookPath, command: "git push origin main", cwd: directory, timeoutMs: 1_000 });

  assert.equal(result.block, false);
  assert.equal(result.reason, "external review allowed");
});

test("external review failures, missing hook, and timeout report unavailable", async (t) => {
  const { directory, hookPath } = await makeHook('#!/usr/bin/env bash\nsleep 10');
  t.after(() => rm(directory, { recursive: true, force: true }));

  const missing = await runExternalReview({ hookPath: join(directory, "missing"), cwd: directory, timeoutMs: 1_000, logPath: join(directory, "missing.log") });
  const timeout = await runExternalReview({ hookPath, cwd: directory, timeoutMs: 20, logPath: join(directory, "timeout.log") });

  assert.equal(missing.available, false);
  assert.equal(timeout.available, false);
  assert.match(timeout.reason, /timeout/i);
});

test("external review caps stderr and kills completed processes", async (t) => {
  const { directory, hookPath } = await makeHook(
    '#!/usr/bin/env bash\nprintf \'%4096s\' | tr \' \' x >&2\nprintf \'{"hookSpecificOutput":{"permissionDecision":"allow"}}\'',
  );
  t.after(() => rm(directory, { recursive: true, force: true }));

  const result = await runExternalReview({ hookPath, cwd: directory, timeoutMs: 1_000, maxBufferBytes: 128, logPath: join(directory, "gate.log") });

  assert.equal(result.block, false);
  assert.ok(result.stderr.length <= 128);
  assert.equal(result.timedOut, false);
});
