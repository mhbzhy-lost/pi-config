import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

// M09：本仓伪 whitelist 的重复 discovery（resources_discover scanner）已退役，
// 原生 discovery 是本仓唯一 owner。本文件不启动 session/Host，不调用模型，
// 不读真实 ~/.agents/skills：用户/项目 scope 均用合成 HOME + 合成项目目录，
// 经原生公开 API（DefaultPackageManager/SettingsManager）验证声明根与排除规则。

const repoRoot = resolve(import.meta.dirname, "..");
// 生产源扫描面：root feature 入口/实现、CLI、enhanced package 源与入口。
// scripts/lib/ 的历史 .mjs 不在生产约定内，不纳入扫描（当前 grep 亦无 resources_discover）。
const productionScanRoots = [
  "src",
  "pi/extensions",
  "scripts",
  "packages/pi-subagents-enhanced/src",
  "packages/pi-subagents-enhanced/extensions",
  "packages/pi-subagents-enhanced/child-extensions",
];

async function collectProductionTsFiles(rootDir, out) {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const fullPath = join(rootDir, entry.name);
    if (entry.isDirectory()) await collectProductionTsFiles(fullPath, out);
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(fullPath);
  }
}

async function createSyntheticSkill(skillsRoot, name) {
  await mkdir(join(skillsRoot, name), { recursive: true });
  await writeFile(
    join(skillsRoot, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: M09 合成技能 ${name}\n---\n合成内容\n`,
  );
}

/** 隔离 HOME：原生 loader 的用户根（~/.pi/agent/skills、~/.agents/skills）只指向合成目录。 */
async function withIsolatedHome(t) {
  const home = await mkdtemp(join(tmpdir(), "m09-skills-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });
  return home;
}

// 只消费本仓物理 SDK（与 test/helpers/pi-runtime.mjs 同一解析优先级），不回退全局安装。
const sdkRoot = process.env.PI_TEST_CODING_AGENT_ROOT?.trim()
  || join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent");

/** 按 manifest exports "." 的 import 条目解析入口，不依赖 CJS 自引用解析。 */
function resolveSdkEntry(root) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const target = manifest.exports?.["."];
  const subpath = typeof target === "string" ? target : target?.import;
  if (typeof subpath !== "string") throw new Error(`SDK manifest lacks a "." import export: ${root}`);
  return pathToFileURL(join(root, subpath)).href;
}

const { DefaultPackageManager, SettingsManager } = await import(resolveSdkEntry(sdkRoot));

test("原生 discovery 为唯一 owner：本仓无 resources_discover scanner，声明 scope 按模板 selector 排除退役技能", async (t) => {
  // 证据 A（静态）：旧入口与实现已删除且无 facade，生产源不再注册 resources_discover。
  assert.equal(existsSync(join(repoRoot, "pi", "extensions", "skill-whitelist.ts")), false);
  assert.equal(existsSync(join(repoRoot, "src", "skill-whitelist", "extension.ts")), false);
  const productionSources = [];
  for (const root of productionScanRoots) {
    await collectProductionTsFiles(join(repoRoot, root), productionSources);
  }
  assert.ok(productionSources.length > 0, "生产源扫描面不得为空");
  for (const file of productionSources) {
    const content = await readFile(file, "utf8");
    assert.ok(
      !content.includes("resources_discover"),
      `生产源不得注册 resources_discover（原生 discovery 为唯一 owner）: ${file}`,
    );
  }

  // 证据 B（运行）：agent 目录 settings 声明的 skills selector 对其配置 scope
  // （用户级自动发现根 agentDir/skills 与 ~/.agents/skills）有排除效果。
  const home = await withIsolatedHome(t);
  const agentDir = join(home, "agent");
  const project = join(home, "project");
  await mkdir(join(agentDir, "skills"), { recursive: true });
  // 项目内放置 .git，使原生祖先 .agents/skills 遍历停止在合成仓库根。
  await mkdir(join(project, ".git"), { recursive: true });
  await createSyntheticSkill(join(agentDir, "skills"), "plan-runner-dispatch");
  await createSyntheticSkill(join(agentDir, "skills"), "agent-dir-keep");
  await mkdir(join(home, ".agents", "skills"), { recursive: true });
  await createSyntheticSkill(join(home, ".agents", "skills"), "plan-runner-dispatch");
  await createSyntheticSkill(join(home, ".agents", "skills"), "agents-keep");

  const settingsManager = SettingsManager.inMemory({ skills: ["!**/plan-runner-dispatch/**"] });
  const packageManager = new DefaultPackageManager({ cwd: project, agentDir, settingsManager });
  const resolved = await packageManager.resolve();

  const retired = resolved.skills.filter((entry) => entry.path.includes("plan-runner-dispatch"));
  assert.equal(retired.length, 2, "两个用户级声明根都应先由原生发现、再被声明 selector 关闭");
  for (const entry of retired) {
    assert.equal(entry.enabled, false, `声明 selector 必须排除退役技能: ${entry.path}`);
    assert.equal(entry.metadata?.source, "auto", "排除发生在原生 auto-discovery 通道上");
    assert.equal(entry.metadata?.scope, "user");
  }
  const enabledPaths = resolved.skills.filter((entry) => entry.enabled).map((entry) => entry.path);
  assert.ok(enabledPaths.includes(join(agentDir, "skills", "agent-dir-keep", "SKILL.md")));
  assert.ok(enabledPaths.includes(join(home, ".agents", "skills", "agents-keep", "SKILL.md")));
  assert.equal(enabledPaths.some((path) => path.includes("plan-runner-dispatch")), false);
});

test("声明 scope 边界：项目 scope 自动发现与 resources_discover 追加通道不受用户模板 selector 约束", async (t) => {
  // 运行证据：同一用户模板 selector 不约束项目另一 scope；项目 scope 由项目 settings 声明。
  // 这是声明资源策略的边界，不是全局权限白名单。
  const home = await withIsolatedHome(t);
  const agentDir = join(home, "agent");
  const project = join(home, "project");
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(join(project, ".pi", "skills"), { recursive: true });
  await mkdir(join(project, ".agents", "skills"), { recursive: true });
  await createSyntheticSkill(join(project, ".pi", "skills"), "plan-runner-dispatch");
  await createSyntheticSkill(join(project, ".pi", "skills"), "project-keep");
  await createSyntheticSkill(join(project, ".agents", "skills"), "plan-runner-dispatch");

  const settingsManager = SettingsManager.inMemory({ skills: ["!**/plan-runner-dispatch/**"] });
  const packageManager = new DefaultPackageManager({ cwd: project, agentDir, settingsManager });
  const resolved = await packageManager.resolve();

  for (const expected of [
    join(project, ".pi", "skills", "plan-runner-dispatch", "SKILL.md"),
    join(project, ".agents", "skills", "plan-runner-dispatch", "SKILL.md"),
    join(project, ".pi", "skills", "project-keep", "SKILL.md"),
  ]) {
    const entry = resolved.skills.find((candidate) => candidate.path === expected);
    assert.ok(entry, `项目 scope 技能应被原生发现: ${expected}`);
    assert.equal(entry.enabled, true, "用户模板 selector 不约束项目另一 scope（声明边界）");
    assert.equal(entry.metadata?.source, "auto");
    assert.equal(entry.metadata?.scope, "project");
  }

  // 源码契约（本仓固定 pi SDK 1.3.0）：resources_discover 回调经 resource loader 的
  // extendResources 追加，该通道不应用 isEnabledByOverrides；第三方 callback、
  // CLI 显式路径不能被用户模板字符串一概排除，本测试只固化该边界，不宣称集合等价。
  const resourceLoaderSource = await readFile(join(sdkRoot, "dist", "core", "resource-loader.js"), "utf8");
  assert.ok(resourceLoaderSource.includes("extendResources(paths)"), "extendResources 追加通道应存在于固定版本");
  assert.ok(
    !resourceLoaderSource.includes("isEnabledByOverrides"),
    "extendResources 通道不应用 settings overrides（排除声明不能覆盖该追加通道）",
  );
});
