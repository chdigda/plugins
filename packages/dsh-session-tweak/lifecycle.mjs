import { createHash, randomUUID } from 'node:crypto';
import { open, rename, unlink, lstat, realpath } from 'node:fs/promises';
import { relative, isAbsolute, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { zstdCompress } from 'node:zlib';
import { loadRuntime } from './runtime.mjs';
import { findMessage, rewriteEvents } from './rewrite.mjs';

const compress = promisify(zstdCompress);

function freezeJson(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freezeJson(child); Object.freeze(value); }
  return value;
}

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
  const revisions = new Map();
  const epoch = randomUUID();
  const listeners = new Set();
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
    const session = runtime.Session.fromRestore(header.id, structuredClone(events), structuredClone(header), inheritedEventCount, 'detached', ctx.sessions.messageProjections ?? runtime.currentSessionMessageProjections);
    session.log.length = events.length;
    session.surfaceManager._pendingPlan = undefined;
    return session;
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

  function prepareMemory(session, rewritten) {
    const template = runtime.Session.create(session.id);
    const log = rewritten.map(event => freezeJson(structuredClone(event)));
    template.log = log;
    template.surfaceManager = new session.surfaceManager.constructor(log, 0, ctx.sessions.messageProjections ?? runtime.currentSessionMessageProjections);
    void template.surfaceManager.nodes;
    template.surfaceManager._state.contentGeneration = Math.max(template.surfaceManager.contentGeneration, session.surface.contentGeneration + 1);
    template.surfaceManager._state.replaceGeneration = Math.max(template.surfaceManager.replaceGeneration, session.surface.replaceGeneration + 1);
    const preserve = new Set(['header', 'inheritedEventCount', 'firstLiveSeq', 'firstLifecycleSeq']);
    const fields = Object.fromEntries(Object.keys(template).filter(key => !preserve.has(key)).map(key => [key, template[key]]));
    const registry = unwrap(ctx.sessionProjections);
    if (!registry?.registrations || typeof registry.buildCell !== 'function') fail('runtime-unsupported', 'Live session projections are unavailable.');
    const cells = [...registry.registrations.values()].map(registration => ({ registration, cell: registry.buildCell(registration.def, session.header, session.inheritedEventCount, log) }));
    for (const { registration, cell } of cells) if (registration.refs > 0 && registration.def.wire) registry.viewCell(registration, cell);
    return { fields, registry, cells };
  }

  function commitMemory(session, prepared) {
    Object.assign(session, prepared.fields);
    for (const { registration, cell } of prepared.cells) registration.cells.set(session, cell);
  }

  function announceProjections(session, registry) {
    const baseline = registry.snapshot(session);
    const changes = Object.entries(baseline.values).map(([key, val]) => ({ key, val }));
    for (const { key, val } of changes) for (const listener of registry.listeners) {
      try { listener(session, key, val, baseline.asOfSeq); } catch {}
    }
    for (const listener of registry.eventListeners) {
      try { listener(session, changes, baseline.asOfSeq); } catch {}
    }
    return baseline;
  }

  function packSnapshot(session) {
    const id = session.id;
    return {
      sessionId: id,
      revision: epoch + ':' + (revisions.get(id) ?? 0),
      epoch,
      version: revisions.get(id) ?? 0,
      events: eventsOf(session),
      header: session.header,
      inheritedEventCount: session.inheritedEventCount,
      projections: ctx.sessionProjections.snapshot(session),
    };
  }

  async function snapshotInner(id) {
    assertOpen();
    if (typeof id !== 'string' || !id) fail('bad-request', 'Session id is required.');
    if (gates.has(id) || ctx.agents.get(id)?.status === 'running') fail('session-busy', 'This session is being edited or running.');
    const before = revisions.get(id) ?? 0;
    const session = ctx.sessions.get(id) ?? await cold(id);
    if ((revisions.get(id) ?? 0) !== before) return snapshot(id);
    return packSnapshot(session);
  }

  function snapshot(id) {
    assertOpen();
    const operation = snapshotInner(id);
    operations.add(operation);
    operation.then(() => operations.delete(operation), () => operations.delete(operation));
    return operation;
  }

  async function rewrite(payload) {
    const { sessionId: id, messageId, revision } = payload;
    const localRestores = [];
    let ownedLease;
    try {
      if (factories.has(id)) fail('session-busy', 'Session creation or resume is still in progress.');
      const agent = ctx.agents.get(id);
      const live = agent?.session ?? ctx.sessions.get(id);
      const initial = live ?? await cold(id);
      if (agent?.status === 'running' || (agent?.phase && agent.phase.kind !== 'idle') || openTurn(eventsOf(initial)) || agent?.inbox?.hasPending || pendingInbox(eventsOf(initial))) fail('session-busy', 'Wait until this session is idle.');
      if (targetOf(initial, messageId).revision !== revision) fail('stale', 'The message has changed.');
      const activeWriter = unwrap(persistence).tracker?.writers?.get(id);
      if (live && (!activeWriter || typeof activeWriter.enqueueChain !== 'function')) fail('runtime-unsupported', 'The current session writer is unavailable.');
      const maintenance = agent?.runMaintenance;
      if (agent && typeof maintenance !== 'function') fail('runtime-unsupported', 'Agent maintenance admission is unavailable.');
      if (agent) for (const key of ['send', 'followup', 'steer', 'inject', 'addContext', 'runMaintenance']) {
        if (typeof agent[key] === 'function') patchOwn(agent, key, () => fail('session-busy', 'This session is being edited.'), localRestores);
      }
      if (live) patchOwn(live, 'append', () => fail('session-busy', 'This session is being edited.'), localRestores);
      const transaction = async () => {
        let writer = activeWriter;
        let current = initial;
        if (live) {
          if (!await ctx.sessions.flush(live)) fail('persistence-unavailable', 'The live session has no persistence writer.');
          await writer.drainLive();
          await writer.flush();
          await writer.chain;
        } else {
          ownedLease = writer = await persistence.open(id, 'write');
          const read = await writer.read(0);
          current = restoreSession(writer.header, read.events, writer.inheritedEventCount);
        }
        const currentEvents = eventsOf(current);
        if (writer.state.cursor !== currentEvents.length) fail('session-busy', 'The session writer has pending events.');
        if (targetOf(current, messageId).revision !== revision) fail('stale', 'The message has changed.');
        const options = { ...payload, expectedText: targetOf(current, messageId).message.text };
        const { events: rewritten } = rewriteEvents(currentEvents, options);
        const detached = restoreSession(writer.header, rewritten, writer.inheritedEventCount);
        ctx.sessionProjections.snapshot(detached);
        const prepared = live ? prepareMemory(live, rewritten) : undefined;
        const catalog = runtime.sessionFormatCatalog;
        const header = JSON.stringify(catalog.encodeCurrentHeader({ ...writer.header, delegationDepth: writer.header.delegationDepth ?? 0 }, writer.inheritedEventCount)) + '\n';
        const body = rewritten.map(event => JSON.stringify(catalog.encodeCurrentEvent(event))).join('\n') + (rewritten.length ? '\n' : '');
        const located = persistence.locate(writer.header);
        if (located?.kind !== 'jsonl' || writer.header.version !== 4) fail('runtime-unsupported', 'Only current v4 JSONL storage is supported.');
        const path = resolve(located.path);
        const root = await realpath(resolve(persistence.config.root));
        const actual = await realpath(path);
        const rel = relative(root, actual);
        const info = await lstat(path);
        if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel) || info.isSymbolicLink() || !info.isFile()) fail('storage-invalid', 'Invalid session artifact.');
        const bytes = path.endsWith('.zstd') ? Buffer.concat([await compress(header), ...(body ? [await compress(body)] : [])]) : Buffer.from(header + body);
        if (cache) {
          await Promise.allSettled([...(cacheWork.get(id) ?? [])]);
          cache.markClean?.(live ?? current);
          await cache.requireTable().delete(id);
        }
        return writer.enqueueChain(async () => {
          if (writer.closing || writer.buffered.length || writer.state.cursor !== currentEvents.length) fail('session-busy', 'The session writer changed during editing.');
          const temp = path + '.' + randomUUID() + '.tmp';
          let created = false;
          try {
            const file = await open(temp, 'wx', info.mode & 0o777);
            created = true;
            try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
            await rename(temp, path);
            created = false;
            writer.state = { cursor: rewritten.length, materialized: true, inheritedEventCount: writer.inheritedEventCount };
            writer.observedLength = rewritten.length;
            writer.drainPaused = false;
            unwrap(persistence).coldLogMemo?.delete(id);
            if (live) commitMemory(live, prepared);
            revisions.set(id, (revisions.get(id) ?? 0) + 1);
            const session = live ?? detached;
            if (live) announceProjections(live, prepared.registry);
            const result = packSnapshot(session);
            for (const listener of listeners) { try { listener(result); } catch {} }
            return { updated: true, ...result };
          } finally {
            if (created) await unlink(temp);
          }
        });
      };
      return agent ? await Reflect.apply(maintenance, agent, [transaction]) : await transaction();
    } finally {
      try { if (ownedLease) await ownedLease.close(); } finally {
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
      listeners.clear();
      revisions.clear();
    })();
    return stopping;
  }

  if (typeof ctx.on === 'function') restores.push(ctx.on('agent/status', ({ agent, status }) => {
    if (stopped || status !== 'idle' || gates.has(agent.id) || !revisions.has(agent.id)) return;
    const value = packSnapshot(agent.session);
    for (const listener of listeners) { try { listener(value); } catch {} }
  }));

  return { describe, mutate, snapshot, subscribe(listener) { assertOpen(); listeners.add(listener); return () => listeners.delete(listener); }, dispose };
}
