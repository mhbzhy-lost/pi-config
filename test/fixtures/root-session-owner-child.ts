import { writeFileSync } from "node:fs";

import { installRootSessionOwner } from "../../pi/child-extensions/root-session-owner.ts";

const reportPath = process.env.ROOT_OWNER_REPORT;
if (!reportPath) throw new Error("ROOT_OWNER_REPORT is required");

let messages = 0;
let sigterms = 0;
const report = () => writeFileSync(reportPath, JSON.stringify({ messages, sigterms }));

process.on("SIGTERM", () => {
  sigterms += 1;
  report();
  setTimeout(() => process.exit(0), 50);
});

await installRootSessionOwner({
  sendMessage() {
    messages += 1;
    report();
  },
});
process.send?.({ type: "owner-ready" });
setInterval(() => {}, 1_000);
