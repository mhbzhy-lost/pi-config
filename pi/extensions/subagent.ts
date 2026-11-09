import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import createMinimalSubagentExtension from "../../src/subagent/index.ts";

export default function subagent(pi: ExtensionAPI): void {
  createMinimalSubagentExtension(pi);
}
