import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { footerLine } from "../src/tui-lite/index.ts";

test("tui footer clamps the final combined line to a narrow terminal", () => {
  const line = footerLine(
    "~/new-api-account-pool",
    "76.1%/272k  (codex-pool) gpt-5.6-sol",
    58,
  );
  assert.ok(visibleWidth(line) <= 58, `footer width was ${visibleWidth(line)}`);
});
