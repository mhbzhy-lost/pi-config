import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { inspectConfiguration, inspectGoalContractIntegrity } from "../scripts/doctor.mjs";
import { canonicalJsonSha256 } from "../scripts/lib/goal-contract/authorization-audit.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const isolatedSubagentPackage = {
  source: "npm:pi-subagents@0.37.2",
  extensions: [],
  skills: [],
  prompts: [],
  themes: [],
};

function runDoctor() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/doctor.mjs"], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      settle(reject, new Error("doctor CLI timed out after 10000ms"));
    }, 10_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => settle(reject, error));
    child.on("close", (code, signal) => settle(resolve, { code, signal, stdout, stderr }));
  });
}

test("inspectConfiguration rejects pi-subagents package resource autoload", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-"));
  try {
    await mkdir(join(root, "skill-overrides"), { recursive: true });
    await writeFile(join(root, "skill-overrides", "skills.list"), "");
    await mkdir(join(root, "pi", "extensions"), { recursive: true });
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(join(root, "pi", "settings.json"), JSON.stringify({ packages: ["npm:pi-subagents@0.37.2"] }));
    await writeFile(join(root, "pi", "extensions", "skill-whitelist.ts"), "");
    await writeFile(join(root, "scripts", "pi-shell.zsh"), "");

    const issues = await inspectConfiguration(root, { readPiVersion: async () => "0.82.1" });
    assert.ok(issues.includes("pi-subagents package resources must all be disabled"));
    assert.ok(issues.includes("missing typed subagent runtime extension: pi/extensions/subagent-runtime.ts"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectConfiguration accepts a configured pi-subagents package", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-"));
  try {
    await mkdir(join(root, "skill-overrides"), { recursive: true });
    for (const skill of ["external-llm-review", "git-commit-convention", "test-driven-development", "writing-skills", "writing-plans", "plan-runner-dispatch", "subagent-dispatch", "exa-search", "playwright", "browser-auth-session", "goal-contract", "mac-mini-worker", "normandy-cli", "tbctx7"]) {
      await mkdir(join(root, "skill-overrides", skill), { recursive: true });
      await writeFile(join(root, "skill-overrides", skill, "SKILL.md"), "# test\n");
    }
    await writeFile(
      join(root, "skill-overrides", "skills.list"),
      "external-llm-review\ngit-commit-convention\ntest-driven-development\nwriting-skills\nwriting-plans\nplan-runner-dispatch\nsubagent-dispatch\nexa-search\nplaywright\nbrowser-auth-session\n",
    );
    await writeFile(
      join(root, "skill-overrides", "skills.local.list"),
      "goal-contract\nmac-mini-worker\nnormandy-cli\ntbctx7\n",
    );
    await mkdir(join(root, "pi", "extensions"), { recursive: true });
    await mkdir(join(root, "pi", "agents"), { recursive: true });
    await mkdir(join(root, "pi", "npm", "node_modules", "pi-subagents", "src", "extension"), { recursive: true });
    await mkdir(join(root, "pi", "npm", "node_modules", "typebox", "build", "compile"), { recursive: true });
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(join(root, "pi", "settings.json"), JSON.stringify({
      theme: "light",
      packages: [isolatedSubagentPackage],
    }));
    await writeFile(join(root, "pi", "extensions", "skill-whitelist.ts"), "");
    await writeFile(join(root, "pi", "extensions", "subagent-runtime.ts"), "");
    await mkdir(join(root, "pi", "child-extensions"), { recursive: true });
    await writeFile(join(root, "pi", "child-extensions", "plan-capsule.ts"), "");
    await writeFile(join(root, "pi", "extensions", "plan-launcher.ts"), "");
    await writeFile(join(root, "pi", "child-extensions", "plan-runner.ts"), "");
    await writeFile(join(root, "scripts", "pi-shell.zsh"), "");
    await mkdir(join(root, "scripts", "lib", "subagent-dispatch"), { recursive: true });
    for (const source of ["root-broker-server.ts", "root-broker-client.ts", "root-broker-protocol.ts", "root-broker-registry.ts"]) {
      await writeFile(join(root, "scripts", "lib", "subagent-dispatch", source), "");
    }
    await writeFile(join(root, "pi", "child-extensions", "root-session-owner.ts"), "");
    await writeFile(join(root, ".gitignore"), "/var/\n");
    for (const [name, model, tools] of [
      ["executor", "codex-pool/gpt-5.6-terra", "read"],
      ["spark", "codex-pool/gpt-5.3-codex-spark", "read"],
      ["plan-runner", "codex-pool/gpt-5.6-sol", "plan_open,plan_status,plan_continue,plan_verify,plan_block,plan_read_revision,plan_amend,read"],
      ["plan-reviewer", "codex-pool/gpt-5.6-sol", "read"],
    ]) {
      const childExtension = name === "plan-runner" ? "subagentOnlyExtensions: .pi-subagents/plan-runner-entry.mjs\n" : "";
      await writeFile(join(root, "pi", "agents", `${name}.md`), `---\nmodel: ${model}\n${childExtension}tools: ${tools}\n---\n`);
    }
    await writeFile(
      join(root, "pi", "npm", "node_modules", "pi-subagents", "package.json"),
      JSON.stringify({ version: "0.37.2", pi: { extensions: ["./src/extension/index.ts"] } }),
    );
    await writeFile(join(root, "pi", "npm", "node_modules", "pi-subagents", "src", "extension", "index.ts"), "");
    await writeFile(join(root, "pi", "npm", "node_modules", "pi-subagents", "src", "extension", "rpc.ts"), 'const methods = ["ping", "status", "spawn", "steer", "interrupt", "stop", "resume"];\n');
    await writeFile(join(root, "pi", "npm", "node_modules", "typebox", "package.json"), JSON.stringify({ version: "1.1.38", type: "module", exports: { "./compile": "./build/compile/index.mjs" } }));
    await writeFile(join(root, "pi", "npm", "node_modules", "typebox", "build", "compile", "index.mjs"), "export {};\n");

    assert.deepEqual(await inspectConfiguration(root, { readPiVersion: async () => "0.82.1", readBasicMemoryVersion: async () => "0.22.1" }), []);

    const runnerPath = join(root, "pi", "agents", "plan-runner.md");
    for (const tool of ["subagent", "subagent_wait", "subagent_supervisor", "plan_executor_supervisor"]) {
      await writeFile(
        runnerPath,
        `---\nmodel: codex-pool/gpt-5.6-sol\nsubagentOnlyExtensions: .pi-subagents/plan-runner-entry.mjs\ntools: plan_open,plan_status,plan_continue,plan_verify,plan_block,plan_read_revision,plan_amend,read,${tool}\n---\n`,
      );
      const issues = await inspectConfiguration(root, { readPiVersion: async () => "0.82.1", readBasicMemoryVersion: async () => "0.22.1" });
      assert.ok(issues.includes(`forbidden plan-runner control tool: ${tool}`));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectConfiguration accepts additional valid local skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-"));
  try {
    const globalSkills = ["external-llm-review", "git-commit-convention", "test-driven-development", "writing-skills", "writing-plans", "plan-runner-dispatch", "subagent-dispatch", "exa-search", "playwright", "browser-auth-session"];
    const localSkills = ["goal-contract", "mac-mini-worker", "normandy-cli", "tbctx7", "crash-analyzer-usage"];
    await mkdir(join(root, "skill-overrides"), { recursive: true });
    for (const skill of [...globalSkills, ...localSkills]) {
      await mkdir(join(root, "skill-overrides", skill), { recursive: true });
      await writeFile(join(root, "skill-overrides", skill, "SKILL.md"), "# test\n");
    }
    await writeFile(join(root, "skill-overrides", "skills.list"), `${globalSkills.join("\n")}\n`);
    await writeFile(join(root, "skill-overrides", "skills.local.list"), `${localSkills.join("\n")}\n`);

    const issues = await inspectConfiguration(root, {
      readPiVersion: async () => "0.82.1",
      readBasicMemoryVersion: async () => "0.22.1",
    });

    assert.equal(issues.includes("unexpected Skill whitelist"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectConfiguration requires every Root broker readiness component", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-"));
  try {
    await mkdir(join(root, "skill-overrides"), { recursive: true });
    await writeFile(join(root, "skill-overrides", "skills.list"), "");
    await mkdir(join(root, "pi", "extensions"), { recursive: true });
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(join(root, "pi", "settings.json"), "{}");
    await writeFile(join(root, "pi", "extensions", "skill-whitelist.ts"), "");
    await writeFile(join(root, "scripts", "pi-shell.zsh"), "");

    const issues = await inspectConfiguration(root, { readPiVersion: async () => "0.82.1" });
    assert.ok(issues.includes("missing Root subagent broker component: scripts/lib/subagent-dispatch/root-broker-server.ts"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi config root does not contain an auto-discovered skills directory", async () => {
  const issues = await inspectConfiguration(repoRoot);
  assert.equal(issues.includes(`unexpected auto-discovery directory: ${join(repoRoot, "pi", "skills")}`), false);
});

test("inspectConfiguration reports missing pi-subagents package", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-"));
  try {
    await mkdir(join(root, "skill-overrides"), { recursive: true });
    await writeFile(join(root, "skill-overrides", "skills.list"), "");
    await mkdir(join(root, "pi", "extensions"), { recursive: true });
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(join(root, "pi", "settings.json"), "{}");
    await writeFile(join(root, "pi", "extensions", "skill-whitelist.ts"), "");
    await writeFile(join(root, "scripts", "pi-shell.zsh"), "");

    const issues = await inspectConfiguration(root, { readPiVersion: async () => "unknown" });
    assert.ok(issues.includes("missing Pi package: pi-subagents@0.37.2"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectConfiguration reports the actual Pi executable version", async () => {
  const issues = await inspectConfiguration(repoRoot, { readPiVersion: async () => "0.80.9" });
  assert.ok(issues.includes("unexpected Pi version: 0.80.9; supported 0.82.0, 0.82.1, 0.83.0"));
});

test("inspectConfiguration accepts every supported Pi version", async () => {
  for (const version of ["0.82.0", "0.82.1", "0.83.0"]) {
    const issues = await inspectConfiguration(repoRoot, { readPiVersion: async () => version });
    assert.equal(issues.some((issue) => issue.startsWith("unexpected Pi version:")), false);
  }
});

test("inspectConfiguration reports an unexpected pi-subagents version", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-"));
  try {
    await mkdir(join(root, "skill-overrides"), { recursive: true });
    await writeFile(join(root, "skill-overrides", "skills.list"), "");
    await mkdir(join(root, "pi", "extensions"), { recursive: true });
    await mkdir(join(root, "pi", "npm", "node_modules", "pi-subagents"), { recursive: true });
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(join(root, "pi", "settings.json"), "{}");
    await writeFile(join(root, "pi", "extensions", "skill-whitelist.ts"), "");
    await writeFile(join(root, "scripts", "pi-shell.zsh"), "");
    await writeFile(join(root, "pi", "npm", "node_modules", "pi-subagents", "package.json"), JSON.stringify({ version: "0.35.1" }));

    const issues = await inspectConfiguration(root);
    assert.ok(issues.includes("unexpected pi-subagents version: 0.35.1; expected 0.37.2"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectConfiguration reports a failed pi-subagents RPC probe", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-"));
  try {
    await mkdir(join(root, "skill-overrides"), { recursive: true });
    await writeFile(join(root, "skill-overrides", "skills.list"), "");
    await mkdir(join(root, "pi", "extensions"), { recursive: true });
    await mkdir(join(root, "pi", "npm", "node_modules", "pi-subagents"), { recursive: true });
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(join(root, "pi", "settings.json"), "{}");
    await writeFile(join(root, "pi", "extensions", "skill-whitelist.ts"), "");
    await writeFile(join(root, "scripts", "pi-shell.zsh"), "");
    await writeFile(join(root, "pi", "npm", "node_modules", "pi-subagents", "package.json"), JSON.stringify({ version: "0.37.2" }));

    const issues = await inspectConfiguration(root);
    assert.ok(issues.some((issue) => issue.startsWith("pi-subagents RPC probe failed:")));
    assert.ok(issues.includes("missing Pi package: typebox@1.1.38"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectConfiguration reports the final plan execution contract gaps", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-"));
  try {
    await mkdir(join(root, "skill-overrides"), { recursive: true });
    await writeFile(join(root, "skill-overrides", "skills.list"), "external-llm-review\n");
    await mkdir(join(root, "skill-overrides", "external-llm-review"), { recursive: true });
    await writeFile(join(root, "skill-overrides", "external-llm-review", "SKILL.md"), "# test\n");
    await mkdir(join(root, "pi", "extensions"), { recursive: true });
    await mkdir(join(root, "pi", "agents"), { recursive: true });
    await mkdir(join(root, "pi", "npm", "node_modules", "pi-subagents", "src", "extension"), { recursive: true });
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(join(root, "pi", "settings.json"), "{}");
    await writeFile(join(root, "pi", "extensions", "skill-whitelist.ts"), "");
    await writeFile(join(root, "pi", "agents", "executor.md"), "---\nmodel: codex-pool/gpt-5.6-sol\nextensions: pi/extensions/provider-fallback.ts\ntools: read\n---\n");
    await writeFile(join(root, "scripts", "pi-shell.zsh"), "");
    await mkdir(join(root, "scripts", "lib"), { recursive: true });
    await writeFile(join(root, "scripts", "lib", "subagent-jobs.mjs"), "legacy\n");
    await writeFile(join(root, "pi", "npm", "node_modules", "pi-subagents", "package.json"), JSON.stringify({ version: "0.37.2", pi: { extensions: ["./src/extension/index.ts"] } }));
    await writeFile(join(root, "pi", "npm", "node_modules", "pi-subagents", "src", "extension", "index.ts"), "");
    await writeFile(join(root, ".gitignore"), "/var/plan-runs/\n");

    const issues = await inspectConfiguration(root, { readPiVersion: async () => "unknown" });
    assert.ok(issues.includes("unexpected Pi version: unknown; supported 0.82.0, 0.82.1, 0.83.0"));
    assert.ok(issues.includes("unexpected executor extension isolation"));
    assert.ok(issues.includes("missing required agent profile: plan-runner"));
    assert.ok(issues.includes("missing required Plan child extension: pi/child-extensions/plan-capsule.ts"));
    assert.ok(issues.includes("missing required Plan child extension: pi/child-extensions/plan-runner.ts"));
    assert.ok(issues.includes("unexpected Skill whitelist"));
    assert.ok(issues.includes("runtime namespace is not ignored: /var/"));
    assert.ok(issues.includes("legacy Task 7 runtime still exists: scripts/lib/subagent-jobs.mjs"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports issue when basic-memory version is wrong", async () => {
  const issues = await inspectConfiguration(repoRoot, {
    readPiVersion: async () => "0.82.1",
    readBasicMemoryVersion: async () => "0.20.0",
  });
  assert.ok(issues.some((i) => i.includes("basic-memory") && i.includes("0.22.1")));
});

test("reports issue when basic-memory is not installed", async () => {
  const issues = await inspectConfiguration(repoRoot, {
    readPiVersion: async () => "0.82.1",
    readBasicMemoryVersion: async () => "unknown",
  });
  assert.ok(issues.some((i) => i.includes("basic-memory")));
});

test("no issue when basic-memory version matches", async () => {
  const issues = await inspectConfiguration(repoRoot, {
    readPiVersion: async () => "0.82.1",
    readBasicMemoryVersion: async () => "0.22.1",
  });
  assert.ok(!issues.some((i) => i.includes("basic-memory")));
});

test("doctor validates Goal Contract integrity for registered goals", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-goal-contract-"));
  try {
    const goalRoot = join(root, ".state", "goal-contract", "goals", "g1");
    await mkdir(goalRoot, { recursive: true });
    await writeFile(
      join(root, ".state", "goal-contract", "registry.json"),
      JSON.stringify({
        schema_version: "goal_contract.registry.v1",
        state_root: ".state/goal-contract",
        active_goal_ids: ["g1"],
        goals: { g1: { contract_dir: ".state/goal-contract/goals/g1" } },
      }),
    );
    const practiceProfile = { schema_version: "goal_contract.practice_profile.v1" };
    const digest = canonicalJsonSha256(practiceProfile);
    await writeFile(
      join(goalRoot, "state.json"),
      JSON.stringify({ practice_profile: practiceProfile, practice_profile_sha256: digest }),
    );
    await writeFile(
      join(goalRoot, "goal-contract.md"),
      `# Goal\n\nPractice-Profile-SHA256: ${digest}\n`,
    );
    await writeFile(join(goalRoot, "authorization-evidence.json"), "{}\n");
    await writeFile(
      join(goalRoot, "amendments.jsonl"),
      `${JSON.stringify({
        status: "applied",
        risk: "high",
        authorization: {
          artifact: "authorization-evidence.json",
          artifactSha256: "0".repeat(64),
        },
      })}\n`,
    );

    const issues = await inspectGoalContractIntegrity(root);

    assert.ok(issues.some((issue) => issue.includes("artifact hash mismatch")), issues);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor accepts current registered Goal Contract integrity", async () => {
  assert.deepEqual(await inspectGoalContractIntegrity(repoRoot), []);
});

test("doctor CLI reports Root broker readiness without retired Host terminology", async () => {
  const result = await runDoctor();
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /Root subagent broker: ready/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Standalone|detached|thin Host/i);
});
