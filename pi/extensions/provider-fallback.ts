import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createProviderFallbackExtension } from "../../src/provider-fallback/extension.ts";

export default function providerFallback(pi: ExtensionAPI) {
  createProviderFallbackExtension(pi);
}
