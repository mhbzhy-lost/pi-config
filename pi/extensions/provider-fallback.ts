import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createProviderFallbackExtension } from "../../scripts/lib/provider-fallback-extension.mjs";

export default function providerFallback(pi: ExtensionAPI) {
  createProviderFallbackExtension(pi);
}
