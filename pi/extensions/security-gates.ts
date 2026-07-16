import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSecurityGatesExtension } from "../../scripts/lib/security-gates-extension.mjs";

export default function securityGates(pi: ExtensionAPI) {
  createSecurityGatesExtension(pi);
}
