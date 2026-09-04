import { readFile } from "node:fs/promises";
import { join } from "node:path";

const PROVIDER_PROMPT_MAP = {
  tokenhub: {
    pattern: /^Peach-07-17-DogFooding$/i,
    file: "SYSTEM.qwen.md",
  },
};

const promptCache = new Map();

async function loadPrompt(piConfigDir, filename) {
  if (promptCache.has(filename)) return promptCache.get(filename);
  const content = await readFile(join(piConfigDir, "pi", filename), "utf8");
  promptCache.set(filename, content);
  return content;
}

function escapeXml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatSkills(skills) {
  const visible = skills.filter((s) => !s.disableModelInvocation);
  if (visible.length === 0) return "";

  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];
  for (const skill of visible) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

function rebuildWithCustomTemplate(template, opts) {
  let prompt = template;

  if (opts.appendSystemPrompt) {
    prompt += `\n\n${opts.appendSystemPrompt}`;
  }

  const contextFiles = opts.contextFiles ?? [];
  if (contextFiles.length > 0) {
    prompt += "\n\n<project_context>\n\n";
    prompt += "Project-specific instructions and guidelines:\n\n";
    for (const { path: filePath, content } of contextFiles) {
      prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
    }
    prompt += "</project_context>\n";
  }

  const skills = opts.skills ?? [];
  const tools = opts.selectedTools ?? ["read"];
  if (tools.includes("read") && skills.length > 0) {
    prompt += formatSkills(skills);
  }

  const cwd = (opts.cwd ?? ".").replace(/\\/g, "/");
  prompt += `\nCurrent working directory: ${cwd}`;
  return prompt;
}

export function createModelSystemPromptExtension(pi, {
  piConfigDir = join(import.meta.dirname, "..", ".."),
} = {}) {
  pi.on("before_agent_start", async (event, ctx) => {
    const model = ctx.model;
    if (!model) return undefined;

    const config = PROVIDER_PROMPT_MAP[model.provider];
    if (!config) return undefined;
    if (!config.pattern.test(model.id)) return undefined;

    const template = await loadPrompt(piConfigDir, config.file);
    const systemPrompt = rebuildWithCustomTemplate(template, event.systemPromptOptions ?? {});
    return { systemPrompt };
  });
}

export default createModelSystemPromptExtension;
