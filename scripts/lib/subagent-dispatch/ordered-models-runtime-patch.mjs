import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const ORDERED_MODELS_PATCH_VERSION = "ordered-models.v2";
export const SUPPORTED_PI_SUBAGENTS_VERSION = "0.45.2";

const MARKER = `// pi-config patch: ${ORDERED_MODELS_PATCH_VERSION}`;
const LEGACY_MARKER = "// pi-config patch: ordered-models.v1";

function replaceOnce(source, before, after, path) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${path}: expected one patch anchor, found ${count}`);
  return source.replace(before, after);
}

function patchedAgentsSource(source, path) {
  if (source.includes(MARKER)) return source;
  if (source.includes(LEGACY_MARKER)) {
    return replaceOnce(source, "fallbackModels: models.slice(1)", "fallbackModels: models", path)
      .replaceAll(LEGACY_MARKER, MARKER);
  }
  let next = source;
  next = replaceOnce(next,
    "\tmcpDirectTools?: string[];\n\tmodel?: string;\n\tfallbackModels?: string[];\n\tthinking?: string | false;",
    `\tmcpDirectTools?: string[];\n\tmodels?: string[];\n\tmodel?: string;\n\tfallbackModels?: string[];\n\tthinking?: string | false;`, path);
  next = replaceOnce(next,
    "const EMPTY_SUBAGENT_SETTINGS: SubagentSettings = { overrides: {} };",
    `const EMPTY_SUBAGENT_SETTINGS: SubagentSettings = { overrides: {} };\n\n${MARKER}\nfunction validateOrderedModels(models: string[], agentName: string): string[] {\n\tif (models.length === 0) throw new Error(\`Agent '\${agentName}' models must contain at least one non-empty candidate.\`);\n\tconst seen = new Set<string>();\n\tfor (const model of models) {\n\t\tif (!/^[^/\\s]+\\/\\S+$/.test(model) || /["']/.test(model)) {\n\t\t\tthrow new Error(\`Agent '\${agentName}' models contains invalid candidate '\${model}'.\`);\n\t\t}\n\t\tif (seen.has(model)) throw new Error(\`Agent '\${agentName}' models contains duplicate candidate '\${model}'.\`);\n\t\tseen.add(model);\n\t}\n\treturn models;\n}`, path);
  next = replaceOnce(next,
    "\t\tconst fallbackModels = parseFrontmatterList(frontmatter.fallbackModels);",
    "\t\tconst declaredModels = parseFrontmatterList(frontmatter.models);\n\t\tconst models = declaredModels === undefined ? undefined : validateOrderedModels(declaredModels, localName);\n\t\tconst fallbackModels = models === undefined ? parseFrontmatterList(frontmatter.fallbackModels) : undefined;", path);
  next = replaceOnce(next,
    "\t\t\t...(frontmatter.model !== undefined ? { model: frontmatter.model } : {}),\n\t\t\t...(fallbackModels?.length ? { fallbackModels } : {}),",
    "\t\t\t...(models !== undefined ? { models, model: models[0], fallbackModels: models } : frontmatter.model !== undefined ? { model: frontmatter.model } : {}),\n\t\t\t...(models === undefined && fallbackModels?.length ? { fallbackModels } : {}),", path);
  next = replaceOnce(next,
    "\t\tfill(\"model\", [\"model\"], override.model === false ? undefined : override.model);",
    "\t\tfill(\"model\", [\"models\", \"model\"], override.model === false ? undefined : override.model);", path);
  next = replaceOnce(next,
    "\t\t\t[\"fallbackModels\"],",
    "\t\t\t[\"models\", \"fallbackModels\"],", path);
  return next;
}

function patchedSerializerSource(source, path) {
  if (source.includes(MARKER)) return source;
  if (source.includes(LEGACY_MARKER)) return source.replaceAll(LEGACY_MARKER, MARKER);
  let next = source;
  next = replaceOnce(next,
    "\t\"model\",\n\t\"fallbackModels\",",
    `\t"models",\n\t"model",\n\t"fallbackModels",`, path);
  next = replaceOnce(next,
    "\tif (config.model || preserve(\"model\")) lines.push(`model: ${config.model ?? \"\"}`);\n\tconst fallbackModelsValue = joinComma(config.fallbackModels);\n\tif (fallbackModelsValue || preserve(\"fallbackModels\")) lines.push(`fallbackModels: ${fallbackModelsValue ?? \"\"}`);",
    `\t${MARKER}\n\tif (config.models || preserve("models")) {\n\t\tlines.push("models:");\n\t\tfor (const model of config.models ?? []) lines.push(\`  - \${model}\`);\n\t} else {\n\t\tif (config.model || preserve("model")) lines.push(\`model: \${config.model ?? ""}\`);\n\t\tconst fallbackModelsValue = joinComma(config.fallbackModels);\n\t\tif (fallbackModelsValue || preserve("fallbackModels")) lines.push(\`fallbackModels: \${fallbackModelsValue ?? ""}\`);\n\t}`, path);
  return next;
}

function patchedModelFallbackSource(source, path) {
  if (source.includes(MARKER)) return source;
  let next = source;
  next = replaceOnce(next,
    "\tscope?: ModelScopeConfig;\n\tonWarn?: (violation: ModelScopeViolation) => void;",
    "\tscope?: ModelScopeConfig;\n\tonWarn?: (violation: ModelScopeViolation) => void;\n\tprioritizePrimaryTier?: boolean;", path);
  next = replaceOnce(next,
    "\tconst rawCandidates = [primaryModel, ...(fallbackModels ?? [])];",
    `\t${MARKER}\n\tconst declaredFallbacks = fallbackModels ?? [];\n\tconst tier = options?.prioritizePrimaryTier\n\t\t? primaryModel?.match(/gpt-5\\.6-(terra|luna)(?:$|[/:.-])/i)?.[1]?.toLowerCase()\n\t\t: undefined;\n\tconst matchingTier = tier ? declaredFallbacks.filter((model) => model.toLowerCase().includes(\`gpt-5.6-\${tier}\`)) : [];\n\tconst orderedFallbacks = tier && matchingTier.length > 0\n\t\t? [...matchingTier, ...declaredFallbacks.filter((model) => !model.toLowerCase().includes(\`gpt-5.6-\${tier}\`))]\n\t\t: declaredFallbacks;\n\tconst rawCandidates = [primaryModel, ...orderedFallbacks];`, path);
  return next;
}

function patchedPreflightSource(source, path) {
  if (source.includes(MARKER)) return source;
  return replaceOnce(source,
    "const modelCandidates = buildModelCandidates(primaryModel, agent.fallbackModels, availableModels, preferredProvider, { scope: discovered.modelScope })",
    `const modelCandidates = buildModelCandidates(primaryModel, agent.fallbackModels, availableModels, preferredProvider, { scope: discovered.modelScope, prioritizePrimaryTier: agent.models !== undefined && input.model !== undefined }) ${MARKER}`, path);
}

function patchedAsyncExecutionSource(source, path) {
  if (source.includes(MARKER)) return source;
  return replaceOnce(source,
    "const modelCandidates = buildModelCandidates(primaryModel, agentConfig.fallbackModels, availableModels, ctx.currentModelProvider, { scope: ctx.modelScope })",
    `const modelCandidates = buildModelCandidates(primaryModel, agentConfig.fallbackModels, availableModels, ctx.currentModelProvider, { scope: ctx.modelScope, prioritizePrimaryTier: agentConfig.models !== undefined && params.modelOverride !== undefined }) ${MARKER}`, path);
}

function patchedForegroundExecutionSource(source, path) {
  if (source.includes(MARKER)) return source;
  return replaceOnce(source,
    "\t\t{ scope: options.modelScope },\n\t);",
    `\t\t{ scope: options.modelScope, prioritizePrimaryTier: agent.models !== undefined && options.modelOverride !== undefined },\n\t); ${MARKER}`, path);
}

export async function verifyOrderedModelsRuntimePatch(packageRoot) {
  const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (metadata.version !== SUPPORTED_PI_SUBAGENTS_VERSION) {
    throw new Error(`ordered models patch supports pi-subagents ${SUPPORTED_PI_SUBAGENTS_VERSION}, found ${metadata.version ?? "unknown"}`);
  }
  for (const relative of [
    "src/agents/agents.ts",
    "src/agents/agent-serializer.ts",
    "src/runs/shared/model-fallback.ts",
    "src/api/preflight.ts",
    "src/runs/background/async-execution.ts",
    "src/runs/foreground/execution.ts",
  ]) {
    const source = await readFile(join(packageRoot, relative), "utf8");
    if (!source.includes(MARKER)) throw new Error(`ordered models runtime patch missing: ${relative}`);
  }
  return true;
}

export async function applyOrderedModelsRuntimePatch(packageRoot) {
  const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (metadata.version !== SUPPORTED_PI_SUBAGENTS_VERSION) {
    throw new Error(`ordered models patch supports pi-subagents ${SUPPORTED_PI_SUBAGENTS_VERSION}, found ${metadata.version ?? "unknown"}`);
  }
  const files = [
    ["src/agents/agents.ts", patchedAgentsSource],
    ["src/agents/agent-serializer.ts", patchedSerializerSource],
    ["src/runs/shared/model-fallback.ts", patchedModelFallbackSource],
    ["src/api/preflight.ts", patchedPreflightSource],
    ["src/runs/background/async-execution.ts", patchedAsyncExecutionSource],
    ["src/runs/foreground/execution.ts", patchedForegroundExecutionSource],
  ];
  for (const [relative, patch] of files) {
    const path = join(packageRoot, relative);
    const source = await readFile(path, "utf8");
    const next = patch(source, relative);
    if (next !== source) await writeFile(path, next, "utf8");
  }
  return verifyOrderedModelsRuntimePatch(packageRoot);
}
