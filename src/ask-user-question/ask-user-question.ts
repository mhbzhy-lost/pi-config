import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAskUserQuestionRenderer } from "./renderer.ts";

export default function askUserQuestionExtension(pi: ExtensionAPI): void {
  pi.registerToolRenderer(createAskUserQuestionRenderer());
}
