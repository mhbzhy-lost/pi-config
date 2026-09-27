import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";

const repoRoot = process.cwd();
const pkgRoot = join(repoRoot, "packages", "pi-subagents-enhanced");
const pkgSrc = join(pkgRoot, "src");
const pkgJson = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
const exportTargets = new Set(Object.values(pkgJson.exports ?? {}).map((p) => p.replace(/^\.\//, "")));

// 步骤 2 RED 时必须保持为空并记录完整孤儿清单；GREEN 后每项豁免都须有中文理由。
const ALLOWLIST = new Map([
  ["src/subagent-dispatch/durable-run-registry.ts", "lifecycle 批次 P2-T3 交付的持久运行登记契约，当前由后续生命周期收尾批次接线；本任务不改变生产实现。"],
  ["src/subagent-dispatch/lifecycle-identity.ts", "lifecycle 批次 P1-T2 交付的纯契约模块，待生命周期收尾批次接入生产宿主；本任务不改变生产实现。"],
  ["src/subagent-dispatch/lifecycle-policy.ts", "lifecycle 批次 P1-T2 交付的纯契约模块，计划 A 不负责接入 timer、storage 或 broker。"],
  ["src/subagent-dispatch/supervisor-replay.ts", "lifecycle 批次 P3-T5 交付物，当前等待生命周期收尾批次接入生产 importer。"],
  ["src/workspace/coordinator-process.ts", "workspace 生命周期批次交付的协调进程模块，当前由宿主外部动态装载；接线不属于本任务范围。"],
]);

const PRODUCTION_ROOTS = [
  join(pkgRoot, "src"), join(pkgRoot, "extensions"), join(pkgRoot, "child-extensions"), join(pkgRoot, "scripts"),
  join(repoRoot, "src"), join(repoRoot, "pi", "extensions"), join(repoRoot, "scripts"),
];

function walkTs(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const IMPORT_SPECIFIER = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;

function resolvesTo(consumerFile, specifier, targetFile) {
  if (!specifier.startsWith(".")) return false;
  const base = join(dirname(consumerFile), specifier);
  const candidates = specifier.endsWith(".ts") ? [base] : [`${base}.ts`, `${base}.d.ts`, join(base, "index.ts")];
  return candidates.some((candidate) => candidate === targetFile);
}

function isReferenced(moduleFile, consumers, texts) {
  return consumers.some((consumer) => {
    if (consumer === moduleFile) return false;
    const text = texts.get(consumer);
    IMPORT_SPECIFIER.lastIndex = 0;
    let match;
    while ((match = IMPORT_SPECIFIER.exec(text)) !== null) {
      if (resolvesTo(consumer, match[1], moduleFile)) return true;
    }
    return false;
  });
}

function findOrphans(allowlist) {
  const modules = walkTs(pkgSrc);
  const consumers = PRODUCTION_ROOTS.flatMap(walkTs);
  const texts = new Map(consumers.map((f) => [f, readFileSync(f, "utf8")]));
  const orphans = [];
  for (const file of modules) {
    const rel = relative(pkgRoot, file).split(sep).join("/");
    if (exportTargets.has(rel) || allowlist.has(rel)) continue;
    if (!isReferenced(file, consumers, texts)) orphans.push(rel);
  }
  return orphans;
}

test("src 下每个模块都有非测试的生产消费方（孤儿模块守卫）", () => {
  const orphans = findOrphans(ALLOWLIST);
  assert.deepEqual(orphans, [],
    `发现孤儿模块（无非测试 importer、不在 package exports、不在 allowlist）：\n  ${orphans.join("\n  ")}\n` +
    "处理方式三选一：接线到生产入口 / 删除该模块 / 加入 ALLOWLIST 并写明中文理由与归属批次。",
  );
});

test("ALLOWLIST 不含已失效条目（防止豁免表腐化）", () => {
  const stale = [...ALLOWLIST.keys()].filter((rel) => !existsSync(join(pkgRoot, rel)));
  assert.deepEqual(stale, [], `ALLOWLIST 含已不存在的模块，请移除条目：${stale.join(", ")}`);
});

test("ALLOWLIST 每个条目都有非空中文理由", () => {
  const empty = [...ALLOWLIST.entries()].filter(([, reason]) => typeof reason !== "string" || reason.trim().length === 0);
  assert.deepEqual(empty.map(([rel]) => rel), [], "ALLOWLIST 条目缺少理由");
});

test("检测算法不被同名 basename 误导（负向自检，在临时副本上进行）", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "orphan-guard-neg-"));
  try {
    cpSync(pkgSrc, join(sandbox, "src"), { recursive: true });
    writeFileSync(join(sandbox, "src", "contracts", "prompt.ts"), "export const A = 1;\n");
    writeFileSync(join(sandbox, "src", "subagent-dispatch", "prompt.ts"), "export const B = 2;\n");
    writeFileSync(join(sandbox, "src", "contracts", "consumer.ts"), 'import { A } from "./prompt.ts";\nexport default A;\n');
    const consumers = walkTs(join(sandbox, "src"));
    const texts = new Map(consumers.map((f) => [f, readFileSync(f, "utf8")]));
    assert.equal(isReferenced(join(sandbox, "src", "contracts", "prompt.ts"), consumers, texts), true);
    assert.equal(isReferenced(join(sandbox, "src", "subagent-dispatch", "prompt.ts"), consumers, texts), false);
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});
