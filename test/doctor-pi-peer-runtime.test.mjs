import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { resolvePiHostPackageEntry, resolvePiHostPaths } from "./helpers/pi-host.mjs";

const enhancedRoot = resolve(import.meta.dirname, "../packages/pi-subagents-enhanced");
// 只接受测试明确提供的physical Host；不继承任意shell环境，也不回退全局Pi。
const explicitHostRoot = process.env.PI_TEST_CODING_AGENT_ROOT?.trim()
  || resolve(import.meta.dirname, "../node_modules/@earendil-works/pi-coding-agent");
const { piHostRoot, piHostAliases } = resolvePiHostPaths({ env: { PI_TEST_CODING_AGENT_ROOT: explicitHostRoot } });
const localAliases = Object.fromEntries([
  "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui",
  "@earendil-works/pi-agent-core", "@earendil-works/pi-ai/compat",
].map((specifier) => [specifier, resolvePiHostPackageEntry(enhancedRoot, specifier)]));
const exportsToCheck = [
  ["@earendil-works/pi-coding-agent", "SessionManager"],
  ["@earendil-works/pi-tui", "Box"],
  ["@earendil-works/pi-agent-core", "Agent"],
  ["@earendil-works/pi-ai/compat", "streamSimple"],
];

async function identityProbe(t) {
  const root = await mkdtemp(join(tmpdir(), "doctor-host-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // 复用已安装 typings，绝不安装依赖；探针只有注册/身份读操作，不启动 session。
  await symlink(join(enhancedRoot, "node_modules"), join(root, "node_modules"));
  return root;
}

const probeImports = exportsToCheck.map(([specifier, name]) => `import { ${name} } from ${JSON.stringify(specifier)};`).join("\n");

test("official Host loader aliases direct TS Pi imports only; this control does not prove native subtree safety", async (t) => {
  // 直接 TS import 的阳性对照：不得把它外推为整个 runtime 安全。
  const root = await identityProbe(t);
  const path = join(root, "peer-probe.ts");
  await writeFile(path, `${probeImports}\nexport default function(pi) { pi.registerCommand("peer-identity", { handler() { return { SessionManager, Box, Agent, streamSimple }; } }); }\n`);
  const { loadExtensions } = await import(pathToFileURL(join(piHostRoot, "dist/core/extensions/loader.js")).href);
  const loaded = await loadExtensions([path], root);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const identities = loaded.extensions[0].commands.get("peer-identity").handler();
  for (const [specifier, name] of exportsToCheck) {
    const host = await import(pathToFileURL(piHostAliases[specifier]).href);
    assert.equal(identities[name], host[name], `${specifier} 必须是 Host 对象，不是同版本本地副本`);
  }
});

function runOfficialNativeProbe(root, path, mode) {
  // 白名单环境隔离凭据/live markers；无 JITI_ALIAS、preload 或 native hooks。
  return execFileSync(process.execPath, [join(import.meta.dirname, "fixtures/doctor-pi-peer-probe.mjs"), path, root,
    piHostRoot, JSON.stringify(piHostAliases), JSON.stringify(localAliases), mode], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: "/tmp", PI_CODING_AGENT_DIR: join(root, "agent"),
      PI_SUBAGENTS_TEMP_ROOT: join(root, "subagent-temp"), PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: piHostRoot },
    timeout: 30_000,
  });
}

test("official Host loader TS factory through native MJS preserves all four identities through bound peers", async (t) => {
  // 捕获错误假设：给 TS 入口设置 aliases 就覆盖了所有 native transitive imports。
  const root = await identityProbe(t);
  await writeFile(join(root, "native-peers.mjs"), `${probeImports}\nexport { SessionManager, Box, Agent, streamSimple };\n`);
  const path = join(root, "native-factory.ts");
  await writeFile(path, 'import * as identities from "./native-peers.mjs";\nexport default function(pi) { pi.registerCommand("peer-identity", { handler() { return identities; } }); }\n');
  const output = runOfficialNativeProbe(root, path, "native-identities");
  for (const [, name] of exportsToCheck) assert.ok(output.includes(`${name}: native === enhanced, native === Host`), output);
  assert.match(output, /Host and enhanced Pi peer versions: all four 1\.4\.0/);
  t.diagnostic(output.trim());
});

test("official Host loader through production compat/upstream watchdog returns enhanced 与 Host 相同来源的 Box 子类", async (t) => {
  // 实际 public root 注册 native upstream consumer，而非自制 Box/Container 替身。
  const root = await identityProbe(t);
  const path = join(root, "upstream-factory.ts");
  const compat = pathToFileURL(join(enhancedRoot, "src/compat/pi-subagents-0.75.ts")).href;
  await writeFile(path, `import { upstreamSubagentRuntime } from ${JSON.stringify(compat)};\nexport default function(pi) { upstreamSubagentRuntime(pi); }\n`);
  const output = runOfficialNativeProbe(root, path, "watchdog-consumer");
  assert.match(output, /Box subclass === enhanced, Box subclass === Host; warning rendered/);
  assert.match(output, /Host and enhanced Pi peer versions: all four 1\.4\.0/);
  t.diagnostic(output.trim());
});

test("detached native runner preload retains Host Pi peer identity with development typings present", async (t) => {
  const root = await identityProbe(t);
  const upstream = join(enhancedRoot, "node_modules/pi-subagents");
  const { resolveHostPeerAliases } = await import(pathToFileURL(join(upstream, "src/runs/background/runner-aliases.js")).href);
  const { aliases, missing } = resolveHostPeerAliases(piHostRoot);
  assert.deepEqual(missing, []);
  const checks = exportsToCheck.map(([specifier, name], index) => `import { ${name} as host${index} } from ${JSON.stringify(pathToFileURL(aliases[specifier]).href)}; assert.equal(${name}, host${index});`).join("\n");
  const sdk = pathToFileURL(join(upstream, "src/runs/shared/child-session.js")).href;
  const path = join(root, "runner-probe.mjs");
  await writeFile(path, `import assert from "node:assert/strict";\n${probeImports}\n${checks}\nimport { loadHostPiCodingAgent } from ${JSON.stringify(sdk)}; assert.equal((await loadHostPiCodingAgent()).SessionManager, SessionManager); console.log("Host identities preserved");\n`);
  // 不继承凭据、live session、root marker；和 production spawnRunner 相同的 preload/aliases。
  const output = execFileSync(process.execPath, ["--import", pathToFileURL(join(upstream, "runner-peer-preload.mjs")).href, path], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: "/tmp", PI_ASYNC_NATIVE_RUNNER: "1", JITI_ALIAS: JSON.stringify(aliases), PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: piHostRoot, PI_PACKAGE_DIR: piHostRoot },
    timeout: 30_000,
  });
  assert.equal(output.trim(), "Host identities preserved");
});
