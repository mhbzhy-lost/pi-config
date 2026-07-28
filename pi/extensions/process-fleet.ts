import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text, matchesKey, Key } from "@earendil-works/pi-tui";
import fleetExtension from "../../scripts/lib/tui/fleet-extension.mjs";

export default function processFleet(pi: ExtensionAPI) {
  fleetExtension(pi, { tui: { Container, Text }, matchesKey, Key });
}
