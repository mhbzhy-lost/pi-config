import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { browserTool } from "./browser/browser.ts";
import { resignIpaTool } from "./resign-ios-ipa/resign-ios-ipa.ts";
import { searchTool } from "./search/search.ts";
import { writingSkillsTool } from "./writing-skills/writing-skills.ts";

export default function progressiveTools(pi: ExtensionAPI): void {
  pi.registerTool(searchTool);
  pi.registerTool(browserTool);
  pi.registerTool(resignIpaTool);
  pi.registerTool(writingSkillsTool);
}
