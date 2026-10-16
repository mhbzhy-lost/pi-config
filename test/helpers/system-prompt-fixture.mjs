/**
 * `customPrompt` / `forceSystemPrompt` 完整替换策略测试专用 helper（测试自有，不入生产）。
 *
 * 职责边界：
 * - 只提供「真实 SDK 编排 + 真实生产 handler」的最小可测边界，以及静态 AST 扫描器实现；
 * - 策略常量（白名单、豁免、profile 名册）由 `test/system-prompt-override-policy.test.mjs` 持有并传入；
 * - 不读取真实用户配置（settings.json / models.json / auth.json / trust.json / run-history /
 *   sessions / logs / authority / state 一律不打开），只读取调用方显式枚举的仓库自有生产目录。
 *
 * 事实来源（源码为准，非转述）：
 * - SDK `dist/core/extensions/runner.js:1121-1164` `emitBeforeAgentStart`：handler 返回
 *   `{ systemPrompt }` 时执行 `currentOptions.forceSystemPrompt = result.systemPrompt`；
 *   `event.systemPrompt` 是由真实 `buildSystemPrompt(currentOptions)` 渲染的 getter。
 * - SDK `dist/core/system-prompt.js:78-79,126-128`：`customPrompt` 作 preamble 时 else 分支
 *   （tools/rules/docs）被整体跳过；`forceSystemPrompt !== undefined` 时 state 只有不透明
 *   `content`，没有 sections。两者都会让 `promptGuidelines` / `toolGuidelines` 消失。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { loadPiTestRuntime } from "./pi-runtime.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");

/** 仓库根（物理路径），所有扫描 roots 都相对它解析并回报相对路径。 */
export const REPO_ROOT = repositoryRoot;

/* -------------------------------------------------------------------------- */
/* TypeScript 解析器解析：只用仓库已安装依赖，不做 npm install                   */
/* -------------------------------------------------------------------------- */

function isClassicTypeScriptApi(candidate) {
  return (
    !!candidate &&
    typeof candidate.createSourceFile === "function" &&
    !!candidate.SyntaxKind &&
    typeof candidate.forEachChild === "function"
  );
}

function loadTypeScriptFrom(fromFile) {
  try {
    const entry = createRequire(pathToFileURL(fromFile)).resolve("typescript");
    const loaded = createRequire(pathToFileURL(fromFile))(entry);
    if (isClassicTypeScriptApi(loaded)) return { module: loaded, entry };
    return { module: undefined, entry };
  } catch {
    return { module: undefined, entry: undefined };
  }
}

let cachedTypeScript;

/**
 * 解析提供经典 AST API（`createSourceFile` / `SyntaxKind` / `forEachChild`）的 TypeScript。
 *
 * 根 devDependency `typescript@7.0.2` 是原生端口，公开入口不暴露 JS 解析器
 * （`typescript/unstable/*` 需要原生二进制句柄），因此优先解析工作区已安装的
 * `packages/pi-subagents-enhanced` 运行时依赖 `typescript@5.9.3`（`npm ls typescript`
 * 可见，属仓库既有依赖树，无需 npm install）。两者都不可用时 fail closed，
 * 不降级为 regex-only 扫描（那会静默削弱策略）。
 */
export function resolveClassicTypeScript() {
  if (cachedTypeScript) return cachedTypeScript;
  const candidates = [
    join(repositoryRoot, "packages", "pi-subagents-enhanced", "package.json"),
    join(repositoryRoot, "package.json"),
  ];
  const attempted = [];
  for (const fromFile of candidates) {
    if (!existsSync(fromFile)) continue;
    const { module: loaded, entry } = loadTypeScriptFrom(fromFile);
    attempted.push({ fromFile, entry, usable: !!loaded });
    if (loaded) {
      cachedTypeScript = { ts: loaded, entry, attempted };
      return cachedTypeScript;
    }
  }
  throw new Error(
    `no installed TypeScript exposes the classic AST API (createSourceFile/SyntaxKind); attempted: ${JSON.stringify(attempted)}`,
  );
}

/* -------------------------------------------------------------------------- */
/* 真实 SDK 编排 harness：真实 ExtensionRunner + 真实生产 handler                */
/* -------------------------------------------------------------------------- */

let cachedSdk;

/** 通过仓库既有 `test/helpers/pi-runtime.mjs` 解析本仓物理 SDK 的公开导出。 */
export async function loadPromptPolicySdk() {
  if (cachedSdk) return cachedSdk;
  const { codingAgent } = await loadPiTestRuntime(import.meta.url);
  for (const name of ["ExtensionRunner", "createExtensionRuntime", "parseFrontmatter", "stripFrontmatter"]) {
    if (typeof codingAgent[name] !== "function") {
      throw new Error(`public SDK export ${name} is missing; refusing to fake the runner boundary`);
    }
  }
  cachedSdk = codingAgent;
  return codingAgent;
}

/**
 * 最小可测边界：只实现生产 factory 实际消费的 `pi.on` / `pi.events.emit`，把真实
 * handler 收进 `Extension.handlers`（SDK 公开 `Extension` 接口的形状：
 * `path: string; handlers: Map<string, HandlerFn[]>`），交给真实 `ExtensionRunner`。
 * 不替换、不 patch 任何 SDK 内部实现。
 */
export function createExtensionRecorder(extensionPath) {
  const handlers = new Map();
  const emittedEvents = [];
  const api = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {
        const list = handlers.get(event);
        if (!list) return;
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },
    events: {
      emit(name, payload) {
        emittedEvents.push({ name, payload });
      },
    },
  };
  return {
    api,
    emittedEvents,
    extension: { path: extensionPath, resolvedPath: extensionPath, handlers },
  };
}

/** 记录 handler 看到的 `event.systemPrompt`（真实 SDK 渲染结果），返回 undefined 不改写。 */
export function createSystemPromptProbe(extensionPath) {
  const recorder = createExtensionRecorder(extensionPath);
  const seen = [];
  recorder.extension.handlers.set("before_agent_start", [
    async (event) => {
      seen.push(event.systemPrompt);
      return undefined;
    },
  ]);
  recorder.seen = seen;
  Object.defineProperty(recorder, "lastSeen", { get: () => seen.at(-1) });
  return recorder;
}

export const GUIDELINE_CANARY = Object.freeze({
  tool: "PROMPT-POLICY-CANARY-TOOLGUIDELINE-9f3a1c",
  prompt: "PROMPT-POLICY-CANARY-PROMPTGUIDELINE-7b21de",
});

/**
 * 构造注入 guideline canary 的真实 `BuildSystemPromptOptions`。
 * canary 走 SDK 的 `toolGuidelines` / `promptGuidelines` 正规入口，由真实
 * `buildRules` 渲染进 `<rules>` section；替换语义一旦发生，canary 立即消失。
 */
export function createCanaryOptions({ cwd, appendSystemPrompt, selectedTools = ["read", "bash"], extra } = {}) {
  return {
    cwd: cwd ?? repositoryRoot,
    selectedTools,
    toolGuidelines: { [selectedTools[0] ?? "read"]: [GUIDELINE_CANARY.tool] },
    promptGuidelines: [GUIDELINE_CANARY.prompt],
    ...(appendSystemPrompt === undefined ? {} : { appendSystemPrompt }),
    ...(extra ?? {}),
  };
}

/**
 * 用真实 `ExtensionRunner.emitBeforeAgentStart` 跑一次 before_agent_start 编排。
 *
 * 返回：
 * - `base`：第一个探针看到的 prompt（生产 handler 之前的真实渲染结果）；
 * - `final`：最后一个探针看到的 prompt（全部 handler 之后的真实渲染结果）；
 * - `systemPromptOptions`：runner 归一化并可能被 handler 改写后的可变 options；
 * - `errors`：runner 通过 `onError` 报出的扩展异常（真实 SDK 错误通道）。
 */
export async function runBeforeAgentStart({ extensions = [], prompt = "policy-probe", options, cwd } = {}) {
  const { ExtensionRunner, createExtensionRuntime } = await loadPromptPolicySdk();
  const first = createSystemPromptProbe("<probe:first>");
  const last = createSystemPromptProbe("<probe:last>");
  const ordered = [first.extension, ...extensions, last.extension];
  const runner = new ExtensionRunner(
    ordered,
    createExtensionRuntime(),
    cwd ?? repositoryRoot,
    undefined,
    undefined,
  );
  const errors = [];
  runner.onError((error) => errors.push(error));
  const result = await runner.emitBeforeAgentStart(prompt, [], options ?? createCanaryOptions({ cwd }));
  return {
    runner,
    base: first.lastSeen,
    final: last.lastSeen,
    systemPromptOptions: result.systemPromptOptions,
    messages: result.messages,
    errors,
  };
}

/** 真实 SDK 的 input 门禁编排（生产 handler 用它加载 AGENTS_* 快照）。 */
export async function runInput({ extensions = [], text = "policy-probe", cwd } = {}) {
  const { ExtensionRunner, createExtensionRuntime } = await loadPromptPolicySdk();
  const runner = new ExtensionRunner(extensions, createExtensionRuntime(), cwd ?? repositoryRoot, undefined, undefined);
  const errors = [];
  runner.onError((error) => errors.push(error));
  return { result: await runner.emitInput(text, [], "user", undefined), errors };
}

const { createAgentsGlobalExtension } = await import("../../src/agents-global/index.ts");
const { createAgentsSharedExtension } = await import("../../src/agents-shared/index.ts");

/**
 * 安装**真实生产** GLOBAL factory（`src/agents-global/index.ts`）。
 * `agentsGlobalPath` / `readFile` 是 factory 自己声明的可注入依赖，不是伪造 handler。
 */
export function installAgentsGlobal({ extensionPath = "<src/agents-global/index.ts>", instructions, path = "/fixture/AGENTS_GLOBAL.md" }) {
  const recorder = createExtensionRecorder(extensionPath);
  createAgentsGlobalExtension(recorder.api, {
    agentsGlobalPath: path,
    readFile: async () => {
      if (instructions instanceof Error) throw instructions;
      return typeof instructions === "function" ? instructions() : instructions;
    },
  });
  return recorder;
}

/** 安装**真实生产** SHARED factory（`src/agents-shared/index.ts`），scope 由调用方显式声明。 */
export function installAgentsShared({ extensionPath = "<src/agents-shared/index.ts>", instructions, scope = "main", path = "/fixture/AGENTS_SHARED.md" }) {
  const recorder = createExtensionRecorder(extensionPath);
  createAgentsSharedExtension(recorder.api, {
    agentsSharedPath: path,
    scope,
    readFile: async () => {
      if (instructions instanceof Error) throw instructions;
      return typeof instructions === "function" ? instructions() : instructions;
    },
  });
  return recorder;
}

export const SHARED_CHILD_BLOCK_OPEN = '<pi_child_execution_boundaries source="runtime">';
export const GLOBAL_BLOCK_OPEN = '<pi_global_instructions source="PI_CODING_AGENT_DIR/AGENTS_GLOBAL.md">';
export const GLOBAL_BLOCK_CLOSE = "</pi_global_instructions>";
export const SHARED_BLOCK_OPEN = '<pi_shared_instructions source="PI_CODING_AGENT_DIR/AGENTS_SHARED.md">';

/* -------------------------------------------------------------------------- */
/* profile / SYSTEM.md 探针（只看仓库自有路径，不读真实用户配置）                 */
/* -------------------------------------------------------------------------- */

const PROFILE_DIR = join("pi", "agents");

/**
 * `SYSTEM.md` / `APPEND_SYSTEM.md` 文件名分类（纯函数，供存在性探针与自测共用）。
 * SDK `dist/core/resource-loader.js` 把 `SYSTEM.md` 接到 `customPrompt`（完整替换），
 * `APPEND_SYSTEM.md` 接到 `appendSystemPrompt`（合法追加）。
 */
export function classifySystemPromptMarkdownName(basename) {
  if (basename === "SYSTEM.md") return "replace";
  if (basename === "APPEND_SYSTEM.md") return "append";
  return "unrelated";
}

/**
 * profile frontmatter `systemPromptMode` 分类（纯函数）。
 * 只有**显式** `append` 合法：缺失也拒绝（上游 child-launch 多数路径默认 replace），
 * 不接受任何其它取值。
 */
export function classifyProfileSystemPromptMode(frontmatter) {
  if (!frontmatter || typeof frontmatter !== "object") return "missing";
  if (!Object.hasOwn(frontmatter, "systemPromptMode")) return "missing";
  const value = frontmatter.systemPromptMode;
  if (value === "append") return "append";
  return typeof value === "string" && value.trim() === "" ? "missing" : "other";
}

/** 读取仓库自有 profile 的 frontmatter 与正文，使用 SDK 公开 `parseFrontmatter`。 */
export async function inspectAgentProfiles({ expectedRoster } = {}) {
  const { parseFrontmatter, stripFrontmatter } = await loadPromptPolicySdk();
  const dir = join(repositoryRoot, PROFILE_DIR);
  if (!existsSync(dir)) throw new Error(`profile directory ${PROFILE_DIR} is missing`);
  const names = readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
  const profiles = names.map((name) => {
    const text = readFileSync(join(dir, name), "utf8");
    const parsed = parseFrontmatter(text);
    return {
      name,
      path: `${PROFILE_DIR}/${name}`,
      frontmatter: parsed.frontmatter ?? {},
      body: stripFrontmatter(text).trim(),
      systemPromptMode: (parsed.frontmatter ?? {}).systemPromptMode,
    };
  });
  if (Array.isArray(expectedRoster)) {
    const actual = names.slice();
    const missing = expectedRoster.filter((item) => !actual.includes(item));
    const unexpected = actual.filter((item) => !expectedRoster.includes(item));
    if (missing.length > 0 || unexpected.length > 0) {
      throw new Error(
        `profile roster drift: missing=${JSON.stringify(missing)} unexpected=${JSON.stringify(unexpected)}`,
      );
    }
  }
  return profiles;
}

const IGNORED_BASENAMES = new Set([".DS_Store", "Thumbs.db"]);
const SKIPPED_DIRECTORY_NAMES = new Set(["node_modules", "dist", "var", "vendor", ".git", "sessions", "logs", "run-history"]);

function* walkFiles(root) {
  if (!existsSync(root)) return;
  const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
      yield* walkFiles(full);
      continue;
    }
    if (!entry.isFile()) continue;
    yield full;
  }
}

/**
 * `SYSTEM.md` / `APPEND_SYSTEM.md` 存在性探针。
 *
 * SDK `dist/core/resource-loader.js:941-945` 把 `SYSTEM.md` 接到 `customPrompt` 路径
 * （完整替换），`APPEND_SYSTEM.md` 才是合法追加。探针只枚举**文件名**：
 * - 声明的生产扫描 roots（递归）；
 * - 仓库根、`pi/`、`.pi/`（仅 depth-1 文件名，不打开任何文件内容）。
 * 真实用户目录（`~/.pi`）不在探针范围内，属静态扫描外风险，由记录如实标注。
 */
export function probeSystemPromptMarkdown({ roots }) {
  const probes = [repositoryRoot, join(repositoryRoot, "pi"), join(repositoryRoot, ".pi"), ...roots.map((root) => resolve(repositoryRoot, root))];
  const system = [];
  const appendSystem = [];
  for (const probeRoot of probes) {
    if (!existsSync(probeRoot)) continue;
    const recursive = roots.some((root) => resolve(repositoryRoot, root) === resolve(probeRoot));
    const files = recursive ? [...walkFiles(probeRoot)] : shallowFiles(probeRoot);
    for (const file of files) {
      const base = file.split(sep).at(-1);
      const rel = relative(repositoryRoot, file);
      if (base === "SYSTEM.md") system.push(rel);
      else if (base === "APPEND_SYSTEM.md") appendSystem.push(rel);
      else if (classifySystemPromptMarkdownName(base) !== "unrelated") system.push(rel);
    }
  }
  return { system: [...new Set(system)].sort(), appendSystem: [...new Set(appendSystem)].sort() };
}

function shallowFiles(root) {
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(root, entry.name));
}

/* -------------------------------------------------------------------------- */
/* 静态 AST 扫描器                                                             */
/* -------------------------------------------------------------------------- */

/** AST 解析的自有生产源码扩展名（production 自有 TS/JS）。 */
const SOURCE_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx", ".tsx"]);
/** 只做字面探针的非源码文本（launcher / 配置），不做 AST 判类。 */
const TEXT_PROBE_EXTENSIONS = new Set([".zsh", ".sh", ".bash", ".json", ".yaml", ".yml", ".txt"]);

/** 默认禁止的完整替换标识符：写入与读取都不允许出现在自有生产代码里。 */
const BANNED_OVERRIDE_NAMES = ["customPrompt", "forceSystemPrompt", "systemPromptOverride"];
const REPLACE_FLAG_LITERAL = "--system-prompt";
const APPEND_FLAG_LITERAL = "--append-system-prompt";

function scriptKindFor(ts, extension) {
  if (extension === ".ts" || extension === ".mts" || extension === ".cts" || extension === ".tsx") return ts.ScriptKind.TS;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function* iterateNodes(node) {
  yield node;
  const children = [];
  node.forEachChild((child) => {
    children.push(child);
  });
  // forEachChild 不保证回调顺序与源码位置一致时仍能先收集再递归，
  // 这里显式按源码位置排序，保证 ordinal / site 顺序可重现。
  children.sort((a, b) => a.getStart() - b.getStart());
  for (const child of children) yield* iterateNodes(child);
}

/** 结构化 shape 指纹：稳定于换行/缩进/行号，敏感于表达式结构与局部标识符名。 */
function describeShape(ts, node, depth = 0) {
  if (node === undefined) return "void";
  if (depth > 8) return "…";
  const kind = node.kind;
  const deeper = (child) => describeShape(ts, child, depth + 1);
  if (ts.isIdentifier(node)) return `id(${node.text})`;
  if (ts.isStringLiteralLike?.(node) || kind === ts.SyntaxKind.StringLiteral || kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) return "str";
  if (kind === ts.SyntaxKind.NumericLiteral) return "num";
  if (ts.isPropertyAccessExpression(node)) return `${deeper(node.expression)}.${node.name.text}`;
  if (ts.isCallExpression(node)) return `${deeper(node.expression)}(${node.arguments.map(deeper).join(",")})`;
  if (ts.isArrayLiteralExpression(node)) return `[${node.elements.map(deeper).join(",")}]`;
  if (ts.isSpreadAssignment(node)) return `...${deeper(node.expression)}`;
  if (ts.isSpreadElement(node)) return `...${deeper(node.expression)}`;
  if (ts.isBinaryExpression(node)) return `${deeper(node.left)}${node.operatorToken.getText()}${deeper(node.right)}`;
  if (ts.isParenthesizedExpression(node)) return deeper(node.expression);
  if (ts.isConditionalExpression(node)) return `cond(${deeper(node.condition)};${deeper(node.whenTrue)};${deeper(node.whenFalse)})`;
  if (ts.isTemplateExpression(node)) return "tpl";
  if (ts.isObjectLiteralExpression(node)) return `{${node.properties.map(deeper).join(",")}}`;
  if (ts.isAwaitExpression(node)) return `await ${deeper(node.expression)}`
  return ts.SyntaxKind[kind] ?? `kind(${kind})`;
}

/** 由外到内的具名函数作用域链，作为 site 的稳定 enclosing 指纹（不依赖行号）。 */
function functionLabelChain(ts, node) {
  const labels = [];
  let current = node?.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current)) labels.push(`function ${current.name?.text ?? "<anonymous>"}`);
    else if (ts.isFunctionExpression(current)) labels.push(current.name ? `function ${current.name.text}` : "function-expression");
    else if (ts.isArrowFunction(current)) labels.push("arrow");
    else if (ts.isMethodDeclaration(current)) labels.push(`method ${current.name?.getText?.() ?? "<computed>"}`);
    else if (ts.isClassDeclaration(current)) labels.push(`class ${current.name?.text ?? "<anonymous>"}`);
    current = current.parent;
  }
  return labels.reverse().join(" > ") || "<module>";
}

function nearestFunction(ts, node) {
  let current = node?.parent;
  while (current) {
    if (
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current) ||
      ts.isFunctionDeclaration(current) ||
      ts.isMethodDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

/** 该节点是否处于 `new Set([...])` 的数组字面量里（flag 名分类器语境）。 */
function isInFlagClassifierSet(ts, node) {
  let current = node.parent;
  while (current) {
    if (ts.isArrayLiteralExpression(current)) {
      const parent = current.parent;
      return (
        ts.isNewExpression(parent) &&
        ts.isIdentifier(parent.expression) &&
        parent.expression.text === "Set" &&
        parent.arguments?.[0] === current
      );
    }
    // 字面量可以直接是 Set 构造参数，也可以嵌在数组里；遇到其它结构即停止上溯。
    if (!ts.isParenthesizedExpression(current) && !ts.isAsExpression(current)) return false;
    current = current.parent;
  }
  return false;
}

/** 识别 `event.systemPromptOptions` 及其局部别名，用于计算键写入的 fail-closed 判定。 */
function collectOptionsAliases(ts, sourceFile) {
  const aliases = new Set();
  const isOptionsMember = (node) =>
    ts.isPropertyAccessExpression(node) && node.name.text === "systemPromptOptions";
  for (const node of iterateNodes(sourceFile)) {
    if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.initializer) {
      if (isOptionsMember(node.initializer)) aliases.add(node.name.text);
    }
    if (ts.isParameter(node) && node.name && ts.isIdentifier(node.name)) {
      // 形如 `handler(event, ctx)` 里的 `event.systemPromptOptions` 解构参数：`{ systemPromptOptions }`
      continue;
    }
    if (ts.isBindingElement(node) && node.name && ts.isIdentifier(node.name) && node.propertyName?.text === "systemPromptOptions") {
      aliases.add(node.name.text);
    }
  }
  return aliases;
}

function optionsTargetRootName(ts, node) {
  let current = node;
  while (current) {
    if (ts.isIdentifier(current)) return current.text;
    if (ts.isPropertyAccessExpression(current)) {
      if (current.name.text === "systemPromptOptions") return "systemPromptOptions";
      current = current.expression;
      continue;
    }
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    return undefined;
  }
  return undefined;
}

function collectBeforeAgentStartHandlers(ts, sourceFile) {
  const localFunctions = new Map();
  for (const node of iterateNodes(sourceFile)) {
    if (ts.isFunctionDeclaration(node) && node.name) localFunctions.set(node.name.text, node);
    if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
        localFunctions.set(node.name.text, node.initializer);
      }
    }
  }
  const handlers = new Set();
  for (const node of iterateNodes(sourceFile)) {
    if (!ts.isCallExpression(node)) continue;
    const callee = node.expression;
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "on") continue;
    const [eventName, target] = node.arguments;
    if (!eventName || !ts.isStringLiteralLike(eventName) || eventName.text !== "before_agent_start") continue;
    if (!target) continue;
    if (ts.isArrowFunction(target) || ts.isFunctionExpression(target)) {
      handlers.add(target);
      continue;
    }
    if (ts.isIdentifier(target)) {
      const resolved = localFunctions.get(target.text);
      if (resolved) handlers.add(resolved);
    }
  }
  return handlers;
}

function assignmentOperatorText(ts, node) {
  if (!ts.isBinaryExpression(node)) return undefined;
  const token = node.operatorToken.kind;
  const assignmentKinds = [
    ts.SyntaxKind.EqualsToken,
    ts.SyntaxKind.PlusEqualsToken,
    ts.SyntaxKind.MinusEqualsToken,
    ts.SyntaxKind.AmpersandAmpersandEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken,
  ];
  return assignmentKinds.includes(token) ? node.operatorToken.getText() : undefined;
}

function propertyNameText(ts, node) {
  if (node === undefined) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteralLike?.(node) || ts.isPrivateIdentifier?.(node)) return node.text;
  if (typeof node.text === "string") return node.text;
  return undefined;
}

/**
 * 扫描单个源文件，返回分类后的 site 与违规。
 *
 * 能力边界（如实声明，不宣称通用 taint engine）：
 * - 覆盖：字面属性名写入/返回、字面 banned 标识符、`systemPromptOptions` 上的计算键写入与
 *   `Object.assign`/`delete`、`--system-prompt` 的 argv 注入语境、handler 返回体里的 spread/简写；
 * - 不覆盖：`eval`、Proxy 拦截、跨模块间接别名、运行时字符串拼接后的动态属性访问、
 *   Host/vendored node_modules 层行为、真实用户 settings（`subagents.agentOverrides.*.systemPrompt`）。
 *   这些不是「已验证安全」，而是「静态不可达」，由记录标注为扫描外风险。
 */
function scanSourceFile({ ts, relPath, text, extension, policy }) {
  const sourceFile = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, scriptKindFor(ts, extension));
  const violations = [];
  const sites = [];
  const handlerFunctions = collectBeforeAgentStartHandlers(ts, sourceFile);
  const optionsAliases = collectOptionsAliases(ts, sourceFile);
  const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const push = (kind, node, detail) => sites.push({ path: relPath, line: lineOf(node), kind, detail });
  const fail = (rule, node, message) => violations.push({ path: relPath, line: lineOf(node), rule, message });

  const isOptionsAliasIdentifier = (node) => ts.isIdentifier(node) && optionsAliases.has(node.text);
  const isOptionsTarget = (node) => {
    const root = optionsTargetRootName(ts, node);
    return root === "systemPromptOptions" || (root !== undefined && optionsAliases.has(root));
  };

  // handler 返回位判定：return 语句的最近具名/匿名函数必须是被注册为 before_agent_start 的 handler。
  const handlerReturnOrdinals = new Map();
  const isHandlerReturnObject = (objectLiteral) => {
    let current = objectLiteral.parent;
    while (current && ts.isParenthesizedExpression(current)) current = current.parent;
    if (!current || !ts.isReturnStatement(current)) return false;
    const fn = nearestFunction(ts, current);
    return fn !== undefined && handlerFunctions.has(fn);
  };

  for (const node of iterateNodes(sourceFile)) {
    /* --- 1. 默认禁止的完整替换标识符 ------------------------------------ */
    if (ts.isIdentifier(node) && BANNED_OVERRIDE_NAMES.includes(node.text)) {
      fail(
        "banned-override-identifier",
        node,
        `自有生产代码出现完整替换标识符 \`${node.text}\`（默认禁止，读写一律不放行）`,
      );
      continue;
    }
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      BANNED_OVERRIDE_NAMES.includes(node.text)
    ) {
      fail(
        "banned-override-key-literal",
        node,
        `自有生产代码出现完整替换键字面量 \`${node.text}\`（含计算键/别名写法，默认禁止）`,
      );
      continue;
    }

    /* --- 2. launcher argv 主动注入 -------------------------------------- */
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (node.text === REPLACE_FLAG_LITERAL) {
        if (isInFlagClassifierSet(ts, node)) {
          push("flag-classifier-literal", node, REPLACE_FLAG_LITERAL);
        } else {
          fail(
            "launcher-argv-injection",
            node,
            `\`${REPLACE_FLAG_LITERAL}\` 只允许作为 flag 名分类器字面量出现在 new Set([...]) 中；此处语境无法证明不是 launcher argv 主动注入`,
          );
        }
        continue;
      }
      if (node.text === APPEND_FLAG_LITERAL) {
        push("append-flag-literal", node, APPEND_FLAG_LITERAL);
        continue;
      }
    }

    /* --- 3. systemPromptOptions 上的不可判定写入 ------------------------- */
    if (ts.isBinaryExpression(node) && assignmentOperatorText(ts, node)) {
      const target = node.left;
      if (ts.isElementAccessExpression(target) && isOptionsTarget(target.expression)) {
        fail(
          "computed-key-write-unclassified",
          node,
          "对 `systemPromptOptions` 的计算键写入无法静态判类（键可能是 customPrompt/forceSystemPrompt）→ fail closed",
        );
        continue;
      }
      if (ts.isPropertyAccessExpression(target) && target.name.text === "systemPrompt") {
        fail("option-write-systemPrompt", node, "直接对 `*.systemPrompt` 赋值属完整替换写入，未在白名单内");
        continue;
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "assign" &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Object" &&
      node.arguments.length > 0 &&
      isOptionsTarget(node.arguments[0])
    ) {
      fail(
        "object-assign-on-options-unclassified",
        node,
        "`Object.assign(systemPromptOptions, ...)` 可注入 customPrompt/forceSystemPrompt，静态不可判类 → fail closed",
      );
      continue;
    }
    // delete <options>.x / delete <options>[k]：TypeScript AST 使用独立 DeleteExpression。
    if (ts.isDeleteExpression(node)) {
      const operand = node.expression;
      if ((ts.isPropertyAccessExpression(operand) || ts.isElementAccessExpression(operand)) && isOptionsTarget(operand.expression)) {
        fail(
          "delete-on-options-unclassified",
          node,
          "对 `systemPromptOptions` 成员的 delete 可摘除 promptGuidelines/appendSystemPrompt → fail closed",
        );
      }
      continue;
    }

    /* --- 4. systemPromptMode 代码侧 replace ------------------------------ */
    if (
      ts.isPropertyAssignment(node) &&
      propertyNameText(ts, node.name) === "systemPromptMode" &&
      ts.isStringLiteralLike(node.initializer) &&
      node.initializer.text === "replace"
    ) {
      fail("profile-mode-replace-in-code", node, "自有生产代码写 `systemPromptMode: replace` → 完整替换，拒绝");
      continue;
    }

    /* --- 5. systemPrompt 名字出现处的穷尽判类 ---------------------------- */
    // 属性名位置的 identifier / 字符串字面量由父节点判类，避免同一处重复上报。
    const parentNode = node.parent;
    if (
      (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      parentNode !== undefined &&
      ((ts.isPropertyAccessExpression(parentNode) && parentNode.name === node) ||
        ((ts.isPropertyAssignment(parentNode) ||
          ts.isShorthandPropertyAssignment(parentNode) ||
          ts.isPropertySignature(parentNode) ||
          ts.isPropertyDeclaration(parentNode) ||
          ts.isMethodDeclaration(parentNode) ||
          ts.isMethodSignature(parentNode) ||
          ts.isGetAccessorDeclaration(parentNode) ||
          ts.isSetAccessorDeclaration(parentNode)) &&
          parentNode.name === node))
    ) {
      continue;
    }

    const isNamedSystemPrompt = (() => {
      if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) {
        return propertyNameText(ts, node.name) === "systemPrompt";
      }
      if (ts.isPropertyAccessExpression(node)) return node.name.text === "systemPrompt";
      if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
        return node.argumentExpression.text === "systemPrompt";
      }
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === "systemPrompt") return true;
      if (ts.isIdentifier(node) && node.text === "systemPrompt") return true;
      return false;
    })();
    if (!isNamedSystemPrompt) continue;

    // 5a. 类型声明成员（无运行时写入能力）
    if ((ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) && node.initializer === undefined) {
      push("type-declaration", node, propertyNameText(ts, node.name));
      continue;
    }
    // 5b. 只读访问（含 tool/handler 可读的 `event.systemPrompt` getter，合同明确要求不得误伤）
    if (ts.isPropertyAccessExpression(node)) {
      const parent = node.parent;
      const isWriteTarget = ts.isBinaryExpression(parent) && assignmentOperatorText(ts, parent) && parent.left === node;
      if (isWriteTarget) {
        fail("option-write-systemPrompt", node, "对 `*.systemPrompt` 赋值属完整替换写入，未在白名单内");
      } else {
        push("read-access", node, node.getText(sourceFile));
      }
      continue;
    }
    // 5c. 字符串键的 element access 写入/读取
    if (ts.isElementAccessExpression(node)) {
      fail(
        "string-key-access-unclassified",
        node,
        "`systemPromptOptions[\"systemPrompt\"]` 形式的字符串键访问无法证明是只读 → fail closed",
      );
      continue;
    }
    // 5d. 对象字面量属性：区分 handler 返回位（替换入口）与数据 DTO
    if (ts.isPropertyAssignment(node)) {
      const objectLiteral = node.parent;
      if (!ts.isObjectLiteralExpression(objectLiteral)) {
        fail("unclassified-systemPrompt-property", node, "`systemPrompt` 属性出现在不可判类的语法位置 → fail closed");
        continue;
      }
      if (isHandlerReturnObject(objectLiteral)) {
        const fn = nearestFunction(ts, objectLiteral);
        const enclosing = functionLabelChain(ts, objectLiteral);
        const key = `${fn === undefined ? "<module>" : "fn"}@${enclosing}`;
        const ordinal = (handlerReturnOrdinals.get(key) ?? 0) + 1;
        handlerReturnOrdinals.set(key, ordinal);
        const site = {
          path: relPath,
          line: lineOf(node),
          kind: "handler-return-replacement",
          enclosing,
          ordinal,
          shape: describeShape(ts, node.initializer),
          detail: node.getText(sourceFile),
        };
        sites.push(site);
        const entry = policy.whitelist.find((item) => item.path === relPath && item.enclosing === enclosing && item.ordinal === ordinal);
        if (!entry) {
          fail(
            "unknown-handler-return-replacement",
            node,
            `未登记的 before_agent_start 完整替换 site：${relPath} enclosing=\`${enclosing}\` ordinal=${ordinal} shape=\`${site.shape}\`（默认拒绝；需先由真实 handler 的 guideline 保留行为测试背书再精确入白名单）`,
          );
        } else if (entry.shape !== site.shape) {
          fail(
            "whitelist-shape-drift",
            node,
            `白名单 site 的结构指纹漂移：${relPath}#${ordinal} 期望 \`${entry.shape}\`，实际 \`${site.shape}\``,
          );
        } else {
          policy.matchedWhitelistKeys.add(`${relPath}::${enclosing}::${ordinal}`);
        }
        continue;
      }
      const enclosing = functionLabelChain(ts, node);
      const site = {
        path: relPath,
        line: lineOf(node),
        kind: "data-dto",
        enclosing,
        shape: describeShape(ts, node.initializer),
        detail: node.getText(sourceFile),
      };
      sites.push(site);
      const exemption = policy.dataDtoSites.find((item) => item.path === relPath && item.enclosing === enclosing && item.shape === site.shape);
      if (!exemption) {
        fail(
          "unclassified-data-dto",
          node,
          `未登记的 \`systemPrompt\` 数据 DTO site：${relPath} enclosing=\`${enclosing}\` shape=\`${site.shape}\`（DTO 豁免按精确 site 授予，不做目录级忽略）`,
        );
      } else {
        policy.matchedDataDtoKeys.add(`${relPath}::${enclosing}::${site.shape}`);
      }
      continue;
    }
    // 5e. 简写与 spread：无法证明不是替换入口
    if (ts.isShorthandPropertyAssignment(node)) {
      fail("shorthand-systemPrompt-unclassified", node, "`{ systemPrompt }` 简写无法静态判类是否进入 handler 返回 → fail closed");
      continue;
    }
    if (ts.isSpreadAssignment(node)) {
      fail("spread-in-handler-return", node, "handler 返回体里的 spread 可携带 systemPrompt 替换 → fail closed");
      continue;
    }
    // 5f. 其它 identifier（局部变量/参数名等）
    fail(
      "unclassified-systemPrompt-usage",
      node,
      `\`systemPrompt\` 出现在未判类的语法位置（${ts.SyntaxKind[node.kind]}）→ fail closed`,
    );
  }

  // handler 返回体里的 spread 单独复查（上面只在名字命中时才走到）
  for (const node of iterateNodes(sourceFile)) {
    if (!ts.isObjectLiteralExpression(node)) continue;
    if (!isHandlerReturnObject(node)) continue;
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        fail(
          "spread-in-handler-return",
          property,
          "before_agent_start 返回对象含 spread：无法证明不携带完整替换字段 → fail closed",
        );
      }
    }
  }

  return { sites, violations };
}

function scanTextFile({ relPath, text }) {
  const violations = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    for (const name of BANNED_OVERRIDE_NAMES) {
      if (line.includes(name)) {
        violations.push({
          path: relPath,
          line: index + 1,
          rule: "banned-override-literal-in-text",
          message: `非源码文本出现完整替换标识符 \`${name}\`（默认禁止）`,
        });
      }
    }
    if (line.includes(REPLACE_FLAG_LITERAL)) {
      violations.push({
        path: relPath,
        line: index + 1,
        rule: "launcher-argv-injection",
        message: `launcher/配置文本出现 \`${REPLACE_FLAG_LITERAL}\`：非 flag 名分类器语境即视为主动注入完整替换`,
      });
    }
  });
  return violations;
}

/** 白名单 / DTO 豁免不得留死条目：登记了就必须真的被现场命中。 */
function assertNoDeadEntries({ policy, violations, whitelist, dataDtoSites }) {
  for (const entry of whitelist) {
    if (!policy.matchedWhitelistKeys.has(`${entry.path}::${entry.enclosing}::${entry.ordinal}`)) {
      violations.push({
        path: entry.path,
        line: 0,
        rule: "whitelist-entry-not-found",
        message: `白名单条目在现场未被命中（site 已消失或指纹漂移）：${entry.path} enclosing=\`${entry.enclosing}\` ordinal=${entry.ordinal}`,
      });
    }
  }
  for (const entry of dataDtoSites) {
    if (!policy.matchedDataDtoKeys.has(`${entry.path}::${entry.enclosing}::${entry.shape}`)) {
      violations.push({
        path: entry.path,
        line: 0,
        rule: "data-dto-entry-not-found",
        message: `DTO 豁免条目在现场未被命中：${entry.path} enclosing=\`${entry.enclosing}\``,
      });
    }
  }
}

/**
 * 扫描自有生产范围（默认拒绝 + 精确 site 白名单）。
 *
 * @param roots 仓库相对目录列表（显式枚举，不做 glob 泛化）
 * @param whitelist handler 返回位替换 site 白名单（path + enclosing + ordinal + shape + reason + preservationTest）
 * @param dataDtoSites 数据 DTO 精确豁免（path + enclosing + shape + reason）
 */
export function scanPromptOverridePolicy({ roots, whitelist = [], dataDtoSites = [] } = {}) {
  const { ts, entry: typeScriptEntry } = resolveClassicTypeScript();
  const policy = {
    whitelist,
    dataDtoSites,
    matchedWhitelistKeys: new Set(),
    matchedDataDtoKeys: new Set(),
  };
  const files = { source: [], text: [], ignored: [] };
  const sites = [];
  const violations = [];

  for (const root of roots) {
    const absolute = resolve(repositoryRoot, root);
    if (!existsSync(absolute)) {
      violations.push({ path: root, line: 0, rule: "missing-scan-root", message: `扫描根不存在：${root}` });
      continue;
    }
    for (const file of walkFiles(absolute)) {
      const relPath = relative(repositoryRoot, file).split(sep).join("/");
      const base = file.split(sep).at(-1);
      const extension = extname(base).toLowerCase();
      if (IGNORED_BASENAMES.has(base)) {
        files.ignored.push(relPath);
        continue;
      }
      if (SOURCE_EXTENSIONS.has(extension)) {
        files.source.push(relPath);
        const text = readFileSync(file, "utf8");
        const result = scanSourceFile({ ts, relPath, text, extension, policy });
        sites.push(...result.sites);
        violations.push(...result.violations);
        continue;
      }
      if (TEXT_PROBE_EXTENSIONS.has(extension)) {
        files.text.push(relPath);
        violations.push(...scanTextFile({ relPath, text: readFileSync(file, "utf8") }));
        continue;
      }
      violations.push({
        path: relPath,
        line: 0,
        rule: "unhandled-file-kind",
        message: `扫描范围内出现未判类的文件类型 \`${extension || "<none>"}\`：fail closed，请显式归类后再接入策略`,
      });
    }
  }

  // 白名单/豁免不得留死条目：登记了就必须真的被现场命中。
  assertNoDeadEntries({ policy, violations, whitelist, dataDtoSites });

  files.source.sort();
  files.text.sort();
  files.ignored.sort();
  sites.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
  return { typeScriptEntry: typeScriptEntry, files, sites, violations, roots: roots.slice() };
}

/** 供自测使用：以任意 baseDir 为根扫描（fixture 目录），路径按 baseDir 相对回报。 */
export function scanPromptOverridePolicyInDirectory({ baseDir, roots = ["."], whitelist = [], dataDtoSites = [] }) {
  const { ts, entry: typeScriptEntry } = resolveClassicTypeScript();
  const policy = { whitelist, dataDtoSites, matchedWhitelistKeys: new Set(), matchedDataDtoKeys: new Set() };
  const sites = [];
  const violations = [];
  for (const root of roots) {
    const absolute = resolve(baseDir, root);
    for (const file of walkFiles(absolute)) {
      const relPath = relative(baseDir, file).split(sep).join("/");
      const extension = extname(file).toLowerCase();
      if (!SOURCE_EXTENSIONS.has(extension)) {
        violations.push({ path: relPath, line: 0, rule: "unhandled-file-kind", message: `fixture 含非源码文件 ${relPath}` });
        continue;
      }
      const result = scanSourceFile({ ts, relPath, text: readFileSync(file, "utf8"), extension, policy });
      sites.push(...result.sites);
      violations.push(...result.violations);
    }
  }
  assertNoDeadEntries({ policy, violations, whitelist, dataDtoSites });
  sites.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
  return { typeScriptEntry, sites, violations };
}

export { dirname };
