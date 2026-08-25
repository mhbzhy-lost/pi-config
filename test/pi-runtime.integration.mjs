import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";

import { discoverManagedSkills } from "../scripts/lib/skill-whitelist.mjs";
import { resolvePiCodingAgentRoot } from "./helpers/pi-runtime.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shellIntegration = join(repoRoot, "scripts", "pi-shell.zsh");
const piBinary = process.env.PI_REAL_BIN;
const piRoot = resolvePiCodingAgentRoot();
const piPackage = join(piRoot, "dist", "index.js");
const piTypes = join(piRoot, "dist", "core", "extensions", "types.d.ts");

test("installed Pi SessionManager preserves custom → compaction → real user branch fields", async () => {
  const { SessionManager } = await import(piPackage);
  const manager = SessionManager.inMemory(repoRoot);
  const intentId = manager.appendCustomEntry("goal-engine-runtime-approval-intent", { protocol: "goal-engine-runtime-approval-intent.v1" });
  const compactionId = manager.appendCompaction("Pi summary", intentId, 1);
  const userEntryId = manager.appendMessage({ role: "user", content: "approve", timestamp: Date.now() });
  const branch = manager.getBranch();
  const [intent, compaction, user] = branch;
  assert.equal(intentId, intent.id);
  assert.equal(compactionId, compaction.id);
  assert.equal(userEntryId, user.id);
  assert.equal(compaction.type, "compaction");
  assert.equal(compaction.parentId, intent.id);
  assert.equal(user.parentId, compaction.id);
  assert.equal(user.message.role, "user");
  const declarations = await (await import("node:fs/promises")).readFile(piTypes, "utf8");
  const inputEvent = declarations.match(/interface InputEvent \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(inputEvent, "installed Pi must declare InputEvent");
  assert.match(inputEvent, /text: string;/);
  assert.match(inputEvent, /source: InputSource;/);
  for (const forbidden of ["entryId", "sessionId", "occurredAt"]) assert.doesNotMatch(inputEvent, new RegExp(`\\b${forbidden}\\b`));
});

test("real Pi Host model mutation keeps defaults session-only unless persist is explicit", async () => {
  const canary = await runModelPersistenceCanary(piRoot);
  assert.equal(canary.defaultBefore, "model-a");
  assert.equal(canary.defaultAfterSessionOnly, "model-a");
  assert.equal(canary.defaultAfterPersist, "model-b");
});

async function runModelPersistenceCanary(hostRoot) {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-model-persistence-agent-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-model-persistence-cwd-"));
  let session;
  try {
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "model-a" }));
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {
      fake: {
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "not-used",
        models: [
          { id: "model-a", name: "Fake model A", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 256 },
          { id: "model-b", name: "Fake model B", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 256 },
        ],
      },
    } }));

    const host = await import(pathToFileURL(join(hostRoot, "dist", "index.js")).href);
    const settingsManager = host.SettingsManager.create(cwd, agentDir);
    const resourceLoader = new host.DefaultResourceLoader({
      cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await resourceLoader.reload();
    const modelRuntime = await host.ModelRuntime.create({
      authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
      allowModelNetwork: false, refreshOnCreate: false,
    });
    assert.deepEqual(modelRuntime.getModels("fake").map((model) => model.id).sort(), ["model-a", "model-b"]);
    const modelA = modelRuntime.getModel("fake", "model-a");
    const modelB = modelRuntime.getModel("fake", "model-b");
    assert.ok(modelA && modelB, "temporary provider must register fake/model-a and fake/model-b");
    ({ session } = await host.createAgentSession({
      cwd, agentDir, settingsManager, resourceLoader, modelRuntime, model: modelA,
      sessionManager: host.SessionManager.create(cwd, join(agentDir, "sessions")), noTools: "all",
    }));

    const defaultBefore = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")).defaultModel;
    await session.setModel(modelB);
    await settingsManager.flush();
    const defaultAfterSessionOnly = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")).defaultModel;
    await session.setModel(modelB, { persist: true });
    await settingsManager.flush();
    const defaultAfterPersist = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")).defaultModel;
    return { defaultBefore, defaultAfterSessionOnly, defaultAfterPersist };
  } finally {
    session?.dispose();
    await rm(agentDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
}

test("real Pi Host session_start provider fallback switches only the current session", async () => {
  const canary = await runProviderFallbackCanary(piRoot);
  assert.equal(canary.requests, 1, "the reachable fallback must be probed with one local HEAD request");
  assert.deepEqual(canary.currentModel, { provider: "openai-codex", id: "gpt-5.6-sol" });
  assert.deepEqual(canary.persistedDefaults, { provider: "primary", model: "primary-model" });
});

async function runProviderFallbackCanary(hostRoot) {
  const configRoot = await mkdtemp(join(tmpdir(), "pi-provider-fallback-config-"));
  const agentDir = join(configRoot, "pi");
  const cwd = await mkdtemp(join(tmpdir(), "pi-provider-fallback-cwd-"));
  const server = createServer((request, response) => {
    assert.equal(request.method, "HEAD");
    response.writeHead(204);
    response.end();
  });
  let session;
  let listening = false;
  let requests = 0;
  server.on("request", () => { requests += 1; });
  try {
    await mkdir(agentDir, { recursive: true });
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", () => { server.off("error", rejectListen); listening = true; resolveListen(); });
    });
    const { port } = server.address();
    const models = { providers: {
      primary: { api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", apiKey: "not-used", models: [model("primary-model", "Primary model")] },
      "openai-codex": { api: "openai-completions", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "not-used", models: [model("gpt-5.6-sol", "Fallback model")] },
    } };
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "primary", defaultModel: "primary-model" }));
    await writeFile(join(agentDir, "models.json"), JSON.stringify(models));
    await writeFile(join(agentDir, "auth.json"), JSON.stringify({
      primary: { type: "api_key", key: "not-used" },
      "openai-codex": { type: "api_key", key: "not-used" },
    }));
    const wrapper = join(agentDir, "provider-fallback-canary.mjs");
    await writeFile(wrapper, `import { createProviderFallbackExtension } from ${JSON.stringify(pathToFileURL(join(repoRoot, "scripts", "lib", "provider-fallback-extension.mjs")).href)};\nexport default (pi) => createProviderFallbackExtension(pi, { configRoot: ${JSON.stringify(configRoot)} });\n`);

    const host = await import(pathToFileURL(join(hostRoot, "dist", "index.js")).href);
    const settingsManager = host.SettingsManager.create(cwd, agentDir);
    const resourceLoader = new host.DefaultResourceLoader({
      cwd, agentDir, settingsManager, additionalExtensionPaths: [wrapper], noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await resourceLoader.reload();
    assert.equal(resourceLoader.getExtensions().extensions.length, 1, JSON.stringify(resourceLoader.getExtensions().diagnostics));
    const modelRuntime = await host.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
    await modelRuntime.refresh({ allowNetwork: false });
    const primary = modelRuntime.getModel("primary", "primary-model");
    const fallback = modelRuntime.getModel("openai-codex", "gpt-5.6-sol");
    assert.ok(primary && fallback, "temporary primary and fallback models must be registered");
    assert.equal(modelRuntime.hasConfiguredAuth("openai-codex"), true, "the fallback must have placeholder auth");
    ({ session } = await host.createAgentSession({
      cwd, agentDir, settingsManager, resourceLoader, modelRuntime, model: primary,
      sessionManager: host.SessionManager.create(cwd, join(agentDir, "sessions")), noTools: "all",
    }));
    await session.bindExtensions({ mode: "rpc", shutdownHandler() {}, onError(error) { throw error; } });
    await settingsManager.flush();
    const persisted = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
    return { currentModel: { provider: session.model?.provider, id: session.model?.id }, persistedDefaults: { provider: persisted.defaultProvider, model: persisted.defaultModel }, requests };
  } finally {
    session?.dispose();
    if (listening) await new Promise((resolveClose) => server.close(resolveClose));
    await rm(configRoot, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
}

function model(id, name) {
  return { id, name, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 256 };
}

test("real Pi RPC loads required auto-discovered Skills without retired products", async () => {
  assert.ok(piBinary, "PI_REAL_BIN must point to an explicitly supported Pi host");
  const controlledSkills = await discoverManagedSkills(repoRoot);

  const result = spawnSync(
    "zsh",
    [
      "-f",
      "-c",
      `source ${shellIntegration}; pi --mode rpc --no-session --offline --provider openai --model gpt-4o`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PI_REAL_BIN: piBinary,
        OPENAI_API_KEY: "integration-test-not-used",
      },
      input: `${JSON.stringify({ id: "commands", type: "get_commands" })}\n`,
      timeout: 15000,
    },
  );

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);

  const records = result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const response = records.find(
    (record) => record.type === "response" && record.command === "get_commands",
  );
  assert.ok(response, `missing get_commands response in: ${result.stdout}`);
  assert.equal(response.success, true);

  const skills = response.data.commands
    .filter((command) => command.source === "skill")
    .map((command) => command.name);
  const requiredSkills = [
    ...[...controlledSkills.keys()].map((name) => `skill:${name}`),
    "skill:cache-stats",
    "skill:external-llm-review-provider",
    "skill:manage-providers",
  ];
  for (const required of requiredSkills) assert.ok(skills.includes(required), `missing required Skill: ${required}`);
  assert.equal(new Set(skills).size, skills.length, "auto-discovered Skills must be unique");
  assert.equal(skills.includes("skill:plan-runner-dispatch"), false);
});
