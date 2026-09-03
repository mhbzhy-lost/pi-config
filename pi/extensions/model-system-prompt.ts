import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAgentsAppendExtension } from "../../scripts/lib/agents-append.mjs";
import { createModelSystemPromptExtension } from "../../scripts/lib/model-system-prompt.mjs";

export default function modelSystemPrompt(pi: ExtensionAPI) {
  createModelSystemPromptExtension(pi);
  createAgentsAppendExtension(pi);
}
