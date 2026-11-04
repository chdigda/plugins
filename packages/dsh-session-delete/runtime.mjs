import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';

export const dshHome = () => resolve(process.env.DSH_HOME || join(homedir(), '.dsh'));
export function runtimeRequire() {
  for (const entry of [process.env.DSH_RUNTIME_ENTRY, process.argv[1], fileURLToPath(import.meta.url)].filter(Boolean)) {
    const req = createRequire(pathToFileURL(resolve(entry)));
    try { if (req('@deepseek-ai/dsh/package.json').version === '0.2.1-rc.5') return req; } catch (e) { if (e.code !== 'MODULE_NOT_FOUND' && e.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw e; }
  }
  throw new Error('dsh-session-delete는 DSH 0.2.1-rc.5에서만 검증되었습니다.');
}
export async function processIdentity() {
  const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const stat = await readFile('/proc/self/stat', 'utf8');
  const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  return boot + ':' + process.pid + ':' + start;
}
