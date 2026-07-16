import { readFile } from "node:fs/promises";
import { join } from "node:path";

const PROVIDER_PROMPT_MAP = {
  "openai-idealab": { pattern: /Qwen/i, file: "SYSTEM.qwen.md" },
  "anthropic-idealab": { pattern: /claude/i, file: "SYSTEM.anthropic.md" },
};

const promptCache = new Map();

async function loadPrompt(piConfigDir, filename) {
  if (promptCache.has(filename)) return promptCache.get(filename);
  const content = await readFile(join(piConfigDir, "pi", filename), "utf8");
  promptCache.set(filename, content);
  return content;
}

export function createModelSystemPromptExtension(pi, {
  piConfigDir = join(import.meta.dirname, "..", ".."),
} = {}) {
  pi.on("before_agent_start", async (_event, ctx) => {
    const model = ctx.model;
    if (!model) return undefined;

    const config = PROVIDER_PROMPT_MAP[model.provider];
    if (!config) return undefined;
    if (!config.pattern.test(model.id)) return undefined;

    const systemPrompt = await loadPrompt(piConfigDir, config.file);
    return { systemPrompt };
  });
}

export default createModelSystemPromptExtension;
