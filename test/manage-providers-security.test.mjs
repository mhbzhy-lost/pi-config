import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { ModelConfig } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/model-config.js";

const script = resolve(".agents/skills/manage-providers/manage-providers.py");

function run(dir, ...args) {
  return spawnSync("python3", [script, ...args], {
    env: { ...process.env, PI_CODING_AGENT_DIR: dir }, encoding: "utf8"
  });
}

test("provider credentials never accept a command-line key", () => {
  const dir = mkdtempSync(join(tmpdir(), "manage-providers-security-"));
  const help = run(dir, "--help");
  assert.equal(help.status, 0);
  assert.doesNotMatch(help.stdout, /--key|set-key <provider> <key>/);
  assert.doesNotMatch(run(dir, "add-provider", "--help").stdout, /metadata-user-id/);
  assert.doesNotMatch(run(dir, "add-model", "--help").stdout, /actual-model-id/);
  const rejected = run(dir, "add-provider", "demo", "--api", "openai-completions", "--base-url", "https://example.invalid", "--key", "fake-test-key");
  assert.notEqual(rejected.status, 0);
  assert.doesNotMatch(rejected.stdout + rejected.stderr, /fake-test-key/);
});

test("auth writes are private and atomic without passing a key through the CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "manage-providers-security-"));
  const helper = join(dir, "write-auth.py");
  writeFileSync(helper, `import importlib.util, os\nfrom pathlib import Path\ns=importlib.util.spec_from_file_location('manage', ${JSON.stringify(script)})\nm=importlib.util.module_from_spec(s)\ns.loader.exec_module(m)\ntarget=os.environ.pop('PI_CODING_AGENT_DIR')\nassert m.get_agent_dir() == Path(${JSON.stringify(resolve("pi"))})\nos.environ['PI_CODING_AGENT_DIR']=target\nm.save_auth_json({'demo': {'type': 'api_key', 'key': 'fake-test-key'}})\n`);
  execFileSync("python3", [helper], { env: { ...process.env, PI_CODING_AGENT_DIR: dir } });
  const auth = join(dir, "auth.json");
  assert.equal(statSync(auth).mode & 0o777, 0o600);
  assert.match(readFileSync(auth, "utf8"), /fake-test-key/);
  assert.equal(existsSync(join(dir, ".auth.json.tmp")), false);
  const implementation = readFileSync(script, "utf8");
  assert.match(implementation, /os\.fsync/);
  assert.match(implementation, /os\.replace/);
  assert.match(implementation, /_models_lock/);
});

test("ordinary header names cannot store credential-like values", async () => {
  const dir = mkdtempSync(join(tmpdir(), "manage-providers-security-"));
  const rejectedValues = [
    "Bearer fake-header-token",
    "Basic ZmFrZS11c2VyOmZha2UtcGFzcw==",
    "sk-fake-header-secret",
    "token_fake_header_secret",
    "aB3dE5fG7hJ9kLmNpQrStUvWxYz0123456789ABCD"
  ];
  for (const value of rejectedValues) {
    const result = run(dir, "add-provider", "bad-value", "--api", "openai-completions", "--base-url", "https://example.invalid", "--header", `X-Feature-Flag: ${value}`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /sensitive header value must not be stored in models\.json/);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.equal(run(dir, "add-provider", "safe-value", "--api", "openai-completions", "--base-url", "https://example.invalid", "--header", "X-Feature-Flag: enabled", "--compat", "supportsDeveloperRole=false", "--compat", "vllmPriority=1", "--compat", 'chatTemplateKwargs={"enable_thinking":true}').status, 0);
  const provider = JSON.parse(readFileSync(join(dir, "models.json"), "utf8")).providers["safe-value"];
  assert.deepEqual(provider.headers, { "X-Feature-Flag": "enabled" });
  assert.deepEqual(provider.compat, { supportsDeveloperRole: false, vllmPriority: 1, chatTemplateKwargs: { enable_thinking: true } });
  const config = await ModelConfig.load(join(dir, "models.json"));
  assert.equal(config.getError(), undefined);
  assert.deepEqual(config.getProvider("safe-value").compat, provider.compat);
});

test("sensitive headers and unconfirmed removals are rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "manage-providers-security-"));
  assert.equal(run(dir, "add-provider", "demo", "--api", "openai-completions", "--base-url", "https://example.invalid").status, 0);
  for (const name of ["Authorization", "Proxy-Authorization", "Cookie", "Set-Cookie", "X-API-Key", "API-Key"]) {
    const value = "fake-sensitive-header-value";
    const header = run(dir, "add-provider", "blocked", "--api", "openai-completions", "--base-url", "https://example.invalid", "--header", `${name}: ${value}`);
    assert.notEqual(header.status, 0);
    assert.match(header.stderr, /^Error: sensitive header must not be stored in models\.json\n$/);
    assert.doesNotMatch(header.stdout + header.stderr, new RegExp(`${name}|${value}`));
  }
  assert.doesNotMatch(readFileSync(join(dir, "models.json"), "utf8"), /Authorization|fake-sensitive-header-value/);
  const remove = run(dir, "remove-provider", "demo");
  assert.notEqual(remove.status, 0);
  assert.match(readFileSync(join(dir, "models.json"), "utf8"), /demo/);
  assert.equal(run(dir, "remove-provider", "demo", "--confirm", "demo").status, 0);
});

test("remove-model requires an exact model-id confirmation before writing", () => {
  const dir = mkdtempSync(join(tmpdir(), "manage-providers-security-"));
  assert.equal(run(dir, "add-provider", "demo", "--api", "openai-completions", "--base-url", "https://example.invalid").status, 0);
  assert.equal(run(dir, "add-model", "demo", "--id", "model-to-remove", "--context", "1", "--max-tokens", "1").status, 0);
  const modelsPath = join(dir, "models.json");
  const before = readFileSync(modelsPath, "utf8");

  const missingConfirmation = run(dir, "remove-model", "demo", "model-to-remove");
  assert.notEqual(missingConfirmation.status, 0);
  assert.equal(readFileSync(modelsPath, "utf8"), before);

  const mismatchedConfirmation = run(dir, "remove-model", "demo", "model-to-remove", "--confirm", "other-model");
  assert.notEqual(mismatchedConfirmation.status, 0);
  assert.equal(readFileSync(modelsPath, "utf8"), before);

  assert.equal(run(dir, "remove-model", "demo", "model-to-remove", "--confirm", "model-to-remove").status, 0);
  assert.doesNotMatch(readFileSync(modelsPath, "utf8"), /model-to-remove/);
});
