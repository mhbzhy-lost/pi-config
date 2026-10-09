#!/usr/bin/env node
// 维护子命令不加载extensions，必须在wrapper入口拒绝而非事后hidden工具。
const args=process.argv.slice(2);
const values=new Set(['-p','--print','-e','--extension','--skill','--prompt-template','--theme','--use-theme','--provider','--model','--models','--thinking','--tools','-t','--exclude-tools','-xt','--api-key','--name','-n','--system-prompt','--append-system-prompt','--session-dir','--session','--session-id','--fork','--mode','--export','--tui-mode']);
for(let i=0;i<args.length;i++){
 const arg=args[i];if(arg==='--')break;
 if(values.has(arg)){i++;continue;}if(arg.startsWith('-'))continue;
 if(arg==='mcp'){console.error('shell MCP维护入口不受会话名单保护，已拒绝；请使用会话内 /mcp');process.exitCode=1;}break;
}
