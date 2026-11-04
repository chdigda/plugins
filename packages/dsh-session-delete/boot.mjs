import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lockFile, assertOffline } from './core.mjs';
import { processRequests } from './requests.mjs';
import { runtimeRequire, dshHome, processIdentity } from './runtime.mjs';

export const name = 'session-delete-boot';
const statesKey = Symbol.for('dsh-session-delete.boot.v2');
const states = globalThis[statesKey] ??= new Map();
export function oncePerProcess(home, run) {
  if (!states.has(home)) states.set(home, Promise.resolve().then(run));
  return states.get(home);
}
export function validateGateEntries(entries) {
  for (const [id, module] of [['session','@deepseek-ai/dsh-session'], ['session-persistence-jsonl','@deepseek-ai/dsh-session-persistence-jsonl'], ['storage','@deepseek-ai/dsh-storage']]) {
    const row = entries.find(e => e.options.id === id);
    if (!row || row.options.name !== module || row.disabled || !Array.isArray(row.options.inject) || !row.options.inject.includes('sessionDeleteReady')) throw new Error('삭제 초기화 순서가 보장되지 않습니다: ' + id);
  }
}
export async function apply(ctx) {
  const home = dshHome();
  const req = runtimeRequire();
  const ready = await oncePerProcess(home, async () => {
    const bootId = await processIdentity();
    if (ctx.get('sessions') || ctx.get('sessionPersistence') || ctx.get('storage')) return { bootId, deferred: true, results: [] };
    const loader = ctx.get('loader');
    if (!loader) throw new Error('DSH 부팅 로더가 없어 자동 삭제를 시작할 수 없습니다.');
    validateGateEntries([...loader.entries()]);
    const { tryLockExclusive } = await import(pathToFileURL(req.resolve('@deepseek-ai/node-addon-system/flock')).href);
    const dir = join(home, 'session-delete-requests');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const handle = await lockFile(home, join(dir, 'runtime.lock'), tryLockExclusive);
    try {
      const results = await processRequests(home, bootId, tryLockExclusive, assertOffline);
      return { bootId, results, handle };
    } catch (error) { await handle.close(); throw error; }
  });
  for (const result of ready.results) if (result.phase === 'failed') ctx.logger.warn('세션 삭제 보류: ' + result.rootId + ' — ' + result.error);
  ctx.provide('sessionDeleteReady', ready);
}
