import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import * as doctor from "../scripts/doctor.mjs";
import { createManagedWorktree } from "../scripts/lib/worktree-lifecycle/managed-worktree.mjs";
import { markDisposition } from "../scripts/lib/worktree-lifecycle/registry.mjs";
const { inspectConfiguration, inspectGoalContractIntegrity } = doctor;
import { canonicalJsonSha256 } from "../scripts/lib/goal-contract/authorization-audit.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const GOAL_ENGINE_TOOL_NAMES = ["goal_init", "goal_status", "goal_dispatch", "goal_settle", "goal_accept", "goal_amend", "goal_integrate"];

async function inspectConfigurationWithValidatedVersions(root, options = {}) {
  const stateExisted = await goalEngineStateExists(root);
  const issues = await inspectConfiguration(root, {
    readPiVersion: async () => "0.82.1",
    readBasicMemoryVersion: async () => "0.22.1",
    ...options,
  });
  assert.equal(await goalEngineStateExists(root), stateExisted);
  return issues;
}

async function goalEngineStateExists(root) {
  try {
    await stat(join(root, ".state", "goal-engine"));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function createGoalEngineToolDefinition(name, options = {}) {
  const definition = {
    name,
    description: `${name} tool ABI fixture`,
    parameters: { type: "object", properties: {} },
  };
  if (options.exposeHandler) {
    definition.handler = async () => ({ status: "ok" });
  }
  if (options.includeExecute !== false) {
    definition.execute = () => {
      if (typeof options.onExecute === "function") {
        options.onExecute();
      }
      throw new Error("Goal Engine definition execute should not be invoked during ABI validation");
    };
  }
  return definition;
}

function createGoalEngineFactoryFixture({
  missingExecute,
  exposeHandlerFor,
  omitTools = [],
  extraTools = [],
  onFactory,
} = {}) {
  const omitted = new Set(omitTools);
  let callCount = 0;
  let executeCallCount = 0;
  const definitions = [];

  const registerDefinitions = (pi) => {
    for (const definition of definitions) {
      pi.registerTool(definition);
    }
    pi.on("tool_result", () => undefined);
  };

  const trackExecute = () => {
    executeCallCount += 1;
  };

  for (const name of GOAL_ENGINE_TOOL_NAMES) {
    if (omitted.has(name)) continue;
    definitions.push(createGoalEngineToolDefinition(name, {
      includeExecute: name !== missingExecute,
      exposeHandler: name === exposeHandlerFor,
      onExecute: trackExecute,
    }));
  }

  for (const name of extraTools) {
    definitions.push(createGoalEngineToolDefinition(name, {
      includeExecute: true,
      onExecute: trackExecute,
    }));
  }

  return {
    get called() {
      return callCount;
    },
    get executeCalls() {
      return executeCallCount;
    },
    factory(pi) {
      callCount += 1;
      if (typeof onFactory === "function") {
        return onFactory(pi, registerDefinitions);
      }
      return registerDefinitions(pi);
    },
  };
}

const isolatedSubagentPackage = {
  source: "npm:pi-subagents@0.45.2",
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
    await writeFile(join(root, "pi", "settings.json"), JSON.stringify({ packages: ["npm:pi-subagents@0.45.2"] }));
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
    for (const skill of ["external-llm-review", "git-commit-convention", "test-driven-development", "writing-skills", "writing-plans", "subagent-dispatch", "using-goal-engine", "exa-search", "playwright", "browser-auth-session", "goal-contract", "mac-mini-worker", "normandy-cli", "tbctx7"]) {
      await mkdir(join(root, "skill-overrides", skill), { recursive: true });
      await writeFile(join(root, "skill-overrides", skill, "SKILL.md"), `---\nname: ${skill}\ndescription: fixture\n---\n`);
    }
    await writeFile(
      join(root, "skill-overrides", "skills.list"),
      "external-llm-review\ngit-commit-convention\ntest-driven-development\nwriting-skills\nwriting-plans\nsubagent-dispatch\nusing-goal-engine\nexa-search\nplaywright\nbrowser-auth-session\n",
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
    await writeFile(join(root, "scripts", "pi-shell.zsh"), "");
    await mkdir(join(root, "scripts", "lib", "subagent-dispatch"), { recursive: true });
    for (const source of ["root-broker-server.ts", "root-broker-client.ts", "root-broker-protocol.ts", "root-broker-registry.ts"]) {
      await writeFile(join(root, "scripts", "lib", "subagent-dispatch", source), "");
    }
    await writeFile(join(root, "pi", "child-extensions", "root-session-owner.ts"), "");
    await writeFile(join(root, ".gitignore"), "/var/\n");
    for (const [name, model, tools] of [
      ["executor", "codex-pool/gpt-5.6-terra", "read"],
    ]) {
      await writeFile(join(root, "pi", "agents", `${name}.md`), `---\nmodel: ${model}\ntools: ${tools}\n---\n`);
    }
    await writeFile(
      join(root, "pi", "npm", "node_modules", "pi-subagents", "package.json"),
      JSON.stringify({ version: "0.45.2", pi: { extensions: ["./src/extension/index.ts"] } }),
    );
    await writeFile(join(root, "pi", "npm", "node_modules", "pi-subagents", "src", "extension", "index.ts"), "");
    await writeFile(join(root, "pi", "npm", "node_modules", "pi-subagents", "src", "extension", "rpc.ts"), 'const methods = ["ping", "status", "spawn", "steer", "interrupt", "stop", "resume"];\n');
    await writeFile(join(root, "pi", "npm", "node_modules", "typebox", "package.json"), JSON.stringify({ version: "1.1.38", type: "module", exports: { "./compile": "./build/compile/index.mjs" } }));
    await writeFile(join(root, "pi", "npm", "node_modules", "typebox", "build", "compile", "index.mjs"), "export {};\n");

    assert.deepEqual(await inspectConfiguration(root, { readPiVersion: async () => "0.82.1", readBasicMemoryVersion: async () => "0.22.1" }), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectConfiguration accepts additional valid local skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-"));
  try {
    const globalSkills = ["external-llm-review", "git-commit-convention", "test-driven-development", "writing-skills", "writing-plans", "subagent-dispatch", "using-goal-engine", "exa-search", "playwright", "browser-auth-session"];
    const localSkills = ["goal-contract", "mac-mini-worker", "normandy-cli", "tbctx7", "crash-analyzer-usage"];
    await mkdir(join(root, "skill-overrides"), { recursive: true });
    for (const skill of [...globalSkills, ...localSkills]) {
      await mkdir(join(root, "skill-overrides", skill), { recursive: true });
      await writeFile(join(root, "skill-overrides", skill, "SKILL.md"), `---\nname: ${skill}\ndescription: fixture\n---\n`);
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
    assert.ok(issues.includes("missing Pi package: pi-subagents@0.45.2"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectConfiguration ignores the retired local Skill list", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-"));
  try {
    await mkdir(join(root, "skill-overrides", "writing-plans"), { recursive: true });
    await writeFile(join(root, "skill-overrides", "skills.list"), "writing-plans\n");
    await writeFile(join(root, "skill-overrides", "skills.local.list"), "Bad_Name\n");
    await writeFile(join(root, "skill-overrides", "writing-plans", "SKILL.md"), "---\nname: writing-plans\ndescription: fixture\n---\n");
    await mkdir(join(root, "pi", "extensions"), { recursive: true });
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(join(root, "pi", "settings.json"), "{}");
    await writeFile(join(root, "pi", "extensions", "skill-whitelist.ts"), "");
    await writeFile(join(root, "scripts", "pi-shell.zsh"), "");

    const issues = await inspectConfiguration(root, { readPiVersion: async () => "0.82.1" });
    assert.equal(issues.some((issue) => issue.includes("Bad_Name")), false);
    assert.ok(issues.includes("unexpected Skill whitelist"));
    assert.ok(issues.includes("missing Pi package: pi-subagents@0.45.2"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectConfiguration reports malformed allowlisted Skill frontmatter and continues", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-"));
  try {
    await mkdir(join(root, "skill-overrides", "writing-plans"), { recursive: true });
    await writeFile(join(root, "skill-overrides", "skills.list"), "writing-plans\n");
    await writeFile(join(root, "skill-overrides", "writing-plans", "SKILL.md"), "# malformed\n");
    await mkdir(join(root, "pi", "extensions"), { recursive: true });
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(join(root, "pi", "settings.json"), "{}");
    await writeFile(join(root, "pi", "extensions", "skill-whitelist.ts"), "");
    await writeFile(join(root, "scripts", "pi-shell.zsh"), "");

    const issues = await inspectConfiguration(root, { readPiVersion: async () => "0.82.1" });
    assert.ok(issues.includes("invalid frontmatter for allowlisted skill: writing-plans: missing frontmatter"));
    assert.ok(issues.includes("unexpected Skill whitelist"));
    assert.ok(issues.includes("missing Pi package: pi-subagents@0.45.2"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectConfiguration reports boolean description frontmatter and continues", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-"));
  try {
    await mkdir(join(root, "skill-overrides", "writing-plans"), { recursive: true });
    await writeFile(join(root, "skill-overrides", "skills.list"), "writing-plans\n");
    await writeFile(join(root, "skill-overrides", "writing-plans", "SKILL.md"), "---\nname: writing-plans\ndescription: true\n---\n");
    await mkdir(join(root, "pi", "extensions"), { recursive: true });
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(join(root, "pi", "settings.json"), "{}");
    await writeFile(join(root, "pi", "extensions", "skill-whitelist.ts"), "");
    await writeFile(join(root, "scripts", "pi-shell.zsh"), "");

    const issues = await inspectConfiguration(root, { readPiVersion: async () => "0.82.1" });
    assert.ok(issues.includes("invalid frontmatter for allowlisted skill: writing-plans: unsupported string scalar"));
    assert.ok(issues.includes("unexpected Skill whitelist"));
    assert.ok(issues.includes("missing Pi package: pi-subagents@0.45.2"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectConfiguration reports the actual Pi executable version", async () => {
  const issues = await inspectConfiguration(repoRoot, { readPiVersion: async () => "0.80.9" });
  assert.ok(issues.includes("unexpected Pi version: 0.80.9; supported 0.82.0, 0.82.1, 0.83.0, 0.84.1"));
});

test("inspectConfiguration accepts every supported Pi version", async () => {
  for (const version of ["0.82.0", "0.82.1", "0.83.0", "0.84.1"]) {
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
    assert.ok(issues.includes("unexpected pi-subagents version: 0.35.1; expected 0.45.2"));
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
    await writeFile(join(root, "pi", "npm", "node_modules", "pi-subagents", "package.json"), JSON.stringify({ version: "0.45.2" }));

    const issues = await inspectConfiguration(root);
    assert.ok(issues.some((issue) => issue.startsWith("pi-subagents RPC probe failed:")));
    assert.ok(issues.includes("missing Pi package: typebox@1.1.38"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectConfiguration reports generic runtime contract gaps without requiring retired products", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-"));
  try {
    await mkdir(join(root, "skill-overrides"), { recursive: true });
    await writeFile(join(root, "skill-overrides", "skills.list"), "external-llm-review\n");
    await mkdir(join(root, "skill-overrides", "external-llm-review"), { recursive: true });
    await writeFile(join(root, "skill-overrides", "external-llm-review", "SKILL.md"), "---\nname: external-llm-review\ndescription: fixture\n---\n");
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
    await writeFile(join(root, "pi", "npm", "node_modules", "pi-subagents", "package.json"), JSON.stringify({ version: "0.45.2", pi: { extensions: ["./src/extension/index.ts"] } }));
    await writeFile(join(root, "pi", "npm", "node_modules", "pi-subagents", "src", "extension", "index.ts"), "");
    await writeFile(join(root, ".gitignore"), "/var/plan-runs/\n");

    const issues = await inspectConfiguration(root, { readPiVersion: async () => "unknown" });
    assert.ok(issues.includes("unexpected Pi version: unknown; supported 0.82.0, 0.82.1, 0.83.0, 0.84.1"));
    assert.ok(issues.includes("unexpected executor extension isolation"));
    assert.equal(issues.some((issue) => /plan-runner|plan-capsule|Plan child/.test(issue)), false);
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

test("Goal Engine tool ABI default factory does not report ABI issues", async () => {
  const issues = await inspectConfigurationWithValidatedVersions(repoRoot);
  assert.equal(
    issues.some((issue) => issue.includes("invalid Goal Engine tool ABI:")),
    false,
  );
});

test("Goal Engine tool ABI validator rejects missing execute", async () => {
  const fixture = createGoalEngineFactoryFixture({
    missingExecute: "goal_dispatch",
  });
  const issues = await inspectConfigurationWithValidatedVersions(repoRoot, {
    goalEngineFactory: fixture.factory,
  });
  assert.equal(fixture.called, 1);
  assert.equal(fixture.executeCalls, 0);
  assert.ok(issues.includes("invalid Goal Engine tool ABI: goal_dispatch"));
});

test("Goal Engine tool ABI validator rejects exposed handler", async () => {
  const fixture = createGoalEngineFactoryFixture({
    exposeHandlerFor: "goal_accept",
  });
  const issues = await inspectConfigurationWithValidatedVersions(repoRoot, {
    goalEngineFactory: fixture.factory,
  });
  assert.equal(fixture.called, 1);
  assert.equal(fixture.executeCalls, 0);
  assert.ok(issues.includes("invalid Goal Engine tool ABI: goal_accept"));
});

test("Goal Engine tool ABI validator requires exact tool set (missing)", async () => {
  const fixture = createGoalEngineFactoryFixture({
    omitTools: ["goal_status"],
  });
  const issues = await inspectConfigurationWithValidatedVersions(repoRoot, {
    goalEngineFactory: fixture.factory,
  });
  assert.equal(fixture.called, 1);
  assert.equal(fixture.executeCalls, 0);
  assert.ok(issues.includes("invalid Goal Engine tool ABI: goal_status"));
});

test("Goal Engine tool ABI validator requires exact tool set (extra)", async () => {
  const fixture = createGoalEngineFactoryFixture({
    extraTools: ["goal_surprise"],
  });
  const issues = await inspectConfigurationWithValidatedVersions(repoRoot, {
    goalEngineFactory: fixture.factory,
  });
  assert.equal(fixture.called, 1);
  assert.equal(fixture.executeCalls, 0);
  assert.ok(issues.includes("invalid Goal Engine tool ABI: goal_surprise"));
});

test("Goal Engine tool ABI validator rejects duplicated tools", async () => {
  const fixture = createGoalEngineFactoryFixture({
    extraTools: ["goal_accept"],
  });
  const issues = await inspectConfigurationWithValidatedVersions(repoRoot, {
    goalEngineFactory: fixture.factory,
  });
  assert.equal(fixture.called, 1);
  assert.equal(fixture.executeCalls, 0);
  assert.equal(
    issues.filter((issue) => issue === "invalid Goal Engine tool ABI: goal_accept").length,
    1,
  );
});

test("Goal Engine tool ABI validator reports factory failures (sync)", async () => {
  const fixture = createGoalEngineFactoryFixture({
    onFactory: () => {
      throw new Error("sync factory failure");
    },
  });
  const issues = await inspectConfigurationWithValidatedVersions(repoRoot, {
    goalEngineFactory: fixture.factory,
  });
  assert.equal(fixture.called, 1);
  assert.equal(fixture.executeCalls, 0);
  assert.ok(issues.includes("invalid Goal Engine tool ABI: factory"));
});

test("Goal Engine tool ABI validator reports factory failures (async)", async () => {
  const fixture = createGoalEngineFactoryFixture({
    onFactory: async () => {
      await Promise.resolve();
      throw new Error("async factory failure");
    },
  });
  const issues = await inspectConfigurationWithValidatedVersions(repoRoot, {
    goalEngineFactory: fixture.factory,
  });
  assert.equal(fixture.called, 1);
  assert.equal(fixture.executeCalls, 0);
  assert.ok(issues.includes("invalid Goal Engine tool ABI: factory"));
});

test("Goal Engine tool ABI validator awaits async factory registration", async () => {
  let factoryResumed = false;
  const fixture = createGoalEngineFactoryFixture({
    onFactory: async (pi, registerDefinitions) => {
      await Promise.resolve();
      registerDefinitions(pi);
      factoryResumed = true;
    },
  });
  const issues = await inspectConfigurationWithValidatedVersions(repoRoot, {
    goalEngineFactory: fixture.factory,
  });
  assert.equal(fixture.called, 1);
  assert.equal(fixture.executeCalls, 0);
  assert.equal(factoryResumed, true);
  assert.equal(issues.some((issue) => issue.includes("invalid Goal Engine tool ABI:")), false);
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

test("RED worktree lifecycle doctor warnings are stable, redacted, and not readiness issues", async () => {
  const format = doctor.formatWorktreeLifecycleWarnings;
  assert.equal(typeof format, "function", "doctor must export formatWorktreeLifecycleWarnings");
  const warnings = format({ items: [
    { code: "WORKTREE_CLEANUP_DEBT", resources: "001", path: "/safe", ownerToken: "secret", owner: "owner", lastError: "error", probe: "probe" },
    { code: null, resources: "111", path: "/ignored" },
  ] });
  assert.deepEqual(warnings, ["[warning] WORKTREE_CLEANUP_DEBT 001 /safe"]);
  assert.equal(JSON.stringify(warnings).match(/secret|owner|error|probe/), null);
  const root = await mkdtemp(join(tmpdir(), "doctor-worktree-"));
  try {
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init", "--initial-branch=main"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test"); await writeFile(join(root, "a"), "a\n"); git("add", "a"); git("commit", "-m", "initial");
    const allocation = createManagedWorktree({ originRoot: root, id: "safe", branch: "safe", baseCommit: git("rev-parse", "HEAD"), owner: { kind: "test", id: "one" } });
    markDisposition({ originRoot: root, id: allocation.id, ownerToken: allocation.ownerToken, disposition: "reclaimable" });
    const report = await doctor.inspectWorktreeLifecycle(root); const item = report.items.find((entry) => entry.id === allocation.id);
    assert.equal(report.apply, false); assert.deepEqual([item.code, item.automaticAction], ["WORKTREE_CLEANUP_DEBT", "release-worktree-only"]); assert.equal(item.path, allocation.path); assert.equal(git("show-ref", "--verify", "--quiet", allocation.branchRef), "");
    const issues = await inspectConfigurationWithValidatedVersions(repoRoot);
    assert.equal(issues.some((issue) => issue.includes("WORKTREE_")), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("doctor CLI reports Root broker readiness without retired Host terminology", async () => {
  const result = await runDoctor();
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /Root subagent broker: ready/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Standalone|detached|thin Host/i);
});
