import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as linux from './linux.mjs';

export const isWindows = process.platform === 'win32';
export function assertOwner(info, path) {
  // Personal Windows profile: POSIX uid/mode is not a Windows ACL check.
  if (!isWindows) linux.assertOwner(info, path);
}
export async function syncDirectory(path) {
  // Deliberately omit directory fsync on Windows; file.sync is still required.
  // This does not promise durable rename/unlink across a power loss.
  if (!isWindows) await linux.syncDirectory(path);
}
export async function assertOffline() {
  if (isWindows) {
    if (process.env.DSH_SESSION_ID) throw new Error('DSH 내부에서는 실행할 수 없습니다. 모든 DSH를 종료하고 일반 터미널에서 실행하세요.');
    // No Windows process scan. Caller must stop all other DSH hosts manually.
    return;
  }
  await linux.assertOffline();
}
export async function processIdentity() {
  if (!isWindows) return linux.processIdentity();
  // Survive ESM hot reload but never reuse the identity in a new process.
  const key = Symbol.for('dsh-session-delete.process-identity.v1');
  return globalThis[key] ??= process.pid + ':' + randomUUID();
}
export async function loadLock(req) {
  if (isWindows) {
    const { acquireLock } = await import('./windows.mjs');
    // Koffi is a dependency of the JSONL backend, not necessarily hoisted next to the CLI.
    const backendRequire = createRequire(req.resolve('@deepseek-ai/dsh-session-persistence-jsonl'));
    return { acquire: path => acquireLock(path, backendRequire) };
  }
  return (await import(pathToFileURL(req.resolve('@deepseek-ai/node-addon-system/flock')).href)).tryLockExclusive;
}
