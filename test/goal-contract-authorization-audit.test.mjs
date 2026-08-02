import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { auditAmendmentAuthorizations } from "../scripts/lib/goal-contract/authorization-audit.mjs";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "goal-auth-audit-"));
  const artifactPath = path.join(root, "authorization-evidence.json");
  writeFileSync(artifactPath, '{"status":"legacy_unverifiable"}\n');
  const artifactSha256 = createHash("sha256").update(readFileSync(artifactPath)).digest("hex");
  const amendment = {
    status: "applied",
    risk: "high",
    authorization: {
      status: "legacy_unverifiable",
      artifact: "authorization-evidence.json",
      artifactSha256,
      sourceIds: ["user-message:legacy"],
    },
  };
  writeFileSync(path.join(root, "amendments.jsonl"), `${JSON.stringify(amendment)}\n`);
  return { root, artifactPath };
}

function withFixture(fn) {
  const value = fixture();
  try {
    fn(value);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
}

test("matching authorization artifact hash passes", () => {
  withFixture(({ root }) => {
    assert.deepEqual(auditAmendmentAuthorizations(root), []);
  });
});

test("applied high-risk amendment requires authorization descriptor", () => {
  withFixture(({ root }) => {
    writeFileSync(
      path.join(root, "amendments.jsonl"),
      `${JSON.stringify({ status: "applied", risk: "high" })}\n`,
    );

    assert.match(auditAmendmentAuthorizations(root).join("\n"), /authorization is required/);
  });
});

test("artifact content drift fails hash validation", () => {
  withFixture(({ root, artifactPath }) => {
    writeFileSync(artifactPath, '{"status":"changed"}\n');

    assert.match(auditAmendmentAuthorizations(root).join("\n"), /hash mismatch/);
  });
});

test("missing artifact fails closed", () => {
  withFixture(({ root, artifactPath }) => {
    rmSync(artifactPath);

    assert.match(auditAmendmentAuthorizations(root).join("\n"), /does not exist/);
  });
});

test("artifact path must remain inside goal directory", () => {
  withFixture(({ root }) => {
    const amendmentPath = path.join(root, "amendments.jsonl");
    const amendment = JSON.parse(readFileSync(amendmentPath, "utf8"));
    amendment.authorization.artifact = "../outside.json";
    writeFileSync(amendmentPath, `${JSON.stringify(amendment)}\n`);

    assert.match(auditAmendmentAuthorizations(root).join("\n"), /goal-relative/);
  });
});
