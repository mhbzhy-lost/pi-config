import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDcpRenderer } from "./renderer.ts";

export default function dcpRendererExtension(pi: ExtensionAPI): void {
  pi.registerToolRenderer(createDcpRenderer());
}
