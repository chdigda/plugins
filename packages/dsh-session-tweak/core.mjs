import { randomUUID } from 'node:crypto';

const MAX_TEXT_BYTES = 65536;
const CAPABILITIES = Object.freeze({ editUser: true, editAssistant: false, deleteMessage: true });

export class TweakError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TweakError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new TweakError(code, message);
}

function eventsOf(session) {
  try {
    if (session && typeof session.snapshotEvents === 'function') {
      const events = session.snapshotEvents();
      if (Array.isArray(events)) return events;
    }
    if (session && Array.isArray(session.events)) return session.events;
  } catch {}
  return [];
}

function nodesOf(session) {
  let nodes;
  try { nodes = session && session.surface ? session.surface.nodes : undefined; } catch { nodes = undefined; }
  if (Array.isArray(nodes)) return nodes;
  if (nodes && typeof nodes[Symbol.iterator] === 'function') return Array.from(nodes);
  return [];
}

function contentOf(event) {
  if (!event || !event.data) return [];
  const message = event.type === 'user/message' ? event.data : event.data.message;
  return message && Array.isArray(message.content) ? message.content : [];
}

function textOf(event) {
  let text = '';
  for (const block of contentOf(event)) if (block && block.type === 'text' && typeof block.text === 'string') text += block.text;
  return text;
}

function toolCallCountOf(event) {
  let count = 0;
  for (const block of contentOf(event)) if (block && block.type === 'tool-call') count += 1;
  return count;
}

function messageIdOf(event) {
  if (!event || !event.data) return undefined;
  const id = event.type === 'user/message' ? event.data.id : event.type === 'assistant/message' && event.data.message ? event.data.message.id : undefined;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

function isUserOrigin(event) {
  return Boolean(event && event.type === 'user/message' && event.data && event.data.source && event.data.source.kind === 'user');
}

function currentSurfaceEvent(session, messageId) {
  const events = eventsOf(session);
  for (const seq of nodesOf(session)) {
    const event = events[seq];
    if (event && messageIdOf(event) === messageId) return event;
  }
  return undefined;
}

function lastTurnStart(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && event.type === 'turn/start') {
      const turn = event.data ? event.data.turn : undefined;
      return typeof turn === 'number' && Number.isFinite(turn) ? turn : null;
    }
  }
  return null;
}

export function isTurnOpen(session) {
  const events = eventsOf(session);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = events[index] ? events[index].type : undefined;
    if (type === 'turn/start') return true;
    if (type === 'turn/end') return false;
  }
  return false;
}

function shadowIndexOf(events) {
  const shadow = new Map();
  for (const event of events) {
    if (!event || !Array.isArray(event.sourceEventSeqs)) continue;
    for (const seq of event.sourceEventSeqs) shadow.set(seq, event);
  }
  return shadow;
}

function isEmptySystemMessage(event) {
  if (!event || event.type !== 'system/message' || !event.data || !event.data.message) return false;
  const content = event.data.message.content;
  return Array.isArray(content) && content.length === 0;
}

function isCompactionCheckpoint(event) {
  return Boolean(event && event.type === 'user/message' && event.data && event.data.source && event.data.source.kind === 'compact-checkpoint');
}

function shadowOutcome(shadow, event, messageId) {
  let current = event.seq;
  const visited = new Set();
  let text = textOf(event);
  while (!visited.has(current)) {
    visited.add(current);
    const next = shadow.get(current);
    if (next === undefined) return { kind: 'orphan', text };
    if (messageIdOf(next) === messageId) text = textOf(next);
    if (isEmptySystemMessage(next)) return { kind: 'removed', text };
    if (isCompactionCheckpoint(next)) return { kind: 'compaction', text };
    if (next.type === 'user/message') {
      current = next.seq;
      continue;
    }
    return { kind: 'other', text };
  }
  return { kind: 'other', text };
}

export function listState(session) {
  const events = eventsOf(session);
  const current = new Map();
  for (const seq of nodesOf(session)) {
    const event = events[seq];
    const messageId = messageIdOf(event);
    if (messageId !== undefined) current.set(messageId, event);
  }
  const shadow = shadowIndexOf(events);
  const messages = [];
  let compacted = 0;
  for (const event of events) {
    if (!event || event.surfaceOp !== 'append') continue;
    const role = isUserOrigin(event) ? 'user' : event.type === 'assistant/message' ? 'assistant' : undefined;
    if (role === undefined) continue;
    const messageId = messageIdOf(event);
    if (messageId === undefined) continue;
    const node = current.get(messageId);
    let seq = null;
    let text;
    let status;
    if (node !== undefined) {
      status = node.seq === event.seq ? 'active' : 'edited';
      text = textOf(node);
      seq = node.seq;
    } else {
      const outcome = shadowOutcome(shadow, event, messageId);
      if (outcome.kind === 'compaction') {
        compacted += 1;
        continue;
      }
      if (outcome.kind !== 'removed') continue;
      status = 'removed';
      text = outcome.text;
    }
    messages.push({
      messageId,
      seq,
      role,
      text,
      status,
      editable: role === 'user' && node !== undefined && isUserOrigin(node),
      deletable: status !== 'removed',
      toolCallCount: role === 'assistant' ? toolCallCountOf(node === undefined ? event : node) : 0,
      originalSeq: event.seq,
    });
  }
  return {
    sessionId: String(session.id),
    compacted,
    running: isTurnOpen(session),
    turn: lastTurnStart(events),
    capabilities: { ...CAPABILITIES },
    messages,
  };
}

function replaceTextBlock(content, text) {
  const next = [];
  let placed = false;
  for (const block of Array.isArray(content) ? content : []) {
    if (block && block.type === 'text') {
      if (!placed) {
        next.push({ type: 'text', text });
        placed = true;
      }
      continue;
    }
    next.push(block);
  }
  if (!placed) next.unshift({ type: 'text', text });
  return next;
}

export function editMessage(session, payload) {
  const body = payload !== null && typeof payload === 'object' ? payload : {};
  const text = body.text;
  if (typeof text !== 'string') fail('text-invalid', '수정할 텍스트가 필요합니다.');
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) fail('text-too-large', '텍스트가 너무 깁니다.');
  if (text.trim() === '') fail('text-invalid', '빈 텍스트로는 수정할 수 없습니다.');
  if (isTurnOpen(session)) fail('session-busy', '진행 중인 턴이 끝난 뒤에 수정할 수 있습니다.');
  const messageId = typeof body.messageId === 'string' && body.messageId !== '' ? body.messageId : undefined;
  if (messageId === undefined) fail('target-not-found', '수정할 메시지를 찾을 수 없습니다. 새로고침 후 다시 시도하세요.');
  const current = currentSurfaceEvent(session, messageId);
  if (current === undefined) fail('target-not-found', '수정할 메시지를 찾을 수 없습니다. 새로고침 후 다시 시도하세요.');
  if (!isUserOrigin(current)) fail('not-editable', '이 메시지는 수정할 수 없습니다.');
  if (current.seq !== body.seq) fail('stale', '메시지가 변경되었습니다. 새로고침 후 다시 시도하세요.');
  if (body.expectedText !== textOf(current)) fail('stale', '메시지가 변경되었습니다. 새로고침 후 다시 시도하세요.');
  const appended = session.append('user/message', {
    id: current.data.id,
    role: 'user',
    content: replaceTextBlock(current.data.content, text),
    source: current.data.source,
  }, {
    surfaceOp: { op: 'replace', startSeq: current.seq, endSeq: current.seq },
    sourceEventSeqs: [current.seq],
  });
  return { seq: appended.seq };
}

function removeSurfaceNode(session, seq) {
  session.append('system/message', {
    turn: 0,
    step: 0,
    message: { id: randomUUID(), role: 'system', content: [], source: { kind: 'system-prompt' } },
  }, {
    surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
    sourceEventSeqs: [seq],
  });
}

export function deleteMessage(session, payload) {
  const body = payload !== null && typeof payload === 'object' ? payload : {};
  if (isTurnOpen(session)) fail('session-busy', '진행 중인 턴이 끝난 뒤에 삭제할 수 있습니다.');
  const messageId = typeof body.messageId === 'string' && body.messageId !== '' ? body.messageId : undefined;
  if (messageId === undefined) fail('target-not-found', '삭제할 메시지를 찾을 수 없습니다. 새로고침 후 다시 시도하세요.');
  const current = currentSurfaceEvent(session, messageId);
  if (current === undefined) fail('target-not-found', '삭제할 메시지를 찾을 수 없습니다. 새로고침 후 다시 시도하세요.');
  if (!isUserOrigin(current) && current.type !== 'assistant/message') fail('not-deletable', '이 메시지는 삭제할 수 없습니다.');
  if (current.seq !== body.seq) fail('stale', '메시지가 변경되었습니다. 새로고침 후 다시 시도하세요.');
  const events = eventsOf(session);
  const nodes = nodesOf(session);
  if (nodes[0] === current.seq && events[current.seq] && events[current.seq].type === 'system/message') fail('not-deletable', '시스템 프롬프트는 삭제할 수 없습니다.');
  const removed = [current.seq];
  if (current.type === 'assistant/message') {
    const callIds = new Set();
    for (const block of contentOf(current)) if (block && block.type === 'tool-call' && typeof block.id === 'string' && block.id !== '') callIds.add(block.id);
    if (callIds.size > 0) {
      const position = nodes.indexOf(current.seq);
      for (let index = position + 1; index < nodes.length; index += 1) {
        const event = events[nodes[index]];
        if (!event || event.type !== 'tool/result') continue;
        const callId = event.data && event.data.message ? event.data.message.toolCallId : undefined;
        if (typeof callId === 'string' && callIds.has(callId)) removed.push(event.seq);
      }
    }
  }
  for (const seq of removed) removeSurfaceNode(session, seq);
  return { removed };
}
