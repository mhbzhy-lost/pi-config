import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";

const COMMIT_TYPES = new Set(["feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert"]);
const WRAPPERS = new Set(["sudo", "command", "env"]);
const SOURCE_PATH = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs)$/i;

function violation(code, reason) {
  return { block: true, code, reason };
}

function shellSegments(command) {
  const segments = [];
  let quote;
  let start = 0;
  const text = String(command);
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    const separatorLength = char === ";" ? 1 : text.slice(index, index + 2) === "&&" || text.slice(index, index + 2) === "||" ? 2 : 0;
    if (separatorLength) {
      const segment = text.slice(start, index).trim();
      if (segment) segments.push(segment);
      index += separatorLength - 1;
      start = index + 1;
    }
  }
  const segment = text.slice(start).trim();
  if (segment) segments.push(segment);
  return segments;
}

function expandTilde(token) {
  const home = homedir();
  if (token === "~") return home;
  if (token.startsWith("~/")) return home + token.slice(1);
  return token;
}

function unwrap(segment) {
  let tokens = segment.trim().match(/(?:\$'[^']*'|"[^"]*"|'[^']*'|[^\s])+/g) ?? [];
  tokens = tokens.map((token) => token.replace(/^(?:\$')?['"]|['"]$/g, ""));
  tokens = tokens.map(expandTilde);
  while (tokens[0] && (WRAPPERS.has(tokens[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]))) {
    if (tokens[0] === "env") {
      tokens = tokens.slice(1);
      while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] ?? "")) tokens = tokens.slice(1);
    } else {
      tokens = tokens.slice(1);
    }
  }
  return tokens;
}

function commandContext(command, cwd) {
  let current = resolve(cwd);
  const commands = [];
  for (const segment of shellSegments(command)) {
    const tokens = unwrap(segment);
    if (tokens[0] === "cd" && tokens[1]) {
      current = resolve(current, tokens[1]);
      commands.push({ tokens, cwd: current, cd: true });
      continue;
    }
    commands.push({ tokens, cwd: current });
  }
  return commands;
}

function hasExpansion(target) {
  return /[$*?\[\]{}~`]|\$\(|<\(|>\(/.test(target);
}

function isWithin(path, root) {
  const delta = relative(resolve(root), resolve(path));
  return delta === "" || (!delta.startsWith("..") && !isAbsolute(delta));
}

function existingAncestor(path) {
  let current = path;
  while (true) {
    try {
      return { path: current, realpath: realpathSync(current) };
    } catch {
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

function canonicalCandidate(path) {
  const ancestor = existingAncestor(path);
  if (!ancestor) return undefined;
  return resolve(ancestor.realpath, relative(ancestor.path, path));
}

function canonicalRoots(paths) {
  return [...new Set(paths.map((path) => canonicalCandidate(path) ?? resolve(path)))];
}

function protectedDirs(workspaceRoot) {
  return canonicalRoots([resolve(workspaceRoot, "pi")]);
}

function checkRm(tokens, cwd, workspaceRoot) {
  if (tokens[0] !== "rm" && !tokens[0]?.endsWith("/rm")) return undefined;
  const targets = tokens.slice(1).filter((token) => token !== "--" && !token.startsWith("-"));
  if (targets.length === 0 || targets.some(hasExpansion)) {
    return violation("RM_TARGET_UNCERTAIN", "无法确定 rm 目标，已按 fail-closed 阻断");
  }
  const guarded = protectedDirs(workspaceRoot);
  for (const target of targets) {
    const path = resolve(cwd, target);
    const candidate = canonicalCandidate(path);
    if (!candidate) return violation("RM_TARGET_UNCERTAIN", "无法确定 rm 目标，已按 fail-closed 阻断");
    if (guarded.some((root) => isWithin(candidate, root))) {
      return violation("RM_PROTECTED_DIR", "禁止删除受保护的 pi 配置目录");
    }
    const workspace = canonicalCandidate(workspaceRoot);
    const temporary = canonicalRoots([tmpdir(), "/tmp", "/private/tmp"]);
    if (workspace && isWithin(candidate, workspace)) continue;
    if (temporary.some((root) => isWithin(candidate, root))) continue;
    if (!isWithin(candidate, workspaceRoot)) {
      return violation("RM_OUTSIDE_WORKSPACE", "禁止 workspace 外 rm");
    }
  }
  return undefined;
}

function gitSubcommand(tokens) {
  // Skip flags and their value arguments (e.g. -C <path>, --git-dir <path>)
  const VALUE_FLAGS = new Set(["-C", "--git-dir", "--work-tree", "--namespace", "-c"]);
  let i = 1;
  while (i < tokens.length) {
    if (VALUE_FLAGS.has(tokens[i])) { i += 2; continue; }
    if (tokens[i].startsWith("-")) { i++; continue; }
    return tokens[i];
  }
  return undefined;
}

function checkDestructiveGit(tokens) {
  if (tokens[0] !== "git" && !tokens[0]?.endsWith("/git")) return undefined;
  const subcommand = gitSubcommand(tokens);
  if (!subcommand) return undefined;

  if (subcommand === "reset" && tokens.includes("--hard")) {
    return violation("GIT_DESTRUCTIVE", "禁止不可逆 Git 操作: git reset --hard");
  }
  if (subcommand === "clean") {
    // Allow dry-run variants: -n, --dry-run, or combined like -nfd
    const isDryRun = tokens.includes("--dry-run") || tokens.some((t) => t.startsWith("-") && !t.startsWith("--") && t.includes("n"));
    if (isDryRun) return undefined;
    if (tokens.some((t) => t.startsWith("-") && !t.startsWith("--") && t.includes("f"))) {
      return violation("GIT_DESTRUCTIVE", "禁止不可逆 Git 操作: git clean -f");
    }
  }
  if (subcommand === "checkout" && tokens.includes("--")) {
    return violation("GIT_DESTRUCTIVE", "禁止不可逆 Git 操作: git checkout -- file");
  }
  if (subcommand === "restore" && tokens.includes("--worktree")) {
    return violation("GIT_DESTRUCTIVE", "禁止不可逆 Git 操作: git restore --worktree");
  }
  return undefined;
}

function checkShellWrapper(tokens, cwd, workspaceRoot) {
  const shells = new Set(["sh", "bash", "zsh"]);
  const cmd = tokens[0]?.split("/").pop();
  if (!cmd || !shells.has(cmd)) return undefined;
  // Find -c as standalone or as combined short flag (e.g. -lc, -xc)
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "-c" && tokens[i + 1]) return checkSingleCommand(tokens[i + 1], cwd, workspaceRoot);
    if (t.startsWith("-") && !t.startsWith("--") && t.endsWith("c") && tokens[i + 1]) {
      return checkSingleCommand(tokens[i + 1], cwd, workspaceRoot);
    }
  }
  return undefined;
}

function checkSingleCommand(command, cwd, workspaceRoot) {
  const commands = commandContext(command, cwd);
  for (const { tokens, cwd: commandCwd } of commands) {
    const rmViolation = checkRm(tokens, commandCwd, workspaceRoot);
    if (rmViolation) return rmViolation;
    const gitViolation = checkDestructiveGit(tokens);
    if (gitViolation) return gitViolation;
    const wrapperViolation = checkShellWrapper(tokens, commandCwd, workspaceRoot);
    if (wrapperViolation) return wrapperViolation;
  }
  return undefined;
}

function commitMessage(tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "-m" || token === "--message") return tokens[index + 1];
    if (token.startsWith("--message=")) return token.slice("--message=".length);
    if (token.startsWith("-m") && token.length > 2) return token.slice(2);
  }
  return undefined;
}

function validateCommit(tokens) {
  const commitIndex = tokens.indexOf("commit");
  if (commitIndex < 0) return undefined;
  if (tokens.some((token) => token === "-F" || token === "--file" || token.startsWith("--file="))) {
    return violation("COMMIT_MESSAGE_REQUIRED", "提交必须使用明确的 -m/--message message");
  }
  const message = commitMessage(tokens);
  if (!message) return violation("COMMIT_MESSAGE_REQUIRED", "提交必须使用明确的 -m/--message message");
  if (/^\$'/.test(message)) return violation("COMMIT_MESSAGE_INVALID", "commit message 不得使用 shell $'...' 形式");
  const normalized = message.replace(/^\$'|'$/g, "");
  const match = normalized.match(/^([a-z]+)(?:\([^\n)]+\))?:\s*(.+)$/s);
  if (!match || !COMMIT_TYPES.has(match[1])) return violation("COMMIT_MESSAGE_INVALID", "commit type 不符合 Conventional Commit 规则");
  const subject = match[2].split("\n")[0].trim();
  if (!/[\u4e00-\u9fff]/.test(subject)) return violation("COMMIT_MESSAGE_INVALID", "commit subject 必须包含中文");
  if (/[。.]$/.test(subject)) return violation("COMMIT_MESSAGE_INVALID", "commit subject 不得以句号结尾");
  if (/^(?:已修复|实现了|修复了|增加了)/.test(subject)) return violation("COMMIT_MESSAGE_INVALID", "commit subject 不得使用过去时");
  if (/^(?:fix|update|bugfix|wip|修改|更新)$/i.test(subject)) return violation("COMMIT_MESSAGE_INVALID", "commit subject 信息量不足");
  if (/(?:^|\n)Co-Authored-By:\s*(?:Claude|Copilot|Cursor|AI\b)/i.test(normalized) || /Generated with\s+\S+/i.test(normalized) || /AI-assisted/i.test(normalized)) {
    return violation("COMMIT_MESSAGE_INVALID", "commit message 不得包含 AI 署名");
  }
  return undefined;
}

function planTodos(repoRoot) {
  const plans = resolve(repoRoot, "docs", "plans");
  let entries;
  try {
    entries = readdirSync(plans, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    return [{ file: plans, text: `读取失败: ${error.message}` }];
  }
  const results = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const file = resolve(entry.parentPath ?? entry.path ?? plans, entry.name);
    try {
      const content = readFileSync(file, "utf8");
      for (const line of content.split(/\r?\n/)) {
        const match = line.match(/^-?\s*TODO:\s*(.+)/);
        if (match) results.push({ file, text: `TODO: ${match[1]}` });
      }
    } catch (error) {
      results.push({ file, text: `读取失败: ${error.message}` });
    }
  }
  return results;
}

export function scanPendingPlanTodos(repoRoot) {
  return planTodos(repoRoot);
}

const SAFE_ENV_SUFFIX = /\.env\.(?:example|sample|template)$/i;
const SENSITIVE_BASENAME = /^(?:auth|mcp-auth)\.json$/i;

export function checkSensitivePath({ toolName, input, cwd }) {
  if (!["read", "write", "edit"].includes(toolName)) return undefined;
  const raw = input?.path ?? input?.filePath ?? input?.file_path ?? input?.filename;
  if (!raw) return violation("SENSITIVE_PATH_UNCERTAIN", "敏感文件工具调用缺少可信路径");
  const expanded = expandTilde(raw);
  const path = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  const candidate = canonicalCandidate(path);
  const normalized = (candidate ?? path).replaceAll("\\", "/");
  if (SAFE_ENV_SUFFIX.test(normalized)) return undefined;
  if (/(?:^|\/)\.env(?:\.[^/]+)?$/i.test(normalized)) {
    return violation("SENSITIVE_ENV_FILE", "禁止 Agent 访问环境凭据文件");
  }
  if (SENSITIVE_BASENAME.test(normalized.split("/").at(-1)) && /(?:^|\/)(?:pi|opencode)(?:\/|$)/i.test(normalized)) {
    return violation("SENSITIVE_AUTH_FILE", "禁止 Agent 访问认证凭据文件");
  }
  return undefined;
}

export function checkShellPolicy({ command, cwd, workspaceRoot, env = {} }) {
  const skipCommitValidation = env.GIT_COMMIT_HOOK_SKIP === "1" || /(?:^|\s)GIT_COMMIT_HOOK_SKIP=1(?:\s|$)/.test(command);
  const commands = commandContext(command, cwd);
  for (const { tokens, cwd: commandCwd, cd } of commands) {
    const rmViolation = checkRm(tokens, commandCwd, workspaceRoot);
    if (rmViolation) return rmViolation;
    const gitViolation = checkDestructiveGit(tokens);
    if (gitViolation) return gitViolation;
    const wrapperViolation = checkShellWrapper(tokens, commandCwd, workspaceRoot);
    if (wrapperViolation) return wrapperViolation;
    if (cd && commands.some((command) => command.tokens[0] === "git")) {
      return violation("GIT_CWD_FORBIDDEN", "禁止通过 cd 切换 Git 工作目录");
    }
    if (tokens[0] === "git" && tokens.includes("-C")) {
      return violation("GIT_C_FORBIDDEN", "禁止使用 git -C 切换工作目录");
    }
    const commitViolation = skipCommitValidation ? undefined : validateCommit(tokens);
    if (commitViolation) return commitViolation;
    const gitSubcommand = tokens[0] === "git" ? tokens.find((token, index) => index > 0 && !token.startsWith("-")) : undefined;
    if (gitSubcommand === "push" && !tokens.includes("--dry-run")) {
      const todos = planTodos(commandCwd);
      if (todos.length > 0) {
        return violation("PUSH_PENDING_PLAN_TODOS", `存在未完成计划 TODO 或读取失败: ${todos[0].text}`);
      }
    }
  }
  return undefined;
}

export function codingReminderFor({ toolName, input }) {
  if (!new Set(["write", "edit"]).has(toolName)) return undefined;
  const path = input?.path ?? input?.filePath ?? input?.file_path ?? input?.filename;
  if (!path || !SOURCE_PATH.test(path)) return undefined;
  const normalized = path.replaceAll("\\", "/");
  const basename = normalized.split("/").at(-1);
  if (/(?:^|\/)__(?:tests?)__\//.test(normalized) || /(?:^|\/)(?:tests?|test)\//.test(normalized) || /(?:^|[._-])(?:test|spec)(?:[._-]|$)/i.test(basename)) return undefined;
  return "逻辑变更请先遵循 test-driven-development，并在修复问题前记录 docs/bugs/bug-*.md 根因分析。";
}
