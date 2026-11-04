import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, symlink, unlink, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { inventory, makePlan, savePlan, purge, safePath, assertOffline, validatePlan, indexFiles, digest } from './core.mjs';
import { createHandler } from './index.mjs';
import { processRequests, readRequests } from './requests.mjs';
import { oncePerProcess } from './boot.mjs';

const unlocked = async () => {};
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-delete-test-'));
  t.after(async () => { assert.ok(home.startsWith(join(tmpdir(), 'dsh-delete-test-'))); await rm(home, { recursive: true }); });
  await mkdir(join(home, 'storages/session_projcache/sessions'), { recursive: true });
  await mkdir(join(home, 'sessions/project'), { recursive: true });
  const root = 'session-' + randomUUID(); const other = 'session-' + randomUUID();
  async function add(id, options = {}) {
    const dir = join(home, 'sessions/project', id);
    await mkdir(dir);
    const header = { type: 'session', version: 4, id, createdAt: 1, cwd: '/work', isSeeded: false, ...options };
    const log = JSON.stringify(header) + '\n' + JSON.stringify({ secret: 'conversation contents' }) + '\n';
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(log)));
    await writeFile(join(dir, 'session.lock'), '');
    await writeFile(join(home, 'storages/session_projcache/sessions', id + '.json'), 'cached secret');
    return dir;
  }
  const rootDir = await add(root); const otherDir = await add(other);
  const workspace = { unit: { name: 'workspace', version: 2 }, global: { archivedSessionIds: [root], pinnedSessionIds: [other] }, tables: { workspaces: { work: { sessionIds: [root, other], title: 'keep workspace' } } } };
  await writeFile(join(home, 'storages/workspace.json'), JSON.stringify(workspace));
  async function queued() {
    const plan = await makePlan(home, root);
    const ticket = await savePlan(home, plan);
    const path = join(home, 'session-deletions', ticket + '.json');
    return { plan: JSON.parse(await readFile(path)), path };
  }
  return { home, root, other, rootDir, otherDir, add, queued };
}
test('permanent purge removes generations/cache/index and membership, preserves unrelated data and lock inode', async t => {
  const f = await fixture(t);
  const child = randomUUID(); const fork = 'session-' + randomUUID();
  await f.add(child, { parentSession: f.root, origin: 'subagent' });
  await f.add(fork, { parentSession: f.root, isSeeded: true });
  await writeFile(join(f.rootDir, 'session.v3.jsonl'), 'old private history');
  await writeFile(join(f.rootDir, 'session.jsonl'), 'legacy v0 history');
  await writeFile(join(f.home, 'important-user-file.txt'), 'preserve');
  const { plan, path } = await f.queued();
  const before = await lstat(join(f.rootDir, 'session.lock'));
  const dbPath = join(f.home, 'search.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA application_id=1146308689; CREATE TABLE persisted_sessions(id TEXT);'); db.close();
  plan.queryPath = dbPath;
  const deleted = await purge(plan, path, unlocked, unlocked);
  assert.deepEqual(new Set(deleted), new Set([f.root, child, fork]));
  assert.deepEqual(await readdir(f.rootDir), ['session.lock']);
  assert.equal((await lstat(join(f.rootDir, 'session.lock'))).ino, before.ino);
  assert.equal((await inventory(f.home)).length, 1);
  assert.equal(await readFile(join(f.home, 'important-user-file.txt'), 'utf8'), 'preserve');
  assert.deepEqual(await readdir(join(f.home, 'storages/session_projcache/sessions')), [f.other + '.json']);
  await assert.rejects(lstat(dbPath), { code: 'ENOENT' });
  const ws = JSON.parse(await readFile(join(f.home, 'storages/workspace.json')));
  assert.deepEqual(ws.tables.workspaces.work.sessionIds, [f.other]);
  assert.deepEqual(ws.global.archivedSessionIds, []);
  const receipt = JSON.parse(await readFile(path));
  assert.equal(receipt.phase, 'complete'); assert.equal(receipt.targets, undefined);
});
test('changed log refuses before any deletion', async t => {
  const f = await fixture(t); const { plan, path } = await f.queued();
  await writeFile(join(f.rootDir, 'session.v3.jsonl'), 'new generation');
  await assert.rejects(purge(plan, path, unlocked, unlocked), /새 로그/);
  assert.equal((await inventory(f.home)).length, 2);
  assert.equal(JSON.parse(await readFile(path)).phase, 'queued');
});
test('same-path log edit is rejected by hash', async t => {
  const f = await fixture(t); const { plan, path } = await f.queued();
  const file = join(f.rootDir, 'session.v4.jsonl.zstd');
  await writeFile(file, Buffer.concat([await readFile(file), zstdCompressSync(Buffer.from('changed\n'))]));
  await assert.rejects(purge(plan, path, unlocked, unlocked), /기록|대화가 변경/);
  assert.equal((await inventory(f.home)).length, 2);
});
test('new descendant invalidates prior confirmation', async t => {
  const f = await fixture(t); const { plan, path } = await f.queued();
  await f.add(randomUUID(), { parentSession: f.root, origin: 'subagent' });
  await assert.rejects(purge(plan, path, unlocked, unlocked), /새 하위/);
  assert.equal((await inventory(f.home)).length, 3);
});
test('symlink and traversal are refused', async t => {
  const f = await fixture(t);
  await assert.rejects(safePath(f.home, join(f.home, '../outside')), /범위/);
  await symlink(f.otherDir, join(f.home, 'sessions/project', randomUUID()));
  await assert.rejects(inventory(f.home), /일반 파일/);
});
test('active write lock refuses all deletion', async t => {
  const f = await fixture(t); const { plan, path } = await f.queued();
  await assert.rejects(purge(plan, path, async () => { throw new Error('busy'); }, unlocked), /busy/);
  assert.equal((await inventory(f.home)).length, 2);
});
test('offline guard is checked before modifications', async t => {
  const f = await fixture(t); const { plan, path } = await f.queued();
  await assert.rejects(purge(plan, path, unlocked, async () => { throw new Error('running host'); }), /running host/);
  assert.equal(JSON.parse(await readFile(path)).phase, 'queued');
});
test('deleting journal permits retry after some files have gone', async t => {
  const f = await fixture(t); const { plan, path } = await f.queued();
  plan.phase = 'deleting'; await writeFile(path, JSON.stringify(plan));
  await unlink(join(f.rootDir, 'session.v4.jsonl.zstd'));
  await purge(plan, path, unlocked, unlocked);
  assert.equal(JSON.parse(await readFile(path)).phase, 'complete');
  assert.deepEqual(await readdir(f.rootDir), ['session.lock']);
});
test('scheduler storage and unrelated database fail closed', async t => {
  const f = await fixture(t); const { plan, path } = await f.queued();
  await writeFile(join(f.home, 'storages/schedule.json'), '{}');
  await assert.rejects(purge(plan, path, unlocked, unlocked), /스케줄/);
  const dbPath = join(f.home, 'user.sqlite'); const db = new DatabaseSync(dbPath); db.exec('CREATE TABLE valuable(x)'); db.close();
  await assert.rejects(indexFiles(dbPath), /DSH 검색/);
  assert.equal((await inventory(f.home)).length, 2);
});
function commandContext(f, accept = true) {
  return {
    sessionPersistence: { flush: unlocked }, sessionQuery: { config: { path: ':memory:' } },
    sessionDeleteReady: { bootId: 'original-process' },
    userQuestions: { ask: async () => ({ answers: [{ id: 'delete-session', selected: [accept ? '재시작 시 영구 삭제' : '취소'] }] }) },
  };
}
test('bare command confirms current session, leaves it live, and purges only after a new process', async t => {
  const f = await fixture(t);
  const handler = createHandler(commandContext(f), f.home);
  const result = await handler({ rawInput: '', agent: { session: { id: f.root } } });
  assert.equal(result.kind, 'success'); assert.match(result.text, /다음 DSH 재시작/);
  assert.equal((await inventory(f.home)).length, 2);
  // Command completion and later conversation bytes must not invalidate the intent.
  const log = join(f.rootDir, 'session.v4.jsonl.zstd');
  await writeFile(log, Buffer.concat([await readFile(log), zstdCompressSync(Buffer.from('command-done\n'))]));
  await processRequests(f.home, 'original-process', unlocked, unlocked);
  assert.equal((await inventory(f.home)).length, 2);
  await processRequests(f.home, 'restarted-process', unlocked, unlocked);
  assert.equal((await inventory(f.home)).length, 1);
  assert.equal((await readRequests(f.home))[0].phase, 'complete');
});
test('declined confirmation and cancellation both preserve the session on restart', async t => {
  const f = await fixture(t); const invocation = { rawInput: '', agent: { session: { id: f.root } } };
  const declined = createHandler(commandContext(f, false), f.home);
  assert.match((await declined(invocation)).text, /삭제하지 않았/);
  assert.deepEqual(await readRequests(f.home), []);
  const handler = createHandler(commandContext(f), f.home);
  await handler(invocation);
  assert.match((await handler({ ...invocation, rawInput: 'cancel' })).text, /취소/);
  await processRequests(f.home, 'restarted-process', unlocked, unlocked);
  assert.equal((await inventory(f.home)).length, 2);
});
test('new descendants after confirmation are not silently included at startup', async t => {
  const f = await fixture(t); const handler = createHandler(commandContext(f), f.home);
  await handler({ rawInput: '', agent: { session: { id: f.root } } });
  await f.add(randomUUID(), { parentSession: f.root, origin: 'subagent' });
  const results = await processRequests(f.home, 'restarted-process', unlocked, unlocked);
  assert.equal(results[0].phase, 'failed'); assert.equal((await inventory(f.home)).length, 3);
});
test('hot reload reuses boot result instead of running deletion again', async () => {
  let calls = 0; const key = 'test-home-' + randomUUID();
  const first = await oncePerProcess(key, async () => ++calls);
  const second = await oncePerProcess(key, async () => ++calls);
  assert.equal(first, 1); assert.equal(second, 1); assert.equal(calls, 1);
});
test('DSH internal invocation cannot bypass offline guard', async () => {
  const saved = process.env.DSH_SESSION_ID; process.env.DSH_SESSION_ID = 'test';
  try { await assert.rejects(assertOffline(), /DSH 내부/); } finally { if (saved === undefined) delete process.env.DSH_SESSION_ID; else process.env.DSH_SESSION_ID = saved; }
});
test('malformed target cannot create a lock in unrelated owned directory', async t => {
  const f = await fixture(t); const { plan, path } = await f.queued();
  plan.targets[0].dir = join(f.home, 'storages');
  await assert.rejects(purge(plan, path, unlocked, unlocked), /경로/);
  await assert.rejects(lstat(join(f.home, 'storages/session.lock')), { code: 'ENOENT' });
});
test('journal recovers index sidecars even when main database was already deleted', async t => {
  const f = await fixture(t); const { plan, path } = await f.queued();
  plan.phase = 'deleting'; plan.queryPath = join(f.home, 'search.sqlite');
  const sidecar = plan.queryPath + '-wal';
  await writeFile(sidecar, 'remaining private index');
  plan.indexCleanup = [{ path: plan.queryPath, sha256: 'a'.repeat(64) }, { path: sidecar, sha256: await digest(sidecar) }];
  await writeFile(path, JSON.stringify(plan));
  await purge(plan, path, unlocked, unlocked);
  await assert.rejects(lstat(sidecar), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(path)).phase, 'complete');
});
test('home-wide lock serializes unrelated purge operations', { skip: !process.env.DSH_TEST_FLOCK }, async t => {
  const { tryLockExclusive } = await import(pathToFileURL(process.env.DSH_TEST_FLOCK).href);
  const f = await fixture(t); const { plan, path } = await f.queued();
  const held = await open(join(f.home, 'session-deletions/purge.lock'), 'w');
  try { await tryLockExclusive(held.fd); await assert.rejects(purge(plan, path, tryLockExclusive, unlocked)); }
  finally { await held.close(); }
  assert.equal(JSON.parse(await readFile(path)).phase, 'queued');
  assert.equal((await inventory(f.home)).length, 2);
});
test('real native DSH flock rejects another writer', { skip: !process.env.DSH_TEST_FLOCK }, async t => {
  const { tryLockExclusive } = await import(pathToFileURL(process.env.DSH_TEST_FLOCK).href);
  const f = await fixture(t); const { plan, path } = await f.queued();
  const held = await open(join(f.rootDir, 'session.lock'), 'r+');
  try { await tryLockExclusive(held.fd); await assert.rejects(purge(plan, path, tryLockExclusive, unlocked)); }
  finally { await held.close(); }
  assert.equal((await inventory(f.home)).length, 2);
  await purge(plan, path, tryLockExclusive, unlocked);
  assert.equal((await inventory(f.home)).length, 1);
});
