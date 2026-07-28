import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dp3Cli = join(repoRoot, "skill-overrides", "dp3-mcp", "scripts", "dp3-mcp");

function run(command, args, env) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

async function withFakeUm(callback, { authFails = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "mcp-skill-cli-"));
  const bin = join(root, "bin");
  const log = join(root, "um-calls.log");
  await mkdir(bin);
  await writeFile(
    join(bin, "um"),
    `#!/usr/bin/env bash\nset -eu\nprintf '%s\\n' "$*" >> "$UM_CALL_LOG"\nif [ "\${1:-}" = whoami ]; then\n  [ "\${UM_AUTH_FAIL:-0}" = 0 ] || exit 1\n  printf 'authenticated-user\\n'\n  exit 0\nfi\nprintf '{"ok":true}\\n'\n`,
    { mode: 0o700 },
  );
  const input = join(root, "input.json");
  await writeFile(input, "{}\n", { mode: 0o600 });
  try {
    await callback({
      input,
      log,
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: root,
        UM_CALL_LOG: log,
        UM_AUTH_FAIL: authFails ? "1" : "0",
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function callLog(path) {
  return (await readFile(path, "utf8")).trim().split("\n");
}

test("dp3 list performs auth preflight and fixes server, env, transport, and JSON output", async () => {
  await withFakeUm(async ({ env, log }) => {
    const result = await run("bash", [dp3Cli, "list"], env);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await callLog(log), [
      "whoami",
      "tmcp client list-tool -s tiga-ssot-dp3 --env pre --transport streamable -f json",
    ]);
  });
});

test("dp3 call forwards only a validated tool name and absolute input file", async () => {
  await withFakeUm(async ({ env, input, log }) => {
    const result = await run(
      "bash",
      [dp3Cli, "--env", "prod", "call", "dp3-event-data-search", input],
      env,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await callLog(log), [
      "whoami",
      `tmcp client call-tool -s tiga-ssot-dp3 --env prod --transport streamable --tool dp3-event-data-search --input @${input} --buc auto -f json --no-trace-id`,
    ]);
  });
});

test("dp3 rejects inline JSON before invoking um", async () => {
  await withFakeUm(async ({ env, log }) => {
    const result = await run(
      "bash",
      [dp3Cli, "call", "dp3-event-data-search", "{}"],
      env,
    );
    assert.equal(result.code, 2);
    await assert.rejects(readFile(log, "utf8"), /ENOENT/);
  });
});

test("dp3 stops after failed um authentication preflight", async () => {
  await withFakeUm(async ({ env, log }) => {
    const result = await run("bash", [dp3Cli, "list"], env);
    assert.equal(result.code, 3);
    assert.match(result.stderr, /tmcp skill/);
    assert.deepEqual(await callLog(log), ["whoami"]);
  }, { authFails: true });
});

const dp3Skill = join(repoRoot, "skill-overrides", "dp3-mcp", "SKILL.md");
const localSkillList = join(repoRoot, "skill-overrides", "skills.local.list");

test("dp3 skill declares tmcp as its external authentication dependency", async () => {
  const skill = await readFile(dp3Skill, "utf8");
  assert.match(skill, /external-skill:\s*tmcp/);
  assert.match(skill, /REQUIRED EXTERNAL SKILL.*`tmcp`/);
  assert.match(skill, /authentication.*`tmcp` Skill/i);
  assert.match(skill, /lifecycle.*`um tmcp client`/i);
  assert.match(skill, /closes on normal completion/i);
  assert.match(skill, /upstream errors.*protocol-level close/is);
  assert.match(skill, /raw stdout.*model context/i);
  assert.match(skill, /no response sanitizer/i);
  assert.match(skill, /exclusion is impossible.*do not call from Pi/is);
  assert.match(skill, /do not predict.*field names/i);
  assert.match(skill, /success.*without `data`.*incomplete/is);
  assert.doesNotMatch(skill, /Each command opens and closes/);
  assert.doesNotMatch(skill, /Authorization:|Bearer\s+[A-Za-z0-9]/);
});

test("dp3 skill is enabled in the local allowlist", async () => {
  const names = (await readFile(localSkillList, "utf8")).split(/\r?\n/);
  assert.ok(names.includes("dp3-mcp"));
});

const crashCli = join(repoRoot, "skill-overrides", "crash-mcp", "scripts", "crash-mcp");

test("crash list performs auth preflight and fixes server, env, transport, and JSON output", async () => {
  await withFakeUm(async ({ env, log }) => {
    const result = await run("bash", [crashCli, "list"], env);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await callLog(log), [
      "whoami",
      "tmcp client list-tool -s tiga-ssot-crash --env pre --transport streamable -f json",
    ]);
  });
});

test("crash describe uses auto BUC handling without exposing header controls", async () => {
  await withFakeUm(async ({ env, log }) => {
    const tool = "motu_querySimpleReportRecordPage";
    const result = await run("bash", [crashCli, "describe", tool], env);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await callLog(log), [
      "whoami",
      `tmcp client call-tool -s tiga-ssot-crash --env pre --transport streamable --tool ${tool} --describe --buc auto -f json --no-trace-id`,
    ]);
  });
});

test("crash rejects unsupported environment before authentication", async () => {
  await withFakeUm(async ({ env, log }) => {
    const result = await run("bash", [crashCli, "--env", "staging", "list"], env);
    assert.equal(result.code, 2);
    await assert.rejects(readFile(log, "utf8"), /ENOENT/);
  });
});

test("crash call requires an absolute input file", async () => {
  await withFakeUm(async ({ env, log }) => {
    const result = await run(
      "bash",
      [crashCli, "call", "motu_querySimpleReportRecordPage", "relative.json"],
      env,
    );
    assert.equal(result.code, 2);
    await assert.rejects(readFile(log, "utf8"), /ENOENT/);
  });
});

const crashSkill = join(repoRoot, "skill-overrides", "crash-mcp", "SKILL.md");

test("crash skill declares tmcp as its external authentication dependency", async () => {
  const skill = await readFile(crashSkill, "utf8");
  assert.match(skill, /external-skill:\s*tmcp/);
  assert.match(skill, /REQUIRED EXTERNAL SKILL.*`tmcp`/);
  assert.match(skill, /authentication.*`tmcp` Skill/i);
  assert.match(skill, /lifecycle.*`um tmcp client`/i);
  assert.match(skill, /closes on normal completion/i);
  assert.match(skill, /upstream errors.*protocol-level close/is);
  assert.match(skill, /raw stdout.*model context/i);
  assert.match(skill, /no response sanitizer/i);
  assert.match(skill, /exclusion is impossible.*do not call.*from Pi/is);
  assert.match(skill, /PII.*signed URL/is);
  assert.match(skill, /do not call that tool from Pi/i);
  assert.match(skill, /crash-analyzer-usage/);
  assert.doesNotMatch(skill, /before storing or modeling/i);
  assert.doesNotMatch(skill, /Each command opens and closes/);
  assert.doesNotMatch(skill, /Authorization:|Bearer\s+[A-Za-z0-9]/);
});

test("crash skill is enabled in the local allowlist", async () => {
  const names = (await readFile(localSkillList, "utf8")).split(/\r?\n/);
  assert.ok(names.includes("crash-mcp"));
});
