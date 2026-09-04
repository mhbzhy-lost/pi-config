import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const ORDERED_MODELS_PATCH_VERSION = "ordered-models.v3";
export const WORKFLOW_CHILD_EXTENSIONS_PATCH_VERSION = "workflow-child-extensions.v1";
export const SUPPORTED_PI_SUBAGENTS_VERSION = "0.62.0";
const MARKER = `// pi-config patch: ${ORDERED_MODELS_PATCH_VERSION}`;
const CHILD_EXTENSIONS_MARKER = `// pi-config patch: ${WORKFLOW_CHILD_EXTENSIONS_PATCH_VERSION}`;

function once(source, re, replacement, path) {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const matches = [...source.matchAll(new RegExp(re.source, flags))];
  if (matches.length !== 1) throw new Error(`${path}: expected one patch anchor, found ${matches.length}`);
  return source.replace(re, replacement);
}
function agents(source, path) {
  if (source.includes(MARKER)) return source;
  let next = source;
  const interfaceStart = next.indexOf("export interface AgentConfig {");
  if (interfaceStart >= 0) {
    const interfaceEnd = next.indexOf("\n}", interfaceStart);
    const block = next.slice(interfaceStart, interfaceEnd);
    const patchedBlock = once(block, /(\tmodel\?: string;\n)(\tmodelProvider\?: string;)/, `$1\tmodels?: string[];\n$2`, path);
    next = next.slice(0, interfaceStart) + patchedBlock + next.slice(interfaceEnd);
  } else {
    next = once(next, /(\tmcpDirectTools\?: string\[\];\n\tmodel\?: string;)/, `$1\n\tmodels?: string[];`, path);
  }
  next = once(next, /(const EMPTY_SUBAGENT_SETTINGS[^\n]*\n)/, `$1\n${MARKER}\nfunction validateOrderedModels(models: string[], agentName: string): string[] {\n\tif (!models.length) throw new Error(\`Agent '\${agentName}' models must contain at least one candidate.\`);\n\tconst seen = new Set<string>();\n\tfor (const model of models) {\n\t\tif (!/^[^/\\s]+\\/\\S+$/.test(model) || /[\"']/.test(model) || seen.has(model)) throw new Error(\`Agent '\${agentName}' models contains invalid or duplicate candidate '\${model}'.\`);\n\t\tseen.add(model);\n\t}\n\treturn models;\n}\n`, path);
  next = once(next, /(\t\tconst fallbackModels = parseFrontmatterList\(frontmatter\.fallbackModels\);)/, `\t\tconst declaredModels = parseFrontmatterList(frontmatter.models);\n\t\tconst models = declaredModels === undefined ? undefined : validateOrderedModels(declaredModels, localName);\n\t\tconst fallbackModels = models === undefined ? parseFrontmatterList(frontmatter.fallbackModels) : undefined;`, path);
  next = once(next, /(\t\t\t\.\.\.\(frontmatter\.model !== undefined \? \{ model: frontmatter\.model \} : \{\}\),\n\t\t\t\.\.\.\(fallbackModels\?\.length \? \{ fallbackModels \} : \{\}\),)/, `\t\t\t...(models !== undefined ? { models, model: models[0], fallbackModels: models } : frontmatter.model !== undefined ? { model: frontmatter.model } : {}),\n\t\t\t...(models === undefined && fallbackModels?.length ? { fallbackModels } : {}),`, path);
  if (next.includes('fill("model", ["model"], override.model === false ? undefined : override.model);')) {
    next = once(next, /fill\("model", \["model"\], override\.model === false \? undefined : override\.model\);/, 'fill("model", ["models", "model"], override.model === false ? undefined : override.model);', path);
  } else {
    next = once(next, /if \(override\.fallbackModels !== undefined\) \{\n\t\tfill\(\n\t\t\t"fallbackModels",[\s\S]*?\n\t\t\);\n\t\}/, 'if (override.fallbackModels !== undefined) {\n\t\tfill("fallbackModels", ["models", "fallbackModels"], override.fallbackModels === false ? undefined : [...override.fallbackModels]);\n\t}', path);
  }
  next = next.replace('["fallbackModels"],', '["models", "fallbackModels"],');
  return next;
}
function serializer(source, path) {
  if (source.includes(MARKER)) return source;
  let next = once(source, /\t"model",\n\t"fallbackModels",/, '\t"models",\n\t"model",\n\t"fallbackModels",', path);
  return once(next, /\tif \(config\.model \|\| preserve\("model"\)\) lines\.push\(`model: \$\{config\.model \?\? ""\}`\);\n\tconst fallbackModelsValue = joinComma\(config\.fallbackModels\);\n\tif \(fallbackModelsValue \|\| preserve\("fallbackModels"\)\) lines\.push\(`fallbackModels: \$\{fallbackModelsValue \?\? ""\}`\);/, `\t${MARKER}\n\tif (config.models || preserve("models")) { lines.push("models:"); for (const model of config.models ?? []) lines.push(\`  - \${model}\`); } else {\n\t\tif (config.model || preserve("model")) lines.push(\`model: \${config.model ?? ""}\`);\n\t\tconst fallbackModelsValue = joinComma(config.fallbackModels);\n\t\tif (fallbackModelsValue || preserve("fallbackModels")) lines.push(\`fallbackModels: \${fallbackModelsValue ?? ""}\`);\n\t}`, path);
}
function fallback(source, path) {
  if (source.includes(MARKER)) return source;
  const interfaceStart = source.indexOf("export interface BuildModelCandidatesOptions {");
  let next;
  if (interfaceStart >= 0) {
    const interfaceEnd = source.indexOf("\n}", interfaceStart);
    const block = source.slice(interfaceStart, interfaceEnd);
    const patchedBlock = once(block, /(\tonWarn\?: \(violation: ModelScopeViolation\) => void;)/, `$1\n\tprioritizePrimaryTier?: boolean;`, path);
    next = source.slice(0, interfaceStart) + patchedBlock + source.slice(interfaceEnd);
  } else {
    next = once(source, /(\tonWarn\?: \(violation: ModelScopeViolation\) => void;)/, `$1\n\tprioritizePrimaryTier?: boolean;`, path);
  }
  next = once(next, /\tconst rawCandidates = \[primaryModel, \.\.\.\(fallbackModels \?\? \[\]\)\];/,  `\t${MARKER}\n\tconst declaredFallbacks = fallbackModels ?? [];\n\tconst tier = options?.prioritizePrimaryTier ? primaryModel?.match(/gpt-5\\.6-(terra|luna)(?:$|[/:.-])/i)?.[1]?.toLowerCase() : undefined;\n\tconst matchingTier = tier ? declaredFallbacks.filter((model) => model.toLowerCase().includes(\`gpt-5.6-\${tier}\`)) : [];\n\tconst orderedFallbacks = tier && matchingTier.length ? [...matchingTier, ...declaredFallbacks.filter((model) => !model.toLowerCase().includes(\`gpt-5.6-\${tier}\`))] : declaredFallbacks;\n\tconst rawCandidates = [primaryModel, ...orderedFallbacks];`, path);
  return next;
}
function patchBuildModelCandidateCalls(source, path) {
  let calls = 0;
  const callPattern = /buildModelCandidates\([\s\S]*?,\s*\{\n([\s\S]*?)\n(\s*)\}\s*\)/g;
  const next = source.replace(callPattern, (match, options, closeIndent) => {
    calls += 1;
    if (/\bprioritizePrimaryTier\s*:/.test(options)) return match;
    const scope = options.match(/^(\s*)scope:\s*[^,\n]+,\s*$/m);
    if (!scope) throw new Error(`${path}: buildModelCandidates options have no scope anchor`);
    return match.replace(scope[0], `${scope[0]}\n${scope[1]}prioritizePrimaryTier: true,`);
  });
  if (calls === 0) throw new Error(`${path}: expected one buildModelCandidates call, found 0`);
  return `${next}\n${MARKER}\n`;
}
function execution(source, path) {
  if (source.includes(MARKER)) return source;
  if (source.includes("buildModelCandidates(")) return patchBuildModelCandidateCalls(source, path);
  return once(source, /\{ scope: options\.modelScope \},/, `{ scope: options.modelScope, prioritizePrimaryTier: true },`, path) + `\n${MARKER}\n`;
}
function workflowChildExtensions(source, path) {
  if (source.includes(CHILD_EXTENSIONS_MARKER)) return source;
  let next = once(source, /(\tworkflowAwaitAsync\?: boolean;\n)/, `$1\tsubagentOnlyExtensions?: string[];\n`, path);
  next = once(next, /(\tconst toolPlan = resolvePiLaunchToolPlan\(\{\n\t\ttools: agentConfig\.tools,)/, `\t${CHILD_EXTENSIONS_MARKER}\n\tconst workflowSubagentOnlyExtensions = params.subagentOnlyExtensions;\n\tconst effectiveSubagentOnlyExtensions = [...new Set([\n\t\t...(agentConfig.subagentOnlyExtensions ?? []),\n\t\t...(workflowSubagentOnlyExtensions ?? []),\n\t])];\n$1`, path);
  next = once(next, /(\t\tsubagentOnlyExtensions: )agentConfig\.subagentOnlyExtensions,(?=[\s\S]*?\n\tconst launchResolvedExtensions)/, `$1effectiveSubagentOnlyExtensions,`, path);
  next = once(next, /(\t{6}subagentOnlyExtensions: )agentConfig\.subagentOnlyExtensions,(?=[\s\S]*?\n\t{6}mcpDirectTools:)/, `$1effectiveSubagentOnlyExtensions,`, path);
  return next;
}
function workflowChildExtensionBridge(source, path) {
  if (source.includes(CHILD_EXTENSIONS_MARKER)) return source;
  return once(source, /(\t{3}workflowAwaitAsync: params\.workflowAwaitAsync,\n)/, `$1\t\t\t${CHILD_EXTENSIONS_MARKER}\n\t\t\tsubagentOnlyExtensions: (params as typeof params & { subagentOnlyExtensions?: string[] }).subagentOnlyExtensions,\n`, path);
}
function asyncExecution(source, path) {
  return workflowChildExtensions(execution(source, path), path);
}
function noop(source) { return source; }
const files = [
  ["src/agents/agents.ts", agents], ["src/agents/agent-serializer.ts", serializer],
  ["src/runs/shared/model-fallback.ts", fallback], ["src/api/preflight.ts", execution],
  ["src/runs/background/async-execution.ts", asyncExecution], ["src/runs/foreground/execution.ts", execution],
];
const workflowChildExtensionFiles = [["src/runs/foreground/subagent-executor.ts", workflowChildExtensionBridge]];
export async function verifyOrderedModelsRuntimePatch(packageRoot) {
  const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (metadata.version !== SUPPORTED_PI_SUBAGENTS_VERSION) throw new Error(`ordered models patch supports pi-subagents ${SUPPORTED_PI_SUBAGENTS_VERSION}, found ${metadata.version ?? "unknown"}`);
  for (const [relative] of files) {
    const source = await readFile(join(packageRoot, relative), "utf8");
    if (!source.includes(MARKER)) throw new Error(`ordered models runtime patch missing: ${relative}`);
    if (relative === "src/runs/background/async-execution.ts" && !source.includes(CHILD_EXTENSIONS_MARKER)) throw new Error(`workflow child extensions runtime patch missing: ${relative}`);
  }
  for (const [relative] of workflowChildExtensionFiles) if (!(await readFile(join(packageRoot, relative), "utf8")).includes(CHILD_EXTENSIONS_MARKER)) throw new Error(`workflow child extensions runtime patch missing: ${relative}`);
  return true;
}
export async function applyOrderedModelsRuntimePatch(packageRoot) {
  const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (metadata.version !== SUPPORTED_PI_SUBAGENTS_VERSION) throw new Error(`ordered models patch supports pi-subagents ${SUPPORTED_PI_SUBAGENTS_VERSION}, found ${metadata.version ?? "unknown"}`);
  for (const [relative, patch] of files) { const path = join(packageRoot, relative); const source = await readFile(path, "utf8"); const next = patch(source, relative); if (next !== source) await writeFile(path, next); }
  for (const [relative, patch] of workflowChildExtensionFiles) { const path = join(packageRoot, relative); const source = await readFile(path, "utf8"); const next = patch(source, relative); if (next !== source) await writeFile(path, next); }
  return verifyOrderedModelsRuntimePatch(packageRoot);
}
