import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { createFooterRuntime } from "../../src/tui/footer-runtime.ts";

export default function customFooter(pi: ExtensionAPI): void {
  const runtime = createFooterRuntime(pi);
  pi.registerShortcut(Key.alt("o"), {
    description: "Open subagent status browser",
    handler: (ctx) => runtime.openBrowser(ctx),
  });
}
