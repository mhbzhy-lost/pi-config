import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  canonicalGoalCwd,
  cwdNamespace,
  ensureGoalStateIdentity,
  resolveGoalStateScope,
  selectGoalStateRoot,
} from "../scripts/lib/goal-engine/state-scope.mjs";

function arena(prefix = "goal-state-scope-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("cwd namespace keeps Pi-style labels readable without path-collision aliases", () => {
  const first = cwdNamespace("/a/b-c");
  const second = cwdNamespace("/a-b/c");

  assert.match(first, /^--a-b-c--_[a-f0-9]{16}$/);
  assert.match(second, /^--a-b-c--_[a-f0-9]{16}$/);
  assert.notEqual(first, second);
  assert.equal(cwdNamespace("/a/b-c"), first);
});

test("cwd namespace stays within one portable filename component for long UTF-8 paths", () => {
  const namespace = cwdNamespace(`/Users/example/${"目录".repeat(200)}`);

  assert.ok(Buffer.byteLength(namespace, "utf8") <= 240, namespace);
  assert.match(namespace, /^--.+--_[a-f0-9]{16}$/u);
});

test("canonical Goal cwd resolves symlink aliases to one physical directory", () => {
  const fixture = arena();
  try {
    const physical = join(fixture.root, "physical");
    const alias = join(fixture.root, "alias");
    mkdirSync(physical);
    symlinkSync(physical, alias, "dir");

    const expected = realpathSync(physical);
    assert.equal(canonicalGoalCwd(alias), expected);
    assert.equal(canonicalGoalCwd(physical), expected);
  } finally {
    fixture.dispose();
  }
});

test("state scope uses legacy storage when PI_CODING_GOAL_DIR is absent", () => {
  const fixture = arena();
  try {
    const scope = resolveGoalStateScope({ cwd: fixture.root, env: {} });

    assert.equal(scope.preferredRoot, join(realpathSync(fixture.root), ".state", "goal-engine"));
    assert.equal(scope.legacyRoot, scope.preferredRoot);
    assert.equal(scope.storage, "legacy");
  } finally {
    fixture.dispose();
  }
});

test("state scope places configured Goal state below a cwd-bound global namespace", () => {
  const fixture = arena();
  const globalRoot = arena("goal-state-global-");
  try {
    const scope = resolveGoalStateScope({ cwd: fixture.root, env: { PI_CODING_GOAL_DIR: globalRoot.root } });

    assert.equal(scope.legacyRoot, join(realpathSync(fixture.root), ".state", "goal-engine"));
    assert.equal(scope.preferredRoot, join(globalRoot.root, scope.namespace));
    assert.equal(scope.identity.canonicalCwd, realpathSync(fixture.root));
    assert.equal(scope.identity.namespace, scope.namespace);
    assert.equal(scope.identity.schemaVersion, "goal-engine.cwd-identity.v1");
    assert.equal(scope.storage, "global");
  } finally {
    fixture.dispose();
    globalRoot.dispose();
  }
});

test("state scope rejects a relative PI_CODING_GOAL_DIR before creating files", () => {
  const fixture = arena();
  try {
    assert.throws(
      () => resolveGoalStateScope({ cwd: fixture.root, env: { PI_CODING_GOAL_DIR: "var/goals" } }),
      (error) => error.code === "INVALID_GOAL_STATE_ROOT" && /absolute/i.test(error.message),
    );
  } finally {
    fixture.dispose();
  }
});

test("identity creation reports an unavailable global root without falling back to legacy", () => {
  const fixture = arena();
  const globalRoot = arena("goal-state-global-");
  const blockedParent = join(globalRoot.root, "blocked");
  mkdirSync(blockedParent, { mode: 0o500 });
  try {
    const scope = resolveGoalStateScope({
      cwd: fixture.root,
      env: { PI_CODING_GOAL_DIR: join(blockedParent, "goals") },
    });

    assert.throws(
      () => ensureGoalStateIdentity(scope),
      (error) => error.code === "GOAL_STATE_ROOT_UNAVAILABLE" && error.message.includes(scope.preferredRoot),
    );
    assert.equal(statSync(blockedParent).mode & 0o777, 0o500);
  } finally {
    chmodSync(blockedParent, 0o700);
    fixture.dispose();
    globalRoot.dispose();
  }
});

test("identity creation is private, idempotent, and rejects a mismatched cwd", () => {
  const fixture = arena();
  const globalRoot = arena("goal-state-global-");
  try {
    const scope = resolveGoalStateScope({ cwd: fixture.root, env: { PI_CODING_GOAL_DIR: globalRoot.root } });
    ensureGoalStateIdentity(scope);
    ensureGoalStateIdentity(scope);

    const identityPath = join(scope.preferredRoot, "identity.json");
    assert.deepEqual(JSON.parse(readFileSync(identityPath, "utf8")), scope.identity);
    assert.equal(statSync(identityPath).mode & 0o777, 0o600);

    writeFileSync(identityPath, `${JSON.stringify({ ...scope.identity, canonicalCwd: "/different/repo" })}\n`, { mode: 0o600 });
    assert.throws(
      () => ensureGoalStateIdentity(scope),
      (error) => error.code === "GOAL_STATE_IDENTITY_MISMATCH" && /different\/repo/.test(error.message),
    );
    assert.equal(JSON.parse(readFileSync(identityPath, "utf8")).canonicalCwd, "/different/repo");
  } finally {
    fixture.dispose();
    globalRoot.dispose();
  }
});

test("identity verification rejects broad namespace and file permissions without repairing them", () => {
  for (const target of ["namespace", "identity"]) {
    const fixture = arena();
    const globalRoot = arena("goal-state-global-");
    try {
      const scope = resolveGoalStateScope({ cwd: fixture.root, env: { PI_CODING_GOAL_DIR: globalRoot.root } });
      ensureGoalStateIdentity(scope);
      const path = target === "namespace" ? scope.preferredRoot : join(scope.preferredRoot, "identity.json");
      chmodSync(path, target === "namespace" ? 0o755 : 0o644);

      assert.throws(
        () => ensureGoalStateIdentity(scope),
        (error) => error.code === "GOAL_STATE_IDENTITY_INSECURE" && error.message.includes(path),
      );
      assert.equal(statSync(path).mode & 0o777, target === "namespace" ? 0o755 : 0o644);
    } finally {
      fixture.dispose();
      globalRoot.dispose();
    }
  }
});

test("identity verification refuses a symlink even when its target has matching private content", () => {
  const fixture = arena();
  const globalRoot = arena("goal-state-global-");
  try {
    const scope = resolveGoalStateScope({ cwd: fixture.root, env: { PI_CODING_GOAL_DIR: globalRoot.root } });
    ensureGoalStateIdentity(scope);
    const identityPath = join(scope.preferredRoot, "identity.json");
    const outsideTarget = join(globalRoot.root, "outside-identity.json");
    writeFileSync(outsideTarget, readFileSync(identityPath), { mode: 0o600 });
    unlinkSync(identityPath);
    symlinkSync(outsideTarget, identityPath);

    assert.throws(
      () => ensureGoalStateIdentity(scope),
      (error) => error.code === "GOAL_STATE_IDENTITY_INSECURE" && /symbolic link|symlink/i.test(error.message),
    );
    assert.equal(statSync(outsideTarget).mode & 0o777, 0o600);
  } finally {
    fixture.dispose();
    globalRoot.dispose();
  }
});

test("root selection pins an active legacy Goal and cuts new Goals over to global storage", () => {
  const scope = { preferredRoot: "/global/repo", legacyRoot: "/repo/.state/goal-engine", storage: "global" };
  const active = new Map([
    [scope.preferredRoot, []],
    [scope.legacyRoot, ["legacy-goal"]],
  ]);
  const listActive = (root) => active.get(root) || [];
  const hasGoal = (root, goalId) => root === scope.legacyRoot && goalId === "legacy-goal";

  assert.deepEqual(selectGoalStateRoot(scope, { operation: "read", listActive, hasGoal }), {
    root: scope.legacyRoot,
    storage: "legacy",
  });
  assert.deepEqual(selectGoalStateRoot(scope, { operation: "mutate", goalId: "legacy-goal", listActive, hasGoal }), {
    root: scope.legacyRoot,
    storage: "legacy",
  });

  active.set(scope.legacyRoot, []);
  assert.deepEqual(selectGoalStateRoot(scope, { operation: "init", listActive, hasGoal: () => false }), {
    root: scope.preferredRoot,
    storage: "global",
  });
});

test("root selection recovers a configured global Goal", () => {
  const scope = { preferredRoot: "/global/repo", legacyRoot: "/repo/.state/goal-engine", storage: "global" };
  const listActive = (root) => root === scope.preferredRoot ? ["global-goal"] : [];
  const hasGoal = (root, goalId) => root === scope.preferredRoot && goalId === "global-goal";

  assert.deepEqual(selectGoalStateRoot(scope, { operation: "read", listActive, hasGoal }), {
    root: scope.preferredRoot,
    storage: "global",
  });
  assert.deepEqual(selectGoalStateRoot(scope, { operation: "read", goalId: "global-goal", listActive, hasGoal }), {
    root: scope.preferredRoot,
    storage: "global",
  });
});

test("root selection fails closed when global and legacy authorities conflict", () => {
  const scope = { preferredRoot: "/global/repo", legacyRoot: "/repo/.state/goal-engine", storage: "global" };

  assert.throws(
    () => selectGoalStateRoot(scope, {
      operation: "read",
      listActive: () => ["active"],
      hasGoal: () => false,
    }),
    (error) => error.code === "GOAL_STATE_ROOT_CONFLICT" && /global.*legacy|legacy.*global/i.test(error.message),
  );

  assert.throws(
    () => selectGoalStateRoot(scope, {
      operation: "read",
      goalId: "duplicate",
      listActive: () => [],
      hasGoal: () => true,
    }),
    (error) => error.code === "GOAL_STATE_IDENTITY_CONFLICT" && /duplicate/.test(error.message),
  );
});
