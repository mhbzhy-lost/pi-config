import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type EnsureOptions = { target?: string; template?: string; check?: boolean; r2cAdapterDir?: string };

type JsonObject = Record<string, any>;

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const defaultTarget = resolve(repoRoot, "pi/settings.json");
const defaultTemplate = resolve(repoRoot, "pi/settings.template.json");
// r2c 采集适配器（ai-coding-trace）：以相对 settings.json 的路径声明，package 自带
// pi.extensions 清单，挂载 package 即挂载扩展。仅在本机 ~/.r2c/integrations/pi-adapter
// 真实存在时生效；缺失时过滤模板条目并清理悬空注册（docs/bugs/bug-missing-pi-adapter-package.md）。
const R2C_ADAPTER_SOURCE = "../../.r2c/integrations/pi-adapter";

function sourceOf(entry: any): string | undefined {
  return typeof entry === "string" ? entry : entry && typeof entry.source === "string" ? entry.source : undefined;
}

function isR2cAdapterEntry(entry: any): boolean {
  return sourceOf(entry) === R2C_ADAPTER_SOURCE;
}

function withoutR2cAdapter(packages: any): any {
  return Array.isArray(packages) ? packages.filter((entry: any) => !isR2cAdapterEntry(entry)) : packages;
}

async function isInstalledDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function mergeObjects(existing: any, declared: any): any {
  if (!existing || typeof existing !== "object" || Array.isArray(existing) || !declared || typeof declared !== "object" || Array.isArray(declared)) return structuredClone(declared);
  const result: JsonObject = { ...existing };
  for (const [key, value] of Object.entries(declared)) result[key] = key in result ? mergeObjects(result[key], value) : structuredClone(value);
  return result;
}

function assertNoExactResourceOverrideConflict(existing: JsonObject, template: JsonObject): void {
  for (const field of ["extensions", "defaultTools"]) {
    const current = Array.isArray(existing[field]) ? existing[field] : [];
    const declared = Array.isArray(template[field]) ? template[field] : [];
    for (const entry of declared) {
      if (typeof entry !== "string" || !/^[+-][^+-].*$/.test(entry)) continue;
      const selector = entry.slice(1);
      const opposite = `${entry[0] === "-" ? "+" : "-"}${selector}`;
      if (current.includes(opposite) || declared.includes(opposite)) {
        throw Object.assign(new Error(`资源选择冲突：${field} ${selector}`), {
          code: "SETTINGS_RESOURCE_OVERRIDE_CONFLICT",
          field,
          selector,
        });
      }
    }
  }
}

function mergeSettings(existing: any, declared: any): any {
  const result = { ...existing };
  if (Array.isArray(declared.packages)) {
    const packages = Array.isArray(existing.packages) ? [...existing.packages] : [];
    const sources = new Set(packages.map(sourceOf).filter(Boolean));
    for (const entry of declared.packages) {
      const source = sourceOf(entry);
      if (!source || !sources.has(source)) { packages.push(structuredClone(entry)); if (source) sources.add(source); }
    }
    result.packages = packages;
  }
  for (const field of ['defaultTools','extensions']) {
    if (Array.isArray(declared[field])) {
      const current = Array.isArray(existing[field]) ? existing[field] : [];
      const additions = declared[field].filter((entry: any) => typeof entry === 'string' && /^[+-]/.test(entry));
      result[field] = [...current.filter((entry: any) => !additions.includes(entry)), ...additions];
    }
  }
  if (declared.subagents && typeof declared.subagents === "object") result.subagents = mergeObjects(existing.subagents ?? {}, declared.subagents);
  return result;
}

function missingFields(actual: JsonObject, template: JsonObject): string[] {
  const missing: string[] = [];
  if (Array.isArray(template.packages)) {
    const sources = new Set((Array.isArray(actual.packages) ? actual.packages : []).map(sourceOf).filter(Boolean));
    if (template.packages.some((entry: any) => !sources.has(sourceOf(entry)))) missing.push("packages");
  }
  for (const field of ['defaultTools','extensions']) {
    if (Array.isArray(template[field]) && template[field].some((entry:any) => !Array.isArray(actual[field]) || !actual[field].includes(entry))) missing.push(field);
  }
  if (template.subagents && JSON.stringify(mergeObjects(actual.subagents ?? {}, template.subagents)) !== JSON.stringify(actual.subagents ?? {})) missing.push("subagents");
  return missing;
}

export async function ensureSettings(options: EnsureOptions = {}): Promise<void> {
  const target = resolve(options.target ?? defaultTarget);
  const templatePath = resolve(options.template ?? defaultTemplate);
  const r2cAdapterDir = resolve(options.r2cAdapterDir ?? join(dirname(target), R2C_ADAPTER_SOURCE));
  const r2cAdapterInstalled = await isInstalledDirectory(r2cAdapterDir);
  let template = JSON.parse(await readFile(templatePath, "utf8")) as JsonObject;
  if (!r2cAdapterInstalled && Array.isArray(template.packages)) template = { ...template, packages: withoutR2cAdapter(template.packages) };
  let existing: JsonObject = {};
  try { existing = JSON.parse(await readFile(target, "utf8")); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  assertNoExactResourceOverrideConflict(existing, template);
  if (options.check) {
    const problems: string[] = [];
    const missing = missingFields(existing, template);
    if (missing.length) problems.push(`missing fields: ${missing.join(", ")}`);
    if (!r2cAdapterInstalled && Array.isArray(existing.packages) && existing.packages.some(isR2cAdapterEntry)) {
      problems.push(`stale r2c adapter package: ${R2C_ADAPTER_SOURCE}`);
    }
    if (problems.length) throw new Error(problems.join("; "));
    return;
  }
  if (!r2cAdapterInstalled && Array.isArray(existing.packages)) existing = { ...existing, packages: withoutR2cAdapter(existing.packages) };
  const result = Object.keys(existing).length ? mergeSettings(existing, template) : template;
  const output = `${JSON.stringify(result, null, 2)}\n`;
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, output, { mode: 0o600 });
  await rename(temporary, target);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const check = process.argv.includes("--check");
  ensureSettings({ check }).catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
}
