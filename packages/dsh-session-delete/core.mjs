import { createReadStream, constants } from 'node:fs';
import { lstat, readdir, realpath, readFile, rename, unlink, mkdir, open } from 'node:fs/promises';
import { resolve, relative, join, dirname, basename, isAbsolute, sep } from 'node:path';
import { assertOwner, syncDirectory, assertOffline } from './platform/index.mjs';
export { assertOffline };
import { createHash, randomUUID } from 'node:crypto';
import { createZstdDecompress } from 'node:zlib';

export const VERSION = 1;
const ID = /^(?:session-)?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const LOG = /^session(?:\.v[1-4])?\.jsonl(?:\.zstd)?$/;
export function assertId(id) {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('정확한 세션 ID가 필요합니다.');
  return id;
}
export async function safePath(root, path, kind = 'file', optional = false) {
  root = resolve(root); path = resolve(path);
  const rel = relative(root, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('저장 경로 범위를 벗어났습니다: ' + path);
  if (relative(await realpath(root), root) !== '') throw new Error('심볼릭 링크 저장 루트는 지원하지 않습니다.');
  let current = root;
  const parts = rel.split(sep);
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let info;
    try { info = await lstat(current); } catch (e) {
      if (optional && e.code === 'ENOENT') return false;
      throw e;
    }
    const directory = i < parts.length - 1 || kind === 'directory';
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new Error('일반 파일/디렉터리가 아닙니다: ' + current);
    if (relative(await realpath(current), current) !== '') throw new Error('일반 파일/디렉터리가 아닙니다 (링크 경로): ' + current);
    assertOwner(info, current);
  }
  return true;
}
export async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function readHeader(path) {
  const source = createReadStream(path);
  const input = path.endsWith('.zstd') ? source.pipe(createZstdDecompress()) : source;
  if (input !== source) source.on('error', e => input.destroy(e));
  let bytes = Buffer.alloc(0);
  try {
    for await (const chunk of input) {
      bytes = Buffer.concat([bytes, chunk]);
      const end = bytes.indexOf(10);
      if (end >= 0) {
        const header = JSON.parse(bytes.subarray(0, end).toString('utf8'));
        if (header.type !== 'session' || header.version !== 4 || !Number.isSafeInteger(header.createdAt)) throw new Error('v4 세션만 지원합니다: ' + path);
        assertId(header.id);
        if (header.parentSession !== undefined) assertId(header.parentSession);
        return header;
      }
      if (bytes.length > 1024 * 1024) throw new Error('잘못된 세션 헤더입니다.');
    }
    throw new Error('세션 헤더가 없습니다: ' + path);
  } finally { input.destroy(); source.destroy(); }
}
export async function inventory(home) {
  const root = join(home, 'sessions');
  await safePath(home, root, 'directory');
  const sessions = [];
  for (const project of await readdir(root)) {
    const projectPath = join(root, project);
    await safePath(home, projectPath, 'directory');
    for (const id of await readdir(projectPath)) {
      assertId(id);
      const dir = join(projectPath, id);
      await safePath(home, dir, 'directory');
      const names = await readdir(dir);
      if (names.some(n => n !== 'session.lock' && !LOG.test(n))) throw new Error('알 수 없는 세션 파일이 있습니다: ' + dir);
      const logs = names.filter(n => LOG.test(n)).sort();
      if (!logs.length) continue;
      const current = logs.filter(n => /^session\.v4\.jsonl(?:\.zstd)?$/.test(n));
      if (current.length !== 1) throw new Error('현재 v4 세션 로그가 하나여야 합니다: ' + dir);
      for (const name of names) await safePath(home, join(dir, name));
      const header = await readHeader(join(dir, current[0]));
      if (header.id !== id || sessions.some(s => s.header.id === id)) throw new Error('세션 ID 또는 저장 경로가 충돌합니다.');
      sessions.push({ header, dir, logs });
    }
  }
  return sessions;
}
export function closure(sessions, rootId) {
  assertId(rootId);
  const root = sessions.find(s => s.header.id === rootId);
  if (!root) throw new Error('세션을 찾을 수 없습니다.');
  if (root.header.origin === 'subagent') throw new Error('하위 세션은 부모 세션과 함께 삭제해야 합니다.');
  const ids = new Set([rootId]);
  for (const id of ids) {
    for (const session of sessions) {
      if (session.header.parentSession === id) ids.add(session.header.id);
    }
  }
  return sessions.filter(s => ids.has(s.header.id)).sort((a,b) => a.header.id.localeCompare(b.header.id));
}
export async function makePlan(home, rootId) {
  home = resolve(home);
  const targets = [];
  for (const { header, dir, logs } of closure(await inventory(home), rootId)) {
    const files = [];
    for (const name of logs) files.push({ name, sha256: await digest(join(dir, name)) });
    targets.push({ header, dir, files });
  }
  return { version: VERSION, home, rootId, targets };
}
export async function atomicJson(path, data) {
  const tmp = path + '.' + randomUUID() + '.tmp';
  const file = await open(tmp, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(data, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  try { await rename(tmp, path); } catch (e) { await unlink(tmp); throw e; }
  await syncDirectory(dirname(path));
}
export async function savePlan(home, plan) {
  const queue = join(home, 'session-deletions');
  await mkdir(queue, { recursive: true, mode: 0o700 });
  await safePath(home, queue, 'directory');
  const ticket = randomUUID();
  await atomicJson(join(queue, ticket + '.json'), { ...plan, ticket, phase: 'queued' });
  return ticket;
}
export function validateStructure(plan) {
  if (plan.version !== VERSION || !['queued','deleting'].includes(plan.phase) || !Array.isArray(plan.targets) || !plan.targets.length) throw new Error('잘못된 삭제 예약입니다.');
  assertId(plan.rootId); assertId(plan.ticket);
  const ids = new Set(plan.targets.map(t => assertId(t.header.id)));
  if (!ids.has(plan.rootId) || ids.size !== plan.targets.length) throw new Error('잘못된 삭제 대상입니다.');
  if (typeof plan.home !== 'string' || resolve(plan.home) !== plan.home) throw new Error('잘못된 저장 루트입니다.');
  for (const target of plan.targets) {
    if (typeof target.dir !== 'string' || basename(target.dir) !== target.header.id || dirname(dirname(target.dir)) !== join(plan.home, 'sessions')) throw new Error('세션 경로가 일치하지 않습니다.');
    if (!Array.isArray(target.files) || !target.files.length || new Set(target.files.map(f => f.name)).size !== target.files.length) throw new Error('잘못된 삭제 파일 목록입니다.');
    for (const file of target.files) if (!LOG.test(file.name) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('잘못된 로그 지문입니다.');
  }
  return ids;
}
export async function validatePlan(plan) {
  const ids = validateStructure(plan);
  const current = await inventory(plan.home);
  for (const s of current) if (ids.has(s.header.parentSession) && !ids.has(s.header.id)) throw new Error('새 하위/분기 세션이 있습니다. 삭제를 다시 예약하세요.');
  for (const target of plan.targets) {
    const actual = current.find(s => s.header.id === target.header.id);
    if (actual && (actual.dir !== target.dir || JSON.stringify(actual.header) !== JSON.stringify(target.header))) throw new Error('세션 헤더가 변경되었습니다.');
    if (!actual && plan.phase !== 'deleting') throw new Error('삭제 대상이 사라졌습니다.');
    const expected = new Set(target.files.map(f => f.name));
    if (actual && actual.logs.some(n => !expected.has(n))) throw new Error('새 로그 세대가 있습니다. 삭제를 다시 예약하세요.');
    for (const file of target.files) {
      const path = join(target.dir, file.name);
      const exists = await safePath(plan.home, path, 'file', plan.phase === 'deleting');
      if (exists && await digest(path) !== file.sha256) throw new Error('예약 후 대화가 변경되었습니다. 다시 예약하세요: ' + target.header.id);
    }
  }
  return ids;
}
export async function cleanupPaths(home, ids) {
  const files = [];
  const cacheDir = join(home, 'storages/session_projcache/sessions');
  if (await safePath(home, cacheDir, 'directory', true)) {
    for (const name of await readdir(cacheDir)) if ([...ids].some(id => name === id + '.json' || name.startsWith(id + '.json.bak.'))) {
      const path = join(cacheDir, name); await safePath(home, path); files.push(path);
    }
  }
  const workspacePath = join(home, 'storages/workspace.json');
  let workspace;
  if (await safePath(home, workspacePath, 'file', true)) {
    workspace = JSON.parse(await readFile(workspacePath, 'utf8'));
    if (workspace.unit?.name !== 'workspace' || workspace.unit.version !== 2 || !workspace.tables?.workspaces || !Array.isArray(workspace.global?.archivedSessionIds) || !Array.isArray(workspace.global?.pinnedSessionIds)) throw new Error('지원하지 않는 워크스페이스 형식입니다.');
    for (const row of Object.values(workspace.tables.workspaces)) {
      if (!Array.isArray(row.sessionIds)) throw new Error('잘못된 워크스페이스 세션 목록입니다.');
      row.sessionIds = row.sessionIds.filter(id => !ids.has(id));
    }
    workspace.global.archivedSessionIds = workspace.global.archivedSessionIds.filter(id => !ids.has(id));
    workspace.global.pinnedSessionIds = workspace.global.pinnedSessionIds.filter(id => !ids.has(id));
  }
  const storage = join(home, 'storages');
  for (const name of await readdir(storage)) if (/schedule/i.test(name)) throw new Error('스케줄 저장소가 있습니다. 예약 작업 정리 지원 전에는 삭제를 거부합니다.');
  return { files, workspace, workspacePath };
}
export async function indexFiles(path) {
  if (path === undefined || path === ':memory:') return [];
  if (!isAbsolute(path)) throw new Error('검색 인덱스는 절대 경로여야 합니다.');
  const parent = dirname(path);
  let parentInfo;
  try { parentInfo = await lstat(parent); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  assertOwner(parentInfo, parent);
  const files = [];
  for (const suffix of ['', '-wal', '-shm', '-journal']) if (await safePath(parent, path + suffix, 'file', true)) files.push(path + suffix);
  if (!files.includes(path)) {
    if (files.length) throw new Error('검색 인덱스 본체가 없습니다.');
    return [];
  }
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (db.prepare('PRAGMA application_id').get().application_id !== 1146308689) throw new Error('DSH 검색 인덱스가 아닙니다.');
    const allowed = new Set(['search_state','persisted_sessions','persisted_docs','persisted_docs_data','persisted_docs_idx','persisted_docs_content','persisted_docs_docsize','persisted_docs_config']);
    for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*'").all()) if (!allowed.has(row.name)) throw new Error('알 수 없는 검색 인덱스 테이블입니다.');
  } finally { db.close(); }
  return files;
}
export async function lockFile(home, path, lock) {
  await safePath(home, dirname(path), 'directory');
  await safePath(home, path, 'file', true);
  // Windows uses the same named semaphore as DSH, with no lock-file footprint.
  if (typeof lock !== 'function') return lock.acquire(path);
  const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    await lock(file.fd);
    const held = await file.stat();
    const current = await lstat(path);
    if (held.ino !== current.ino || held.dev !== current.dev) throw new Error('잠금 파일이 변경되었습니다.');
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

export async function purge(plan, planPath, lock, checkOffline = assertOffline) {
  validateStructure(plan);
  await checkOffline();
  await safePath(plan.home, planPath);
  const held = [];
  let failure;
  try {
    if (planPath !== join(plan.home, 'session-deletions', assertId(plan.ticket) + '.json')) throw new Error('예약 경로가 일치하지 않습니다.');
    const locks = [join(plan.home, 'session-deletions/purge.lock'), ...plan.targets.map(target => join(target.dir, 'session.lock'))];
    for (const path of locks) held.push(await lockFile(plan.home, path, lock));
    const ids = await validatePlan(plan);
    const cleanup = await cleanupPaths(plan.home, ids);
    const indexes = plan.phase === 'deleting' && plan.indexCleanup ? plan.indexCleanup : await Promise.all((await indexFiles(plan.queryPath)).map(async path => ({ path, sha256: await digest(path) })));
    for (const file of indexes) {
      if (!['', '-wal', '-shm', '-journal'].some(suffix => file.path === plan.queryPath + suffix)) throw new Error('잘못된 인덱스 정리 경로입니다.');
      if (await safePath(dirname(file.path), file.path, 'file', true) && await digest(file.path) !== file.sha256) throw new Error('검색 인덱스가 변경되었습니다.');
    }
    await checkOffline();
    plan.phase = 'deleting';
    plan.indexCleanup = indexes;
    await atomicJson(planPath, plan);
    for (const target of plan.targets) for (const file of target.files) {
      const path = join(target.dir, file.name);
      if (await safePath(plan.home, path, 'file', true)) await unlink(path);
    }
    for (const path of cleanup.files) if (await safePath(plan.home, path, 'file', true)) await unlink(path);
    for (const { path } of indexes) if (await safePath(dirname(path), path, 'file', true)) await unlink(path);
    if (cleanup.workspace) await atomicJson(cleanup.workspacePath, cleanup.workspace);
    for (const dir of new Set([...plan.targets.map(t => t.dir), ...cleanup.files.map(dirname), ...indexes.map(f => dirname(f.path))])) await syncDirectory(dir);
    plan.phase = 'complete';
    await atomicJson(planPath, { version: VERSION, ticket: plan.ticket, phase: 'complete', deletedIds: [...ids], completedAt: new Date().toISOString() });
    return [...ids];
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const errors = [];
    for (const file of held.reverse()) {
      try { await file.close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) {
      if (failure) failure.cleanupErrors = errors;
      else throw new AggregateError(errors, '삭제 잠금 해제에 실패했습니다.');
    }
  }
}
