import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  auditAmendmentAuthorizations,
  auditPracticeProfileSync,
  canonicalJsonSha256,
} from "../src/goal-contract/authorization-audit.ts";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "goal-auth-audit-"));
  const linkedArtifactPath = path.join(root, "todo-recovery-snapshot.json");
  writeFileSync(linkedArtifactPath, '{"status":"legacy_unverifiable"}\n');
  const linkedArtifactSha256 = createHash("sha256")
    .update(readFileSync(linkedArtifactPath))
    .digest("hex");
  const artifactPath = path.join(root, "authorization-evidence.json");
  writeFileSync(
    artifactPath,
    `${JSON.stringify({
      status: "legacy_unverifiable",
      linkedArtifacts: [
        { artifact: "todo-recovery-snapshot.json", sha256: linkedArtifactSha256 },
      ],
    })}\n`,
  );
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
  return { root, artifactPath, linkedArtifactPath };
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

test("linked authorization artifact content drift fails hash validation", () => {
  withFixture(({ root, linkedArtifactPath }) => {
    writeFileSync(linkedArtifactPath, '{"status":"changed"}\n');

    assert.match(auditAmendmentAuthorizations(root).join("\n"), /linked artifact hash mismatch/);
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

function practiceProfileFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "goal-profile-audit-"));
  const practiceProfile = {
    schema_version: "goal_contract.practice_profile.v1",
    evidence_lanes: [{ id: "source", purpose: "Source evidence" }],
    drift_detectors: [{ id: "single-writer", action: "fail" }],
  };
  const digest = canonicalJsonSha256(practiceProfile);
  writeFileSync(
    path.join(root, "state.json"),
    `${JSON.stringify({ practice_profile: practiceProfile, practice_profile_sha256: digest })}\n`,
  );
  writeFileSync(
    path.join(root, "goal-contract.md"),
    `# Goal Contract\n\nPractice-Profile-SHA256: ${digest}\n`,
  );
  return { root, practiceProfile, digest };
}

function withPracticeProfileFixture(fn) {
  const value = practiceProfileFixture();
  try {
    fn(value);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
}

test("matching practice profile identities pass", () => {
  withPracticeProfileFixture(({ root }) => {
    assert.deepEqual(auditPracticeProfileSync(root), []);
  });
});

test("legacy practice profile without identity declarations remains readable", () => {
  withPracticeProfileFixture(({ root, practiceProfile }) => {
    writeFileSync(
      path.join(root, "state.json"),
      `${JSON.stringify({ practice_profile: practiceProfile })}\n`,
    );
    writeFileSync(path.join(root, "goal-contract.md"), "# Legacy Goal Contract\n");

    assert.deepEqual(auditPracticeProfileSync(root), []);
  });
});

test("practice profile content drift fails declared hash", () => {
  withPracticeProfileFixture(({ root }) => {
    const statePath = path.join(root, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.practice_profile.drift_detectors[0].action = "silently-continue";
    writeFileSync(statePath, `${JSON.stringify(state)}\n`);

    assert.match(auditPracticeProfileSync(root).join("\n"), /state hash mismatch/);
  });
});

test("markdown practice profile marker must match canonical profile", () => {
  withPracticeProfileFixture(({ root }) => {
    writeFileSync(
      path.join(root, "goal-contract.md"),
      `# Goal Contract\n\nPractice-Profile-SHA256: ${"0".repeat(64)}\n`,
    );

    assert.match(auditPracticeProfileSync(root).join("\n"), /contract marker mismatch/);
  });
});
