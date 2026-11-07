import { createHash, randomUUID } from 'node:crypto';
import { open, rename, unlink, lstat, realpath } from 'node:fs/promises';
import { dirname, relative, isAbsolute, resolve, sep } from 'node:path';
import { promisify, isDeepStrictEqual } from 'node:util';
import { zstdCompress } from 'node:zlib';
import { loadRuntime } from './runtime.mjs';
import { findMessage, rewriteEvents } from './rewrite.mjs';

const compress = promisify(zstdCompress);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function eventsOf(session) {
  return session.snapshotEvents();
}

function openTurn(events) {
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index].type === 'turn/start') return true;
    if (events[index].type === 'turn/end') return false;
  }
  return false;
}

function pendingInbox(events) {
  const queues = { 'next-step': [], 'next-turn': [] };
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue;
    const data = event.data;
    const queue = queues[data.target];
    if (!queue || !Number.isSafeInteger(data.start) || data.start < 0 || data.start > queue.length || !Array.isArray(data.inserted)) fail('session-invalid', 'Invalid persisted inbox.');
    const removed = data.removedCount ?? 0;
    if (!Number.isSafeInteger(removed) || removed < 0 || data.start + removed > queue.length) fail('session-invalid', 'Invalid persisted inbox.');
    queue.splice(data.start, removed, ...data.inserted);
  }
  return queues['next-step'].length > 0 || queues['next-turn'].length > 0;
}

function targetOf(session, messageId) {
  const events = eventsOf(session);
  const visible = new Set(session.surface.nodes);
  const event = findMessage(events, messageId);
  if (!event) fail('target-not-found', 'The message was not found.');
  if (!events.some(item => visible.has(item.seq) && (item.type === 'user/message' ? item.data.id : item.type === 'assistant/message' ? item.data.message?.id : undefined) === messageId)) fail('compacted', 'This message is no longer on the current session surface.');
  const message = event.type === 'user/message' ? event.data : event.data.message;
  const text = (message.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('');
  const revision = createHash('sha256').update(JSON.stringify(canonical(event))).digest('hex');
  return { event, revision, message: { messageId, seq: event.seq, role: event.type === 'user/message' ? 'user' : 'assistant', text } };
}

function patchOwn(target, key, value, restores) {
  const own = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  restores.push(() => {
    if (own) Object.defineProperty(target, key, own);
    else delete target[key];
  });
}

function patchMethod(target, key, wrap, restores) {
  let owner = target;
  while (owner && !Object.hasOwn(owner, key)) owner = Object.getPrototypeOf(owner);
  const descriptor = owner && Object.getOwnPropertyDescriptor(owner, key);
  if (!descriptor || typeof descriptor.value !== 'function') fail('runtime-unsupported', `Missing runtime method ${key}.`);
  const replacement = wrap(descriptor.value);
  Object.defineProperty(owner, key, { ...descriptor, value: replacement });
  restores.push(() => {
    if (Object.getOwnPropertyDescriptor(owner, key)?.value === replacement) Object.defineProperty(owner, key, descriptor);
  });
}

export function createCoordinator(ctx) {
  const runtime = loadRuntime();
  const unwrap = (value) => value?.[runtime.symbols.original] ?? value;
  const registry = unwrap(ctx.agents);
  const persistence = ctx.sessionPersistence;
  const cache = ctx.sessionProjectionCache;
  const handles = new Map();
  const gates = new Set();
  const factories = new Map();
  const cacheWork = new Map();
  const operations = new Set();
  const restores = [];
  let stopped = false;
  let stopping;

  function assertOpen() {
    if (stopped) fail('unavailable', 'Session rewrite coordinator is stopping.');
  }

  function track(map, id, promise) {
    const set = map.get(id) ?? new Set();
    map.set(id, set);
    set.add(promise);
    promise.then(() => finish(), () => finish());
    function finish() {
      set.delete(promise);
      if (!set.size) map.delete(id);
    }
    return promise;
  }

  function factoryHook(original) {
    return function (options) {
      if (unwrap(this) !== registry) return Reflect.apply(original, this, arguments);
      const id = options?.resumeSessionId ?? options?.sessionId;
      if (gates.has(id)) fail('session-busy', 'This session is being rewritten.');
      const result = Promise.resolve(Reflect.apply(original, this, arguments)).then((handle) => {
        if (handle?.agent && typeof handle.dispose === 'function') handles.set(handle.agent.id, handle);
        return handle;
      });
      return track(factories, id, result);
    };
  }

  try {
    patchMethod(registry, 'create', factoryHook, restores);
    patchMethod(registry, 'resume', factoryHook, restores);
    if (cache) {
      const actualCache = unwrap(cache);
      for (const key of ['write', 'put']) {
        patchMethod(actualCache, key, (original) => function (...args) {
          if (unwrap(this) !== actualCache) return Reflect.apply(original, this, args);
          const id = key === 'write' ? args[0]?.id : args[0];
          if (gates.has(id)) return Promise.resolve();
          return track(cacheWork, id, Promise.resolve(Reflect.apply(original, this, args)));
        }, restores);
      }
    }
  } catch (error) {
    for (const restore of restores.reverse()) restore();
    throw error;
  }

  function restoreSession(header, events, inheritedEventCount) {
    runtime.assertReleasedV4Relationships({ header, events, inheritedEventCount }, runtime.KNOWN_SESSION_EVENT_TYPES);
    return runtime.Session.fromRestore(header.id, structuredClone(events), structuredClone(header), inheritedEventCount, 'detached', ctx.sessions.messageProjections ?? runtime.currentSessionMessageProjections);
  }

  async function cold(id) {
    const handle = await persistence.open(id, 'read');
    try {
      const { events } = await handle.read(0);
      return restoreSession(handle.header, events, handle.inheritedEventCount);
    } finally {
      await handle.close();
    }
  }

  function idleReason(id, agent, session) {
    if (gates.has(id) || factories.has(id)) return 'session-busy';
    if (agent?.status === 'running' || (agent?.phase && agent.phase.kind !== 'idle')) return 'session-busy';
    const events = eventsOf(session);
    if (openTurn(events) || agent?.inbox?.hasPending || pendingInbox(events)) return 'session-busy';
    if ((agent || ctx.sessions.get(id)) && (!agent || handles.get(id)?.agent !== agent)) return 'restart-required';
    return undefined;
  }

  async function describeInner(sessionId, messageId) {
    assertOpen();
    if (typeof sessionId !== 'string' || !sessionId || typeof messageId !== 'string' || !messageId) fail('bad-request', 'Session and message ids are required.');
    const agent = ctx.agents.get(sessionId);
    const session = agent?.session ?? ctx.sessions.get(sessionId) ?? await cold(sessionId);
    const target = targetOf(session, messageId);
    const reason = idleReason(sessionId, agent, session);
    return { running: reason === 'session-busy', editable: !reason, ...(reason ? { reason } : {}), revision: target.revision, message: target.message };
  }

  function describe(sessionId, messageId) {
    assertOpen();
    const operation = describeInner(sessionId, messageId);
    operations.add(operation);
    operation.then(() => operations.delete(operation), () => operations.delete(operation));
    return operation;
  }

  async function rewrite(payload) {
    const { sessionId: id, messageId, revision, operation, text } = payload;
    const localRestores = [];
    let lease;
    try {
      if (factories.has(id)) fail('session-busy', 'Session creation or resume is still in progress.');
      const agent = ctx.agents.get(id);
      const live = agent?.session ?? ctx.sessions.get(id);
      const initial = live ?? await cold(id);
      if (agent?.status === 'running' || (agent?.phase && agent.phase.kind !== 'idle') || openTurn(eventsOf(initial)) || agent?.inbox?.hasPending || pendingInbox(eventsOf(initial))) fail('session-busy', 'Wait until the session and inbox are idle.');
      const owner = handles.get(id);
      if (live && (!agent || owner?.agent !== agent)) fail('restart-required', 'Restart DSH with this plugin enabled before editing this live session.');
      if (targetOf(initial, messageId).revision !== revision) fail('stale', 'The message has changed. Refresh and try again.');
      const options = { ...payload, expectedText: targetOf(initial, messageId).message.text };
      const preflight = rewriteEvents(eventsOf(initial), options);
      const preflightEvents = Array.isArray(preflight) ? preflight : preflight.events;
      restoreSession(initial.header, preflightEvents, initial.inheritedEventCount);
      runtime.sessionFormatCatalog.encodeCurrentHeader({ ...initial.header, delegationDepth: initial.header.delegationDepth ?? 0 }, initial.inheritedEventCount);
      for (const event of preflightEvents) runtime.sessionFormatCatalog.encodeCurrentEvent(event);
      if (agent) {
        const originalMaintenance = agent.runMaintenance;
        if (typeof originalMaintenance !== 'function') fail('runtime-unsupported', 'Agent maintenance admission is unavailable.');
        for (const key of ['send', 'followup', 'steer', 'inject', 'addContext', 'runMaintenance']) {
          if (typeof agent[key] === 'function') patchOwn(agent, key, () => fail('session-busy', 'This session is being rewritten.'), localRestores);
        }
        patchOwn(live, 'append', () => fail('session-busy', 'This session is being rewritten.'), localRestores);
        try {
          await Reflect.apply(originalMaintenance, agent, [() => undefined]);
        } catch (error) {
          fail('session-busy', `Session maintenance admission failed: ${error.message}`);
        }
        if (!await ctx.sessions.flush(live)) fail('persistence-unavailable', 'The live session has no persistence writer.');
        await owner.dispose();
        handles.delete(id);
        if (ctx.agents.get(id) || ctx.sessions.get(id)) fail('session-busy', 'The session did not fully unload.');
      }
      lease = await persistence.open(id, 'write');
      const { events } = await lease.read(0);
      const finalSession = restoreSession(lease.header, events, lease.inheritedEventCount);
      if (openTurn(events) || pendingInbox(events)) fail('session-busy', 'The persisted session is not idle.');
      if (targetOf(finalSession, messageId).revision !== revision) fail('stale', 'The persisted message has changed. Refresh and try again.');
      const result = rewriteEvents(events, { ...options, operation, text });
      const rewritten = Array.isArray(result) ? result : result.events;
      restoreSession(lease.header, rewritten, lease.inheritedEventCount);
      const located = persistence.locate(lease.header);
      if (located?.kind !== 'jsonl' || lease.header.version !== 4) fail('runtime-unsupported', 'Only installed current v4 JSONL storage can be rewritten.');
      const path = resolve(located.path);
      const root = await realpath(resolve(persistence.config.root));
      const actual = await realpath(path);
      const rel = relative(root, actual);
      const info = await lstat(path);
      if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel) || info.isSymbolicLink() || !info.isFile()) fail('storage-invalid', 'Session artifact is not a regular file beneath its configured root.');
      const catalog = runtime.sessionFormatCatalog;
      const header = JSON.stringify(catalog.encodeCurrentHeader(lease.header, lease.inheritedEventCount)) + '\n';
      const body = rewritten.map((event) => JSON.stringify(catalog.encodeCurrentEvent(event))).join('\n') + (rewritten.length ? '\n' : '');
      const bytes = path.endsWith('.zstd') ? Buffer.concat([await compress(header), ...(body ? [await compress(body)] : [])]) : Buffer.from(header + body);
      if (cache) {
        await Promise.allSettled([...(cacheWork.get(id) ?? [])]);
        const table = cache.requireTable();
        if (typeof table.delete !== 'function') fail('runtime-unsupported', 'Projection cache invalidation is unavailable.');
        await table.delete(id);
      }
      const temp = path + '.' + randomUUID() + '.tmp';
      let created = false;
      try {
        const file = await open(temp, 'wx', info.mode & 0o777);
        created = true;
        try {
          await file.writeFile(bytes);
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temp, path);
        created = false;
        if (process.platform !== 'win32') {
          const directory = await open(dirname(path), 'r');
          try { await directory.sync(); } finally { await directory.close(); }
        }
      } finally {
        if (created) await unlink(temp);
      }
      const verified = await cold(id);
      if (!isDeepStrictEqual(eventsOf(verified).slice(0, rewritten.length), rewritten)) fail('verification-failed', 'Replacement verification failed. The session remains unloaded.');
      await lease.close();
      lease = undefined;
      return { reload: true };
    } finally {
      try { if (lease) await lease.close(); } finally {
        for (const restore of localRestores.reverse()) restore();
        gates.delete(id);
      }
    }
  }

  function mutate(payload) {
    assertOpen();
    if (!payload || typeof payload.sessionId !== 'string' || !payload.sessionId || typeof payload.messageId !== 'string' || !payload.messageId || typeof payload.revision !== 'string' || !['edit', 'delete'].includes(payload.operation)) fail('bad-request', 'Invalid rewrite payload.');
    if (payload.operation === 'edit' && (typeof payload.text !== 'string' || !payload.text.trim())) fail('text-invalid', 'Replacement text must not be empty.');
    if (payload.operation === 'edit' && Buffer.byteLength(payload.text) > 65536) fail('text-too-large', 'Replacement text exceeds 65536 bytes.');
    if (gates.has(payload.sessionId)) fail('session-busy', 'This session is already being rewritten.');
    gates.add(payload.sessionId);
    const operation = rewrite(payload);
    operations.add(operation);
    operation.then(() => operations.delete(operation), () => operations.delete(operation));
    return operation;
  }

  function dispose() {
    if (stopping) return stopping;
    stopped = true;
    stopping = (async () => {
      await Promise.allSettled([...operations]);
      await Promise.allSettled([...factories.values()].flatMap((set) => [...set]));
      for (const restore of restores.reverse()) restore();
      handles.clear();
    })();
    return stopping;
  }

  return { describe, mutate, dispose };
}
