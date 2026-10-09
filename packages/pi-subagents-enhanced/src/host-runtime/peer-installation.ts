import { lstat, readFile, realpath, rename, rm, symlink, mkdir } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

const PEERS = ['pi-coding-agent', 'pi-agent-core', 'pi-ai', 'pi-tui'] as const;

/** 部署时仅将四个Pi peer物理来源绑定到已验证root，不重写上游受控文件。 */
export async function bindPhysicalHostPeers({ enhancedPackageRoot, hostRoot }: { enhancedPackageRoot: string; hostRoot: string }) {
  if (!isAbsolute(enhancedPackageRoot) || !isAbsolute(hostRoot)) throw new Error('physical peer路径必须为绝对路径');
  const enhanced = await realpath(enhancedPackageRoot);
  const host = await realpath(hostRoot);
  const insideEnhanced = relative(enhanced,host);
  if (insideEnhanced === '' || (!insideEnhanced.startsWith('..') && !isAbsolute(insideEnhanced))) throw new Error('physical target不能位于enhanced tree');
  for (const parent of [join(enhanced,'node_modules'),join(enhanced,'node_modules/@earendil-works')]) {
    try { const info = await lstat(parent); if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error('physical peer parent边界非法'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  const targets = await Promise.all(PEERS.map(async name => {
    const target = await realpath(join(host, '..', name));
    const metadata = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
    if (metadata.name !== '@earendil-works/' + name || metadata.version !== '1.0.4') throw new Error('physical peer身份或版本错误：' + name);
    const destination = join(enhanced, 'node_modules/@earendil-works', name);
    if (relative(destination, target) === '') throw new Error('physical peer不能指向自身');
    return { target, destination };
  }));
  const replaced: { destination: string; backup?: string }[] = [];
  try {
    for (const { target, destination } of targets) {
      await mkdir(join(enhanced, 'node_modules/@earendil-works'), { recursive: true });
      try { if (await realpath(destination) === target) continue; } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      let backup: string | undefined;
      try { await lstat(destination); backup = destination + '.before-physical-' + randomUUID(); await rename(destination, backup); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      replaced.push({ destination, backup });
      await symlink(relative(join(destination, '..'), target), destination, 'dir');
      if (await realpath(destination) !== target) throw new Error('physical peer绑定验证失败');
    }
  } catch (error) {
    const errors: unknown[] = [error];
    for (const { destination, backup } of replaced.reverse()) {
      try { await rm(destination, { recursive: true, force: true }); if (backup) await rename(backup, destination); } catch (cleanup) { errors.push(cleanup); }
    }
    if (errors.length > 1) throw new AggregateError(errors, 'physical peer绑定与回滚失败', { cause: error });
    throw error;
  }
  for (const { backup } of replaced) if (backup) await rm(backup, { recursive: true });
  return { hostRoot: host, peers: targets.map(({ target, destination }) => ({ target, destination })) };
}
