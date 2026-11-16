#!/usr/bin/env node
// pi-web：把 pi TUI 通过浏览器共享到局域网。
// pi 跑在 tmux 会话里：本机 tmux attach 保持完整 TUI，手机浏览器看到并操作同一会话。
// 用法：node scripts/pi-web.ts [--port 7681] [--session pi] [--token xxx] [--cwd dir] [-- <命令>]
import { startPiWebServer, checkTmux, type PiWebOptions } from "../src/pi-web/server.ts";
import { resolve } from "node:path";

/** 默认走仓内 launcher，与桌面 pi 完全同源：物理版本校验、local settings、session-owner 门控。 */
function defaultPiCommand(): string[] {
  return ["zsh", resolve(import.meta.dirname, "pi-launcher.zsh")];
}

function parseArgs(argv: string[]): { opts: Partial<PiWebOptions>; passthrough: string[] } {
  const opts: Partial<PiWebOptions> = {};
  const passthrough: string[] = [];
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift()!;
    if (arg === "--") {
      passthrough.push(...args);
      break;
    }
    if (arg === "--port" || arg === "-p") opts.port = Number(args.shift());
    else if (arg === "--host") opts.host = String(args.shift());
    else if (arg === "--token") opts.token = String(args.shift());
    else if (arg === "--session" || arg === "-s") opts.session = String(args.shift());
    else if (arg === "--cols") opts.cols = Number(args.shift());
    else if (arg === "--rows") opts.rows = Number(args.shift());
    else if (arg === "--cwd") opts.cwd = String(args.shift());
    else {
      console.error(`未知参数：${arg}`);
      process.exit(1);
    }
  }
  return { opts, passthrough };
}

const { opts, passthrough } = parseArgs(process.argv.slice(2));
const options: PiWebOptions = {
  port: 7681,
  host: "0.0.0.0",
  session: "pi",
  cols: 100,
  rows: 30,
  cwd: process.cwd(),
  command: passthrough.length > 0 ? passthrough : defaultPiCommand(),
  ...opts,
};
if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
  console.error("--port 必须是 1-65535 的整数");
  process.exit(1);
}
options.cwd = resolve(options.cwd);

const tmuxVersion = await checkTmux();
const { urls, close } = await startPiWebServer(options);
console.log(`pi-web 已启动（tmux ${tmuxVersion}，工作目录 ${options.cwd}）`);
console.log("  手机打开即见会话列表，可进入现有会话；会话由本机 pi 命令创建。");
console.log(`  浏览器：  http://localhost:${options.port}`);
for (const url of urls.filter((u) => !u.includes("localhost"))) console.log(`  局域网：  ${url}${options.token ? "?token=" + options.token : ""}`);
if (!options.token) {
  console.warn("⚠ 未设置 --token：同一局域网内任何设备都可以完全控制这些终端。");
}
console.log("Ctrl+C 停止 server（tmux 中的 pi 会话不受影响）。");

const shutdown = () => {
  console.log("正在关闭…");
  close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
