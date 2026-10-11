import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectConfiguration, inspectCoordinatorDoctor, resolveRpcSource } from "../scripts/doctor.ts";

test("resolveRpcSource 兼容 0.62 TS 源与 0.71 编译版", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-rpc-"));
  try {
    const pkg = join(root, "pi-subagents");
    const ext = join(pkg, "src", "extension");
    mkdirSync(ext, { recursive: true });
    // 仅编译版（0.71 布局）：应读到源并兼容方法检查
    writeFileSync(join(ext, "rpc.js"), "const methods = [\"ping\", \"spawn\"];");
    const compiledOnly = await resolveRpcSource(pkg);
    assert.ok(compiledOnly.includes("ping"), "rpc.js-only 布局应能读到源");
    // 仅 TS 源（0.62 布局）：优先读取
    writeFileSync(join(ext, "rpc.ts"), "const methodsTs = [\"ping\"];");
    const tsFirst = await resolveRpcSource(pkg);
    assert.ok(tsFirst.includes("methodsTs"), "存在 rpc.ts 时应优先 TS 源");
    // 两者皆无：返回 null
    rmSync(join(ext, "rpc.js"));
    rmSync(join(ext, "rpc.ts"));
    assert.equal(await resolveRpcSource(pkg), null, "无源时应返回 null");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor distinguishes an unreadable .gitignore from a missing /var/ ignore rule and preserves filesystem cause", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-unreadable-"));
  try {
    mkdirSync(join(root, "skill-overrides"));
    writeFileSync(join(root, ".gitignore"), "/var/\n");
    chmodSync(join(root, ".gitignore"), 0o000);
    const issues = await inspectConfiguration(root, { readPiVersion: () => "0.87.1", readBasicMemoryVersion: () => "0.22.1", globalSkillsDir: root });
    assert.equal(issues.some((issue) => String(issue).includes("runtime namespace is not ignored")), false);
    const unreadable = issues.find((issue) => String(issue).includes("unreadable .gitignore"));
    assert.ok(unreadable, "a permission error must be reported instead of being treated as a missing rule");
    assert.ok(["EACCES", "EPERM"].includes(unreadable.cause?.code));
  } finally {
    chmodSync(join(root, ".gitignore"), 0o600);
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor reports unreadable settings with original filesystem cause rather than aborting configuration inspection", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-settings-"));
  try {
    mkdirSync(join(root, "skill-overrides"));
    mkdirSync(join(root, "pi"));
    writeFileSync(join(root, "pi", "settings.json"), "{}");
    chmodSync(join(root, "pi", "settings.json"), 0o000);
    const issues = await inspectConfiguration(root, { readPiVersion: () => "0.87.1", readBasicMemoryVersion: () => "0.22.1", globalSkillsDir: root });
    const unreadable = issues.find((issue) => String(issue).includes("unreadable pi/settings.json"));
    assert.ok(unreadable);
    assert.ok(["EACCES", "EPERM"].includes(unreadable.cause?.code));
  } finally {
    chmodSync(join(root, "pi", "settings.json"), 0o600);
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor 校验 r2c pi-adapter 安装与注册的一致性（双向）", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-r2c-"));
  try {
    mkdirSync(join(root, "skill-overrides"));
    mkdirSync(join(root, "pi"));
    const adapterDir = join(root, "r2c-adapter");
    const base = { readPiVersion: () => "0.87.1", readBasicMemoryVersion: () => "0.22.1", globalSkillsDir: root, r2cAdapterDir: adapterDir };
    const settingsPath = join(root, "pi", "settings.json");
    const writeSettings = (packages) => writeFileSync(settingsPath, JSON.stringify({ packages }));

    // 已安装但未挂载：采集扩展不会加载，必须报警
    mkdirSync(adapterDir);
    writeSettings([]);
    const unregistered = await inspectConfiguration(root, base);
    assert.ok(
      unregistered.some((issue) => String(issue).includes("r2c pi-adapter is installed but not registered")),
      "installed adapter missing from settings must be reported",
    );

    // 已安装且已挂载：无 r2c 相关报警
    writeSettings([{ source: "../packages/pi-subagents-enhanced" }, "../../.r2c/integrations/pi-adapter"]);
    const healthy = await inspectConfiguration(root, base);
    assert.equal(healthy.some((issue) => String(issue).includes("r2c pi-adapter")), false);
    // M09 退役 scanner 入口不再是必需 Pi 配置文件，Doctor 不得再报缺失。
    assert.equal(
      healthy.some((issue) => String(issue).includes("skill-whitelist")),
      false,
      "retired skill-whitelist entry must no longer be required by doctor",
    );

    // 未安装但注册残留：悬空 package 必须报警
    rmSync(adapterDir, { recursive: true, force: true });
    const dangling = await inspectConfiguration(root, base);
    assert.ok(
      dangling.some((issue) => String(issue).includes("references missing local r2c adapter package")),
      "dangling adapter registration must be reported",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor reports unreadable RPC source with filesystem cause instead of mislabeling the package missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-rpc-permission-"));
  const pkg = join(root, "packages", "pi-subagents-enhanced", "node_modules", "pi-subagents");
  const rpc = join(pkg, "src", "extension", "rpc.ts");
  try {
    mkdirSync(join(root, "skill-overrides"));
    mkdirSync(join(pkg, "src", "extension"), { recursive: true });
    mkdirSync(join(pkg, "extensions"));
    writeFileSync(join(pkg, "extensions", "subagent-runtime.ts"), "");
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: "0.75.0", pi: { extensions: ["./extensions/subagent-runtime.ts"] } }));
    writeFileSync(rpc, "const methods = [];");
    chmodSync(rpc, 0o000);
    const issues = await inspectConfiguration(root, { readPiVersion: () => "0.87.1", readBasicMemoryVersion: () => "0.22.1", globalSkillsDir: root });
    const unreadable = issues.find((issue) => String(issue).includes("unreadable pi-subagents RPC v1 source"));
    assert.ok(unreadable);
    assert.ok(["EACCES", "EPERM"].includes(unreadable.cause?.code));
    assert.equal(issues.some((issue) => String(issue).includes("missing Pi package: pi-subagents@")), false);
  } finally {
    chmodSync(rpc, 0o600);
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor reports an unreadable legacy path rather than silently treating it as absent", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-legacy-"));
  try {
    mkdirSync(join(root, "skill-overrides"));
    writeFileSync(join(root, ".gitignore"), "/var/\n");
    mkdirSync(join(root, "scripts", "lib", "runtime"), { recursive: true });
    writeFileSync(join(root, "scripts", "lib", "runtime", "spawn.mjs"), "legacy");
    chmodSync(join(root, "scripts", "lib", "runtime"), 0o000);
    const issues = await inspectConfiguration(root, { readPiVersion: () => "0.87.1", readBasicMemoryVersion: () => "0.22.1", globalSkillsDir: root });
    const unreadable = issues.find((issue) => String(issue).includes("unreadable legacy generic subagent runtime: scripts/lib/runtime/spawn.mjs"));
    assert.ok(unreadable, "legacy access failures other than ENOENT must be observable");
    assert.ok(["EACCES", "EPERM"].includes(unreadable.cause?.code));
  } finally {
    chmodSync(join(root, "scripts", "lib", "runtime"), 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

const piPeers = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];

async function inspectLocalPiPeers(t, mutate = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "doctor-dev-peers-"));
  mkdirSync(join(root, "skill-overrides"));
  const packageRoot = join(root, "packages", "pi-subagents-enhanced");
  mkdirSync(packageRoot, { recursive: true });
  t.after(() => {
    chmodSync(join(packageRoot, "node_modules", "@earendil-works"), 0o755);
    rmSync(root, { recursive: true, force: true });
  });
  // 来自合法安装 manifest，非通过伪造版本推导期望。
  const metadata = JSON.parse(readFileSync(new URL("../packages/pi-subagents-enhanced/package.json", import.meta.url), "utf8"));
  for (const entry of metadata.pi.extensions) {
    const path = join(packageRoot, entry);
    mkdirSync(join(packageRoot, "extensions"), { recursive: true });
    writeFileSync(path, "");
  }
  for (const peer of piPeers) {
    const path = join(packageRoot, "node_modules", peer);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "package.json"), JSON.stringify({ name: peer, version: "0.87.1" }));
  }
  mutate(metadata, packageRoot);
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify(metadata));
  const issues = await inspectConfiguration(root, { readPiVersion: () => "0.87.1", readBasicMemoryVersion: () => "0.22.1", globalSkillsDir: root });
  return issues.map(String).filter((issue) => /package-local Pi core peer|peer ownership/.test(issue));
}

test("doctor rejects all four package-local Pi peers even with exact dev versions and wildcard peers", async (t) => {
  // 合法开发声明不保证 native ESM 子图沿用 Host 身份；放行分支会漏掉四个真实冲突。
  const issues = await inspectLocalPiPeers(t);
  assert.equal(issues.length, 4, issues.join("\n"));
  for (const peer of piPeers) assert.ok(issues.some((issue) => issue.includes(peer)));
});

test("doctor rejects local Pi peers regardless of dependency declarations or local manifest contents", async (t) => {
  const peer = "@earendil-works/pi-tui";
  const cases = [
    ["undeclared", (m) => { delete m.devDependencies[peer]; }],
    ["runtime dependency", (m) => { m.dependencies[peer] = "0.87.1"; }],
    ["optional runtime dependency", (m) => { m.optionalDependencies = { [peer]: "0.87.1" }; }],
    ["bundled", (m) => { m.bundleDependencies.push(peer); }],
    ["alternate bundle spelling", (m) => { m.bundledDependencies = [peer]; }],
    ["missing peer contract", (m) => { delete m.peerDependencies[peer]; }],
    ["non-wildcard peer", (m) => { m.peerDependencies[peer] = "^0.87.1"; }],
    ["unbounded dev version", (m) => { m.devDependencies[peer] = "*"; }],
    ["local version drift", (_m, root) => { writeFileSync(join(root, "node_modules", peer, "package.json"), JSON.stringify({ name: peer, version: "0.85.1" })); }],
    ["wrong installed identity", (_m, root) => { writeFileSync(join(root, "node_modules", peer, "package.json"), JSON.stringify({ name: "other-package", version: "0.87.1" })); }],
    ["malformed local manifest", (_m, root) => { writeFileSync(join(root, "node_modules", peer, "package.json"), "{"); }],
    ["missing local manifest", (_m, root) => { rmSync(join(root, "node_modules", peer, "package.json")); }],
  ];
  for (const [label, mutate] of cases) await t.test(label, async (t) => {
    const issues = await inspectLocalPiPeers(t, mutate);
    assert.equal(issues.length, 4, issues.join("\n"));
    for (const name of piPeers) assert.ok(issues.some((issue) => issue.includes(name)));
  });
});

test("doctor rejects every local peer when the manifest bundles all dependencies", async (t) => {
  const issues = await inspectLocalPiPeers(t, (m) => { m.bundleDependencies = true; });
  assert.equal(issues.length, 4);
  for (const peer of piPeers) assert.ok(issues.some((issue) => issue.includes(peer)));
});

test("doctor preserves unreadable local Pi peer filesystem failures", async (t) => {
  const issues = await inspectLocalPiPeers(t, (_m, root) => {
    // lstat 的父目录不可访问，而非改为读取 peer manifest 才能发现的错误。
    chmodSync(join(root, "node_modules", "@earendil-works"), 0o000);
  });
  assert.equal(issues.length, 4);
  for (const issue of issues) assert.match(issue, /peer ownership.*EACCES|peer ownership.*EPERM/);
});

test("doctor does not report a local Pi peer when its path is absent", async (t) => {
  const issues = await inspectLocalPiPeers(t, (_m, root) => {
    for (const peer of piPeers) rmSync(join(root, "node_modules", peer), { recursive: true });
  });
  assert.deepEqual(issues, []);
});

test("doctor rejects split brain, unknown queue schema, and unresolved debts", () => {
  const issues = inspectCoordinatorDoctor({
    schemaVersion: "managed-workspace-administration.v1",
    coordinator: { status: "observed", protocol: "old" },
    queue: { items: [] },
    debts: [
      { kind: "state-root-split-brain" },
      { kind: "queue-schema" },
      { kind: "proof" },
      { kind: "delivery" },
      { kind: "cleanup" },
    ],
  });
  assert.match(issues.join("\n"), /protocol|split-brain|schema|proof|delivery|cleanup/);
});

test("doctor accepts an empty isolated coordinator audit", () => {
  assert.deepEqual(inspectCoordinatorDoctor({
    schemaVersion: "managed-workspace-administration.v1",
    coordinator: { status: "missing" }, queue: { items: [] }, debts: [],
  }), []);
});

test('Doctor静态层仅允许已绑定权威root的physical peer，普通同版本副本仍拒绝', async t => {
 const {bindPhysicalHostPeers}=await import('../packages/pi-subagents-enhanced/src/host-runtime/index.ts');
 const root=mkdtempSync(join(tmpdir(),'doctor-bound-peers-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const pkg=join(root,'packages/pi-subagents-enhanced');mkdirSync(pkg,{recursive:true});mkdirSync(join(root,'skill-overrides'));
 const metadata=JSON.parse(readFileSync(new URL('../packages/pi-subagents-enhanced/package.json',import.meta.url),'utf8'));writeFileSync(join(pkg,'package.json'),JSON.stringify(metadata));
 for(const peer of piPeers){const p=join(root,'node_modules',peer);mkdirSync(p,{recursive:true});writeFileSync(join(p,'package.json'),JSON.stringify({name:peer,version:'1.0.4'}));}
 await bindPhysicalHostPeers({enhancedPackageRoot:pkg,hostRoot:join(root,'node_modules/@earendil-works/pi-coding-agent')});
 const issues=await inspectConfiguration(root,{readPiVersion:()=> '1.0.4',readBasicMemoryVersion:()=> '0.22.1',globalSkillsDir:root});
 assert.deepEqual(issues.map(String).filter(x=>/package-local Pi core peer|peer ownership/.test(x)),[]);
 assert.equal(issues.some(x=>String(x).includes('unexpected Pi version')),false);
});

test('目标physical部署中TypeBox按实际Host exports解析，不要求上游历史nested peer布局',async()=>{
 const repo=new URL('../',import.meta.url).pathname;
 const issues=await inspectConfiguration(repo,{readPiVersion:()=> '1.0.4',readBasicMemoryVersion:()=> '0.22.1',globalSkillsDir:process.env.HOME+'/.agents/skills'});
 assert.deepEqual(issues.map(String).filter(s=>/typebox|TypeBox/.test(s)),[],'Host的1.3.27与scheduler的1.1.38不能混为旧nested peer要求');
});
