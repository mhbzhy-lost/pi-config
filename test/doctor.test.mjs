import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

test("doctor reports unreadable RPC source with filesystem cause instead of mislabeling the package missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-rpc-permission-"));
  const pkg = join(root, "packages", "pi-subagents-enhanced", "node_modules", "pi-subagents");
  const rpc = join(pkg, "src", "extension", "rpc.ts");
  try {
    mkdirSync(join(root, "skill-overrides"));
    mkdirSync(join(pkg, "src", "extension"), { recursive: true });
    mkdirSync(join(pkg, "extensions"));
    writeFileSync(join(pkg, "extensions", "subagent-runtime.ts"), "");
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: "0.71.0", pi: { extensions: ["./extensions/subagent-runtime.ts"] } }));
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
