import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiSearchProvider, FallbackSearchProvider, mapResults, SearchProviderError, ENDPOINTS } from './provider.mjs';

const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const tavilyData = { results: [{ url: 'https://example.com/a', title: 'A', content: 'one', published_date: '2026-10-01' }] };
const braveData = { type: 'search', web: { results: [{ url: 'https://example.com/b', title: 'B', description: 'two', extra_snippets: ['two', 'three'], page_age: '2026-10-02' }] } };
const provider = (id = 'tavily', extra = {}) => new ApiSearchProvider(id, { resolveKey: async () => 'TEST-SECRET', fetchImpl: async () => json(id === 'tavily' ? tavilyData : braveData), ...extra });
const error = (code, extra = {}) => new SearchProviderError('safe message', code, extra);
const rejectCode = code => err => err.code === code;

test('Tavily uses fixed official POST endpoint, bearer auth and bounded economical options', async () => {
  let seen;
  const result = await provider('tavily', { fetchImpl: async (url, init) => { seen = { url, init }; return json(tavilyData); } }).search({ query: '한국어? & more', maxResults: 80 });
  assert.equal(seen.url, ENDPOINTS.tavily);
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.Authorization, 'Bearer TEST-SECRET');
  assert.equal(seen.init.redirect, 'error');
  assert.ok(seen.init.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(seen.init.body), { query: '한국어? & more', max_results: 20, search_depth: 'basic', include_answer: false, include_raw_content: false });
  assert.deepEqual(result, { sources: [{ url: 'https://example.com/a', title: 'A', snippet: 'one', publishedAt: '2026-10-01' }], truncated: false });
});

test('Brave encodes query/count and authenticates only in X-Subscription-Token', async () => {
  let seen;
  const result = await provider('brave', { fetchImpl: async (url, init) => { seen = { url: new URL(url), init }; return json(braveData); } }).search({ query: '한국어? & more', maxResults: 3 });
  assert.equal(seen.url.origin + seen.url.pathname, ENDPOINTS.brave);
  assert.equal(seen.url.searchParams.get('q'), '한국어? & more');
  assert.equal(seen.url.searchParams.get('count'), '3');
  assert.equal(seen.url.searchParams.get('extra_snippets'), 'true');
  assert.equal(seen.url.searchParams.get('text_decorations'), 'false');
  assert.equal(seen.init.headers['X-Subscription-Token'], 'TEST-SECRET');
  assert.equal(seen.init.redirect, 'error');
  assert.ok(!seen.url.href.includes('TEST-SECRET'));
  assert.equal(result.sources[0].snippet, 'two\nthree'.replace('\\n', '\n'));
  assert.equal(result.sources[0].publishedAt, '2026-10-02');
});

test('normalization skips unsafe/malformed URLs, deduplicates and caps sources', () => {
  const data = { results: [null, {}, { url: 'javascript:alert(1)' }, { url: 'https://user:pass@example.com/' }, { url: 'https://example.com/a' }, { url: 'https://example.com/a', title: 'duplicate' }, { url: 'https://example.com/b', title: 42 }, { url: 'https://example.com/c' }] };
  assert.deepEqual(mapResults('tavily', data, 1), { sources: [{ url: 'https://example.com/a' }], truncated: true });
});

test('empty results are valid and Brave may omit web section for zero hits', () => {
  assert.deepEqual(mapResults('tavily', { results: [] }, 8), { sources: [], truncated: false });
  assert.deepEqual(mapResults('brave', { type: 'search', query: { original: 'none' } }, 8), { sources: [], truncated: false });
});

for (const data of [null, [], {}, { results: 'wrong' }, { error: 'TEST-SECRET', results: [] }]) {
  test('malformed Tavily payload fails without echoing data: ' + JSON.stringify(data), () => {
    assert.throws(() => mapResults('tavily', data, 8), err => err.code === 'WEB_INVALID_RESPONSE' && !err.message.includes('TEST-SECRET'));
  });
}

test('source title and snippets have output bounds', () => {
  const result = mapResults('brave', { web: { results: [{ url: 'https://example.com/', title: 'x'.repeat(2000), description: 'y'.repeat(10000) }] } }, 8);
  assert.equal(result.sources[0].title.length, 1000);
  assert.equal(result.sources[0].snippet.length, 6000);
});

for (const request of [{ query: '' }, { query: ' ' }, {}, { query: 'q', maxResults: -1 }, { query: 'q', maxResults: 1.5 }]) {
  test('invalid request never resolves credentials or sends network: ' + JSON.stringify(request), async () => {
    let calls = 0;
    await assert.rejects(provider('tavily', { resolveKey: async () => { calls++; } }).search(request), rejectCode('WEB_INVALID_REQUEST'));
    assert.equal(calls, 0);
  });
}

test('zero results makes no paid request', async () => {
  let calls = 0;
  assert.deepEqual(await provider('tavily', { resolveKey: async () => { calls++; } }).search({ query: 'q', maxResults: 0 }), { sources: [], truncated: false });
  assert.equal(calls, 0);
});

test('missing key is actionable and sends no network request', async () => {
  let calls = 0;
  await assert.rejects(provider('tavily', { resolveKey: async () => undefined, fetchImpl: async () => { calls++; } }).search({ query: 'q' }), err => err.code === 'WEB_CREDENTIAL_MISSING' && err.message.includes('TAVILY_API_KEY'));
  assert.equal(calls, 0);
});

test('credentials and options rotate per operation and snapshot together', async () => {
  let ref = 'ONE', timeoutMs = 12000;
  const refs = [], keys = [];
  const p = provider('tavily', { options: () => ({ apiKeyEnv: ref, timeoutMs }), resolveKey: async options => { refs.push(options.apiKeyEnv); return options.apiKeyEnv; }, fetchImpl: async (_, init) => { keys.push(init.headers.Authorization); return json(tavilyData); } });
  await p.search({ query: 'q' }); ref = 'TWO'; timeoutMs = 1000;
  await p.search({ query: 'q' });
  assert.deepEqual(refs, ['ONE', 'TWO']);
  assert.deepEqual(keys, ['Bearer ONE', 'Bearer TWO']);
});

for (const status of [400, 401, 402, 403, 429, 500, 503]) {
  test('HTTP ' + status + ' is sanitized and classified for fallback', async () => {
    await assert.rejects(provider('tavily', { fetchImpl: async () => new Response('TEST-SECRET upstream body', { status }) }).search({ query: 'q' }), err => err.code === 'WEB_HTTP_ERROR' && err.status === status && err.fallback === (status !== 400) && !err.message.includes('TEST-SECRET'));
  });
}

test('network and credential resolver errors never leak raw exceptions', async () => {
  for (const extra of [{ resolveKey: async () => { throw new Error('TEST-SECRET'); } }, { fetchImpl: async () => { throw new Error('TEST-SECRET'); } }]) {
    await assert.rejects(provider('tavily', extra).search({ query: 'q' }), err => err.code === 'WEB_PROVIDER_ERROR' && !String(err.stack).includes('TEST-SECRET') && err.cause === undefined);
  }
});

test('malformed JSON is sanitized', async () => {
  await assert.rejects(provider('tavily', { fetchImpl: async () => new Response('TEST-SECRET{') }).search({ query: 'q' }), err => err.code === 'WEB_INVALID_RESPONSE' && !err.message.includes('TEST-SECRET'));
});

test('declared and streamed byte limits are enforced', async () => {
  for (const headers of [{ 'content-length': '999' }, {}]) {
    await assert.rejects(provider('tavily', { options: () => ({ maxResponseBytes: 5 }), fetchImpl: async () => new Response('123456789', { headers }) }).search({ query: 'q' }), rejectCode('WEB_RESPONSE_TOO_LARGE'));
  }
});

test('already aborted call does not resolve key or start fetch', async () => {
  let calls = 0;
  await assert.rejects(provider('tavily', { resolveKey: async () => { calls++; } }).search({ query: 'q' }, AbortSignal.abort()), rejectCode('WEB_ABORTED'));
  assert.equal(calls, 0);
});

test('abort during credential resolution settles without starting network', async () => {
  const controller = new AbortController();
  let calls = 0, finish;
  const p = provider('tavily', { resolveKey: () => new Promise(resolve => { finish = resolve; }), fetchImpl: async () => { calls++; } });
  const result = p.search({ query: 'q' }, controller.signal);
  await delay(1); controller.abort();
  await assert.rejects(result, rejectCode('WEB_ABORTED'));
  finish('late-secret');
  assert.equal(calls, 0);
});

test('abort during fetch is forwarded and observed even by an uncooperative fetch', async () => {
  const controller = new AbortController();
  let received;
  const p = provider('tavily', { fetchImpl: async (_, init) => { received = init.signal; return new Promise(() => {}); } });
  const result = p.search({ query: 'q' }, controller.signal);
  await delay(1); controller.abort();
  await assert.rejects(result, rejectCode('WEB_ABORTED'));
  assert.equal(received.aborted, true);
});

test('timeout includes credential preflight and network, enabling fallback', async () => {
  for (const extra of [{ resolveKey: () => new Promise(() => {}) }, { fetchImpl: () => new Promise(() => {}) }]) {
    // Keep event loop alive: AbortSignal.timeout intentionally uses an unref timer.
    const keepAlive = setTimeout(() => {}, 1000);
    try { await assert.rejects(provider('tavily', { options: () => ({ timeoutMs: 5 }), ...extra }).search({ query: 'q' }), err => err.code === 'WEB_TIMEOUT' && err.fallback); }
    finally { clearTimeout(keepAlive); }
  }
});

test('router returns Tavily success without calling or charging Brave', async () => {
  let calls = 0;
  const result = await new FallbackSearchProvider(provider(), { id: 'brave', available: () => true, search: async () => { calls++; } }).search({ query: 'q' });
  assert.equal(result.sources[0].url, 'https://example.com/a');
  assert.equal(calls, 0);
});

test('router falls back in either configured order', async () => {
  for (const [primary, backup, url] of [['tavily', 'brave', 'https://example.com/b'], ['brave', 'tavily', 'https://example.com/a']]) {
    const router = new FallbackSearchProvider(provider(primary, { resolveKey: async () => undefined }), provider(backup));
    assert.equal(router.id, primary + '-' + backup);
    assert.equal((await router.search({ query: 'q' })).sources[0].url, url);
  }
});

test('router uses Brave on quota, auth, transient or malformed primary response', async () => {
  for (const fetchImpl of [async () => new Response('', { status: 429 }), async () => new Response('', { status: 401 }), async () => new Response('', { status: 503 }), async () => new Response('not json')]) {
    const result = await new FallbackSearchProvider(provider('tavily', { fetchImpl }), provider('brave')).search({ query: 'q' });
    assert.equal(result.sources[0].url, 'https://example.com/b');
  }
});

test('router does not fallback on empty results or invalid input', async () => {
  let calls = 0;
  const backup = { id: 'brave', available: () => true, search: async () => { calls++; } };
  const router = new FallbackSearchProvider(provider('tavily', { fetchImpl: async () => json({ results: [] }) }), backup);
  assert.deepEqual(await router.search({ query: 'q' }), { sources: [], truncated: false });
  await assert.rejects(router.search({ query: '' }), rejectCode('WEB_INVALID_REQUEST'));
  assert.equal(calls, 0);
});

test('router never falls back on cancellation or HTTP 400', async () => {
  let calls = 0;
  const backup = { id: 'brave', available: () => true, search: async () => { calls++; } };
  for (const first of [{ id: 'tavily', available: () => true, search: async () => { throw error('WEB_ABORTED'); } }, provider('tavily', { fetchImpl: async () => new Response('', { status: 400 }) })]) {
    await assert.rejects(new FallbackSearchProvider(first, backup).search({ query: 'q' }));
  }
  assert.equal(calls, 0);
});

test('no keys produces one actionable error without trying other vendors', async () => {
  const router = new FallbackSearchProvider(provider('tavily', { resolveKey: async () => undefined }), provider('brave', { resolveKey: async () => undefined }));
  await assert.rejects(router.search({ query: 'q' }), err => err.code === 'WEB_CREDENTIAL_MISSING' && err.message.includes('TAVILY_API_KEY') && err.message.includes('BRAVE_SEARCH_API_KEY'));
});

test('combined failure summary exposes only provider/status/code', async () => {
  const router = new FallbackSearchProvider(provider('tavily', { fetchImpl: async () => new Response('TEST-SECRET', { status: 429 }) }), provider('brave', { fetchImpl: async () => { throw new Error('TEST-SECRET'); } }));
  await assert.rejects(router.search({ query: 'q' }), err => err.code === 'WEB_PROVIDER_ERROR' && err.message.includes('HTTP 429') && !err.message.includes('TEST-SECRET'));
});

test('disabled providers are excluded from direct and fallback calls', async () => {
  let enabled = false, calls = 0;
  const tavily = provider('tavily', { options: () => ({ enabled }), resolveKey: async () => { calls++; return 'TEST'; } });
  const brave = provider('brave');
  const router = new FallbackSearchProvider(tavily, brave);
  assert.equal((await router.search({ query: 'q' })).sources[0].url, 'https://example.com/b');
  assert.equal(calls, 0);
  await assert.rejects(tavily.search({ query: 'q' }), rejectCode('WEB_PROVIDER_DISABLED'));
  brave.options = () => ({ enabled: false });
  assert.equal(router.available(), false);
  await assert.rejects(router.search({ query: 'q' }), rejectCode('WEB_PROVIDER_DISABLED'));
  enabled = true;
  assert.equal(router.available(), true);
});
