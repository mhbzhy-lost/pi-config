import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const NON_CODE_EXTS = new Set([".md", ".json", ".txt", ".yml", ".yaml", ".toml", ".csv", ".lock", ".gitignore"]);
const MAX_EXEMPT_LINES = 10;
const NEGATIVE_RE = /^(none\.?|_?\(?none\)?_?|n\/?a|no\s+(\w+\s+)?issues(\s+found)?|nothing\s+to\s+report|✅|无)/i;
const PROVIDER_CHAIN = ["idealab-anthropic", "idealab-openai"];
const DEFAULT_TIMEOUT_MS = 660_000;

export function parseSections(text) {
  function hasContent(header) {
    const pattern = new RegExp(`#{1,4}\\s*${header}[^\\n]*\\n(.+?)(?=\\n#{1,4}\\s|$)`, "si");
    const m = text.match(pattern);
    if (!m) return false;
    const body = m[1].trim();
    const firstLine = body.split("\n").find((l) => l.trim())?.trim() ?? "";
    const normalized = firstLine.replace(/^[-*+]\s*/, "").replace(/^[*_`\t ]+|[*_`\t ]+$/g, "");
    return body.length > 0 && !NEGATIVE_RE.test(normalized);
  }
  return { hasCritical: hasContent("Critical"), hasImportant: hasContent("Important"), hasMinor: hasContent("Minor") };
}

export function shouldExempt({ totalLines, allNonCode, hasBinary }) {
  if (hasBinary) return false;
  if (totalLines < MAX_EXEMPT_LINES) return true;
  if (allNonCode) return true;
  return false;
}

export async function workspaceReviewBypass({ cwd }) {
  try {
    const config = JSON.parse(await readFile(join(cwd, ".push-gate.json"), "utf8"));
    return config !== null && !Array.isArray(config) && typeof config === "object" && config.bypassReview === true;
  } catch {
    return false;
  }
}

export async function gatherDiffInfo({ cwd }) {
  const git = (...args) => execFileAsync("git", args, { cwd, timeout: 10_000 }).then((r) => r.stdout.trim());

  let baseRef;
  try {
    baseRef = await git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  } catch {
    try {
      baseRef = await git("rev-parse", "--abbrev-ref", "origin/HEAD");
    } catch {
      baseRef = "origin/main";
    }
  }

  const range = `${baseRef}..HEAD`;
  let ahead;
  try {
    ahead = await git("rev-list", range, "--count");
  } catch {
    return { exempt: true, reason: "git-error" };
  }
  if (ahead === "0") return { exempt: true, reason: "nothing-to-push" };

  let numstat;
  try {
    numstat = await git("diff", "--diff-filter=ACM", "--numstat", range);
  } catch {
    return { exempt: true, reason: "git-error" };
  }

  let totalLines = 0;
  let allNonCode = true;
  let hasBinary = false;
  let fileCount = 0;

  for (const line of numstat.split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    fileCount++;
    if (parts[0] === "-") { hasBinary = true; continue; }
    totalLines += parseInt(parts[0], 10) + parseInt(parts[1], 10);
    const ext = "." + (parts[2].split(".").pop() || "").toLowerCase();
    if (!NON_CODE_EXTS.has(ext)) allNonCode = false;
  }

  if (shouldExempt({ totalLines, allNonCode, hasBinary })) return { exempt: true, reason: "small-or-non-code" };

  let diffContent;
  try {
    diffContent = await git("diff", "--diff-filter=ACM", range);
  } catch {
    return { exempt: true, reason: "git-error" };
  }
  const diffHash = createHash("sha256").update(diffContent).digest("hex").slice(0, 16);

  return { exempt: false, baseRef, range, diffHash, fileCount };
}

export async function runReview({ cwd, baseRef, round, reviewerPy, envFile, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  for (const provider of PROVIDER_CHAIN) {
    try {
      const { stdout } = await execFileAsync("uv", [
        "run", "--no-project",
        "--with", "httpx", "--with", "python-dotenv", "--with", "pyyaml",
        "python", reviewerPy, baseRef, "HEAD",
        "--provider", provider,
        "--review-depth", "exhaustive",
        "--review-round", String(round),
        "--max-issues", "25",
        "--api-timeout-seconds", "600",
      ], { cwd, timeout: timeoutMs, env: { ...process.env, DOTENV_PATH: envFile } });
      if (stdout.trim()) return { output: stdout.trim(), provider };
    } catch {
      continue;
    }
  }
  return { output: null, provider: null };
}

export function buildDenyReason({ reviewOutput, range, cwd, fileCount }) {
  const context = `Review range: ${range}\nReview repo: ${cwd}\nReview file count: ${fileCount}`;
  const digest =
    "## 综合判断 4 步（必须执行）\n" +
    "1. 逐条比对：列出 (A)双方都抓到 (B)只外源抓到 (C)只同族抓到\n" +
    "2. 对(B)做 threat-model 校验：外源常见误报——本机 CLI 输入当不可信、单 task 阻塞标 Critical、误读累积 diff、只看 diff 没看完整源码\n" +
    "3. 对(C)做同族盲点反思：是否涉及训练偏好（生态版本兼容、库 API 名）\n" +
    "4. 综合产出 fix dispatch：双方认可 + 任一方有真实 evidence 的项打包修复\n" +
    "严重度由证据决定，不由谁说了算。\n\n";
  return `🚫 禁止 push。异源 Review 发现需要修复的问题。\n\n${context}\n\n${digest}---\n\n${reviewOutput}`;
}
