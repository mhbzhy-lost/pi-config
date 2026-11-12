import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { RuntimeFault, safeError, safeName, validateCommand, type RuntimeOptions } from './contracts.ts';
import { resolveScope, startRuntime, stopRuntime, getRuntimeStatus, listRuntimeInstances, sendRuntimeCommand, serveRuntime } from './lifecycle.ts';
import { sdkAdapter } from './sdk-adapter.ts';
import { executeOperation } from './operations.ts';

export async function runCli(argv: string[]): Promise<number> {
  if (argv[0] === '--_daemon') {
    if (!process.send) return 1;
    return await new Promise<number>(done => {
      const controller = new AbortController(); let received = false, settled = false;
      process.on('disconnect', () => { if (!settled) controller.abort(); });
      process.on('message', async (m: any) => {
        if (m.cancel) { controller.abort(); return; }
        if (received) return; received = true;
        try {
          const ready = await serveRuntime(m.scope, m.options, sdkAdapter, executeOperation, controller.signal);
          settled = true; if (process.connected) process.send?.({ ready }); done(0);
        } catch (error) { settled = true; if (process.connected) process.send?.({ error: safeError(error, 'browser') }); done(1); }
      });
    });
  }
  try {
    if (argv.length === 0 || argv.includes('--help')) {
      console.log(JSON.stringify({ usage: 'node playwright.ts --instance <name> [--profile <name>] start [--headed] [--auth] | command <json> | status | stop; instances', browser: 'system Chrome', defaultMode: 'headless' })); return 0;
    }
    let instance: string | undefined, profile: string | undefined, headed = false, auth = false; const args = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--instance' || argv[i] === '--profile') { const key = argv[i]; safeName(argv[++i]); if (key === '--instance') instance = argv[i]; else profile = argv[i]; }
      else if (argv[i] === '--headed') headed = true;
      else if (argv[i] === '--headless') headed = false;
      else if (argv[i] === '--auth') auth = true;
      else args.push(argv[i]);
    }
    const op = args[0];
    if (!['start', 'command', 'stop', 'status', 'instances'].includes(op) || args.length !== (op === 'command' ? 2 : 1)) throw new RuntimeFault('config', 'invalid-arguments');
    if (op !== 'start' && (profile || headed || auth)) throw new RuntimeFault('config', 'start-options-only');
    if (op !== 'instances' && !instance) throw new RuntimeFault('config', 'instance-required');
    if (op === 'instances' && instance) throw new RuntimeFault('config', 'invalid-arguments');
    let command;
    if (op === 'command') { try { command = JSON.parse(args[1]); } catch { throw new RuntimeFault('protocol', 'invalid-command'); } validateCommand(command); }
    const scope = await resolveScope(), ref = { scope, instance: instance! };
    let result;
    if (op === 'start') {
      const idle = process.env.PI_PLAYWRIGHT_IDLE_TIMEOUT === undefined ? 1800 : Number(process.env.PI_PLAYWRIGHT_IDLE_TIMEOUT);
      const options: RuntimeOptions = { instance: instance!, profile, headless: !headed, channel: 'chrome', authMode: auth, startupTimeoutMs: 30_000, idleTimeoutMs: idle * 1000 };
      result = await startRuntime(scope, options);
    } else if (op === 'command') result = await sendRuntimeCommand(ref, command);
    else if (op === 'stop') result = await stopRuntime(ref);
    else if (op === 'status') result = await getRuntimeStatus(ref);
    else result = await listRuntimeInstances(scope);
    console.log(JSON.stringify({ ok: true, result })); return 0;
  } catch (error) { console.log(JSON.stringify({ ok: false, error: safeError(error, 'config') })); return 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runCli(process.argv.slice(2));
