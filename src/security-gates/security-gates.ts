import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSecurityGatesExtension } from "./extension.ts";

export default function securityGates(pi: ExtensionAPI) {
  createSecurityGatesExtension(pi);
}
