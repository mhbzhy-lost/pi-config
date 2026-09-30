import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type EnsureOptions = { target?: string; template?: string; check?: boolean };

type JsonObject = Record<string, any>;

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const defaultTarget = resolve(repoRoot, "pi/settings.json");
const defaultTemplate = resolve(repoRoot, "pi/settings.template.json");

function sourceOf(entry: any): string | undefined {
  return typeof entry === "string" ? entry : entry && typeof entry.source === "string" ? entry.source : undefined;
}

function mergeObjects(existing: any, declared: any): any {
  if (!existing || typeof existing !== "object" || Array.isArray(existing) || !declared || typeof declared !== "object" || Array.isArray(declared)) return structuredClone(declared);
  const result: JsonObject = { ...existing };
  for (const [key, value] of Object.entries(declared)) result[key] = key in result ? mergeObjects(result[key], value) : structuredClone(value);
  return result;
}

function mergeSettings(existing: JsonObject, template: JsonObject): JsonObject {
  const result = { ...existing };
  if (Array.isArray(template.packages)) {
    const packages = Array.isArray(existing.packages) ? [...existing.packages] : [];
    const sources = new Set(packages.map(sourceOf).filter(Boolean));
    for (const entry of template.packages) {
      const source = sourceOf(entry);
      if (!source || !sources.has(source)) { packages.push(structuredClone(entry)); if (source) sources.add(source); }
    }
    result.packages = packages;
  }
  if (template.subagents && typeof template.subagents === "object") result.subagents = mergeObjects(existing.subagents ?? {}, template.subagents);
  return result;
}

function missingFields(actual: JsonObject, template: JsonObject): string[] {
  const missing: string[] = [];
  if (Array.isArray(template.packages)) {
    const sources = new Set((Array.isArray(actual.packages) ? actual.packages : []).map(sourceOf).filter(Boolean));
    if (template.packages.some((entry: any) => !sources.has(sourceOf(entry)))) missing.push("packages");
  }
  if (template.subagents && JSON.stringify(mergeObjects(actual.subagents ?? {}, template.subagents)) !== JSON.stringify(actual.subagents ?? {})) missing.push("subagents");
  return missing;
}

export async function ensureSettings(options: EnsureOptions = {}): Promise<void> {
  const target = resolve(options.target ?? defaultTarget);
  const templatePath = resolve(options.template ?? defaultTemplate);
  const template = JSON.parse(await readFile(templatePath, "utf8")) as JsonObject;
  let existing: JsonObject = {};
  try { existing = JSON.parse(await readFile(target, "utf8")); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  if (options.check) {
    const missing = missingFields(existing, template);
    if (missing.length) throw new Error(`missing fields: ${missing.join(", ")}`);
    return;
  }
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
