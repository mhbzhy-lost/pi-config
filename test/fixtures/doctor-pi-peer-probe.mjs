import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// fresh process 中只用真实 global loader，不注入 alias/preload，不读取 auth/models。
const [entry, root, hostRoot, hostAliasesJson, localAliasesJson, mode] = process.argv.slice(2);
const hostAliases = JSON.parse(hostAliasesJson);
const localAliases = JSON.parse(localAliasesJson);
const { loadExtensions } = await import(pathToFileURL(join(hostRoot, "dist/core/extensions/loader.js")).href);
const loaded = await loadExtensions([entry], root);
assert.deepEqual(loaded.errors, []);
assert.equal(loaded.extensions.length, 1);
const extension = loaded.extensions[0];

if (mode === "native-identities") {
  const identities = extension.commands.get("peer-identity").handler();
  for (const [specifier, name] of [
    ["@earendil-works/pi-coding-agent", "SessionManager"],
    ["@earendil-works/pi-tui", "Box"],
    ["@earendil-works/pi-agent-core", "Agent"],
    ["@earendil-works/pi-ai/compat", "streamSimple"],
  ]) {
    const host = await import(pathToFileURL(hostAliases[specifier]).href);
    const local = await import(pathToFileURL(localAliases[specifier]).href);
    assert.equal(identities[name], host[name], `${name}: native 子图不应被直接 TS 对照掩盖`);
    assert.equal(identities[name], local[name], `${name}: 必须证明来自 enhanced 副本`);
    console.log(`${name}: native === enhanced, native === Host`);
  }
} else if (mode === "watchdog-consumer") {
  // 用真实 compat public root 注册上游 renderer；不发 session_start 或执行 subagent/model 工具。
  const renderer = extension.messageRenderers.get("subagent_watchdog_warning");
  assert.equal(typeof renderer, "function");
  const details = {
    severity: "concern", importance: "high", category: "test-gap", source: "main", state: "displayed",
    summary: "Identity probe", evidence: "Native ESM resolves package-local Pi peers",
    recommendedAction: "Keep Doctor fail closed until a separate loader decision",
  };
  const component = renderer({ customType: "subagent_watchdog_warning", content: details.summary, display: true, details },
    { expanded: true }, { fg: (_color, text) => text, bold: (text) => text });
  const host = await import(pathToFileURL(hostAliases["@earendil-works/pi-tui"]).href);
  const local = await import(pathToFileURL(localAliases["@earendil-works/pi-tui"]).href);
  assert.equal(component.constructor, host.Container);
  assert.equal(component.constructor, local.Container);
  assert.equal(component instanceof host.Container, true);
  assert.equal(component instanceof local.Container, true);
  const text = component.render(100).join("\n");
  assert.match(text, /Identity probe/);
  assert.match(text, /Native ESM/);
  console.log("upstream watchdog renderer: Container === enhanced, Container === Host; warning rendered");
} else {
  throw new Error(`Unknown probe mode: ${mode}`);
}

// 固定现场四包版本，排除版本漂移导致的不等；权威目录独立传入，禁止依赖根副本。
for (const specifier of Object.keys(localAliases)) {
  const name = specifier.replace(/\/compat$/, "");
  for (const entry of [hostAliases[specifier], localAliases[specifier]]) {
    const metadata = JSON.parse(await readFile(join(dirname(dirname(entry)), "package.json"), "utf8"));
    assert.equal(metadata.name, name);
    assert.equal(metadata.version, "1.0.4");
  }
}
console.log("Host and enhanced Pi peer versions: all four 1.0.4");
for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, {});
loaded.runtime.invalidate();
