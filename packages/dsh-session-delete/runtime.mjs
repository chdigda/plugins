import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
export { processIdentity } from './platform/index.mjs';

export const dshHome = () => resolve(process.env.DSH_HOME || join(homedir(), '.dsh'));
export function runtimeRequire() {
  for (const entry of [process.env.DSH_RUNTIME_ENTRY, process.argv[1], fileURLToPath(import.meta.url)].filter(Boolean)) {
    const req = createRequire(pathToFileURL(resolve(entry)));
    try { if (req('@deepseek-ai/dsh/package.json').version === '0.2.1-rc.5') return req; } catch (e) { if (e.code !== 'MODULE_NOT_FOUND' && e.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw e; }
  }
  throw new Error('dsh-session-delete는 DSH 0.2.1-rc.5에서만 검증되었습니다.');
}
