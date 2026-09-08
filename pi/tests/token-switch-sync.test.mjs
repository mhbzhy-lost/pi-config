import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const syncScript = resolve("pi/scripts/sync-token-switch-to-pi.ts");
const keyHelper = resolve("pi/scripts/token-switch-api-key.ts");
const fixtureKey = "fake-token-switch-api-key";
const tokenSwitchUserAgent = "opencode/1.18.4 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";

function modeProvider(mode, overrides = {}) {
  return {
    npm: "@ai-sdk/openai-compatible",
    options: {
      baseURL: `http://127.0.0.1:15722/opencode/mode-${mode}/v1`,
      apiKey: fixtureKey,
      setCacheKey: "fake-token-switch-cache-key"
    },
    models: {
      [`model-${mode}`]: {
        name: `Mode ${mode}`,
        limit: { context: 123456, output: 7890 },
        reasoning: true,
        modalities: { input: ["text", "image"] }
      }
    },
    ...overrides
  };
}

function writeFixture(dir, config, settings = { enabledModels: ["preserved/first", "tokenhub/obsolete", "token-switch-mode-stale/old", "preserved/last"] }) {
  const source = join(dir, "opencode.json");
  const target = join(dir, "models.json");
  const settingsTarget = join(dir, "settings.json");
  writeFileSync(source, JSON.stringify(config));
  writeFileSync(target, JSON.stringify({
    providers: {
      tokenhub: { api: "openai-completions", models: [] },
      preserved: { api: "openai-completions", models: [{ id: "keep", name: "Keep" }] }
    }
  }, null, 2));
  writeFileSync(settingsTarget, JSON.stringify(settings, null, 2));
  return { source, target, settingsTarget };
}

function runSync(source, target, settingsTarget) {
  return spawnSync("node", [syncScript], {
    cwd: resolve("."),
    encoding: "utf8",
    env: { ...process.env, OPENCODE_CONFIG: source, PI_MODELS_CONFIG: target, PI_SETTINGS_CONFIG: settingsTarget }
  });
}

test("syncs all current Token Switch modes into settings without persisting fixture credentials", () => {
  const dir = mkdtempSync(join(tmpdir(), "token-switch-sync-"));
  const { source, target, settingsTarget } = writeFixture(dir, {
    provider: {
      alpha: modeProvider("alpha"),
      beta: modeProvider("beta"),
      ordinary: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://example.invalid/v1", apiKey: fixtureKey } }
    }
  }, {
    enabledModels: [
      "preserved/first",
      "token-switch-mode-24b28efaa85443a5bf7eac4de15190f5/mode-24b28efaa85443a5bf7eac4de15190f5",
      "preserved/last"
    ]
  });

  const result = runSync(source, target, settingsTarget);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(fixtureKey));
  const modelsText = readFileSync(target, "utf8");
  const models = JSON.parse(modelsText);
  assert.deepEqual(Object.keys(models.providers).sort(), ["preserved", "token-switcher", "token-switcher-1"]);
  assert.equal(models.providers["token-switcher"].baseUrl, "http://127.0.0.1:15722/opencode/mode-alpha/v1");
  assert.equal(models.providers["token-switcher"].api, "openai-completions");
  assert.equal(models.providers["token-switcher"].apiKey, "!node \"$PI_CODING_AGENT_DIR/scripts/token-switch-api-key.ts\" mode-alpha");
  assert.deepEqual(models.providers["token-switcher"].headers, { "User-Agent": tokenSwitchUserAgent });
  assert.deepEqual(models.providers["token-switcher-1"].headers, { "User-Agent": tokenSwitchUserAgent });
  assert.deepEqual(models.providers["token-switcher"].compat, {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: "max_tokens"
  });
  assert.deepEqual(models.providers["token-switcher"].models, [{
    id: "Mode-alpha", name: "Mode alpha", contextWindow: 123456, maxTokens: 7890,
    reasoning: true, input: ["text", "image"], samplingParams: { model: "mode-alpha" }
  }]);
  assert.deepEqual(models.providers["token-switcher-1"].models[0].samplingParams, { model: "mode-beta" });
  assert.doesNotMatch(modelsText, new RegExp(fixtureKey));
  assert.doesNotMatch(modelsText, /fake-token-switch-cache-key/);
  assert.deepEqual(JSON.parse(readFileSync(settingsTarget, "utf8")).enabledModels, [
    "preserved/first",
    "preserved/last",
    "token-switcher/Mode-alpha",
    "token-switcher-1/Mode-beta"
  ]);
});

test("uses readable model ids derived from names and migrates old hash references", () => {
  const dir = mkdtempSync(join(tmpdir(), "token-switch-sync-"));
  const { source, target, settingsTarget } = writeFixture(dir, {
    provider: {
      dogfooding: modeProvider("24b28efaa85443a5bf7eac4de15190f5", {
        models: {
          "mode-24b28efaa85443a5bf7eac4de15190f5": {
            name: "Qwen3.8-Max-DogFooding",
            limit: { context: 123456, output: 7890 }, reasoning: false, modalities: { input: ["text"] }
          }
        }
      }),
      advanced: modeProvider("8a8dd030c1ac46eab434e59b9b9a951a", {
        models: {
          "mode-8a8dd030c1ac46eab434e59b9b9a951a": {
            name: "高级", limit: { context: 123456, output: 7890 }, reasoning: false, modalities: { input: ["text"] }
          }
        }
      }),
      flagship: modeProvider("d98246c0ef8840b399161f798f5831b1", {
        models: {
          "mode-d98246c0ef8840b399161f798f5831b1": {
            name: "旗舰", limit: { context: 123456, output: 7890 }, reasoning: false, modalities: { input: ["text", "image"] }
          }
        }
      })
    }
  });

  const result = runSync(source, target, settingsTarget);
  assert.equal(result.status, 0, result.stderr);
  const models = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(models.providers["token-switcher"].models[0].id, "Qwen3.8-Max-DogFooding");
  assert.equal(models.providers["token-switcher-1"].models[0].id, "高级");
  assert.equal(models.providers["token-switcher-2"].models[0].id, "旗舰");
  assert.deepEqual(models.providers["token-switcher"].models[0].samplingParams, { model: "mode-24b28efaa85443a5bf7eac4de15190f5" });
  assert.deepEqual(models.providers["token-switcher-1"].models[0].samplingParams, { model: "mode-8a8dd030c1ac46eab434e59b9b9a951a" });
  assert.deepEqual(models.providers["token-switcher-2"].models[0].samplingParams, { model: "mode-d98246c0ef8840b399161f798f5831b1" });
  assert.deepEqual(JSON.parse(readFileSync(settingsTarget, "utf8")).enabledModels, [
    "preserved/first",
    "preserved/last",
    "token-switcher/Qwen3.8-Max-DogFooding",
    "token-switcher-1/高级",
    "token-switcher-2/旗舰"
  ]);
});

test("numbers providers by OpenCode declaration order beyond ten modes", () => {
  const dir = mkdtempSync(join(tmpdir(), "token-switch-sync-"));
  const provider = {};
  for (let index = 0; index < 11; index++) provider[`source-${index}`] = modeProvider(`mode-${index}`);
  const { source, target, settingsTarget } = writeFixture(dir, { provider }, { enabledModels: [] });

  const first = runSync(source, target, settingsTarget);
  assert.equal(first.status, 0, first.stderr);
  const firstModels = readFileSync(target, "utf8");
  assert.deepEqual(Object.keys(JSON.parse(firstModels).providers), [
    "preserved", "token-switcher", "token-switcher-1", "token-switcher-2", "token-switcher-3",
    "token-switcher-4", "token-switcher-5", "token-switcher-6", "token-switcher-7", "token-switcher-8",
    "token-switcher-9", "token-switcher-10"
  ]);
  const second = runSync(source, target, settingsTarget);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(target, "utf8"), firstModels);
});

test("replaces only managed legacy short providers and migrates their settings references", () => {
  const dir = mkdtempSync(join(tmpdir(), "token-switch-sync-"));
  const { source, target, settingsTarget } = writeFixture(dir, { provider: { alpha: modeProvider("alpha") } }, {
    enabledModels: ["preserved/first", "token-switcher-7/legacy", "preserved/last"]
  });
  const models = JSON.parse(readFileSync(target, "utf8"));
  models.providers["token-switcher-7"] = {
    baseUrl: "http://127.0.0.1:15722/opencode/mode-legacy/v1",
    api: "openai-completions",
    apiKey: "!node \"$PI_CODING_AGENT_DIR/scripts/token-switch-api-key.ts\" mode-legacy",
    models: []
  };
  writeFileSync(target, JSON.stringify(models, null, 2));

  const result = runSync(source, target, settingsTarget);
  assert.equal(result.status, 0, result.stderr);
  const updated = JSON.parse(readFileSync(target, "utf8"));
  assert.deepEqual(Object.keys(updated.providers).sort(), ["preserved", "token-switcher"]);
  assert.deepEqual(JSON.parse(readFileSync(settingsTarget, "utf8")).enabledModels, [
    "preserved/first", "preserved/last", "token-switcher/Mode-alpha"
  ]);
});

test("appends current Token Switch settings references once when no old references exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "token-switch-sync-"));
  const { source, target, settingsTarget } = writeFixture(dir, { provider: { alpha: modeProvider("alpha") } }, {
    enabledModels: ["preserved/first", "preserved/last"]
  });

  const first = runSync(source, target, settingsTarget);
  assert.equal(first.status, 0, first.stderr);
  const afterFirst = readFileSync(settingsTarget, "utf8");
  const second = runSync(source, target, settingsTarget);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(settingsTarget, "utf8"), afterFirst);
  assert.deepEqual(JSON.parse(afterFirst).enabledModels, ["preserved/first", "preserved/last", "token-switcher/Mode-alpha"]);
});

test("normalizes Unicode names, whitespace, and slashes into readable ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "token-switch-sync-"));
  const { source, target, settingsTarget } = writeFixture(dir, {
    provider: {
      alpha: modeProvider("alpha", {
        models: {
          alpha: { name: "  Qwen / 高级  ", limit: { context: 1, output: 1 }, reasoning: false, modalities: { input: ["text"] } }
        }
      })
    }
  });

  const result = runSync(source, target, settingsTarget);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(target, "utf8")).providers["token-switcher"].models[0].id, "Qwen-高级");
});

test("disambiguates colliding readable model ids deterministically", () => {
  const dir = mkdtempSync(join(tmpdir(), "token-switch-sync-"));
  const duplicate = name => ({ name, limit: { context: 1, output: 1 }, reasoning: false, modalities: { input: ["text"] } });
  const { source, target, settingsTarget } = writeFixture(dir, {
    provider: {
      alpha: modeProvider("alpha", { models: { alpha: duplicate("Same Name") } }),
      beta: modeProvider("beta", { models: { beta: duplicate("Same/Name") } })
    }
  });

  const first = runSync(source, target, settingsTarget);
  assert.equal(first.status, 0, first.stderr);
  const firstOutput = readFileSync(target, "utf8");
  assert.deepEqual(JSON.parse(firstOutput).providers["token-switcher"].models.map(model => model.id), ["Same-Name-alpha"]);
  assert.deepEqual(JSON.parse(firstOutput).providers["token-switcher-1"].models.map(model => model.id), ["Same-Name-beta"]);
  assert.deepEqual(JSON.parse(firstOutput).providers["token-switcher"].models[0].samplingParams, { model: "mode-alpha" });
  assert.deepEqual(JSON.parse(firstOutput).providers["token-switcher-1"].models[0].samplingParams, { model: "mode-beta" });
  const second = runSync(source, target, settingsTarget);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(target, "utf8"), firstOutput);
});

test("migrates a provider generated with the intermediate helper path and missing User-Agent", () => {
  const dir = mkdtempSync(join(tmpdir(), "token-switch-sync-"));
  const { source, target, settingsTarget } = writeFixture(dir, { provider: { alpha: modeProvider("alpha") } });
  const models = JSON.parse(readFileSync(target, "utf8"));
  models.providers["token-switch-mode-alpha"] = {
    baseUrl: "http://127.0.0.1:15722/opencode/mode-alpha/v1",
    api: "openai-completions",
    apiKey: "!node \"$PI_CODING_AGENT_DIR/pi/scripts/token-switch-api-key.ts\" mode-alpha",
    models: []
  };
  writeFileSync(target, JSON.stringify(models, null, 2));

  const result = runSync(source, target, settingsTarget);
  assert.equal(result.status, 0, result.stderr);
  const migrated = JSON.parse(readFileSync(target, "utf8")).providers["token-switcher"];
  assert.equal(migrated.apiKey, "!node \"$PI_CODING_AGENT_DIR/scripts/token-switch-api-key.ts\" mode-alpha");
  assert.deepEqual(migrated.headers, { "User-Agent": tokenSwitchUserAgent });
});

test("helper returns only the requested mode key and fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "token-switch-helper-"));
  const { source } = writeFixture(dir, { provider: { alpha: modeProvider("alpha") } });
  const success = spawnSync("node", [keyHelper, "mode-alpha"], { encoding: "utf8", env: { ...process.env, OPENCODE_CONFIG: source } });
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.stdout, `${fixtureKey}\n`);
  const rejected = spawnSync("node", [keyHelper, "missing"], { encoding: "utf8", env: { ...process.env, OPENCODE_CONFIG: source } });
  assert.notEqual(rejected.status, 0);
  assert.equal(rejected.stdout, "");
  assert.doesNotMatch(rejected.stderr, new RegExp(fixtureKey));
});

test("helper command resolves from the Pi launcher environment", () => {
  const dir = mkdtempSync(join(tmpdir(), "token-switch-helper-"));
  const { source } = writeFixture(dir, { provider: { alpha: modeProvider("alpha") } });
  const result = spawnSync("sh", ["-c", "node \"$PI_CODING_AGENT_DIR/scripts/token-switch-api-key.ts\" mode-alpha"], {
    encoding: "utf8",
    env: { ...process.env, OPENCODE_CONFIG: source, PI_CODING_AGENT_DIR: resolve("pi") }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${fixtureKey}\n`);
});

for (const [name, config] of [
  ["malformed JSON", "{"],
  ["no matching mode", JSON.stringify({ provider: { ordinary: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://example.invalid/v1" } } } })],
  ["missing apiKey", JSON.stringify({ provider: { alpha: modeProvider("alpha", { options: { baseURL: "http://127.0.0.1:15722/opencode/mode-alpha/v1" } }) } })],
  ["duplicate mode", JSON.stringify({ provider: { alpha: modeProvider("alpha"), beta: modeProvider("alpha") } })],
  ["non-string model name", JSON.stringify({ provider: { alpha: modeProvider("alpha", { models: { alpha: { name: 42, limit: { context: 1, output: 1 }, modalities: { input: ["text"] } } } }) } })],
  ["empty model name", JSON.stringify({ provider: { alpha: modeProvider("alpha", { models: { alpha: { name: "", limit: { context: 1, output: 1 }, modalities: { input: ["text"] } } } }) } })],
  ["separator-only model name", JSON.stringify({ provider: { alpha: modeProvider("alpha", { models: { alpha: { name: " / ", limit: { context: 1, output: 1 }, modalities: { input: ["text"] } } } }) } })]
]) {
  test(`keeps the target unchanged for ${name}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "token-switch-sync-"));
    const source = join(dir, "opencode.json");
    const target = join(dir, "models.json");
    const settingsTarget = join(dir, "settings.json");
    writeFileSync(source, config);
    writeFileSync(target, "{\n  \"providers\": {\n    \"preserved\": {}\n  }\n}\n");
    writeFileSync(settingsTarget, "{\n  \"enabledModels\": [\"preserved/model\"]\n}\n");
    const before = readFileSync(target, "utf8");
    const settingsBefore = readFileSync(settingsTarget, "utf8");
    const result = runSync(source, target, settingsTarget);
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(target, "utf8"), before);
    assert.equal(readFileSync(settingsTarget, "utf8"), settingsBefore);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(fixtureKey));
  });
}

test("keeps the target unchanged when a generated provider id conflicts", () => {
  const dir = mkdtempSync(join(tmpdir(), "token-switch-sync-"));
  const { source, target, settingsTarget } = writeFixture(dir, { provider: { alpha: modeProvider("alpha") } });
  const conflict = JSON.parse(readFileSync(target, "utf8"));
  conflict.providers["token-switcher"] = { api: "other", models: [] };
  writeFileSync(target, JSON.stringify(conflict, null, 2));
  const before = readFileSync(target, "utf8");
  const result = runSync(source, target, settingsTarget);
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(target, "utf8"), before);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(fixtureKey));
});

for (const [name, settingsText] of [
  ["malformed settings", "{"],
  ["non-array enabledModels", '{"enabledModels": "wrong"}']
]) {
  test(`keeps both targets unchanged for ${name}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "token-switch-sync-"));
    const { source, target, settingsTarget } = writeFixture(dir, { provider: { alpha: modeProvider("alpha") } });
    writeFileSync(settingsTarget, settingsText);
    const modelsBefore = readFileSync(target, "utf8");
    const settingsBefore = readFileSync(settingsTarget, "utf8");
    const result = runSync(source, target, settingsTarget);
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(target, "utf8"), modelsBefore);
    assert.equal(readFileSync(settingsTarget, "utf8"), settingsBefore);
  });
}
