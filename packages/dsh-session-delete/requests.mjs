import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertId, safePath, atomicJson, inventory, closure, makePlan, savePlan, purge } from './core.mjs';

const requestDirectory = home => join(home, 'session-delete-requests');
const isPending = request => ['pending', 'executing'].includes(request.phase);
export function identities(targets) {
  return targets.map(t => ({ id: t.header.id, createdAt: t.header.createdAt, cwd: t.header.cwd, parentSession: t.header.parentSession, origin: t.header.origin, isSeeded: t.header.isSeeded })).sort((a,b) => a.id.localeCompare(b.id));
}
export async function reviewTargets(home, id) {
  return identities(closure(await inventory(home), assertId(id)));
}
export async function readRequests(home) {
  const dir = requestDirectory(home);
  if (!await safePath(home, dir, 'directory', true)) return [];
  const requests = [];
  for (const name of (await readdir(dir)).sort()) {
    if (!name.endsWith('.json')) continue;
    const ticket = assertId(name.slice(0, -5));
    const path = join(dir, name);
    await safePath(home, path);
    const item = JSON.parse(await readFile(path, 'utf8'));
    if (item.version !== 2 || item.ticket !== ticket || item.home !== home || !Array.isArray(item.targets) || !item.targets.length) throw new Error('잘못된 재시작 삭제 예약: ' + ticket);
    assertId(item.rootId);
    const ids = new Set(item.targets.map(t => assertId(t.id)));
    if (ids.size !== item.targets.length || !ids.has(item.rootId) || typeof item.queuedBootId !== 'string' || !['pending','executing','complete','cancelled','failed'].includes(item.phase)) throw new Error('잘못된 삭제 대상 또는 상태입니다.');
    requests.push({ ...item, path });
  }
  return requests;
}
export async function updateRequest(request, fields) {
  const { path, ...data } = { ...request, ...fields };
  await atomicJson(path, data);
  Object.assign(request, fields);
}
export async function queueRequest(home, rootId, targets, queryPath, bootId) {
  const existing = await readRequests(home);
  const ids = new Set(targets.map(t => t.id));
  if (existing.some(r => isPending(r) && r.targets.some(t => ids.has(t.id)))) throw new Error('이미 삭제 예약된 세션이 포함되어 있습니다. /session-delete status로 확인하세요.');
  const dir = requestDirectory(home);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await safePath(home, dir, 'directory');
  const ticket = randomUUID();
  const request = { version: 2, home, ticket, rootId, targets, queryPath, queuedBootId: bootId, phase: 'pending', queuedAt: new Date().toISOString() };
  await atomicJson(join(dir, ticket + '.json'), request);
  return ticket;
}
export async function cancelRequests(home, rootId) {
  let count = 0;
  for (const item of await readRequests(home)) if (item.rootId === rootId && item.phase === 'pending') {
    await updateRequest(item, { phase: 'cancelled' }); count++;
  }
  return count;
}
export async function processRequests(home, bootId, lock, checkOffline) {
  const requests = (await readRequests(home)).filter(r => isPending(r) && r.queuedBootId !== bootId);
  if (requests.length) await checkOffline();
  const results = [];
  for (const request of requests) {
    let plan;
    try {
      if (request.phase === 'pending') {
        const current = await makePlan(home, request.rootId);
        if (JSON.stringify(identities(current.targets)) !== JSON.stringify(request.targets)) throw new Error('확인 후 세션 구성/ID가 변경되었습니다. 다시 확인해야 합니다.');
        const journal = await savePlan(home, { ...current, queryPath: request.queryPath });
        await updateRequest(request, { phase: 'executing', journal });
      }
      const journalPath = join(home, 'session-deletions', assertId(request.journal) + '.json');
      await safePath(home, journalPath);
      plan = JSON.parse(await readFile(journalPath, 'utf8'));
      if (plan.phase !== 'complete') {
        if (plan.home !== home || plan.rootId !== request.rootId || JSON.stringify(identities(plan.targets)) !== JSON.stringify(request.targets)) throw new Error('삭제 저널과 확인한 대상이 다릅니다.');
        await purge(plan, journalPath, lock, checkOffline);
      }
      await updateRequest(request, { phase: 'complete', completedAt: new Date().toISOString() });
      results.push({ rootId: request.rootId, phase: 'complete' });
    } catch (error) {
      if (plan?.phase === 'deleting' || request.phase === 'executing' && plan === undefined) throw error;
      await updateRequest(request, { phase: 'failed', error: error.message });
      results.push({ rootId: request.rootId, phase: 'failed', error: error.message });
    }
  }
  return results;
}
