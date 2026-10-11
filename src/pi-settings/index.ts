import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type EnsureOptions = {
  target?: string;
  template?: string;
  check?: boolean;
  r2cAdapterDir?: string;
};

type JsonObject = Record<string, unknown>;
type DirectoryProbe = { exists: boolean; error?: NodeJS.ErrnoException };

export const R2C_ADAPTER_SOURCE = "../../.r2c/integrations/pi-adapter";
export const TASK_SCHEDULER_SOURCE = "npm:@amaster.ai/pi-task-scheduler@0.1.9";
const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const;
const SELECTOR_FIELDS = ["defaultTools", "extensions", "skills"] as const;
const SHARED_SCALAR_FIELDS = ["hideThinkingBlock"] as const;

const moduleRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const defaultTarget = resolve(moduleRoot, "pi/settings.json");
const defaultTemplate = resolve(moduleRoot, "pi/settings.template.json");

export function sourceOf(entry: unknown): string | undefined {
  return typeof entry === "string"
    ? entry
    : entry && typeof entry === "object" && typeof (entry as { source?: unknown }).source === "string"
      ? (entry as { source: string }).source
      : undefined;
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isSelector(value: unknown): value is string {
  return typeof value === "string" && (/^[+-][^+-].*$/.test(value) || /^!.+$/.test(value));
}

function oppositeSelector(value: string): string | undefined {
  if (value.startsWith("+")) return `-${value.slice(1)}`;
  if (value.startsWith("-")) return `+${value.slice(1)}`;
  return undefined;
}

function assertSelectorConflicts(existing: JsonObject, declared: JsonObject): void {
  for (const field of SELECTOR_FIELDS) {
    const current = Array.isArray(existing[field]) ? existing[field] : [];
    const additions = Array.isArray(declared[field]) ? declared[field] : [];
    for (const entry of additions) {
      if (!isSelector(entry)) continue;
      const opposite = oppositeSelector(entry);
      if (opposite && (current.includes(opposite) || additions.includes(opposite))) {
        throw Object.assign(new Error(`资源选择冲突：${field} ${entry.slice(1)}`), {
          code: "SETTINGS_RESOURCE_OVERRIDE_CONFLICT",
          field,
          selector: entry.slice(1),
        });
      }
    }
  }
}

function validateSharedScalars(existing: JsonObject, declared: JsonObject): void {
  for (const field of SHARED_SCALAR_FIELDS) {
    for (const [label, value] of [["template", declared[field]], ["settings", existing[field]]] as const) {
      if (value !== undefined && typeof value !== "boolean") {
        throw Object.assign(new Error(`${label}.${field} 必须是 boolean`), {
          code: "SETTINGS_INVALID_VALUE",
          field,
          value,
        });
      }
    }
  }
}

function mergeSelectorList(existing: unknown, declared: unknown): unknown {
  if (!Array.isArray(declared)) return existing;
  const current = Array.isArray(existing) ? [...existing] : [];
  const selectors = declared.filter(isSelector);
  return [...current.filter((entry) => !selectors.includes(entry)), ...selectors.map(clone)];
}

function mergeObjects(existing: unknown, declared: unknown): unknown {
  if (!isRecord(existing) || !isRecord(declared)) return clone(declared);
  const result: JsonObject = { ...existing };
  for (const [key, value] of Object.entries(declared)) {
    result[key] = key in result ? mergeObjects(result[key], value) : clone(value);
  }
  return result;
}

function mergePackages(existing: unknown, declared: unknown): unknown[] | undefined {
  if (!Array.isArray(declared)) return Array.isArray(existing) ? clone(existing) : undefined;
  const packages = Array.isArray(existing) ? existing.map(clone) : [];
  for (let index = 0; index < packages.length; index += 1) {
    if (sourceOf(packages[index]) === TASK_SCHEDULER_SOURCE) packages[index] = mergeSchedulerEntry(packages[index]);
  }
  const positions = new Map<string, number>();
  for (let index = 0; index < packages.length; index += 1) {
    const source = sourceOf(packages[index]);
    if (source && !positions.has(source)) positions.set(source, index);
  }
  for (const entry of declared) {
    const source = sourceOf(entry);
    if (!source) {
      packages.push(clone(entry));
      continue;
    }
    const position = positions.get(source);
    if (position === undefined) {
      positions.set(source, packages.length);
      packages.push(source === TASK_SCHEDULER_SOURCE ? mergeSchedulerEntry(entry) : clone(entry));
    } else if (source === TASK_SCHEDULER_SOURCE) {
      packages[position] = mergeSchedulerEntry(packages[position]);
    }
  }
  // 只对调度器去重；其它 package 的重复条目可能是用户有意保留的配置。
  const schedulerIndex = positions.get(TASK_SCHEDULER_SOURCE);
  if (schedulerIndex !== undefined) {
    const scheduler = packages[schedulerIndex];
    const result: unknown[] = [];
    let retained = false;
    for (const entry of packages) {
      if (sourceOf(entry) !== TASK_SCHEDULER_SOURCE) result.push(entry);
      else if (!retained) {
        result.push(scheduler);
        retained = true;
      }
    }
    return result;
  }
  return packages;
}

function mergeSchedulerEntry(entry: unknown): unknown {
  const result: JsonObject = isRecord(entry) ? { ...entry } : { source: TASK_SCHEDULER_SOURCE };
  for (const field of RESOURCE_FIELDS) result[field] = [];
  return result;
}

function schedulerEntries(settings: JsonObject): unknown[] {
  return Array.isArray(settings.packages)
    ? settings.packages.filter((entry) => sourceOf(entry) === TASK_SCHEDULER_SOURCE)
    : [];
}

function schedulerNeedsNormalization(settings: JsonObject): boolean {
  const entries = schedulerEntries(settings);
  return entries.length !== 1 || entries.some((entry) => !isRecord(entry) || RESOURCE_FIELDS.some((field) => !Array.isArray(entry[field]) || entry[field].length !== 0));
}

function mergeSettings(existing: JsonObject, declared: JsonObject): JsonObject {
  const result: JsonObject = { ...existing };
  if (Array.isArray(declared.packages)) result.packages = mergePackages(existing.packages, declared.packages);
  for (const field of SELECTOR_FIELDS) {
    if (!Array.isArray(declared[field])) continue;
    if (field === "defaultTools" && declared[field].some((entry) => !isSelector(entry))) {
      result[field] = clone(declared[field]);
    } else {
      result[field] = mergeSelectorList(existing[field], declared[field]);
    }
  }
  if (isRecord(declared.subagents)) result.subagents = mergeObjects(existing.subagents ?? {}, declared.subagents);
  if (existing.hideThinkingBlock === undefined && declared.hideThinkingBlock !== undefined) {
    result.hideThinkingBlock = declared.hideThinkingBlock;
  }
  return result;
}

function withoutR2cAdapter(packages: unknown): unknown {
  return Array.isArray(packages) ? packages.filter((entry) => sourceOf(entry) !== R2C_ADAPTER_SOURCE) : packages;
}

function hasPackageSource(settings: JsonObject, source: string): boolean {
  return Array.isArray(settings.packages) && settings.packages.some((entry) => sourceOf(entry) === source);
}

function missingFields(actual: JsonObject, template: JsonObject): string[] {
  const missing: string[] = [];
  if (Array.isArray(template.packages)) {
    const sources = new Set((Array.isArray(actual.packages) ? actual.packages : []).map(sourceOf).filter(Boolean));
    for (const entry of template.packages) {
      const source = sourceOf(entry);
      if (source && source !== R2C_ADAPTER_SOURCE && !sources.has(source)) missing.push("packages");
    }
  }
  for (const field of SELECTOR_FIELDS) {
    if (Array.isArray(template[field])) {
      const current = Array.isArray(actual[field]) ? actual[field] : [];
      if (template[field].some((entry) => isSelector(entry) && !current.includes(entry))) missing.push(field);
    }
  }
  for (const field of SHARED_SCALAR_FIELDS) {
    if (template[field] !== undefined && actual[field] === undefined) missing.push(field);
    if (actual[field] !== undefined && typeof actual[field] !== "boolean") missing.push(field);
  }
  if (isRecord(template.subagents) && JSON.stringify(mergeObjects(actual.subagents ?? {}, template.subagents)) !== JSON.stringify(actual.subagents ?? {})) missing.push("subagents");
  const declaredScheduler = Array.isArray(template.packages)
    && template.packages.some((entry) => sourceOf(entry) === TASK_SCHEDULER_SOURCE);
  if (declaredScheduler) {
    if (!hasPackageSource(actual, TASK_SCHEDULER_SOURCE)) missing.push("packages");
    if (schedulerNeedsNormalization(actual)) missing.push("packages");
  }
  return [...new Set(missing)];
}

export async function probeDirectory(path: string): Promise<DirectoryProbe> {
  try {
    await access(path, constants.R_OK);
    if ((await stat(path)).isDirectory()) return { exists: true };
    return { exists: false };
  } catch (error) {
    const filesystemError = error as NodeJS.ErrnoException;
    if (filesystemError.code === "ENOENT" || filesystemError.code === "ENOTDIR") return { exists: false };
    return { exists: false, error: filesystemError };
  }
}

export function resolveR2cAdapterDirectory(target: string, override?: string): string {
  return resolve(override ?? join(dirname(target), R2C_ADAPTER_SOURCE));
}

async function readJson(path: string): Promise<JsonObject> {
  return JSON.parse(await readFile(path, "utf8")) as JsonObject;
}

export async function ensureSettings(options: EnsureOptions = {}): Promise<void> {
  const target = resolve(options.target ?? defaultTarget);
  const templatePath = resolve(options.template ?? defaultTemplate);
  const r2cAdapterDir = resolveR2cAdapterDirectory(target, options.r2cAdapterDir);
  const r2c = await probeDirectory(r2cAdapterDir);
  if (r2c.error) throw Object.assign(new Error(`无法读取 r2c pi-adapter：${r2c.error.message}`, { cause: r2c.error }), { code: "SETTINGS_R2C_UNREADABLE" });
  let template = await readJson(templatePath);
  validateSharedScalars({}, template);
  const declaredPackages = Array.isArray(template.packages) ? [...template.packages] : [];
  if (r2c.exists && !declaredPackages.some((entry) => sourceOf(entry) === R2C_ADAPTER_SOURCE)) {
    declaredPackages.push(R2C_ADAPTER_SOURCE);
  }
  template = { ...template, packages: declaredPackages };
  let existing: JsonObject = {};
  try {
    existing = await readJson(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  validateSharedScalars(existing, template);
  assertSelectorConflicts(existing, template);
  if (!r2c.exists) template = { ...template, packages: withoutR2cAdapter(template.packages) as unknown[] };

  if (options.check) {
    const problems = missingFields(existing, template);
    if (!r2c.exists && hasPackageSource(existing, R2C_ADAPTER_SOURCE)) problems.push("stale r2c adapter package");
    if (problems.length) throw new Error(`配置不完整：${[...new Set(problems)].join(", ")}`);
    return;
  }

  if (!r2c.exists) existing = { ...existing, packages: withoutR2cAdapter(existing.packages) as unknown[] };
  const result = Object.keys(existing).length ? mergeSettings(existing, template) : template;
  const output = `${JSON.stringify(result, null, 2)}\n`;
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, output, { mode: 0o600 });
  await rename(temporary, target);
}

export async function checkSettings(options: {
  settings: JsonObject;
  template?: JsonObject;
  target?: string;
  r2cAdapterDir?: string;
}): Promise<string[]> {
  const target = resolve(options.target ?? defaultTarget);
  const r2cDir = resolveR2cAdapterDirectory(target, options.r2cAdapterDir);
  const r2c = await probeDirectory(r2cDir);
  if (r2c.error) throw Object.assign(new Error(`无法读取 r2c pi-adapter：${r2c.error.message}`, { cause: r2c.error }), { code: "SETTINGS_R2C_UNREADABLE" });
  const issues: string[] = [];
  try {
    validateSharedScalars(options.settings, options.template ?? {});
  } catch (error) {
    issues.push((error as Error).message);
  }
  const registered = hasPackageSource(options.settings, R2C_ADAPTER_SOURCE);
  if (r2c.exists && !registered) issues.push(`r2c pi-adapter is installed but not registered in pi/settings.json (run: node scripts/ensure-pi-settings.ts): ${R2C_ADAPTER_SOURCE}`);
  if (!r2c.exists && registered) issues.push(`pi/settings.json references missing local r2c adapter package: ${R2C_ADAPTER_SOURCE}`);
  if (schedulerNeedsNormalization(options.settings)) issues.push("task scheduler package resources must all be disabled and uniquely configured");
  return issues;
}

export { defaultTarget, defaultTemplate };
