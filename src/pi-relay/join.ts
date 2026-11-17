/**
 * pi-relay 新主机交互式接入：把中继注入材料（webExposure/webRelay）合并进本机
 * pi/settings.local.json，随后 fetch-ca + ensure + status 一条龙。
 * 注入材料两种来源：ssh 从 ECS 取回（仅文件读取，绝不使用端口转发），或手工粘贴。
 * 凭据纪律：agentToken 全程不回显（摘要展示），不落临时文件；settings 写入 0600。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { validateWebSettings } from "./config.ts";

function fail(message: string): never {
  console.error(`[pi-relay-join] ${message}`);
  process.exit(1);
}

/** 展开开头 ~；其余原样 */
function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(homedir(), p.slice(2)) : p;
}

/** agentToken 摘要展示（绝不回显完整值） */
function maskToken(token: string): string {
  return `${token.slice(0, 4)}…（${token.length} 字符，已隐去）`;
}

/** 从可能含杂质的输出中提取首个 { 到末个 } 的 JSON 并校验为 public 注入材料 */
function parseInjection(raw: string): { webExposure: "public"; webRelay: { url: string; agentToken: string; caFingerprint: string } } {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) fail("未找到 JSON 对象：请确认取回的是 init 输出的注入材料");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    fail("注入材料不是合法 JSON");
  }
  const settings = validateWebSettings(parsed as { webExposure?: unknown; webRelay?: unknown });
  if (settings.exposure !== "public" || !settings.relay) fail("注入材料必须是 webExposure=public 且含完整 webRelay");
  return parsed as { webExposure: "public"; webRelay: { url: string; agentToken: string; caFingerprint: string } };
}

/** git1 优先（仓库规范），不存在回落 git */
function gitBin(): string {
  return spawnSync("git1", ["--version"], { encoding: "utf8" }).status === 0 ? "git1" : "git";
}

export async function runJoin(root: string): Promise<void> {
  try {
    await joinFlow(root);
  } catch (e) {
    if ((e as { code?: string }).code === "ABORT_ERR") fail("输入已结束（Ctrl+D/EOF），已取消；未写入的配置不受影响");
    throw e;
  }
}

async function joinFlow(root: string): Promise<void> {
  if (!process.stdin.isTTY) fail("需要交互式终端（stdin 非 TTY）：请在终端直接运行 node scripts/pi-relay-join.ts");
  if (!existsSync(path.join(root, "scripts", "pi-relay.ts"))) fail(`${root} 不是 pi-config 仓库根（缺 scripts/pi-relay.ts）`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (question: string, fallback = ""): Promise<string> => {
    const suffix = fallback ? `（默认 ${fallback}）` : "";
    const answer = (await rl.question(`${question}${suffix}：`)).trim();
    return answer || fallback;
  };
  const confirm = async (question: string, defaultYes = true): Promise<boolean> => {
    const answer = (await rl.question(`${question}（${defaultYes ? "Y/n" : "y/N"}）：`)).trim().toLowerCase();
    return answer === "" ? defaultYes : answer === "y" || answer === "yes";
  };

  console.log("pi-relay 新主机接入：合并中继注入材料 → fetch-ca → ensure → status");
  console.log(`仓库根：${root}`);

  // 1) 代码更新（多主机能力自 679a814 起；旧代码也能连 v2 中继，但建议先拉新）
  if (await confirm("先执行 git pull --ff-only 更新仓库？")) {
    const pull = spawnSync(gitBin(), ["pull", "--ff-only"], { cwd: root, stdio: "inherit" });
    if (pull.status !== 0) {
      console.error("[pi-relay-join] git pull 失败（可能有本地改动或网络问题）。");
      if (!(await confirm("仍用当前代码继续？", false))) fail("已取消：请先处理仓库更新");
    }
  }

  // 2) 注入材料来源
  let raw: string;
  const mode = await ask("注入材料来源：1=ssh 从 ECS 取回，2=手工粘贴", "1");
  if (mode === "2") {
    console.log("请粘贴 init 输出的注入 JSON（含 webExposure/webRelay），以单独一行 END 结束：");
    // 持久 line 监听：整段粘贴（多行一次性到达）时逐行收集；
    // 不能用顺序 question()——问题切换间隙到达的行会被丢弃（实测 END 行被吞）
    raw = await new Promise<string>((resolve) => {
      const lines: string[] = [];
      const onLine = (line: string): void => {
        if (line.trim() === "END") {
          rl.removeListener("line", onLine);
          resolve(lines.join("\n"));
        } else {
          lines.push(line);
        }
      };
      rl.on("line", onLine);
      rl.once("close", () => {
        rl.removeListener("line", onLine);
        resolve(lines.join("\n")); // EOF/Ctrl+D：以已收集内容走校验失败路径，不挂起
      });
    });
  } else if (mode === "1") {
    const ecs = await ask("ECS ssh 目标（user@host）");
    if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ecs)) fail("ssh 目标格式应为 user@host（不含空格/特殊字符）");
    const pemRaw = await ask("pem 私钥路径");
    const pem = expandHome(pemRaw);
    if (!pem || !existsSync(pem)) fail(`私钥文件不存在：${pem || "(空)"}`);
    const port = await ask("ssh 端口", "22");
    if (!/^[0-9]{1,5}$/.test(port)) fail("ssh 端口必须是数字");
    const remote = await ask("远端注入材料路径（相对登录家目录）", "pi-relay/init-output-agent2.txt");
    if (!/^[A-Za-z0-9_./-]+$/.test(remote)) fail("远端路径只允许字母/数字/_-./（防 shell 注入）");
    const base = path.posix.basename(remote);
    // 仅文件读取；先按给定路径 cat，失败再 find 兜底（登录用户家目录可能与文件属主不同）
    const remoteCmd = `cat '${remote}' 2>/dev/null || find /home /root -maxdepth 3 -name '${base}' -exec cat {} \\;`;
    console.log(`正在经 ssh 取回 ${ecs}:${remote} …`);
    const res = spawnSync(
      "ssh",
      ["-i", pem, "-p", port, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10", ecs, remoteCmd],
      { encoding: "utf8", timeout: 30_000 },
    );
    if (res.status !== 0 || !res.stdout?.trim()) {
      console.error(res.stderr?.trim() || "(无 stderr)");
      fail("ssh 取回失败：请核对目标/私钥/端口/路径，或改用手工粘贴（来源选 2）");
    }
    raw = res.stdout;
  } else {
    fail("来源只能是 1 或 2");
  }

  // 3) 校验 + 合并 + 确认
  const injection = parseInjection(raw);
  const settingsPath = process.env.PI_LOCAL_SETTINGS_PATH ?? path.join(root, "pi", "settings.local.json");
  let current: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      current = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    } catch {
      fail(`现有 ${settingsPath} 不是合法 JSON：请先手动修复`);
    }
  }
  const merged = { ...current, ...injection };
  validateWebSettings(merged); // 合并后整体再校验一次（fail closed）
  console.log("将写入以下外部控制配置（其余本机字段保持不变）：");
  console.log(`  webExposure：public`);
  console.log(`  webRelay.url：${injection.webRelay.url}`);
  console.log(`  webRelay.agentToken：${maskToken(injection.webRelay.agentToken)}`);
  console.log(`  webRelay.caFingerprint：${injection.webRelay.caFingerprint}`);
  console.log(`  目标文件：${settingsPath}`);
  if (!(await confirm("确认写入？"))) fail("已取消：未写入任何配置");
  writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  console.log("已写入。");
  rl.close();

  // 4) fetch-ca → ensure → status（复用本机 CLI；fetch-ca 恒 exit 0，用「本次是否重写 CA」判定成败，
  // 避免旧配置残留的 root-ca.crt 让失败误判为成功）
  const env = { ...process.env, PI_LOCAL_SETTINGS_PATH: settingsPath };
  const run = (args: string[]): number => spawnSync(process.execPath, [path.join(root, "scripts", "pi-relay.ts"), ...args], { cwd: root, stdio: "inherit", env }).status ?? 1;
  const caPath = path.join(root, "var", "pi-relay", "root-ca.crt");
  const caMtimeBefore = existsSync(caPath) ? statSync(caPath).mtimeMs : 0;
  console.log("\n—— fetch-ca（下载并按指纹校验中继 CA）——");
  run(["fetch-ca"]);
  if (!existsSync(caPath) || statSync(caPath).mtimeMs <= caMtimeBefore) fail("CA 未被本次 fetch-ca 重写：取回/校验失败（核对 url 端口/安全组/指纹），请修复后重跑本脚本");
  console.log("\n—— ensure（启动 web + agent）——");
  run(["ensure"]);
  console.log("\n—— status ——");
  run(["status"]);
  console.log("\n接入完成。手机侧：打开中继入口 → 列表页「添加主机」→ 选本机 → 把配对码在本机运行 node scripts/pi-relay.ts approve <码> 批准。");
}