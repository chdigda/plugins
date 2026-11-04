import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as linux from './linux.mjs';

export const isWindows = process.platform === 'win32';
export function assertOwner(info, path) {
  if (!isWindows) linux.assertOwner(info, path);
}
export async function syncDirectory(path) {
  if (!isWindows) await linux.syncDirectory(path);
}
export async function assertOffline() {
  if (isWindows) {
    if (process.env.DSH_SESSION_ID) throw new Error('DSH 내부에서는 실행할 수 없습니다. 모든 DSH를 종료하고 일반 터미널에서 실행하세요.');
    return;
  }
  await linux.assertOffline();
}
export async function processIdentity() {
  if (!isWindows) return linux.processIdentity();
  const key = Symbol.for('dsh-session-delete.process-identity.v1');
  return globalThis[key] ??= process.pid + ':' + randomUUID();
}
export async function loadLock(req) {
  if (isWindows) {
    const { acquireLock } = await import('./windows.mjs');
    const backendRequire = createRequire(req.resolve('@deepseek-ai/dsh-session-persistence-jsonl'));
    return { acquire: path => acquireLock(path, backendRequire) };
  }
  return (await import(pathToFileURL(req.resolve('@deepseek-ai/node-addon-system/flock')).href)).tryLockExclusive;
}
