import { createCoordinator } from './lifecycle.mjs';

export const name = 'session-tweak';
export const inject = ['agents', 'sessions', 'sessionPersistence', 'sessionProjectionCache', 'connection', 'webServer'];
const PREFIX = '/plugin-session-tweak';
const MAX_BODY = 262144;

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}

function failure(res, status, code, message) {
  reply(res, status, { ok: false, error: { code, message } });
}

async function bodyOf(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw Object.assign(new Error('JSON 요청이 필요합니다.'), { code: 'bad-request', status: 415 });
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('요청이 너무 큽니다.'), { code: 'text-too-large', status: 413 });
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('올바르지 않은 JSON입니다.'), { code: 'bad-request', status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('올바르지 않은 요청입니다.'), { code: 'bad-request', status: 400 });
  return body;
}

export function createHandler(ctx, coordinator) {
  return async (req, res) => {
    try {
      const connection = ctx.connection;
      if (typeof connection?.admit === 'function') {
        const admission = connection.admit(req);
        if ('rejection' in admission) return failure(res, admission.rejection, 'unauthorized', '인증이 필요합니다.');
        if (admission.peer?.principal?.kind !== 'owner') return failure(res, 403, 'unauthorized', '세션 소유자만 수정할 수 있습니다.');
      } else {
        const denied = typeof connection?.requestRejection === 'function' ? connection.requestRejection(req) : 503;
        if (denied !== undefined) return failure(res, Number.isInteger(denied) ? denied : 503, 'unauthorized', '인증이 필요합니다.');
      }
      const url = new URL(req.url, 'http://localhost');
      const method = req.method;
      if (url.pathname === PREFIX + '/message') {
        if (method !== 'GET') return failure(res, 405, 'bad-request', 'GET 요청이 필요합니다.');
        const value = await coordinator.describe(url.searchParams.get('session'), url.searchParams.get('message'));
        return reply(res, 200, { ok: true, value });
      }
      if (url.pathname === PREFIX + '/edit' || url.pathname === PREFIX + '/delete') {
        if (method !== 'POST') return failure(res, 405, 'bad-request', 'POST 요청이 필요합니다.');
        const body = await bodyOf(req);
        const value = await coordinator.mutate({ ...body, operation: url.pathname.endsWith('/edit') ? 'edit' : 'delete' });
        return reply(res, 200, { ok: true, value });
      }
      return failure(res, 404, 'not-found', '요청을 찾을 수 없습니다.');
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      failure(res, error.status || 200, error.code || 'internal', error.code ? error.message : '수정에 실패했습니다.');
      if (!error.code) ctx.logger?.warn?.(error);
    }
  };
}

export function apply(ctx) {
  ctx.effect(() => {
    const coordinator = createCoordinator(ctx);
    let unregister;
    try { unregister = ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler: createHandler(ctx, coordinator) }); }
    catch (error) { void coordinator.dispose(); throw error; }
    return async () => {
      unregister();
      await coordinator.dispose();
    };
  }, 'session-tweak: direct editing');
}
