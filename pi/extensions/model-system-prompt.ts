import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAgentsAppendExtension } from "../../src/agents-append/index.ts";
import { createModelSystemPromptExtension } from "../../src/model-system-prompt/index.ts";

export default function modelSystemPrompt(pi: ExtensionAPI) {
  createModelSystemPromptExtension(pi);
  createAgentsAppendExtension(pi);
}
