import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writingSkillsTool } from "./writing-skills-tool.ts";

export default function writingSkillsExtension(pi: ExtensionAPI): void {
  pi.registerTool(writingSkillsTool);
}
