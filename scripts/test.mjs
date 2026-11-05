import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';

const root = new URL('../', import.meta.url);
const read = async path => (await readFile(new URL(path, root), 'utf8')).replace(/\r\n/g, '\n');
const shared = await read('shared/plugin-updates.js');
const collection = await read('shared/plugin-collection.js');
const sandbox = { console, setTimeout, clearTimeout, URL, AbortController, Promise };
const exportsOf = runInContext(shared + '\n' + collection + '\n;({ pluginUpdatesVersion, pluginUpdatesCompare, pluginUpdatesSource, pluginCollectionSpec, pluginCollectionSameSource, pluginCollectionStatus, pluginCollectionManifestURL, createPluginCollectionController })', createContext(sandbox));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (actual, expected, message) => assert(actual === expected, message + ': expected ' + JSON.stringify(expected) + ', received ' + JSON.stringify(actual));

equal(exportsOf.pluginUpdatesCompare('0.3.0', '0.3.1'), -1, 'semver ordering');
equal(exportsOf.pluginUpdatesCompare('1.0.0', '1.0.0'), 0, 'semver equality');
equal(exportsOf.pluginUpdatesCompare('1.0.0', '1.0.0-rc.1'), 1, 'release above prerelease');
assert(exportsOf.pluginCollectionSameSource('git+https://github.com/chdigda/plugins.git#path:/packages/dsh-web-search', 'github:chdigda/plugins#path:/packages/dsh-web-search'), 'github shorthand equals the canonical git source');
assert(!exportsOf.pluginCollectionSameSource('git+https://github.com/chdigda/plugins.git#path:/packages/dsh-web-search', 'git+https://github.com/chdigda/plugins.git#path:/packages/dsh-session-delete'), 'different subdirectories differ');
assert(!exportsOf.pluginCollectionSameSource('git+https://github.com/other/plugins.git#path:/packages/dsh-web-search', 'git+https://github.com/chdigda/plugins.git#path:/packages/dsh-web-search'), 'different repositories differ');
equal(exportsOf.pluginCollectionSpec('https://github.com/chdigda/plugins', 'packages/dsh-web-search'), 'git+https://github.com/chdigda/plugins.git#path:/packages/dsh-web-search', 'spec construction');
equal(exportsOf.pluginCollectionSpec('https://github.com/chdigda/plugins.git', ''), 'git+https://github.com/chdigda/plugins.git', 'root spec construction');
equal(exportsOf.pluginCollectionManifestURL({ owner: 'chdigda', repo: 'plugins', ref: 'main' }, 'packages/dsh-web-search'), 'https://raw.githubusercontent.com/chdigda/plugins/main/packages/dsh-web-search/package.json', 'manifest URL with subdirectory');
equal(exportsOf.pluginCollectionStatus('0.3.0', '0.3.1'), 'available', 'update available status');
equal(exportsOf.pluginCollectionStatus('0.3.1', '0.3.1'), 'current', 'current status');

function fakeManager(bundles, overrides = {}) {
  const calls = [];
  const manager = {
    listBundles: async () => { calls.push(['listBundles']); return { ok: true, value: bundles() }; },
    installBundle: async (spec, options) => { calls.push(['installBundle', spec, options]); return overrides.install ? overrides.install(spec, options) : { ok: true, value: { bundle: 'dsh-web-search', version: '0.3.1', application: 'restart-required' } }; },
    removeBundle: async name => { calls.push(['removeBundle', name]); return { ok: true, value: { bundle: name, application: 'applied' } }; },
  };
  return { manager, calls };
}
function fakeFetch(versions) {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    const parts = new URL(url);
    const segments = parts.pathname.split('/').filter(Boolean);
    const name = segments[segments.indexOf('packages') + 1];
    const version = versions[name];
    if (!version) return { ok: false, status: 404 };
    return { ok: true, json: async () => ({ name, version }) };
  };
  return { fetcher, calls };
}
const plugins = [
  { name: 'dsh-web-search', dir: 'packages/dsh-web-search', title: { en: 'Web Search' } },
  { name: 'dsh-session-delete', dir: 'packages/dsh-session-delete', title: { en: 'Session Delete' }, restart: true },
];
const baseBundles = () => [
  { name: 'dsh-plugins', installed: true, enabled: true, version: '0.1.0', source: 'git+https://github.com/chdigda/plugins.git' },
  { name: 'dsh-web-search', installed: true, enabled: true, version: '0.3.0', source: 'github:chdigda/plugins#path:/packages/dsh-web-search' },
];
const confirmCalls = [];
const controller = exportsOf.createPluginCollectionController({
  manager: fakeManager(baseBundles).manager,
  plugins, packageName: 'dsh-plugins', repository: 'https://github.com/chdigda/plugins', branch: 'main',
  fetch: fakeFetch({ 'dsh-web-search': '0.3.1', 'dsh-session-delete': '0.3.1' }).fetcher,
  confirm: (key, detail) => { confirmCalls.push([key, detail]); return true; },
});
await controller.check();
let snapshot = controller.getSnapshot();
equal(snapshot.phase, 'checked', 'check phase');
equal(snapshot.repo.ref, 'HEAD', 'repository ref from the installed collection source');
equal(snapshot.rows[0].status, 'available', 'web search update available');
equal(snapshot.rows[0].latest, '0.3.1', 'web search latest version');
equal(snapshot.rows[1].status, 'missing', 'session delete is not installed');
equal(snapshot.hubVersion, '0.1.0', 'collection manager version');

const removed = [];
const installed = [];
const done = new Set();
const applyManager = {
  listBundles: async () => ({
    ok: true,
    value: [
      { name: 'dsh-plugins', installed: true, enabled: true, version: '0.1.0', source: 'git+https://github.com/chdigda/plugins.git' },
      { name: 'dsh-web-search', installed: true, enabled: true, version: done.has('dsh-web-search') ? '0.3.1' : '0.3.0', source: 'github:chdigda/plugins#path:/packages/dsh-web-search' },
      ...(done.has('dsh-session-delete') ? [{ name: 'dsh-session-delete', installed: true, enabled: true, version: '0.3.1', source: 'git+https://github.com/chdigda/plugins.git#path:/packages/dsh-session-delete' }] : []),
    ],
  }),
  installBundle: async (spec, options) => {
    installed.push([spec, options]);
    const name = spec.includes('dsh-session-delete') ? 'dsh-session-delete' : 'dsh-web-search';
    done.add(name);
    return { ok: true, value: { bundle: name, version: '0.3.1', application: 'restart-required' } };
  },
  removeBundle: async name => { removed.push(name); return { ok: true, value: { bundle: name, application: 'applied' } }; },
};
controller.dispose();
const applyController = exportsOf.createPluginCollectionController({
  manager: applyManager,
  plugins, packageName: 'dsh-plugins', repository: 'https://github.com/chdigda/plugins', branch: 'main',
  fetch: fakeFetch({ 'dsh-web-search': '0.3.1', 'dsh-session-delete': '0.3.1' }).fetcher,
  confirm: () => true,
});
await applyController.check();
equal(applyController.getSnapshot().rows[1].status, 'missing', 'session delete starts missing');
await applyController.applyOne('dsh-session-delete');
snapshot = applyController.getSnapshot();
equal(installed.length, 1, 'one install call');
equal(installed[0][0], 'git+https://github.com/chdigda/plugins.git#path:/packages/dsh-session-delete', 'collection spec used for a fresh install');
equal(installed[0][1].enabled, true, 'fresh install enables the bundle');
equal(snapshot.rows[1].installed, true, 'session delete now installed');
equal(snapshot.restart, true, 'restart required after installing session delete');
await applyController.applyOne('dsh-web-search');
equal(installed.length, 2, 'second install call');
equal(installed[1][0], 'github:chdigda/plugins#path:/packages/dsh-web-search', 'update reinstalls the installed source form');
equal(applyController.getSnapshot().rows[0].status, 'current', 'web search is current after update');

let firstInstall = true;
let fallbackVersion = '0.3.0';
const fallbackCalls = [];
const fallbackManager = {
  listBundles: async () => ({ ok: true, value: [{ name: 'dsh-plugins', installed: true, enabled: true, version: '0.1.0', source: 'git+https://github.com/chdigda/plugins.git' }, { name: 'dsh-web-search', installed: true, enabled: false, version: fallbackVersion, source: 'git+https://github.com/chdigda/plugins.git#path:/packages/dsh-web-search' }] }),
  installBundle: async (spec, options) => {
    fallbackCalls.push(['installBundle', spec, options.enabled]);
    if (firstInstall) { firstInstall = false; return { ok: false, error: { code: 'already-installed', message: 'already installed' } }; }
    fallbackVersion = '0.3.1';
    return { ok: true, value: { bundle: 'dsh-web-search', version: '0.3.1', application: 'applied' } };
  },
  removeBundle: async name => { fallbackCalls.push(['removeBundle', name]); return { ok: true, value: { bundle: name, application: 'applied' } }; },
};
const fallbackController = exportsOf.createPluginCollectionController({
  manager: fallbackManager,
  plugins, packageName: 'dsh-plugins', repository: 'https://github.com/chdigda/plugins', branch: 'main',
  fetch: fakeFetch({ 'dsh-web-search': '0.3.1' }).fetcher,
  confirm: () => true,
});
await fallbackController.check();
await fallbackController.applyOne('dsh-web-search');
equal(fallbackCalls.filter(call => call[0] === 'removeBundle').length, 1, 'already-installed triggers removal before reinstall');
equal(fallbackCalls.filter(call => call[0] === 'installBundle')[1][2], false, 'reinstall preserves the disabled activation state');
equal(fallbackController.getSnapshot().error, null, 'fallback update succeeds');
console.log('Shared update logic checks passed.');
const loadArtifact = code => {
  let captured;
  runInContext(code, createContext({ window: { __ModuleLoader__: { load: module => { captured = module; } } } }));
  if (!captured) throw new Error('client bundle did not register a module');
  return captured;
};
const ReactStub = { createElement: () => null, useSyncExternalStore: () => ({}), useState: () => [null, () => {}] };
const hubModule = loadArtifact(await read('client-bundle.mjs'));
equal(hubModule.id, 'dsh-plugins', 'hub client module id');
const hub = hubModule.factory(spec => {
  if (spec === 'react') return ReactStub;
  throw new Error('unexpected client module request: ' + spec);
});
assert(Array.isArray(hub.inject) && hub.inject.includes('slots') && hub.inject.includes('locale'), 'hub client inject list');
const seen = { injected: [], slots: [], services: null, effects: [] };
const live = {
  remote: { pluginManager: { listBundles: async () => ({ ok: true, value: [] }) } },
  effect: fn => { const disposer = fn(); seen.effects.push(disposer); return disposer; },
  slots: {
    inject: (name, register) => { seen.injected.push(name); return register(); },
    register: (entry, Card) => { seen.slots.push({ entry, Card }); return () => {}; },
  },
};
const ctx = {
  locale: { bind: () => key => key, register: () => {}, resolveText: value => (typeof value === 'string' ? value : value.en) },
  effect: disposer => { seen.effects.push(disposer); return disposer; },
  on: () => () => {},
  inject: (services, callback) => { seen.services = services; callback(live); },
  slots: live.slots,
};
hub.apply(ctx);
assert(seen.services.includes('remote.pluginManager'), 'hub client injects the plugin manager remote');
assert(seen.injected.includes('plugins.bundle.config'), 'hub client registers on the bundle configuration slot');
equal(seen.slots.length, 1, 'hub client registers one slot entry');
equal(seen.slots[0].entry.key, 'dsh-plugins', 'hub slot key is the bundle package name');
assert(typeof seen.slots[0].entry.locale === 'string' && seen.slots[0].entry.locale.length > 0, 'hub slot locale namespace');
console.log('Client artifact checks passed.');