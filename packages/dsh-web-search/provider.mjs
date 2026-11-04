export const ENDPOINTS = Object.freeze({
  tavily: 'https://api.tavily.com/search',
  brave: 'https://api.search.brave.com/res/v1/web/search',
});

export class SearchProviderError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'SearchProviderError';
    this.code = code;
    Object.assign(this, details);
  }
}

const localFailures = new WeakSet();
function failure(makeError, message, code, details = {}) {
  const error = Object.assign(makeError(message, code), details);
  localFailures.add(error);
  return error;
}

function aborted(makeError) {
  return failure(makeError, 'Web search was cancelled.', 'WEB_ABORTED');
}

function abortable(promise, signal, makeError) {
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(aborted(makeError));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(aborted(makeError));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function resultLimit(request, makeError) {
  if (typeof request?.query !== 'string' || request.query.trim().length === 0) {
    throw failure(makeError, 'Search query must be a non-empty string.', 'WEB_INVALID_REQUEST');
  }
  const requested = request.maxResults ?? 8;
  if (!Number.isInteger(requested) || requested < 0) {
    throw failure(makeError, 'maxResults must be a non-negative integer.', 'WEB_INVALID_REQUEST');
  }
  return Math.min(requested, 20);
}

function text(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function safeSourceURL(value) {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = new URL(value);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

export function mapResults(id, data, limit, makeError = (message, code) => new SearchProviderError(message, code)) {
  if (data === null || typeof data !== 'object' || Array.isArray(data) || data.error) {
    throw failure(makeError, id + ' returned an invalid search response.', 'WEB_INVALID_RESPONSE', { fallback: true });
  }
  let rows;
  if (id === 'tavily') {
    rows = data.results;
  } else {
    if (data.web === undefined && (data.type === 'search' || data.query !== undefined)) rows = [];
    else rows = data.web?.results;
  }
  if (!Array.isArray(rows)) {
    throw failure(makeError, id + ' returned an invalid search result list.', 'WEB_INVALID_RESPONSE', { fallback: true });
  }
  const sources = [];
  const seen = new Set();
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const url = safeSourceURL(row.url);
    if (url === undefined || seen.has(url)) continue;
    seen.add(url);
    const snippets = id === 'tavily' ? [row.content] : [row.description, ...(Array.isArray(row.extra_snippets) ? row.extra_snippets : [])];
    const snippet = [...new Set(snippets.filter(value => typeof value === 'string' && value.length > 0))].join('\n').slice(0, 6000);
    const title = text(row.title)?.slice(0, 1000);
    const publishedAt = text(id === 'tavily' ? row.published_date : row.page_age);
    sources.push({ url, ...(title ? { title } : {}), ...(snippet ? { snippet } : {}), ...(publishedAt ? { publishedAt } : {}) });
  }
  return { sources: sources.slice(0, limit), truncated: sources.length > limit };
}

async function readJSON(response, maxBytes, signal, makeError, id) {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw failure(makeError, id + ' response exceeded the byte limit.', 'WEB_RESPONSE_TOO_LARGE', { fallback: true });
  }
  if (!response.body) {
    throw failure(makeError, id + ' returned an empty response.', 'WEB_INVALID_RESPONSE', { fallback: true });
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal, makeError);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        throw failure(makeError, id + ' response exceeded the byte limit.', 'WEB_RESPONSE_TOO_LARGE', { fallback: true });
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw failure(makeError, id + ' returned malformed JSON.', 'WEB_INVALID_RESPONSE', { fallback: true });
  }
}

export class ApiSearchProvider {
  constructor(id, { resolveKey, options = () => ({}), fetchImpl = globalThis.fetch, makeError = (message, code) => new SearchProviderError(message, code) }) {
    if (!Object.hasOwn(ENDPOINTS, id)) throw new TypeError('Unsupported search provider');
    this.id = id;
    this.resolveKey = resolveKey;
    this.options = options;
    this.fetchImpl = fetchImpl;
    this.makeError = makeError;
  }

  available() { return this.options().enabled !== false; }

  async search(request, signal) {
    const makeError = this.makeError;
    if (signal?.aborted) throw aborted(makeError);
    if (!this.available()) throw failure(makeError, this.id + ' search is switched off in Plugins > Web Search.', 'WEB_PROVIDER_DISABLED');
    const limit = resultLimit(request, makeError);
    if (limit === 0) return { sources: [], truncated: false };
    const options = this.options();
    const timeoutMs = options.timeoutMs ?? 12000;
    const maxResponseBytes = options.maxResponseBytes ?? 2000000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 25000 || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 10000000) {
      throw failure(makeError, 'Invalid search timeout or response limit.', 'WEB_INVALID_CONFIG');
    }
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const id = this.id;
    try {
      const key = await abortable(Promise.resolve().then(() => this.resolveKey(options)), combined, makeError);
      if (typeof key !== 'string' || key.trim().length === 0) {
        const ref = options.apiKeyEnv ?? (id === 'tavily' ? 'TAVILY_API_KEY' : 'BRAVE_SEARCH_API_KEY');
        throw failure(makeError, id + ' API key is missing. Set ' + ref + ' in Plugins > Web Search.', 'WEB_CREDENTIAL_MISSING', { fallback: true });
      }
      if (combined.aborted) throw aborted(makeError);
      let url = ENDPOINTS[id];
      let init;
      if (id === 'tavily') {
        init = {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + key.trim(), 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ query: request.query, max_results: limit, search_depth: 'basic', include_answer: false, include_raw_content: false }),
        };
      } else {
        const params = new URLSearchParams({ q: request.query, count: String(limit), extra_snippets: 'true', text_decorations: 'false', result_filter: 'web' });
        url += '?' + params;
        init = { method: 'GET', headers: { 'X-Subscription-Token': key.trim(), 'Accept': 'application/json' } };
      }
      const response = await abortable(this.fetchImpl(url, { ...init, redirect: 'error', signal: combined }), combined, makeError);
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const status = response.status;
        throw failure(makeError, id + ' search failed (HTTP ' + status + '). Check the API key, plan and rate limits in Plugins > Web Search.', 'WEB_HTTP_ERROR', { status, fallback: [401, 402, 403, 408, 429].includes(status) || status >= 500 });
      }
      const data = await readJSON(response, maxResponseBytes, combined, makeError, id);
      if (combined.aborted) throw aborted(makeError);
      return mapResults(id, data, limit, makeError);
    } catch (error) {
      if (signal?.aborted) throw aborted(makeError);
      if (timeout.aborted) throw failure(makeError, id + ' search timed out.', 'WEB_TIMEOUT', { fallback: true });
      if (localFailures.has(error)) throw error;
      throw failure(makeError, id + ' search could not reach its API or resolve its credential.', 'WEB_PROVIDER_ERROR', { fallback: true });
    }
  }
}

export class FallbackSearchProvider {
  constructor(primary, fallback, makeError = (message, code) => new SearchProviderError(message, code)) {
    this.id = primary.id + '-' + fallback.id;
    this.providers = [primary, fallback];
    this.makeError = makeError;
  }
  available() { return this.providers.some(provider => provider.available()); }
  async search(request, signal) {
    if (signal?.aborted) throw aborted(this.makeError);
    if (!this.available()) throw failure(this.makeError, 'Tavily and Brave search are both switched off in Plugins > Web Search.', 'WEB_PROVIDER_DISABLED');
    const failures = [];
    for (const provider of this.providers) {
      if (!provider.available()) continue;
      if (signal?.aborted) throw aborted(this.makeError);
      try {
        return await provider.search(request, signal);
      } catch (error) {
        if (signal?.aborted || error?.code === 'WEB_ABORTED') throw aborted(this.makeError);
        if (!error?.fallback) throw error;
        failures.push({ provider: provider.id, error });
      }
    }
    if (failures.every(({ error }) => error.code === 'WEB_CREDENTIAL_MISSING')) {
      throw failure(this.makeError, 'No web search API key is configured. Set TAVILY_API_KEY and/or BRAVE_SEARCH_API_KEY in Plugins > Web Search.', 'WEB_CREDENTIAL_MISSING');
    }
    const summary = failures.map(({ provider, error }) => provider + ': ' + error.code + (Number.isInteger(error.status) ? ' (HTTP ' + error.status + ')' : '')).join('; ');
    throw failure(this.makeError, 'Tavily and Brave search are unavailable. ' + summary + '. Check keys, plans and rate limits in Plugins > Web Search.', 'WEB_PROVIDER_ERROR');
  }
}
