import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';

// Portable packages need no private runtime dependency install. An explicitly supplied
// runtime must work: bad paths/imports are failures, never silently skipped. Do not
// import the CLI itself: it boots profiles and can write persistent user state.
const runtimeEntry = process.env.DSH_RUNTIME_ENTRY;

test('native DSH service, credential, lifecycle and bundle integration', {
  skip: runtimeEntry ? false : 'Set DSH_RUNTIME_ENTRY to an installed DSH CLI entry to run native integration tests.',
  timeout: 15000,
}, async t => {
  const runtimeRequire = createRequire(runtimeEntry);
  const native = async name => import(pathToFileURL(runtimeRequire.resolve(name)).href);
  // Load the plugin first, so its runtime resolver is exercised, including the
  // shared ESM Schemastery entry (not the alternate CJS schema implementation).
  const plugin = await import('./index.mjs');
  const { Context } = await native('@deepseek-ai/cordis');
  // FiberState is a TypeScript const enum, not an exported JS runtime object.
  const FiberState = { PENDING: 0, ACTIVE: 2 };
  const { WebRuntime, WebError } = await native('@deepseek-ai/dsh-web');
  const { CredentialProvider } = await native('@deepseek-ai/dsh-credentials');
  const { createLaunchEnvironmentSnapshot } = await native('@deepseek-ai/dsh-launch-environment');
  const { Loader } = await native('@deepseek-ai/cordis-plugin-loader');
  const { updateVolatile } = await native('@deepseek-ai/cosmokit');
  const http = await native('@deepseek-ai/dsh-web-fetch-http');
  const { applyEntryPatches, entryListSchema } = await native('@deepseek-ai/cordis-plugin-include');
  const yaml = runtimeRequire('js-yaml');
  const query = { query: 'integration 한국어 & ?', maxResults: 2 };
  const response = id => new Response(JSON.stringify(id === 'tavily'
    ? { results: [{ url: 'https://example.com/tavily', title: 'Tavily', content: 'Tavily snippet' }] }
    : { type: 'search', web: { results: [{ url: 'https://example.com/brave', title: 'Brave', description: 'Brave snippet' }] } }), { headers: { 'content-type': 'application/json' } });
  const matchesError = code => error => {
    assert.ok(error instanceof WebError, 'must use the active DSH WebError class');
    assert.equal(error.code, code);
    return true;
  };

  async function mount(t, { searchProvider = 'tavily-brave', config = {}, keys = {}, withCredentials = true, viaLoader = false, environment = {} } = {}) {
    const ctx = new Context();
    t.after(() => ctx.fiber.dispose());
    // A snapshot made only from synthetic values prevents accidental reads of the
    // developer's process environment, profiles, credential stores or .env files.
    ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: environment }]));
    const requests = [], refs = [], values = new Map(Object.entries(keys));
    let resolve = async ref => values.has(ref) ? { value: values.get(ref), source: 'integration-memory' } : undefined;
    let reply = id => response(id);
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      const parsed = new URL(url);
      const id = parsed.origin === 'https://api.tavily.com' && parsed.pathname === '/search' ? 'tavily'
        : parsed.origin === 'https://api.search.brave.com' && parsed.pathname === '/res/v1/web/search' ? 'brave' : undefined;
      assert.ok(id, 'provider must use only a fixed official endpoint');
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal instanceof AbortSignal);
      requests.push({ id, url: parsed, init });
      return reply(id, parsed, init);
    });
    class MemoryCredentials extends CredentialProvider {
      async resolve(ref) {
        refs.push(ref);
        return resolve(ref);
      }
    }
    let credentialFiber;
    async function addCredentials() {
      credentialFiber = ctx.plugin(MemoryCredentials);
      await credentialFiber.await();
      return credentialFiber;
    }
    if (withCredentials) await addCredentials();
    const webFiber = ctx.plugin(WebRuntime, { ...(searchProvider === null ? {} : { searchProvider }), fetchProvider: 'http' });
    await webFiber.await();
    const httpFiber = ctx.plugin(http, { timeoutMs: 1000 });
    await httpFiber.await();
    let searchFiber, entry;
    if (viaLoader) {
      const loaderFiber = ctx.plugin(Loader);
      await loaderFiber.await();
      ctx.loader.builtins.integrationSearch = plugin;
      const id = await ctx.loader.create({ name: 'cordis:integrationSearch', config });
      await ctx.loader.await();
      entry = ctx.loader.resolve(id);
      searchFiber = entry.fiber;
    } else {
      searchFiber = ctx.plugin(plugin, config);
    }
    await searchFiber.await();
    assert.equal(searchFiber.state, FiberState.ACTIVE);
    return {
      ctx, webFiber, httpFiber, searchFiber, entry, requests, refs, values, addCredentials,
      get credentialFiber() { return credentialFiber; },
      setResolver(value) { resolve = value; },
      setReply(value) { reply = value; },
      select(id) {
        const next = WebRuntime.Config(id === undefined ? {} : { searchProvider: id });
        updateVolatile(webFiber.config.searchProvider, next.searchProvider);
        // Explicit configuration always wins over process-level provider overrides.
        ctx.web.searchProviderEnv = undefined;
      },
    };
  }

  await t.test('native schema produces credential refs and immutable volatile defaults, and rejects unsafe limits', () => {
    const config = plugin.Config({});
    assert.equal(plugin.name, 'web-search');
    assert.deepEqual(plugin.inject, ['web']);
    const expected = { tavilyApiKeyEnv: 'TAVILY_API_KEY', braveApiKeyEnv: 'BRAVE_SEARCH_API_KEY', timeoutMs: 12000, maxResponseBytes: 2000000 };
    for (const [name, value] of Object.entries(expected)) {
      assert.equal(config[name].get(), value);
      assert.ok(Object.isFrozen(config[name]));
      assert.equal(plugin.Config.dict[name].meta.volatile, true);
    }
    for (const name of ['tavilyApiKeyEnv', 'braveApiKeyEnv']) assert.equal(plugin.Config.dict[name].meta.role, 'credential-ref');
    for (const config of [{ timeoutMs: 499 }, { timeoutMs: 25001 }, { timeoutMs: 500.5 }, { timeoutMs: Infinity }, { timeoutMs: '1000' }, { maxResponseBytes: 1023 }, { maxResponseBytes: 10000001 }, { maxResponseBytes: 1024.5 }]) {
      const result = plugin.Config['~standard'].validate(config);
      assert.ok(result.issues?.length, 'native standard-schema validation must reject ' + JSON.stringify(config));
    }
    assert.equal(plugin.Config({ timeoutMs: 500, maxResponseBytes: 1024 }).timeoutMs.get(), 500);
    assert.equal(plugin.Config({ timeoutMs: 25000, maxResponseBytes: 10000000 }).maxResponseBytes.get(), 10000000);
  });

  await t.test('ctx.plugin waits for web, registrations belong to the fiber, and disable/re-enable preserves native HTTP fetch', async t => {
    const ctx = new Context();
    t.after(() => ctx.fiber.dispose());
    const search = ctx.plugin(plugin, {});
    await search.await();
    assert.equal(search.state, FiberState.PENDING);
    const web = ctx.plugin(WebRuntime, { searchProvider: 'tavily-brave', fetchProvider: 'http' });
    await web.await();
    await search.await();
    const fetch = ctx.plugin(http, { timeoutMs: 1000 });
    await fetch.await();
    assert.equal(search.state, FiberState.ACTIVE);
    assert.deepEqual([...ctx.web.searchProviders.keys()].sort(), ['brave', 'brave-tavily', 'tavily', 'tavily-brave']);
    const preservedHttp = ctx.web.fetchProviders.get('http');
    assert.ok(preservedHttp instanceof http.HttpFetchProvider);
    await search.dispose();
    assert.equal(ctx.web.searchProviders.size, 0);
    assert.equal(ctx.web.fetchProviders.get('http'), preservedHttp);
    await assert.rejects(ctx.web.search(query), matchesError('WEB_PROVIDER_CONFIGURED_MISSING'));
    const replacement = ctx.plugin(plugin, {});
    await replacement.await();
    assert.equal(ctx.web.searchProviders.size, 4);
    await web.dispose();
    await replacement.await();
    assert.equal(replacement.state, FiberState.PENDING);
    const newWeb = ctx.plugin(WebRuntime, { searchProvider: 'tavily-brave', fetchProvider: 'http' });
    await newWeb.await();
    await replacement.await();
    await fetch.await();
    assert.equal(replacement.state, FiberState.ACTIVE);
    assert.deepEqual([...ctx.web.searchProviders.keys()].sort(), ['brave', 'brave-tavily', 'tavily', 'tavily-brave']);
    assert.ok(ctx.web.fetchProviders.get('http') instanceof http.HttpFetchProvider);
    await replacement.restart();
    assert.equal(ctx.web.searchProviders.size, 4, 'restart must not leak duplicate registrations');
  });

  await t.test('native registry selects explicit IDs, rejects ambiguity/duplicates, and router charges only the used provider', async t => {
    const h = await mount(t, { keys: { TAVILY_API_KEY: 'synthetic-tavily', BRAVE_SEARCH_API_KEY: 'synthetic-brave' } });
    for (const [selected, expected] of [['tavily-brave', 'tavily'], ['brave-tavily', 'brave'], ['brave', 'brave'], ['tavily', 'tavily']]) {
      h.select(selected);
      const before = h.requests.length;
      const result = await h.ctx.web.search(query);
      assert.equal(result.sources[0].url, 'https://example.com/' + expected);
      assert.equal(h.requests.length, before + 1);
      assert.equal(h.requests.at(-1).id, expected);
    }
    h.select(undefined);
    await assert.rejects(h.ctx.web.search(query), matchesError('WEB_PROVIDER_AMBIGUOUS'));
    h.select('not-registered');
    await assert.rejects(h.ctx.web.search(query), matchesError('WEB_PROVIDER_CONFIGURED_MISSING'));
    assert.throws(() => h.ctx.web.registerSearchProvider({ id: 'tavily', available: () => true }), matchesError('WEB_DUPLICATE_PROVIDER'));
    h.select('tavily-brave');
    h.values.delete('TAVILY_API_KEY');
    const before = h.requests.length;
    assert.equal((await h.ctx.web.search(query)).sources[0].title, 'Brave');
    assert.equal(h.requests.length, before + 1, 'a missing primary key must not send a primary request');
    assert.equal(h.requests.at(-1).id, 'brave');
    h.values.set('TAVILY_API_KEY', 'synthetic-tavily');
    h.setReply(id => id === 'tavily' ? new Response('synthetic-secret must not escape', { status: 429 }) : response(id));
    const start = h.requests.length;
    assert.equal((await h.ctx.web.search(query)).sources[0].title, 'Brave');
    assert.deepEqual(h.requests.slice(start).map(request => request.id), ['tavily', 'brave']);
  });

  await t.test('native credentials resolve on every operation and native Loader commits volatile references without remounting', async t => {
    const h = await mount(t, { viaLoader: true, keys: { TAVILY_API_KEY: 'synthetic-one', BRAVE_SEARCH_API_KEY: 'synthetic-brave', ROTATED_TAVILY: 'synthetic-three', ROTATED_BRAVE: 'synthetic-four' } });
    const provider = h.ctx.web.searchProviders.get('tavily');
    const oldFiber = h.entry.fiber;
    const oldBox = oldFiber.config.tavilyApiKeyEnv;
    await h.ctx.web.search(query);
    h.values.set('TAVILY_API_KEY', 'synthetic-two');
    await h.ctx.web.search(query);
    assert.deepEqual(h.requests.map(request => request.init.headers.Authorization), ['Bearer synthetic-one', 'Bearer synthetic-two']);
    await h.entry.update({ config: { tavilyApiKeyEnv: 'ROTATED_TAVILY', braveApiKeyEnv: 'ROTATED_BRAVE', timeoutMs: 500, maxResponseBytes: 1024 } });
    await h.entry.fiber.await();
    assert.equal(h.entry.fiber, oldFiber);
    assert.equal(h.entry.fiber.config.tavilyApiKeyEnv, oldBox);
    assert.equal(h.ctx.web.searchProviders.get('tavily'), provider);
    assert.equal(oldBox.get(), 'ROTATED_TAVILY');
    assert.equal(oldFiber.config.timeoutMs.get(), 500);
    assert.equal(oldFiber.config.maxResponseBytes.get(), 1024);
    await h.ctx.web.search(query);
    h.select('brave');
    await h.ctx.web.search(query);
    assert.deepEqual(h.refs, ['TAVILY_API_KEY', 'TAVILY_API_KEY', 'ROTATED_TAVILY', 'ROTATED_BRAVE']);
    assert.equal(h.requests[2].init.headers.Authorization, 'Bearer synthetic-three');
    assert.equal(h.requests[3].init.headers['X-Subscription-Token'], 'synthetic-four');
    for (const request of h.requests) {
      assert.ok(!request.url.href.includes('synthetic-'));
      assert.ok(!String(request.init.body).includes('synthetic-'));
    }
    assert.ok(!inspect(oldFiber.config).includes('synthetic-'));
    assert.ok(!JSON.stringify(h.entry.options).includes('synthetic-'), 'serialized native config contains references, never resolved secrets');
  });

  await t.test('optional credential service is discovered per call and missing service alone enables launch-snapshot fallback', async t => {
    const h = await mount(t, { searchProvider: 'tavily', withCredentials: false, environment: { TAVILY_API_KEY: 'synthetic-launch-only' }, keys: { TAVILY_API_KEY: 'synthetic-store-only' } });
    const provider = h.ctx.web.searchProviders.get('tavily');
    await h.ctx.web.search(query);
    assert.equal(h.requests.at(-1).init.headers.Authorization, 'Bearer synthetic-launch-only');
    await h.addCredentials();
    await h.ctx.web.search(query);
    assert.equal(h.requests.at(-1).init.headers.Authorization, 'Bearer synthetic-store-only');
    h.values.clear();
    const before = h.requests.length;
    await assert.rejects(h.ctx.web.search(query), matchesError('WEB_CREDENTIAL_MISSING'));
    assert.equal(h.requests.length, before, 'do not bypass an installed credential service with ambient environment values');
    await h.credentialFiber.dispose();
    await h.ctx.web.search(query);
    assert.equal(h.requests.at(-1).init.headers.Authorization, 'Bearer synthetic-launch-only');
    assert.equal(h.ctx.web.searchProviders.get('tavily'), provider, 'optional credential service changes must not remount search');
  });

  await t.test('all provider failure paths use native WebError and redact upstream/credential failures', async t => {
    const secret = 'synthetic-SECRET-DO-NOT-LEAK';
    const h = await mount(t, { searchProvider: 'tavily', keys: { TAVILY_API_KEY: secret } });
    async function rejects(code, operation = () => h.ctx.web.search(query)) {
      await assert.rejects(operation(), error => {
        matchesError(code)(error);
        assert.ok(!inspect(error, { depth: 10 }).includes(secret));
        assert.equal(error.cause, undefined);
        return true;
      });
    }
    h.setResolver(async () => { throw new Error(secret); });
    await rejects('WEB_PROVIDER_ERROR');
    h.setResolver(async () => ({ value: secret }));
    h.setReply(() => { throw Object.assign(new Error(secret), { code: 'WEB_HTTP_ERROR', status: 401 }); });
    await rejects('WEB_PROVIDER_ERROR');
    h.setReply(() => new Response(secret, { status: 401 }));
    await rejects('WEB_HTTP_ERROR');
    h.setReply(() => new Response(secret + '{'));
    await rejects('WEB_INVALID_RESPONSE');
    const before = h.requests.length;
    await rejects('WEB_INVALID_REQUEST', () => h.ctx.web.search({ query: ' ' }));
    await rejects('WEB_ABORTED', () => h.ctx.web.search(query, AbortSignal.abort()));
    assert.deepEqual(await h.ctx.web.search({ ...query, maxResults: 0 }), { sources: [], truncated: false });
    assert.equal(h.requests.length, before);
    h.setResolver(async () => undefined);
    h.select('tavily-brave');
    await rejects('WEB_CREDENTIAL_MISSING');
  });

  await t.test('shipped base and web bundle composition disables old search/UI rows but preserves HTTP and all unrelated rows', async () => {
    const loadYaml = async path => yaml.load(await readFile(path, 'utf8'), { schema: entryListSchema });
    let shipped = [];
    for (const name of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']) {
      const manifestPath = runtimeRequire.resolve(name + '/package.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      const paths = manifest.dsh.bundle.patch;
      for (const path of Array.isArray(paths) ? paths : [paths]) {
        shipped = applyEntryPatches(shipped, await loadYaml(new URL(path, pathToFileURL(manifestPath))), () => {});
      }
    }
    const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
    assert.equal(manifest.name, 'dsh-web-search');
    assert.equal(manifest.exports['.'], './index.mjs');
    assert.equal(manifest.exports['./client'], './client-bundle.mjs');
    assert.equal(manifest.dsh.client.platform, 'web');
    const patch = await loadYaml(new URL(manifest.dsh.bundle.patch, new URL('./package.json', import.meta.url)));
    const original = structuredClone(shipped), warnings = [];
    const composed = applyEntryPatches(shipped, patch, (...args) => warnings.push(args));
    assert.deepEqual(warnings, [], 'every bundle override must target a real shipped row');
    assert.deepEqual(shipped, original, 'native patch application must not mutate shipped cached entries');
    const flatten = entries => entries.flatMap(entry => [entry, ...(entry.group && Array.isArray(entry.config) ? flatten(entry.config) : [])]);
    const before = new Map(flatten(shipped).map(entry => [entry.id, entry]));
    const after = new Map(flatten(composed).map(entry => [entry.id, entry]));
    assert.deepEqual(after.get('web').config, { searchProvider: 'tavily-brave', fetchProvider: 'http' });
    const changed = new Set(['web', 'web-search-deepseek', 'web-deepseek-api', 'ui-settings-web-search']);
    for (const id of ['web-search-deepseek', 'web-deepseek-api', 'ui-settings-web-search']) {
      assert.equal(after.get(id).disabled, true);
      assert.deepEqual(after.get(id), { ...before.get(id), disabled: true }, 'preserve the original disabled implementation and its configuration');
    }
    assert.deepEqual(after.get('web-fetch-http'), before.get('web-fetch-http'));
    assert.notEqual(after.get('web-fetch-http').disabled, true);
    assert.equal(after.get('web-search').name, manifest.name);
    assert.equal(flatten(composed).filter(entry => entry.id === 'web-search').length, 1);
    for (const [id, entry] of before) {
      if (!changed.has(id) && !entry.group) assert.deepEqual(after.get(id), entry, 'unrelated row changed: ' + id);
    }
  });

  await t.test('actual native HttpFetchProvider still blocks loopback/private SSRF without DNS, external traffic or a listening server', async t => {
    const h = await mount(t);
    const provider = h.ctx.web.fetchProviders.get('http');
    assert.ok(provider instanceof http.HttpFetchProvider);
    // IPv4 literals take the native pre-network path. IPv6 is deliberately omitted:
    // this runtime may perform DNS64 discovery for IPv6, which is not network-free.
    for (const url of ['http://127.0.0.1:9/', 'http://2130706433:9/', 'http://0x7f000001:9/', 'http://10.0.0.1:9/', 'http://192.168.1.1:9/', 'http://169.254.169.254/latest/meta-data/', 'http://0.0.0.0:9/']) {
      await assert.rejects(h.ctx.web.fetch({ url }), matchesError('WEB_BLOCKED_URL'));
    }
    await assert.rejects(h.ctx.web.fetch({ url: 'file:///etc/passwd' }), matchesError('WEB_INVALID_URL'));
    await assert.rejects(h.ctx.web.fetch({ url: 'http://user:pass@127.0.0.1:9/' }), matchesError('WEB_BLOCKED_URL'));
    assert.equal(h.requests.length, 0, 'fetch must not be routed through either credential-bearing search transport');
    assert.equal(h.refs.length, 0, 'public HTTP fetching requires neither search credential');
    await h.searchFiber.dispose();
    assert.equal(h.ctx.web.fetchProviders.get('http'), provider);
    await assert.rejects(h.ctx.web.fetch({ url: 'http://127.0.0.1:9/' }), matchesError('WEB_BLOCKED_URL'));
  });
});
