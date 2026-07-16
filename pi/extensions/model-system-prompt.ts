import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createModelSystemPromptExtension } from "../../scripts/lib/model-system-prompt.mjs";

export default function modelSystemPrompt(pi: ExtensionAPI) {
  createModelSystemPromptExtension(pi);
}
