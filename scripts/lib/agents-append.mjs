import { readFile as readTextFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_AGENTS_APPEND_PATH = join(
  import.meta.dirname,
  "..",
  "..",
  "pi",
  "AGENTS_APPEND.md",
);

const UNREADABLE_DIAGNOSTIC =
  "Required Pi global AGENTS_APPEND.md is missing or unreadable";
const EMPTY_DIAGNOSTIC = "Required Pi global AGENTS_APPEND.md is empty";

async function loadInstructions(agentsAppendPath, readFile) {
  let content;
  try {
    content = await readFile(agentsAppendPath, "utf8");
  } catch {
    return { error: UNREADABLE_DIAGNOSTIC };
  }

  const instructions = content.trim();
  if (!instructions) return { error: EMPTY_DIAGNOSTIC };
  return { instructions };
}

function notifyConfigurationError(ctx, message) {
  try {
    ctx.ui?.notify?.(message, "error");
  } catch {
    // Notification failure must not reopen the provider path.
  }
}

function createBlockingSystemPrompt(message) {
  return [
    '<pi_global_configuration_error source="PI_CODING_AGENT_DIR/AGENTS_APPEND.md">',
    message,
    "Do not call tools or modify any state.",
    "Report this configuration error to the user and stop.",
    "</pi_global_configuration_error>",
  ].join("\n");
}

export function createAgentsAppendExtension(pi, {
  agentsAppendPath = DEFAULT_AGENTS_APPEND_PATH,
  readFile = readTextFile,
} = {}) {
  let pendingInstructions;

  pi.on("input", async (_event, ctx) => {
    pendingInstructions = undefined;
    const loaded = await loadInstructions(agentsAppendPath, readFile);
    if (loaded.error) {
      notifyConfigurationError(ctx, loaded.error);
      return { action: "handled" };
    }
    pendingInstructions = loaded.instructions;
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (event) => {
    const loaded = pendingInstructions === undefined
      ? await loadInstructions(agentsAppendPath, readFile)
      : { instructions: pendingInstructions };
    pendingInstructions = undefined;
    if (loaded.error) {
      return { systemPrompt: createBlockingSystemPrompt(loaded.error) };
    }

    return {
      systemPrompt: [
        event.systemPrompt,
        '<pi_global_instructions source="PI_CODING_AGENT_DIR/AGENTS_APPEND.md">',
        loaded.instructions,
        "</pi_global_instructions>",
      ].join("\n\n"),
    };
  });
}

export default createAgentsAppendExtension;
