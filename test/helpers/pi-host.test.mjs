import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { loadPiTestRuntime, resolvePiCodingAgentRoot } from "./pi-runtime.mjs";
import { resolvePiHostPaths } from "./pi-host.mjs";

const PUBLIC_SPECIFIERS = [
  "@earendil-works/pi-ai/compat",
  "@earendil-works/pi-tui",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
];

const repoRoot = resolve(import.meta.dirname, "..", "..");
const sessionViewportPath = join(repoRoot, "packages", "pi-subagents-enhanced", "src", "tui", "session-viewport.ts");
/** A real installed Pi package root inside the repository, used as an explicit candidate. */
const explicitCandidateRoot = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent");

async function writeFixtureFile(root, relativePath, contents = "export const fixture = true;\n") {
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
  return target;
}

async function writeFixtureManifest(root, relativeDirectory, manifest) {
  return writeFixtureFile(root, join(relativeDirectory, "package.json"), JSON.stringify(manifest));
}

/**
 * A fixture that mimics the Pi 0.85.1 published layout: `exports`-driven ESM
 * entries for the agent/AI packages, a legacy `main` for pi-tui and a hoisted
 * pi-agent-core that only exists above the candidate root.
 */
async function createPiHostFixture({ piAiCompatEntry = "./dist/compat.js" } = {}) {
  const parent = await mkdtemp(join(tmpdir(), "pi-host-fixture-"));
  const candidateRoot = join(parent, "candidate");
  await writeFixtureManifest(parent, "candidate", {
    name: "@earendil-works/pi-coding-agent",
    version: "0.85.1",
    exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
  });
  await writeFixtureFile(parent, join("candidate", "dist", "index.js"));
  await writeFixtureFile(parent, join("candidate", "node_modules", "jiti", "lib", "jiti.mjs"));
  await writeFixtureManifest(parent, join("candidate", "node_modules", "@earendil-works", "pi-ai"), {
    name: "@earendil-works/pi-ai",
    version: "0.85.1",
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./compat": { types: "./dist/compat.d.ts", import: piAiCompatEntry },
    },
  });
  await writeFixtureFile(parent, join("candidate", "node_modules", "@earendil-works", "pi-ai", "dist", "index.js"));
  await writeFixtureFile(
    parent,
    join("candidate", "node_modules", "@earendil-works", "pi-ai", piAiCompatEntry.replace(/^\.\//, "")),
  );
  await writeFixtureManifest(parent, join("candidate", "node_modules", "@earendil-works", "pi-tui"), {
    name: "@earendil-works/pi-tui",
    version: "0.85.1",
    main: "dist/index.js",
  });
  const sharedPiTuiEntry = await writeFixtureFile(parent, join("shared", "pi-tui-entry.js"));
  const piTuiEntryLink = join(parent, "candidate", "node_modules", "@earendil-works", "pi-tui", "dist", "index.js");
  await mkdir(dirname(piTuiEntryLink), { recursive: true });
  await symlink(sharedPiTuiEntry, piTuiEntryLink);
  await writeFixtureManifest(parent, join("node_modules", "@earendil-works", "pi-agent-core"), {
    name: "@earendil-works/pi-agent-core",
    version: "0.85.1",
    exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
  });
  await writeFixtureFile(parent, join("node_modules", "@earendil-works", "pi-agent-core", "dist", "index.js"));
  return { parent, candidateRoot, sharedPiTuiEntry };
}

test("host aliases keep every public Pi specifier and resolve them under the explicit candidate root", async () => {
  const { parent, candidateRoot, sharedPiTuiEntry } = await createPiHostFixture();
  const paths = resolvePiHostPaths({ env: { PI_TEST_CODING_AGENT_ROOT: candidateRoot } });

  assert.equal(paths.piHostRoot, candidateRoot);
  assert.deepEqual(Object.keys(paths.piHostAliases), PUBLIC_SPECIFIERS);
  assert.equal(
    paths.piHostAliases["@earendil-works/pi-coding-agent"],
    realpathSync(join(candidateRoot, "dist", "index.js")),
  );
  assert.equal(
    paths.piHostAliases["@earendil-works/pi-ai"],
    realpathSync(join(candidateRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js")),
  );
  assert.equal(
    paths.piHostAliases["@earendil-works/pi-ai/compat"],
    realpathSync(join(candidateRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "compat.js")),
  );
  assert.equal(
    paths.piHostAliases["@earendil-works/pi-agent-core"],
    realpathSync(join(parent, "node_modules", "@earendil-works", "pi-agent-core", "dist", "index.js")),
  );
  assert.equal(
    paths.piHostAliases["@earendil-works/pi-tui"],
    realpathSync(sharedPiTuiEntry),
    "pi-tui entry must be reported as its real path",
  );
  assert.equal(paths.piHostModuleUrl, pathToFileURL(paths.piHostAliases["@earendil-works/pi-coding-agent"]).href);
});

test("host aliases follow each package manifest instead of a hard-coded dist layout", async () => {
  const { candidateRoot } = await createPiHostFixture({ piAiCompatEntry: "./dist/compat-entry.mjs" });
  const paths = resolvePiHostPaths({ env: { PI_TEST_CODING_AGENT_ROOT: candidateRoot } });

  assert.equal(
    paths.piHostAliases["@earendil-works/pi-ai/compat"],
    realpathSync(join(candidateRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "compat-entry.mjs")),
  );
});

test("host aliases point at the same pi-tui entry the Host itself resolves", () => {
  const paths = resolvePiHostPaths({ env: { PI_TEST_CODING_AGENT_ROOT: explicitCandidateRoot } });
  const hostRequire = createRequire(join(paths.piHostRoot, "dist", "index.js"));
  assert.equal(paths.piHostAliases["@earendil-works/pi-tui"], hostRequire.resolve("@earendil-works/pi-tui"));
});

async function assertSingleCustomEditorIdentity(candidateRoot) {
  const runtime = await loadPiTestRuntime(import.meta.url, {
    env: { PI_TEST_CODING_AGENT_ROOT: candidateRoot },
  });
  const viewport = await runtime.jiti.import(sessionViewportPath);
  const editor = new viewport.ReadOnlyBrowserEditor({ requestRender() {} }, { borderColor: (text) => text, selectList: {} }, {});
  const jitiCodingAgent = await runtime.jiti.import("@earendil-works/pi-coding-agent");

  assert.equal(runtime.root, candidateRoot);
  assert.equal(
    jitiCodingAgent.CustomEditor,
    runtime.codingAgent.CustomEditor,
    "jiti public specifier import must reuse the runtime module instance",
  );
  assert.equal(
    Object.getPrototypeOf(Object.getPrototypeOf(editor)),
    runtime.codingAgent.CustomEditor.prototype,
    "editor prototype must come from the runtime CustomEditor",
  );
  assert.equal(editor instanceof runtime.codingAgent.CustomEditor, true);
  const jitiPiTui = await runtime.jiti.import("@earendil-works/pi-tui");
  assert.equal(jitiPiTui.visibleWidth, runtime.piTui.visibleWidth, "pi-tui must load as a single instance");
  return runtime;
}

test("jiti and runtime share one CustomEditor for an explicit candidate root", async () => {
  await assertSingleCustomEditorIdentity(explicitCandidateRoot);
});

test("jiti and runtime share one CustomEditor for the global Pi installation", async () => {
  await assertSingleCustomEditorIdentity(resolvePiCodingAgentRoot());
});
