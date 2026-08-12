import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const KEYS = [
  "schemaVersion",
  "id",
  "ownerKind",
  "ownerId",
  "ownerToken",
  "originRoot",
  "gitCommonDir",
  "path",
  "branchRef",
  "baseCommit",
  "headCommit",
  "state",
  "createdAt",
  "updatedAt",
  "disposition",
  "lastError",
];
const STATES = new Set([
  "allocating",
  "active",
  "reclaimable",
  "preserved",
  "cleanup-debt",
  "released",
]);
const DISP = new Set(["reclaimable", "preserved", "cleanup-debt", "released"]);
const hash = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const idRE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CODES = {
  main: null,
  active: "WORKTREE_OWNER_ACTIVE",
  reclaimable: "WORKTREE_CLEANUP_DEBT",
  preserved: "WORKTREE_PRESERVED",
  dirty: "WORKTREE_DIRTY",
  sequencer: "WORKTREE_SEQUENCER_ACTIVE",
  "cleanup-debt": "WORKTREE_CLEANUP_DEBT",
  unmanaged: "WORKTREE_UNMANAGED",
  missing: "WORKTREE_IDENTITY_MISMATCH",
  mismatch: "WORKTREE_IDENTITY_MISMATCH",
  released: null,
};
export function parseWorktreePorcelain(text) {
  let current;
  const result = [];
  for (const part of String(text).split("\0")) {
    if (!part) continue;
    const i = part.indexOf(" ");
    const key = i < 0 ? part : part.slice(0, i),
      value = i < 0 ? "" : part.slice(i + 1);
    if (key === "worktree") {
      current = { path: value };
      result.push(current);
    } else if (current)
      current[key] =
        key === "bare" || key === "detached" ? true : value || true;
  }
  return result;
}
function run(cwd, args, kind, probe, commandObserver) {
  commandObserver?.({ file: "git", cwd, args: [...args] });
  const injected = probe?.({ kind, cwd, args });
  if (injected) return injected;
  try {
    return {
      ok: true,
      stdout: execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      }),
      stderr: "",
    };
  } catch {
    return { ok: false, stdout: "", stderr: "" };
  }
}
const exact = (x, keys) =>
  x &&
  typeof x === "object" &&
  !Array.isArray(x) &&
  JSON.stringify(Object.keys(x).sort()) === JSON.stringify([...keys].sort());
const canonical = (x) =>
  typeof x === "string" && isAbsolute(x) && resolve(x) === x;
function validLegacyManifest(m, name) {
  const keys = [
    "schemaVersion",
    "id",
    "path",
    "originRoot",
    "ownerKind",
    "ownerId",
    "ownerToken",
    "state",
  ];
  return (
    exact(m, keys) &&
    m.schemaVersion === 1 &&
    typeof m.id === "string" &&
    idRE.test(m.id) &&
    basename(m.id) === m.id &&
    name === `${m.id}.json` &&
    canonical(m.path) &&
    typeof m.originRoot === "string" &&
    canonical(m.originRoot) &&
    typeof m.ownerKind === "string" &&
    typeof m.ownerId === "string" &&
    typeof m.ownerToken === "string" &&
    STATES.has(m.state)
  );
}
function validManifest(m, name, repo, mode, probe, observer) {
  if (
    mode !== 0o600 ||
    !exact(m, KEYS) ||
    m.schemaVersion !== "worktree-lifecycle.owner.v1" ||
    typeof m.id !== "string" ||
    !idRE.test(m.id) ||
    basename(m.id) !== m.id ||
    name !== `${m.id}.json`
  )
    return false;
  if (
    !["ownerKind", "ownerId"].every(
      (k) => typeof m[k] === "string" && m[k].trim() === m[k] && m[k],
    ) ||
    !/^worktree-owner\.v1:[a-f0-9]{64}$/.test(m.ownerToken) ||
    !["originRoot", "gitCommonDir", "path"].every((k) => canonical(m[k]))
  )
    return false;
  if (
    m.originRoot !== repo.root ||
    m.gitCommonDir !== repo.common ||
    !canonicalCandidate(m.path) ||
    !m.branchRef?.startsWith("refs/heads/") ||
    !hash.test(m.baseCommit) ||
    !(m.headCommit === null || hash.test(m.headCommit))
  )
    return false;
  if (
    !STATES.has(m.state) ||
    !Number.isFinite(Date.parse(m.createdAt)) ||
    !Number.isFinite(Date.parse(m.updatedAt)) ||
    Date.parse(m.createdAt) > Date.parse(m.updatedAt)
  )
    return false;
  const dispositionOK =
    m.disposition === null ||
    (exact(m.disposition, ["state", "reason"]) &&
      DISP.has(m.disposition.state) &&
      (m.disposition.reason === null ||
        (typeof m.disposition.reason === "string" &&
          m.disposition.reason.trim() === m.disposition.reason &&
          m.disposition.reason)));
  if (!dispositionOK) return false;
  if (
    !(
      m.lastError === null ||
      (exact(m.lastError, ["code", "message", "at"]) &&
        typeof m.lastError.code === "string" &&
        m.lastError.code &&
        typeof m.lastError.message === "string" &&
        m.lastError.message &&
        Number.isFinite(Date.parse(m.lastError.at)))
    )
  )
    return false;
  const committed = typeof m.headCommit === "string";
  if (
    (m.state === "allocating" &&
      (committed || m.disposition !== null || m.lastError !== null)) ||
    (m.state === "active" &&
      (!committed || m.disposition !== null || m.lastError !== null)) ||
    (["reclaimable", "preserved"].includes(m.state) &&
      (!committed ||
        m.disposition?.state !== m.state ||
        m.lastError !== null)) ||
    (m.state === "cleanup-debt" &&
      (m.disposition?.state !== m.state || m.lastError === null)) ||
    (m.state === "released" &&
      (m.disposition?.state !== "released" || m.lastError !== null))
  )
    return false;
  for (const rev of [m.baseCommit, ...(m.headCommit ? [m.headCommit] : [])])
    if (
      !run(
        repo.root,
        ["rev-parse", "--verify", `${rev}^{commit}`],
        "object",
        probe,
        observer,
      ).ok
    )
      return false;
  if (
    !run(
      repo.root,
      ["check-ref-format", m.branchRef],
      "ref",
      probe,
      observer,
    ).ok
  )
    return false;
  if (
    m.headCommit &&
    ["active", "reclaimable", "preserved"].includes(m.state)
  ) {
    const branch = run(
      repo.root,
      ["rev-parse", "--verify", `${m.branchRef}^{commit}`],
      "branch",
      probe,
      observer,
    );
    if (!branch.ok || branch.stdout.trim() !== m.headCommit) return false;
  }
  return true;
}
function canonicalCandidate(path) {
  try {
    let cursor = path,
      suffix = [];
    while (!existsSync(cursor)) {
      const parent = dirname(cursor);
      if (parent === cursor) return false;
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
    return (
      suffix.reduce(
        (value, part) => join(value, part),
        realpathSync(cursor),
      ) === path
    );
  } catch {
    return false;
  }
}
function manifests(root, repo, probe, observer) {
  const parts = [".state", "worktree-lifecycle", "leases"];
  let dir = root;
  for (const part of parts) {
    dir = join(dir, part);
    try {
      const stat = lstatSync(dir);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        realpathSync(dir) !== dir
      )
        return [{ invalid: true, name: "leases" }];
    } catch (e) {
      return e?.code === "ENOENT" ? [] : [{ invalid: true, name: "leases" }];
    }
  }
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .map((name) => {
        const file = join(dir, name);
        try {
          const st = lstatSync(file);
          if (!st.isFile() || st.isSymbolicLink()) throw 0;
          const bytes = readFileSync(file);
          const m = JSON.parse(bytes.toString("utf8"));
          const digest = createHash("sha256").update(bytes).digest("hex");
          if (m.schemaVersion === 1)
            return validLegacyManifest(m, name)
              ? { manifest: m, name, legacy: true, digest }
              : { invalid: true, name };
          return validManifest(m, name, repo, st.mode & 0o777, probe, observer)
            ? { manifest: m, name, digest }
            : { invalid: true, name };
        } catch {
          return { invalid: true, name };
        }
      });
  } catch {
    return [{ invalid: true, name: "leases" }];
  }
}
export function classifyWorktreeFact(fact) {
  let state = "active";
  if (
    fact.probeFailed ||
    fact.mismatch ||
    fact.registration?.locked ||
    fact.owner?.state === "cleanup-debt"
  )
    state = "cleanup-debt";
  else if (fact.main) state = "main";
  else if (!fact.pathExists) state = "missing";
  else if (fact.active) state = "active";
  else if (fact.operation) state = "sequencer";
  else if (fact.clean === false) state = "dirty";
  else if (!fact.owner) state = "unmanaged";
  else if (fact.owner.state === "preserved") state = "preserved";
  else if (fact.owner.state === "released") state = "released";
  else if (
    fact.owner.state === "reclaimable" &&
    fact.clean === true &&
    fact.identity !== false
  )
    state = "reclaimable";
  const reasons = [];
  if (fact.probeFailed) reasons.push("probe-failed");
  if (fact.operation) reasons.push(`sequencer:${fact.operation}`);
  if (fact.clean === false) reasons.push("dirty");
  if (!fact.owner && !fact.main) reasons.push("no-owner");
  return {
    state,
    reasons,
    automaticAction: state === "reclaimable" ? "release-worktree-only" : "none",
  };
}
export function classifyReconciliationResources(f) {
  const resources = f.resources ?? "000";
  const safe =
    (resources === "001" || resources === "111") &&
    f.manifestAuthority === "current" &&
    f.state === "reclaimable" &&
    f.disposition === "reclaimable" &&
    f.clean === true &&
    f.identity === true &&
    !f.active &&
    !f.operation &&
    !f.probeFailed &&
    !f.locked;
  const code =
    resources === "000" ||
    resources === "010" ||
    resources === "011" ||
    resources === "101"
      ? "WORKTREE_IDENTITY_MISMATCH"
      : resources === "100" || resources === "110"
        ? "WORKTREE_UNMANAGED"
        : "WORKTREE_CLEANUP_DEBT";
  return {
    resources,
    code,
    automaticAction: safe ? "release-worktree-only" : "none",
  };
}
function identity(root, reg, m, probe, observer) {
  if (!m || !existsSync(reg.path)) return false;
  try {
    const path = realpathSync(reg.path);
    const top = run(
        path,
        ["rev-parse", "--show-toplevel"],
        "identity",
        probe,
        observer,
      ),
      common = run(
        path,
        ["rev-parse", "--git-common-dir"],
        "identity",
        probe,
        observer,
      ),
      branch = run(
        path,
        ["symbolic-ref", "-q", "HEAD"],
        "identity",
        probe,
        observer,
      ),
      head = run(
        path,
        ["rev-parse", "--verify", "HEAD^{commit}"],
        "identity",
        probe,
        observer,
      );
    if (![top, common, branch, head].every((x) => x.ok)) return false;
    return (
      path === m.path &&
      realpathSync(top.stdout.trim()) === m.path &&
      realpathSync(
        isAbsolute(common.stdout.trim())
          ? common.stdout.trim()
          : resolve(path, common.stdout.trim()),
      ) === m.gitCommonDir &&
      branch.stdout.trim() === m.branchRef &&
      head.stdout.trim() === m.headCommit &&
      reg.branch === m.branchRef &&
      m.originRoot === root
    );
  } catch {
    return false;
  }
}
function output(f, ttlMs, now) {
  const c = classifyWorktreeFact(f);
  const resources = `${f.pathExists ? 1 : 0}${f.registration ? 1 : 0}${f.manifestPresent ? 1 : 0}`;
  const rec = classifyReconciliationResources({
    ...f,
    resources,
    state: f.owner?.state,
    disposition: f.owner?.disposition?.state,
    locked: f.registration?.locked,
  });
  const state = f.forceState ?? c.state;
  const action = f.mismatch
    ? "none"
    : f.legacy
      ? c.automaticAction
      : state === "reclaimable"
        ? rec.automaticAction
        : "none";
  const age =
    f.owner && Number.isFinite(ttlMs) && ttlMs >= 0 && Number.isFinite(now)
      ? now - Date.parse(f.owner.updatedAt || f.owner.createdAt)
      : null;
  const registration = f.registration
    ? {
        path: f.registration.path,
        HEAD: f.registration.HEAD,
        branch: f.registration.branch,
        locked: Boolean(f.registration.locked),
        prunable: Boolean(f.registration.prunable),
      }
    : undefined;
  return {
    registration,
    path: registration?.path ?? f.owner?.path ?? f.path,
    id: f.owner?.id ?? f.id,
    owner: f.owner
      ? { kind: f.owner.ownerKind, id: f.owner.ownerId }
      : undefined,
    resources,
    state,
    reasons: c.reasons,
    automaticAction: action,
    code: f.mismatch
      ? CODES.mismatch
      : state === "reclaimable"
        ? rec.code
        : CODES[state],
    severity:
      state === "reclaimable" || state === "cleanup-debt"
        ? age !== null && age < ttlMs
          ? "diagnostic"
          : "warning"
        : "diagnostic",
  };
}
async function inspectRepositoryWorktrees({
  originRoot,
  activeProcessCwds = [],
  probe,
  commandObserver,
  ttlMs,
  now,
} = {}) {
  const root = resolve(originRoot);
  const top = run(
    root,
    ["rev-parse", "--show-toplevel"],
    "origin",
    probe,
    commandObserver,
  );
  const common = run(
    root,
    ["rev-parse", "--git-common-dir"],
    "origin",
    probe,
    commandObserver,
  );
  if (!top.ok || !common.ok)
    return {
      repo: null,
      candidates: [],
      items: [
        output(
          {
            registration: { path: root },
            main: true,
            pathExists: existsSync(root),
            probeFailed: true,
          },
          ttlMs,
          now,
        ),
      ],
    };
  let repo;
  try {
    repo = {
      root: realpathSync(top.stdout.trim()),
      common: realpathSync(
        isAbsolute(common.stdout.trim())
          ? common.stdout.trim()
          : resolve(root, common.stdout.trim()),
      ),
    };
  } catch {
    return {
      repo: null,
      candidates: [],
      items: [
        output(
          {
            registration: { path: root },
            main: true,
            pathExists: existsSync(root),
            probeFailed: true,
          },
          ttlMs,
          now,
        ),
      ],
    };
  }
  const list = run(
    repo.root,
    ["worktree", "list", "--porcelain", "-z"],
    "list",
    probe,
    commandObserver,
  );
  if (!list.ok)
    return {
      repo: null,
      candidates: [],
      items: [
        output(
          {
            registration: { path: repo.root },
            main: true,
            pathExists: true,
            probeFailed: true,
          },
          ttlMs,
          now,
        ),
      ],
    };
  const es = manifests(repo.root, repo, probe, commandObserver),
    regs = parseWorktreePorcelain(list.stdout),
    used = new Set(),
    facts = [];
  const duplicates = new Set();
  for (const key of ["id", "path", "branchRef"]) {
    const seen = new Map();
    for (const e of es.filter((x) => x.manifest && !x.legacy)) {
      const value = e.manifest[key];
      if (seen.has(value)) {
        duplicates.add(e);
        duplicates.add(seen.get(value));
      } else seen.set(value, e);
    }
  }
  for (let i = 0; i < regs.length; i++) {
    const r = regs[i],
      ms = es.filter(
        (e) => e.manifest && resolve(e.manifest.path) === resolve(r.path),
      );
    ms.forEach((e) => used.add(e));
    const e = ms.length === 1 ? ms[0] : null,
      m = e?.manifest,
      pathExists = existsSync(r.path);
    let clean,
      operation,
      probeFailed = false;
    if (pathExists) {
      const s = run(
        r.path,
        ["status", "--porcelain=v1", "-z"],
        "status",
        probe,
        commandObserver,
      );
      if (!s.ok) probeFailed = true;
      else {
        clean = s.stdout.length === 0;
        for (const marker of [
          "MERGE_HEAD",
          "CHERRY_PICK_HEAD",
          "REVERT_HEAD",
          "rebase-merge",
          "rebase-apply",
          "sequencer",
        ]) {
          const x = run(
            r.path,
            ["rev-parse", "--git-path", marker],
            "rev-parse",
            probe,
            commandObserver,
          );
          if (!x.ok) {
            probeFailed = true;
            break;
          }
          if (existsSync(x.stdout.trim())) {
            operation = marker;
            break;
          }
        }
      }
    }
    const same = identity(repo.root, r, m, probe, commandObserver);
    facts.push(
      output(
        {
          registration: r,
          owner: m,
          main: i === 0 || resolve(r.path) === repo.root,
          pathExists,
          manifestPresent: !!m,
          legacy: e?.legacy,
          manifestAuthority: e?.legacy ? "legacy" : m ? "current" : undefined,
          mismatch:
            ms.length > 1 || duplicates.has(e) || (m && !e.legacy && !same),
          identity: e?.legacy ? undefined : same,
          active: activeProcessCwds.some(
            (x) =>
              resolve(x) === resolve(r.path) ||
              resolve(x).startsWith(`${resolve(r.path)}/`),
          ),
          clean,
          operation,
          probeFailed,
        },
        ttlMs,
        now,
      ),
    );
  }
  for (const e of es)
    if (!used.has(e)) {
      if (e.invalid) {
        facts.push(
          output(
            {
              id: e.name.replace(/\.json$/, ""),
              path: join(repo.root, ".state/worktree-lifecycle/leases", e.name),
              manifestPresent: true,
              mismatch: true,
            },
            ttlMs,
            now,
          ),
        );
        continue;
      }
      const m = e.manifest,
        pathExists = existsSync(m.path),
        registration = regs.find((r) => resolve(r.path) === resolve(m.path));
      const released = m.state === "released" && !pathExists && !registration;
      facts.push(
        output(
          {
            owner: m,
            path: m.path,
            pathExists,
            registration,
            manifestPresent: true,
            legacy: e.legacy,
            manifestAuthority: e.legacy ? "legacy" : "current",
            identity:
              !e.legacy &&
              m.state === "reclaimable" &&
              !pathExists &&
              !registration,
            mismatch:
              duplicates.has(e) ||
              (!e.legacy &&
                !released &&
                !(m.state === "reclaimable" && !pathExists && !registration)),
            forceState:
              !e.legacy &&
              m.state === "reclaimable" &&
              !pathExists &&
              !registration
                ? "reclaimable"
                : released
                  ? "released"
                  : undefined,
            clean: true,
          },
          ttlMs,
          now,
        ),
      );
    }
  const candidates = es
    .filter((e) => e.manifest && !e.legacy && !duplicates.has(e))
    .map((e) => ({
      manifest: e.manifest,
      item: facts.find((item) => item.id === e.manifest.id),
    }))
    .filter(({ manifest, item }) =>
      (manifest.state === "reclaimable" &&
        item?.automaticAction === "release-worktree-only" &&
        ["001", "111"].includes(item.resources)) ||
      (manifest.state === "released" && item?.state === "released" && item.resources === "001"),
    )
    .map(({ manifest }) => ({
      id: manifest.id,
      ownerToken: manifest.ownerToken,
      state: manifest.state,
      identity: {
        originRoot: manifest.originRoot,
        gitCommonDir: manifest.gitCommonDir,
        path: manifest.path,
        branchRef: manifest.branchRef,
        headCommit: manifest.headCommit,
      },
    }));
  return { repo, items: facts, candidates, registrations: regs, manifests: es };
}

function cleanupSnapshot(inspected, probe, commandObserver) {
  const { repo, registrations = [], manifests = [] } = inspected;
  if (!repo) return null;
  // An unreadable or invalid receipt cannot safely be treated as "no owner".
  if (manifests.some((entry) => entry.invalid)) {
    const error = new Error("Owner manifest inventory is invalid");
    error.code = "WORKTREE_STALE_REGISTRATION_MANIFEST_INVALID";
    throw error;
  }
  const owners = new Set(manifests.map((entry) => resolve(entry.manifest.path)));
  const registrationsSnapshot = registrations.map((registration) => ({
    path: resolve(registration.path),
    HEAD: registration.HEAD === true ? true : registration.HEAD ?? null,
    branch: registration.branch === true ? true : registration.branch ?? null,
    // Preserve porcelain's reason verbatim: it is authorization material.
    prunable: registration.prunable ?? null,
  })).sort((a, b) => a.path.localeCompare(b.path));
  const candidates = registrationsSnapshot.filter((registration) =>
    registration.path !== repo.root && !existsSync(registration.path) &&
    typeof registration.prunable === "string" && registration.prunable && !owners.has(registration.path),
  ).map((registration) => {
    if (registration.branch === null) return registration;
    if (typeof registration.branch !== "string" || !registration.branch.startsWith("refs/heads/")) {
      const error = new Error("Candidate branch is not a local branch or detached HEAD");
      error.code = "WORKTREE_STALE_REGISTRATION_EXACTNESS_FAILED";
      throw error;
    }
    const branch = run(repo.root, ["rev-parse", "--verify", `${registration.branch}^{commit}`], "cleanup-branch", probe, commandObserver);
    if (!branch.ok) {
      const error = new Error("Candidate branch cannot be resolved");
      error.code = "WORKTREE_STALE_REGISTRATION_EXACTNESS_FAILED";
      throw error;
    }
    return { ...registration, branchHead: branch.stdout.trim() };
  });
  const ownerManifests = manifests.map(({ name, digest }) => ({ name, digest })).sort((a, b) => a.name.localeCompare(b.name));
  return { originRoot: repo.root, gitCommonDir: repo.common, registrations: registrationsSnapshot, candidates, ownerManifests };
}
function challengeFor(snapshot) {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}
/** Plan migration-only removal of abandoned Git administrative registrations. */
export async function planStaleRegistrationCleanup(options = {}) {
  const inspected = await inspectRepositoryWorktreesSafe(options);
  const snapshot = cleanupSnapshot(inspected, options.probe, options.commandObserver);
  if (!snapshot) {
    const error = new Error("Repository inventory is unavailable");
    error.code = "WORKTREE_STALE_REGISTRATION_INVENTORY_FAILED";
    throw error;
  }
  return { apply: false, originRoot: snapshot.originRoot, gitCommonDir: snapshot.gitCommonDir,
    candidates: snapshot.candidates, snapshot, snapshotChallenge: challengeFor(snapshot) };
}
/** Apply only the exact, freshly challenged migration plan. */
export async function applyStaleRegistrationCleanup({ originRoot, challenge, probe, commandObserver } = {}) {
  if (!/^[a-f0-9]{64}$/.test(challenge ?? "")) {
    const error = new Error("A 64-character lowercase snapshot challenge is required");
    error.code = "WORKTREE_STALE_REGISTRATION_CHALLENGE_REQUIRED";
    throw error;
  }
  const before = await planStaleRegistrationCleanup({ originRoot, probe, commandObserver });
  if (before.snapshotChallenge !== challenge) {
    const error = new Error("Snapshot challenge does not match the current inventory");
    error.code = "WORKTREE_STALE_REGISTRATION_CHALLENGE_MISMATCH";
    throw error;
  }
  if (!before.candidates.length) {
    const gate = await planStaleRegistrationCleanup({ originRoot, probe, commandObserver });
    if (gate.snapshotChallenge !== challenge) {
      const error = new Error("Cleanup inventory changed before completion");
      error.code = "WORKTREE_STALE_REGISTRATION_CHALLENGE_MISMATCH";
      throw error;
    }
    return { ...before, apply: true, removed: [] };
  }
  const gate = await planStaleRegistrationCleanup({ originRoot, probe, commandObserver });
  if (gate.snapshotChallenge !== challenge) {
    const error = new Error("Cleanup inventory changed before removal");
    error.code = "WORKTREE_STALE_REGISTRATION_CHALLENGE_MISMATCH";
    throw error;
  }
  const refs = run(before.originRoot, ["show-ref"], "cleanup-refs", probe, commandObserver);
  const mainHead = run(before.originRoot, ["rev-parse", "--verify", "HEAD^{commit}"], "cleanup-head", probe, commandObserver);
  const status = run(before.originRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], "cleanup-status", probe, commandObserver);
  if (![refs, mainHead, status].every((x) => x.ok)) {
    const error = new Error("Unable to establish cleanup invariants"); error.code = "WORKTREE_STALE_REGISTRATION_INVENTORY_FAILED"; throw error;
  }
  // Recheck after invariant probes: observers may expose a last-moment race.
  const finalGate = await planStaleRegistrationCleanup({ originRoot, probe, commandObserver });
  if (finalGate.snapshotChallenge !== challenge) {
    const error = new Error("Cleanup inventory changed before removal");
    error.code = "WORKTREE_STALE_REGISTRATION_CHALLENGE_MISMATCH";
    throw error;
  }
  const removedPaths = new Set();
  for (const candidate of before.candidates) {
    const current = await planStaleRegistrationCleanup({ originRoot, probe, commandObserver });
    const expectedCurrent = {
      ...before.snapshot,
      registrations: before.snapshot.registrations.filter((entry) => !removedPaths.has(entry.path)),
      candidates: before.snapshot.candidates.filter((entry) => !removedPaths.has(entry.path)),
    };
    if (current.snapshotChallenge !== challengeFor(expectedCurrent)) {
      const error = new Error("Cleanup inventory changed before exact removal");
      error.code = "WORKTREE_STALE_REGISTRATION_CHALLENGE_MISMATCH";
      throw error;
    }
    const removal = run(before.originRoot, ["worktree", "remove", candidate.path], "stale-registration-remove", probe, commandObserver);
    if (!removal.ok) {
      const error = new Error("Exact stale registration removal failed; cleanup debt remains");
      error.code = "WORKTREE_STALE_REGISTRATION_REMOVE_FAILED";
      throw error;
    }
    removedPaths.add(candidate.path);
  }
  const afterInspection = await inspectRepositoryWorktreesSafe({ originRoot, probe, commandObserver });
  const afterSnapshot = cleanupSnapshot(afterInspection, probe, commandObserver);
  const after = afterSnapshot ? { apply: false, originRoot: afterSnapshot.originRoot, gitCommonDir: afterSnapshot.gitCommonDir, candidates: afterSnapshot.candidates, snapshot: afterSnapshot, snapshotChallenge: challengeFor(afterSnapshot) } : null;
  const afterPaths = new Set(afterSnapshot?.registrations.map((x) => x.path));
  const expected = before.candidates.map((x) => x.path).sort();
  // Approved paths must be absent from all Git registrations, not merely candidates.
  const remaining = expected.filter((path) => afterPaths.has(path));
  const approvedPaths = new Set(expected);
  const expectedRegistrations = before.snapshot.registrations.filter((entry) => !approvedPaths.has(entry.path));
  // Registrations created after the final gate are not authorized targets.
  const unchangedRegistrations = expectedRegistrations.every((entry) =>
    afterSnapshot?.registrations.some((actual) => JSON.stringify(actual) === JSON.stringify(entry)),
  );
  const refsAfter = run(before.originRoot, ["show-ref"], "cleanup-refs", probe, commandObserver);
  const headAfter = run(before.originRoot, ["rev-parse", "--verify", "HEAD^{commit}"], "cleanup-head", probe, commandObserver);
  const statusAfter = run(before.originRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], "cleanup-status", probe, commandObserver);
  const unchangedManifests = JSON.stringify(afterSnapshot?.ownerManifests) === JSON.stringify(before.snapshot.ownerManifests);
  if (remaining.length || !unchangedRegistrations || !unchangedManifests || !refsAfter.ok || !headAfter.ok || !statusAfter.ok || refsAfter.stdout !== refs.stdout || headAfter.stdout !== mainHead.stdout || statusAfter.stdout !== status.stdout) {
    const error = new Error("Cleanup postcondition verification failed"); error.code = "WORKTREE_STALE_REGISTRATION_POSTCONDITION_FAILED"; throw error;
  }
  return { ...before, apply: true, removed: expected };
}
async function inspectRepositoryWorktreesSafe(options) {
  try {
    return await inspectRepositoryWorktrees(options);
  } catch {
    const root = resolve(options.originRoot);
    return {
      repo: null,
      candidates: [],
      items: [
        output(
          {
            registration: { path: root },
            main: true,
            pathExists: existsSync(root),
            probeFailed: true,
          },
          options.ttlMs,
          options.now,
        ),
      ],
    };
  }
}
export async function inventoryRepositoryWorktrees(options = {}) {
  return (await inspectRepositoryWorktreesSafe(options)).items;
}
export async function reconcileManagedWorktrees({
  originRoot,
  apply = false,
  activeProcessCwds = [],
  ttlMs = 0,
  now = Date.now(),
  probe,
  commandObserver,
} = {}) {
  const options = {
    originRoot,
    activeProcessCwds,
    ttlMs,
    now,
    probe,
    commandObserver,
  };
  const before = await inspectRepositoryWorktreesSafe(options);
  if (!apply) return { apply: false, items: before.items };
  const failures = new Set();
  if (before.repo && before.candidates.length) {
    const common = run(
      before.repo.root,
      ["rev-parse", "--git-common-dir"],
      "origin",
      probe,
      commandObserver,
    );
    let canonicalCommon = null;
    try {
      canonicalCommon = common.ok
        ? realpathSync(
            isAbsolute(common.stdout.trim())
              ? common.stdout.trim()
              : resolve(before.repo.root, common.stdout.trim()),
          )
        : null;
    } catch {}
    if (canonicalCommon !== before.repo.common) {
      before.candidates.forEach((candidate) => failures.add(candidate.id));
    } else {
      const { releaseManagedWorktree } = await import("./managed-worktree.mjs");
      for (const candidate of before.candidates) {
        try {
        releaseManagedWorktree({
          originRoot: before.repo.root,
          id: candidate.id,
          ownerToken: candidate.ownerToken,
          commandObserver,
        });
        } catch {
          failures.add(candidate.id);
        }
      }
    }
  }
  const after = await inspectRepositoryWorktreesSafe(options);
  const items = after.items.map((item) =>
    failures.has(item.id) && item.state !== "cleanup-debt"
      ? { ...item, code: "WORKTREE_IDENTITY_MISMATCH", automaticAction: "none" }
      : item,
  );
  return { apply: true, items };
}
