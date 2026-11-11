import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createProviderFallbackExtension } from "./extension.ts";

export default function providerFallback(pi: ExtensionAPI) {
  createProviderFallbackExtension(pi);
}
