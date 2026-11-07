const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result']);

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function messageOf(event) {
  return event?.type === 'user/message' ? event.data : event?.data?.message;
}

export function textOfMessage(message) {
  return Array.isArray(message?.content)
    ? message.content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
    : '';
}

export function findMessage(events, messageId) {
  if (!Array.isArray(events)) return undefined;
  return events.find(event => event?.surfaceOp === 'append' &&
    (event.type === 'assistant/message' ||
      (event.type === 'user/message' && event.data?.source?.kind === 'user')) &&
    messageOf(event)?.id === messageId);
}

function assertNotCompacted(events, targets) {
  const affected = new Set(targets);
  const nodes = [];
  for (const event of events) {
    const op = SURFACE_TYPES.has(event.type) ? event.surfaceOp : undefined;
    let start = -1;
    let shadowed = [];
    if (op?.op === 'replace') {
      start = nodes.indexOf(op.startSeq);
      const end = nodes.indexOf(op.endSeq);
      if (start < 0 || end < start) fail('bad-request', 'Invalid session surface replacement.');
      shadowed = nodes.slice(start, end + 1);
    }
    const dependent = affected.has(event.seq) ||
      (Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : []).some(seq => affected.has(seq)) ||
      shadowed.some(seq => affected.has(seq));
    if (dependent) {
      if (messageOf(event)?.source?.kind === 'compact-checkpoint') {
        fail('compacted', 'This message is covered by a compaction checkpoint.');
      }
      affected.add(event.seq);
    }
    if (op === 'append') nodes.push(event.seq);
    else if (start >= 0) nodes.splice(start, shadowed.length, event.seq);
  }
}

function replaceText(message, text) {
  let inserted = false;
  message.content = message.content.flatMap(block => {
    if (block?.type !== 'text') return [block];
    if (inserted) return [];
    inserted = true;
    return [{ ...block, text }];
  });
  if (!inserted) message.content.unshift({ type: 'text', text });
}

function rewriteStream(event) {
  const stream = Array.isArray(event.data.stream) ? event.data.stream : [];
  const time = stream[0]?.time ?? stream[0]?.time0 ?? event.time;
  const records = event.data.message.content.flatMap((block, index) => [
    { type: 'chunk', time, chunk: { type: 'block-start', index, blockType: block.type } },
    { type: 'chunk', time, chunk: { type: 'block-end', index, block: structuredClone(block) } },
  ]);
  for (const record of stream) {
    if (record.type !== 'chunk') continue;
    if (record.chunk?.type === 'usage') records.push(record);
    if (record.chunk?.type === 'finish') {
      delete record.chunk.replayState;
      records.push(record);
    }
  }
  event.data.stream = records;
  if (event.data.message.source) delete event.data.message.source.replayState;
}

function erase(event) {
  event.type = 'plugin:session-tweak/deleted';
  event.data = {};
  event.ignorable = true;
  delete event.surfaceOp;
  delete event.sourceEventSeqs;
}

function eraseTargets(originals, events, targets) {
  const previous = [];
  const current = [];
  const changedSeqs = [];
  for (let index = 0; index < originals.length; index++) {
    const original = originals[index];
    const event = events[index];
    const op = SURFACE_TYPES.has(original.type) ? original.surfaceOp : undefined;
    let oldStart = -1;
    let shadowed = [];
    if (op?.op === 'replace') {
      oldStart = previous.indexOf(op.startSeq);
      const oldEnd = previous.indexOf(op.endSeq);
      if (oldStart < 0 || oldEnd < oldStart) fail('bad-request', 'Invalid session surface replacement.');
      shadowed = previous.slice(oldStart, oldEnd + 1);
    }
    const survivors = shadowed.filter(seq => current.includes(seq));
    let removed = targets.has(event.seq) || (oldStart >= 0 && survivors.length === 0);
    if (!removed && event.type === 'image/offload') {
      const retained = event.data.targets.filter(target => !targets.has(target.seq));
      if (!retained.length) removed = true;
      else if (retained.length !== event.data.targets.length) {
        event.data.targets = retained;
        changedSeqs.push(event.seq);
      }
    }
    if (removed) {
      erase(event);
      targets.add(event.seq);
      changedSeqs.push(event.seq);
    } else if (oldStart >= 0) {
      const start = current.indexOf(survivors[0]);
      event.surfaceOp = { op: 'replace', startSeq: survivors[0], endSeq: survivors.at(-1) };
      current.splice(start, survivors.length, event.seq);
      if (JSON.stringify(op) !== JSON.stringify(event.surfaceOp)) changedSeqs.push(event.seq);
    } else if (op === 'append') {
      current.push(event.seq);
    }
    if (op === 'append') previous.push(original.seq);
    else if (oldStart >= 0) previous.splice(oldStart, shadowed.length, original.seq);
  }
  return changedSeqs;
}

export function rewriteEvents(events, options) {
  if (!Array.isArray(events) || !options || typeof options !== 'object' ||
    typeof options.messageId !== 'string' || !options.messageId.trim() ||
    typeof options.expectedText !== 'string' ||
    !['edit', 'delete'].includes(options.operation)) {
    fail('bad-request', 'Invalid message rewrite request.');
  }
  const { messageId, expectedText, text, operation } = options;
  if (operation === 'edit') {
    if (typeof text !== 'string') fail('bad-request', 'Edited text must be a string.');
    if (Buffer.byteLength(text, 'utf8') > 65536) fail('text-too-large', 'Edited text exceeds 65536 UTF-8 bytes.');
    if (!text.trim()) fail('text-invalid', 'Edited text must not be blank.');
  }
  const original = findMessage(events, messageId);
  if (!original) fail('target-not-found', 'Original message was not found.');
  if (textOfMessage(messageOf(original)) !== expectedText) fail('stale', 'The original message text has changed.');
  const targets = new Set();
  const callIds = new Set();
  for (const event of events) {
    if (event.type !== original.type || messageOf(event)?.id !== messageId) continue;
    targets.add(event.seq);
    if (operation === 'delete' && event.type === 'assistant/message') {
      for (const block of messageOf(event).content) {
        if (block?.type === 'tool-call') callIds.add(block.id);
      }
    }
  }
  if (operation === 'delete' && callIds.size) {
    for (const event of events) {
      if ((event.type === 'tool/result' &&
        (callIds.has(event.data?.message?.toolCallId) || callIds.has(event.data?.message?.source?.callId))) ||
        (event.type === 'tool/call' && callIds.has(event.data?.callId)) ||
        ((event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch') && callIds.has(event.data?.rootCallId))) {
        targets.add(event.seq);
      }
    }
  }
  assertNotCompacted(events, targets);
  const clone = structuredClone(events);
  if (operation === 'delete') return { events: clone, changedSeqs: eraseTargets(events, clone, targets), messageId };
  const changedSeqs = [];
  for (const event of clone) {
    if (!targets.has(event.seq)) continue;
    replaceText(messageOf(event), text);
    if (event.type === 'assistant/message') rewriteStream(event);
    changedSeqs.push(event.seq);
  }
  return { events: clone, changedSeqs, messageId };
}
