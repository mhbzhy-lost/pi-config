import * as coding from '@earendil-works/pi-coding-agent';
import * as tui from '@earendil-works/pi-tui';
import { pathToFileURL } from 'node:url';

/** 测试专用：捕获真实官方映射，消费生产public compat和实际watchdog，不注册resolver。 */
export default async function (pi: any) {
  const native = await import(pathToFileURL(process.env.JOINT_NATIVE_ENTRY!).href);
  const compat = await import(pathToFileURL(process.env.JOINT_COMPAT_ENTRY!).href);
  compat.upstreamSubagentRuntime(pi);
  pi.registerCommand('joint-identity', {
    handler: () => ({ host: { SessionManager: coding.SessionManager, Container: tui.Container }, native }),
  });
}
