import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../shared/plugin-updates.js', import.meta.url), 'utf8');
const React = { createElement: (type, props, ...children) => ({ type, props, children }), useSyncExternalStore: (_subscribe, snapshot) => snapshot() };
function load(extra = {}) {
  const context = vm.createContext({ URL, AbortController, setTimeout, clearTimeout, require(name) { assert.equal(name, 'react'); return React; }, ...extra });
  vm.runInContext(source, context);
  return context;
}
const api = load();
const ok = value => ({ ok: true, value });
const change = (extra = {}) => ok({ changed: true, stage: 'install', target: 'dsh-web-search', application: 'applied', bundle: 'dsh-web-search', version: '1.1.0', ...extra });
const already = () => change({ application: 'failed', error: { code: 'already-installed' } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(overrides = {}) {
  const calls = [];
  const b = { name: 'dsh-web-search', source: 'git+https://github.com/chdigda/plugins.git#dsh-web-search', version: '1.0.0', installed: true, enabled: true, removable: true, ...overrides.bundle };
  const manager = {
    async listBundles() { calls.push(['list']); return ok([{ ...b }]); },
    async installBundle(spec, options) { calls.push(['install', spec, { ...options }]); return change(); },
    async removeBundle(name) { calls.push(['remove', name]); return change({ stage: 'remove', bundle: undefined, version: undefined }); },
    ...overrides.manager,
  };
  const fetches = [];
  const fetch = async (url, options) => {
    fetches.push([url, options]);
    if (url.startsWith('https://api.github.com/')) return { ok: true, json: async () => ({ ref: 'refs/heads/' + api.pluginUpdatesSource(b.source).ref }) };
    return { ok: true, json: async () => ({ name: b.name, version: '1.1.0' }) };
  };
  const controller = api.createPluginUpdatesController({ pluginId: b.name, manager, fetch, confirm: async () => { calls.push(['confirm']); return true; }, ...overrides.options });
  return { controller, manager, calls, b, fetches };
}

test('classic declaration works inside a generated ModuleLoader factory without ESM', () => {
  let plugin;
  const context = vm.createContext({ URL, AbortController, setTimeout, clearTimeout, require: () => React, window: { __ModuleLoader__: { load: record => { assert.equal(record.id, 'x-updates'); plugin = record.factory(() => React); } } } });
  vm.runInContext('window.__ModuleLoader__.load({id:"x-updates",factory(require){' + source + '\nreturn createPluginUpdates({pluginId:"x",entryId:"main",title:"X"});}})', context);
  assert.equal(typeof plugin.apply, 'function');
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'locale']);
});

test('strict semver: numeric core/prerelease, release, build and arbitrary precision', () => {
  const sequence = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.2.0', '1.10.0', '2.0.0'];
  for (let i = 1; i < sequence.length; i++) {
    assert.equal(api.pluginUpdatesCompare(sequence[i - 1], sequence[i]), -1);
    assert.equal(api.pluginUpdatesCompare(sequence[i], sequence[i - 1]), 1);
  }
  assert.equal(api.pluginUpdatesCompare('1.0.0+one', '1.0.0+two'), 0);
  assert.equal(api.pluginUpdatesCompare('1.0.0-99999999999999999999', '1.0.0-100000000000000000000'), -1);
  for (const invalid of ['1', 'v1.0.0', '1.00.0', '1.0.0-01', '1.0.0-', '1.0.0+a..b', '', null, 123]) assert.throws(() => api.pluginUpdatesVersion(invalid), /Invalid/);
});

test('GitHub roots preserve forks, slash refs, explicit heads and default HEAD', () => {
  for (const name of ['dsh-web-search', 'dsh-session-delete']) {
    const p = api.pluginUpdatesSource('git+https://github.com/chdigda/plugins.git#' + name);
    assert.equal(p.repo, 'plugins'); assert.equal(p.ref, name);
  }
  const p = api.pluginUpdatesSource('git+https://github.com/my-fork/plugins.git#feature/nested');
  assert.equal(p.owner, 'my-fork'); assert.match(p.manifestURL, /my-fork\/plugins\/feature%2Fnested\/package.json$/);
  assert.equal(api.pluginUpdatesSource('https://github.com/fork/repo').ref, 'HEAD');
  assert.equal(api.pluginUpdatesSource('https://github.com/fork/repo#refs/heads/main').ref, 'main');
});

test('reject unsafe, local, pinned and unsupported sources', () => {
  for (const value of [undefined, 'file:../x', 'link:../x', 'github:a/b/c', 'http://github.com/a/b', 'git+ssh://git@github.com/a/b', 'https://evil.com/a/b', 'https://github.com/a/b/tree/main', 'https://u:p@github.com/a/b', 'https://github.com/a/b?x=1', ...['deadbeef', 'v1.2.3', '1.2.3', 'refs/tags/release', 'semver:^1', 'a..b', 'a%20b', '%zz'].map(ref => 'git+https://github.com/a/b#' + ref)]) assert.throws(() => api.pluginUpdatesSource(value));
});

test('check latest manifest on installed source and Check again', async () => {
  const f = fixture();
  await f.controller.check();
  assert.equal(f.controller.getSnapshot().phase, 'available');
  assert.equal(f.controller.getSnapshot().latest, '1.1.0');
  assert.match(f.fetches[0][0], /api.github.com.*heads\/dsh-web-search$/);
  assert.match(f.fetches[1][0], /raw.githubusercontent.com\/chdigda\/plugins\/dsh-web-search\/package.json$/);
  assert.equal(f.fetches[1][1].cache, 'no-store');
  await f.controller.check(); assert.equal(f.fetches.length, 4);
});

test('fork and slash branch are fetched, never hard-coded upstream', async () => {
  const f = fixture({ bundle: { source: 'git+https://github.com/fork/custom.git#work/next' } });
  await f.controller.check();
  assert.equal(f.controller.getSnapshot().phase, 'available');
  assert.match(f.fetches[0][0], /fork\/custom\/git\/ref\/heads\/work%2Fnext$/);
  assert.match(f.fetches[1][0], /fork\/custom\/work%2Fnext/);
});

test('default HEAD checks raw manifest without requiring a main branch', async () => {
  const f = fixture({ bundle: { source: 'git+https://github.com/fork/repo.git' } });
  await f.controller.check(); assert.equal(f.fetches.length, 1); assert.match(f.fetches[0][0], /\/HEAD\/package.json$/);
});

for (const version of ['1.0.0', '0.9.0']) test('not newer manifest is up to date: ' + version, async () => {
  const f = fixture({ bundle: { source: 'https://github.com/a/b' }, options: { fetch: async () => ({ ok: true, json: async () => ({ name: 'dsh-web-search', version }) }) } });
  await f.controller.check(); assert.equal(f.controller.getSnapshot().phase, 'current');
  await f.controller.update(); assert.equal(f.calls.filter(c => c[0] === 'install').length, 0);
});

for (const [label, fetch, error] of [
  ['HTTP', async () => ({ ok: false, status: 404 }), /HTTP 404/],
  ['JSON', async () => ({ ok: true, json: async () => { throw new Error('bad JSON'); } }), /bad JSON/],
  ['name', async () => ({ ok: true, json: async () => ({ name: 'wrong', version: '9.0.0' }) }), /name mismatch/],
  ['version', async () => ({ ok: true, json: async () => ({ name: 'dsh-web-search', version: 'invalid' }) }), /Invalid manifest version/],
  ['network', async () => { throw new Error('offline'); }, /offline/],
  ['timeout', () => new Promise(() => {}), /timed out/],
]) test('check explicitly fails on ' + label, async () => {
  const f = fixture({ bundle: { source: 'https://github.com/a/b' }, options: { fetch, timeoutMs: 5 } });
  await f.controller.check(); assert.equal(f.controller.getSnapshot().phase, 'error'); assert.match(f.controller.getSnapshot().error, error);
});

test('arbitrary tag selector rejected by heads verification', async () => {
  const f = fixture({ bundle: { source: 'https://github.com/a/b#release-stable' }, options: { fetch: async () => ({ ok: false, status: 404 }) } });
  await f.controller.check(); assert.equal(f.controller.getSnapshot().phase, 'error'); assert.match(f.controller.getSnapshot().error, /tags/);
});

for (const bundle of [{ version: 'oops' }, { source: 'file:/tmp/plugin' }, { installed: false }]) test('invalid installed record fails: ' + JSON.stringify(bundle), async () => {
  const f = fixture({ bundle }); await f.controller.check(); assert.equal(f.controller.getSnapshot().phase, 'error'); assert.equal(f.fetches.length, 0);
});

test('remote denied or malformed list is explicit failure', async () => {
  for (const response of [{ ok: false, error: { code: 'permission-denied' } }, ok(null), ok([])]) {
    const f = fixture({ manager: { listBundles: async () => response } });
    await f.controller.check(); assert.equal(f.controller.getSnapshot().phase, 'error');
  }
});

test('stale check completion cannot replace newer state', async () => {
  const pending = deferred(); let calls = 0;
  const f = fixture({ bundle: { source: 'https://github.com/a/b' }, options: { fetch: async () => { calls++; if (calls === 1) await pending.promise; return { ok: true, json: async () => ({ name: 'dsh-web-search', version: calls === 1 ? '9.0.0' : '1.1.0' }) }; } } });
  const old = f.controller.check(); await tick(); await f.controller.check();
  const snapshot = f.controller.getSnapshot(); pending.resolve(); await old;
  assert.equal(f.controller.getSnapshot(), snapshot);
});

test('dispose aborts a check and suppresses further notifications', async () => {
  const pending = deferred(); let signal, notifications = 0;
  const f = fixture({ bundle: { source: 'https://github.com/a/b' }, options: { fetch: async (_url, options) => { signal = options.signal; await pending.promise; return { ok: true, json: async () => ({ name: 'dsh-web-search', version: '1.1.0' }) }; } } });
  f.controller.subscribe(() => notifications++);
  const work = f.controller.check(); await tick(); f.controller.dispose(); const before = notifications;
  assert.equal(signal.aborted, true); pending.resolve(); await work; await f.controller.check(); await f.controller.update(); assert.equal(notifications, before);
});

test('declining confirmation performs no package operations', async () => {
  const f = fixture({ options: { confirm: async () => false } });
  await f.controller.check(); await f.controller.update();
  assert.equal(f.controller.getSnapshot().phase, 'available'); assert.deepEqual(f.calls.map(c => c[0]), ['list']);
});

test('already installed falls back to remove then same-source install with enabled preserved', async () => {
  const f = fixture({ bundle: { enabled: false } }); let n = 0;
  f.manager.installBundle = async (spec, options) => { f.calls.push(['install', spec, { ...options }]); return ++n === 1 ? already() : change(); };
  await f.controller.check(); await f.controller.update();
  assert.deepEqual(f.calls.map(c => c[0]), ['list', 'confirm', 'list', 'install', 'remove', 'install']);
  for (const c of f.calls.filter(c => c[0] === 'install')) { assert.equal(c[1], f.b.source); assert.deepEqual(c[2], { enabled: false }); }
  assert.equal(f.controller.getSnapshot().phase, 'updated');
});

test('supported direct install success does not remove bundle', async () => {
  const f = fixture(); await f.controller.check(); await f.controller.update();
  assert.equal(f.calls.some(c => c[0] === 'remove'), false); assert.equal(f.controller.getSnapshot().phase, 'updated');
});

test('self detach during remove must not cancel reinstall', async () => {
  const f = fixture(); let n = 0;
  f.manager.installBundle = async (spec, options) => { f.calls.push(['install', spec, { ...options }]); return ++n === 1 ? already() : change(); };
  f.manager.removeBundle = async () => { f.calls.push(['remove']); f.controller.dispose(); return change({ stage: 'remove' }); };
  await f.controller.check(); await f.controller.update();
  assert.equal(n, 2); assert.equal(f.controller.getSnapshot().phase, 'updated');
});

test('detach before confirmation resolves prevents all mutations', async () => {
  const pending = deferred(); const f = fixture({ options: { confirm: () => pending.promise } });
  await f.controller.check(); const work = f.controller.update(); f.controller.dispose(); pending.resolve(true); await work;
  assert.equal(f.calls.some(c => c[0] === 'install'), false);
});

test('concurrent update and check calls do not double mutate', async () => {
  const pending = deferred(); let confirms = 0;
  const f = fixture({ options: { confirm: () => { confirms++; return pending.promise; } } });
  await f.controller.check(); const one = f.controller.update(); await f.controller.update(); await f.controller.check();
  assert.equal(confirms, 1); pending.resolve(true); await one;
  assert.equal(f.calls.filter(c => c[0] === 'install').length, 1);
});

test('source/version drift, read-only and nonremovable bundles never mutate', async () => {
  for (const patch of [{ source: 'https://github.com/fork/repo' }, { version: '1.0.1' }, { readOnlyReason: 'management-required' }, { removable: false }]) {
    const f = fixture(); await f.controller.check(); Object.assign(f.b, patch); await f.controller.update();
    assert.equal(f.controller.getSnapshot().phase, 'error'); assert.equal(f.calls.some(c => c[0] === 'install'), false);
  }
});

test('permission and other install failures never trigger removal', async () => {
  for (const result of [{ ok: false, error: { code: 'permission-denied' } }, change({ error: { code: 'management-required' }, application: 'failed' }), change({ packageResult: { exitCode: 1, kind: 'permission', output: 'denied' } }), change({ application: 'cancelled' }), change({ application: 'overridden' })]) {
    const f = fixture({ manager: { installBundle: async () => result } }); await f.controller.check(); await f.controller.update();
    assert.equal(f.controller.getSnapshot().phase, 'error'); assert.equal(f.calls.some(c => c[0] === 'remove'), false);
  }
});

test('remove failure stops reinstall; post-remove install failure provides exact manual source', async () => {
  const f = fixture(); let n = 0;
  f.manager.installBundle = async () => { n++; return already(); };
  f.manager.removeBundle = async () => change({ application: 'failed', error: { code: 'bundle-in-use' } });
  await f.controller.check(); await f.controller.update(); assert.equal(n, 1); assert.match(f.controller.getSnapshot().error, /bundle-in-use/);
  const g = fixture(); let m = 0;
  g.manager.installBundle = async () => ++m === 1 ? already() : change({ application: 'failed', packageResult: { exitCode: 1, kind: 'permission' } });
  await g.controller.check(); await g.controller.update();
  assert.equal(m, 2); assert.match(g.controller.getSnapshot().error, /Reinstall manually from: git\+https:\/\/github.com\/chdigda\/plugins.git#dsh-web-search/);
});

test('restart-required from either operation survives to final status', async () => {
  const f = fixture({ manager: { installBundle: async () => change({ application: 'restart-required' }) } });
  await f.controller.check(); await f.controller.update(); assert.equal(f.controller.getSnapshot().phase, 'restart');
  const g = fixture(); let n = 0;
  g.manager.installBundle = async () => ++n === 1 ? already() : change();
  g.manager.removeBundle = async () => change({ application: 'restart-required', stage: 'remove' });
  await g.controller.check(); await g.controller.update(); assert.equal(g.controller.getSnapshot().phase, 'restart');
});

test('result identity or old installed version is not falsely reported successful', async () => {
  for (const patch of [{ bundle: 'wrong' }, { version: '1.0.0' }, { version: 'bad' }]) {
    const f = fixture({ manager: { installBundle: async () => change(patch) } }); await f.controller.check(); await f.controller.update(); assert.equal(f.controller.getSnapshot().phase, 'error');
  }
});

test('unknown enabled state is never silently auto-enabled', async () => {
  const f = fixture({ bundle: { enabled: undefined } });
  await f.controller.check(); await f.controller.update();
  assert.equal(f.controller.getSnapshot().phase, 'error'); assert.match(f.controller.getSnapshot().error, /enabled state is unknown/);
  assert.equal(f.calls.some(c => c[0] === 'install'), false);
});

test('detach during nondestructive already-installed probe prevents removal', async () => {
  const f = fixture();
  f.manager.installBundle = async () => { f.controller.dispose(); return already(); };
  await f.controller.check(); await f.controller.update();
  assert.equal(f.calls.some(c => c[0] === 'remove'), false);
});

test('missing result version is verified from inventory rather than invented', async () => {
  const f = fixture({ manager: { installBundle: async () => change({ version: undefined }) } });
  await f.controller.check(); await f.controller.update();
  assert.equal(f.controller.getSnapshot().phase, 'error'); assert.match(f.controller.getSnapshot().error, /older/);
  const g = fixture();
  g.manager.installBundle = async () => { g.b.version = '1.1.0'; return change({ version: undefined }); };
  await g.controller.check(); await g.controller.update(); assert.equal(g.controller.getSnapshot().phase, 'updated');
});

test('optional remote integration registers native buttons and ko/en via locale', async () => {
  const dictionaries = {}; const registrations = []; const cleanups = []; let card;
  const locale = { bind: ns => key => dictionaries[ns]?.en[key] || key, register(ns, value) { dictionaries[ns] = value; return () => {}; } };
  const effect = callback => { const cleanup = callback(); if (typeof cleanup === 'function') cleanups.push(cleanup); };
  const live = { locale, effect, remote: { pluginManager: fixture().manager }, slots: { inject(name, cb) { assert.equal(name, 'plugins.row.config'); return cb(); }, register(meta, component) { registrations.push(meta); card = component; return () => {}; } } };
  const ctx = { locale, effect, inject(deps, cb) { assert.deepEqual(Array.from(deps), ['remote', 'remote.pluginManager']); cb(live); } };
  const local = load({ confirm: () => false });
  local.createPluginUpdates({ pluginId: 'dsh-web-search', entryId: 'updates', title: 'Updates' }).apply(ctx);
  assert.equal(registrations.length, 1); assert.equal(registrations[0].key, 'dsh-web-search#updates');
  const dict = Object.values(dictionaries)[0]; assert.equal(dict.ko.update, '업데이트'); assert.match(dict.en.confirm, /removed/); assert.match(dict.en.confirm, /reinstall can fail/);
  const rendered = card(); const buttons = rendered.children[2].children;
  assert.equal(buttons[0].type, 'button'); assert.equal(buttons[0].props.disabled, false); assert.equal(buttons[0].children[0], dict.en.check);
  for (const cleanup of cleanups.reverse()) cleanup();
});

test('pnpm subdirectory sources and normalized shorthand preserve independent package manifests', async () => {
  for (const name of ['dsh-web-search', 'dsh-session-delete']) {
    for (const prefix of ['git+https://github.com/chdigda/plugins.git', 'github:chdigda/plugins']) {
      const source = prefix + '#path:/packages/' + name;
      const parsed = api.pluginUpdatesSource(source);
      assert.equal(parsed.path, 'packages/' + name);
      assert.equal(parsed.ref, 'HEAD');
      assert.equal(parsed.source, source);
      assert.equal(parsed.manifestURL, 'https://raw.githubusercontent.com/chdigda/plugins/HEAD/packages/' + name + '/package.json');
      const f = fixture({ bundle: { name, source }, options: { fetch: async url => {
        assert.equal(url, parsed.manifestURL);
        return { ok: true, json: async () => ({ name, version: '1.1.0' }) };
      } } });
      await f.controller.check();
      assert.equal(f.controller.getSnapshot().phase, 'available');
    }
  }
});
test('combined ref and path selectors support forks and reject traversal/duplicates', () => {
  const p = api.pluginUpdatesSource('github:fork/plugins#work/next&path:/packages/dsh-web-search');
  assert.equal(p.owner, 'fork'); assert.equal(p.ref, 'work/next');
  assert.equal(p.manifestURL, 'https://raw.githubusercontent.com/fork/plugins/work%2Fnext/packages/dsh-web-search/package.json');
  for (const fragment of ['path:', 'path:/../x', 'path:/a/./b', 'path:/a//b', 'path:/a%5Cb', 'path:/a?b', 'path:/a&path:/b', 'main&next', 'main&unknown:value', 'path:/a%26b', 'v1.2.3&path:/a', 'deadbeef&path:/a']) {
    assert.throws(() => api.pluginUpdatesSource('github:a/b#' + fragment), fragment);
  }
});
test('normalized Git subdirectory source survives remove and reinstall unchanged', async () => {
  const source = 'github:chdigda/plugins#path:/packages/dsh-web-search';
  const f = fixture({ bundle: { source } }); let n = 0;
  f.manager.installBundle = async (spec, options) => {
    assert.equal(spec, source); assert.equal(options.enabled, true);
    return ++n === 1 ? already() : change();
  };
  await f.controller.check(); await f.controller.update();
  assert.equal(n, 2); assert.equal(f.controller.getSnapshot().phase, 'updated');
});
