import { TweakError, listState, editMessage, deleteMessage } from './core.mjs';

export const name = 'session-tweak';
export const inject = ['sessions', 'connection', 'webServer'];

const ROUTE = '/plugin-session-tweak';
const STATE_PATH = ROUTE + '/state';
const EDIT_PATH = ROUTE + '/edit';
const DELETE_PATH = ROUTE + '/delete';
const MAX_BODY_BYTES = 262144;
const MESSAGES = {
  'bad-request': '잘못된 요청입니다.',
  'not-found': '알 수 없는 요청입니다.',
  'unsupported-media-type': 'content-type은 application/json이어야 합니다.',
  'payload-too-large': '요청 본문이 너무 큽니다.',
  'session-not-found': '세션을 찾을 수 없습니다.',
  'session-busy': '진행 중인 턴이 끝난 뒤에 시도하세요.',
  'target-not-found': '대상 메시지를 찾을 수 없습니다. 새로고침 후 다시 시도하세요.',
  'not-editable': '이 메시지는 수정할 수 없습니다.',
  'not-deletable': '이 메시지는 삭제할 수 없습니다.',
  stale: '메시지가 이미 변경되었습니다. 새로고침 후 다시 시도하세요.',
  'text-invalid': '수정할 텍스트가 올바르지 않습니다.',
  'text-too-large': '텍스트가 너무 깁니다.',
  internal: '내부 오류가 발생했습니다.',
};

function errorBody(code, message) {
  return { ok: false, error: { code, message: typeof message === 'string' && message !== '' ? message : MESSAGES[code] || MESSAGES.internal } };
}

function setHeaders(res, headers) {
  if (!res || typeof res.setHeader !== 'function') return;
  for (const key of Object.keys(headers)) res.setHeader(key, headers[key]);
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  setHeaders(res, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function sendStatus(res, status, headers) {
  res.statusCode = status;
  setHeaders(res, { ...headers, 'cache-control': 'no-store' });
  res.end();
}

function serviceOf(ctx, key) {
  const direct = ctx ? ctx[key] : undefined;
  if (direct !== undefined && direct !== null) return direct;
  if (ctx && typeof ctx.get === 'function') return ctx.get(key);
  return undefined;
}

function rejectionOf(ctx, req) {
  let connection;
  try { connection = serviceOf(ctx, 'connection'); } catch { return 503; }
  if (!connection || typeof connection.requestRejection !== 'function') return 503;
  try {
    const status = connection.requestRejection(req);
    if (status === undefined) return undefined;
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
    return 503;
  } catch {
    return 503;
  }
}

function lookupSession(ctx, sessionId) {
  let sessions;
  try { sessions = serviceOf(ctx, 'sessions'); } catch { sessions = undefined; }
  if (!sessions || typeof sessions.get !== 'function') return { unavailable: true };
  if (typeof sessionId !== 'string' || sessionId === '') return { sessions, session: undefined };
  try {
    return { sessions, session: sessions.get(sessionId) };
  } catch {
    return { sessions, session: undefined };
  }
}

function mediaTypeOf(req) {
  const headers = req && req.headers ? req.headers : {};
  const raw = headers['content-type'];
  return typeof raw === 'string' ? raw.split(';')[0].trim().toLowerCase() : '';
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      if (typeof req.resume === 'function') req.resume();
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

async function handleState(ctx, url, res) {
  const sessionId = url.searchParams.get('session');
  if (typeof sessionId !== 'string' || sessionId === '') {
    sendJson(res, 200, errorBody('bad-request'));
    return;
  }
  const found = lookupSession(ctx, sessionId);
  if (found.unavailable) {
    sendStatus(res, 503);
    return;
  }
  if (!found.session) {
    sendJson(res, 200, errorBody('session-not-found'));
    return;
  }
  try {
    sendJson(res, 200, { ok: true, state: listState(found.session) });
  } catch {
    sendJson(res, 200, errorBody('internal'));
  }
}

async function handleMutation(ctx, operation, req, res) {
  if (mediaTypeOf(req) !== 'application/json') {
    sendJson(res, 415, errorBody('unsupported-media-type'));
    return;
  }
  const declared = Number(req && req.headers ? req.headers['content-length'] : undefined);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    sendJson(res, 413, errorBody('payload-too-large'));
    return;
  }
  let text;
  try {
    text = await readBody(req);
  } catch {
    sendJson(res, 400, errorBody('bad-request'));
    return;
  }
  if (text === null) {
    sendJson(res, 413, errorBody('payload-too-large'));
    return;
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    sendJson(res, 400, errorBody('bad-request'));
    return;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, errorBody('bad-request'));
    return;
  }
  const found = lookupSession(ctx, body.sessionId);
  if (found.unavailable) {
    sendStatus(res, 503);
    return;
  }
  if (!found.session) {
    sendJson(res, 200, errorBody('session-not-found'));
    return;
  }
  if (typeof found.sessions.flush !== 'function') {
    sendStatus(res, 503);
    return;
  }
  try {
    const value = operation === 'edit' ? editMessage(found.session, body) : deleteMessage(found.session, body);
    await found.sessions.flush(found.session);
    sendJson(res, 200, { ok: true, value });
  } catch (error) {
    if (error instanceof TweakError) sendJson(res, 200, errorBody(error.code, error.message));
    else sendJson(res, 200, errorBody('internal'));
  }
}

export function createHandler(ctx) {
  return async function handler(req, res) {
    const rejection = rejectionOf(ctx, req);
    if (rejection !== undefined) {
      sendStatus(res, rejection);
      return;
    }
    let url;
    try {
      url = new URL(req && typeof req.url === 'string' && req.url !== '' ? req.url : '/', 'http://localhost');
    } catch {
      sendJson(res, 400, errorBody('bad-request'));
      return;
    }
    const method = req && typeof req.method === 'string' ? req.method.toUpperCase() : '';
    if (url.pathname === STATE_PATH) {
      if (method !== 'GET') {
        sendStatus(res, 405, { allow: 'GET' });
        return;
      }
      await handleState(ctx, url, res);
      return;
    }
    if (url.pathname === EDIT_PATH || url.pathname === DELETE_PATH) {
      if (method !== 'POST') {
        sendStatus(res, 405, { allow: 'POST' });
        return;
      }
      await handleMutation(ctx, url.pathname === EDIT_PATH ? 'edit' : 'delete', req, res);
      return;
    }
    sendJson(res, 404, errorBody('not-found'));
  };
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: createHandler(ctx) }), 'session-tweak: routes');
}
