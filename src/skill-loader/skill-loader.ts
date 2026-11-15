import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 入口位于 <repo>/src/skill-loader/，skill 本体收在同目录 skills/<name>/SKILL.md。
const skillsRoot = join(dirname(fileURLToPath(import.meta.url)), "skills");

// 枚举 skills/ 下每个含 SKILL.md 的子目录，作为显式 skillPaths 注入。
function discoverSkillFiles(): string[] {
  if (!existsSync(skillsRoot)) return [];
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(skillsRoot, entry.name, "SKILL.md"))
    .filter((file) => existsSync(file))
    .sort();
}

// 经 resources_discover 注入本 feature 自带的 skill。extension 由 pi-config settings 声明、
// launcher 无论 cwd 都会加载，因此这些 skill 在所有使用本仓配置的会话中常驻可见。
// skill 本体收在 src/skill-loader/skills/（不放 .agents/skills/）：项目级目录发现只按 cwd
// 向上回溯，跨 cwd 场景由本入口补齐；收进 feature 自有目录也避免与目录发现形成双来源。
export default function skillLoaderExtension(pi: ExtensionAPI): void {
  pi.on("resources_discover", () => {
    return { skillPaths: discoverSkillFiles() };
  });
}
