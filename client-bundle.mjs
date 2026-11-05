window.__ModuleLoader__.load({
  id: "dsh-plugins",
  factory(require) {
function pluginUpdatesVersion(value) {
  if (typeof value !== 'string') throw new Error('Invalid manifest version');
  var m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!m || (m[4] || '').split('.').some(function (p) { return /^0\d+$/.test(p); })) throw new Error('Invalid manifest version: ' + value);
  return { core: m.slice(1, 4), pre: m[4] ? m[4].split('.') : [] };
}
function pluginUpdatesCompare(a, b) {
  a = pluginUpdatesVersion(a); b = pluginUpdatesVersion(b);
  function number(x, y) { return x.length === y.length ? (x === y ? 0 : x > y ? 1 : -1) : x.length > y.length ? 1 : -1; }
  for (var i = 0; i < 3; i++) { var c = number(a.core[i], b.core[i]); if (c) return c; }
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (var j = 0; j < Math.max(a.pre.length, b.pre.length); j++) {
    var x = a.pre[j], y = b.pre[j];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    var nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    return nx && ny ? number(x, y) : nx !== ny ? (nx ? -1 : 1) : x > y ? 1 : -1;
  }
  return 0;
}
function pluginUpdatesSource(source) {
  if (typeof source !== 'string') throw new Error('No GitHub source (local installs cannot be updated here)');
  var normalized = source.replace(/^github:/i, 'https://github.com/').replace(/^git\+/, '');
  var url;
  try { url = new URL(normalized); } catch (_) { throw new Error('Unsupported source; use a GitHub HTTPS installation address'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search) throw new Error('Only HTTPS GitHub sources are supported');
  var m = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.pathname);
  if (!m || m[1] === '.' || m[1] === '..' || m[2] === '.' || m[2] === '..') throw new Error('Invalid GitHub repository root');
  var ref = '', path = '', seenPath = false;
  if (url.hash) url.hash.slice(1).split('&').forEach(function (part) {
    try { part = decodeURIComponent(part); } catch (_) { throw new Error('Invalid Git selector encoding'); }
    if (part.startsWith('path:')) {
      if (seenPath) throw new Error('Duplicate Git subdirectory');
      seenPath = true;
      path = part.slice(5).replace(/^\//, '');
      if (!path || path.split('/').some(function (p) { return !/^[A-Za-z0-9_@.-]+$/.test(p) || p === '.' || p === '..'; })) throw new Error('Unsafe Git subdirectory');
    } else {
      if (ref || !part) throw new Error('Duplicate or empty Git ref');
      ref = part;
    }
  });
  ref = ref || 'HEAD';
  if (/^(?:[0-9a-f]{7,64}|v?\d+(?:\.\d+){0,2}(?:[-+].*)?|semver:.*|refs\/tags\/.*)$/i.test(ref)) throw new Error('Pinned commits, tags and semver selectors cannot be updated');
  ref = ref.replace(/^refs\/heads\//, '');
  if (!ref || /[\s~^:?*\[\]\\#%&]/.test(ref) || ref.includes('..') || ref.includes('@{') || ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.') || ref.split('/').some(function (p) { return !p || p[0] === '.' || p.endsWith('.lock'); })) throw new Error('Unsupported Git ref');
  return { source: source, owner: m[1], repo: m[2], ref: ref, path: path,
    manifestURL: 'https://raw.githubusercontent.com/' + m[1] + '/' + m[2] + '/' + encodeURIComponent(ref) + '/' + (path ? path.split('/').map(encodeURIComponent).join('/') + '/' : '') + 'package.json' };
}
function pluginUpdatesUnwrap(result) {
  if (!result || result.ok !== true) {
    var e = result && result.error;
    throw new Error('Plugin manager: ' + (e && (e.message || e.code || e.kind) || 'remote request failed'));
  }
  return result.value;
}
function pluginUpdatesChange(result) {
  var r = pluginUpdatesUnwrap(result);
  if (!r || r.error || (r.packageResult && r.packageResult.exitCode !== 0) || !['applied', 'restart-required'].includes(r.application)) {
    var error = new Error('Plugin manager: ' + (r && (r.error && (r.error.code + (r.error.diagnostic ? ': ' + r.error.diagnostic : '')) || r.packageResult && (r.packageResult.kind || r.packageResult.output) || r.application) || 'invalid result'));
    error.code = r && r.error && r.error.code;
    throw error;
  }
  return r;
}
function createPluginUpdatesController(options) {
  var manager = options.manager, fetcher = options.fetch || globalThis.fetch;
  var state = { phase: 'idle', latest: null, current: null, error: null, source: null };
  var listeners = new Set(), generation = 0, detached = false, updating = false, abort;
  function emit(patch) { state = Object.assign({}, state, patch); if (!detached) listeners.forEach(function (f) { f(); }); }
  async function bundle() {
    var all = pluginUpdatesUnwrap(await manager.listBundles());
    if (!Array.isArray(all)) throw new Error('Invalid bundle list');
    var matches = all.filter(function (b) { return b.name === options.pluginId; });
    if (matches.length !== 1 || !matches[0].installed) throw new Error('Bundle is not uniquely installed');
    return matches[0];
  }
  async function manifest(parsed, signal) {
    var timer;
    try {
      return await Promise.race([
        (async function () {
          var fetchOptions = { signal: signal, cache: 'no-store', credentials: 'omit' };
          if (parsed.ref !== 'HEAD') {
            var branch = await fetcher('https://api.github.com/repos/' + parsed.owner + '/' + parsed.repo + '/git/ref/heads/' + encodeURIComponent(parsed.ref), fetchOptions);
            if (!branch.ok) throw new Error('GitHub branch unavailable (tags are not update sources): HTTP ' + branch.status);
            var head = await branch.json();
            if (!head || head.ref !== 'refs/heads/' + parsed.ref) throw new Error('GitHub source is not a branch');
          }
          var response = await fetcher(parsed.manifestURL, fetchOptions);
          if (!response.ok) throw new Error('GitHub manifest HTTP ' + response.status);
          var data = await response.json();
          if (!data || data.name !== options.pluginId) throw new Error('GitHub manifest package name mismatch');
          pluginUpdatesVersion(data.version);
          return data.version;
        })(),
        new Promise(function (_, reject) { timer = setTimeout(function () { reject(new Error('GitHub manifest request timed out')); }, options.timeoutMs || 15000); })
      ]);
    } finally { clearTimeout(timer); }
  }
  async function check() {
    if (detached || updating) return;
    var token = ++generation;
    if (abort) abort.abort();
    abort = new AbortController();
    var request = abort;
    emit({ phase: 'checking', error: null, latest: null });
    try {
      var b = await bundle();
      var parsed = pluginUpdatesSource(b.source);
      pluginUpdatesVersion(b.version);
      var version = await manifest(parsed, request.signal);
      if (detached || token !== generation) return;
      emit({ phase: pluginUpdatesCompare(version, b.version) > 0 ? 'available' : 'current', latest: version, current: b.version, source: b.source });
    } catch (e) {
      if (!detached && token === generation) emit({ phase: 'error', error: String(e.message || e) });
    } finally { request.abort(); }
  }
  async function update() {
    if (detached || updating || state.phase !== 'available') return;
    updating = true;
    var checked = state, removed = false;
    emit({ phase: 'confirming', error: null });
    try {
      if (!await options.confirm(checked)) { emit({ phase: 'available' }); return; }
      if (detached) return;
      var b = await bundle();
      if (detached) return;
      if (b.source !== checked.source || b.version !== checked.current) throw new Error('Installed source/version changed; check again');
      if (b.readOnlyReason || !b.removable) throw new Error('Bundle cannot be safely replaced: ' + (b.readOnlyReason || 'not-removable'));
      if (typeof b.enabled !== 'boolean') throw new Error('Bundle enabled state is unknown; refusing to change activation');
      pluginUpdatesSource(b.source);
      emit({ phase: 'updating' });
      var result, restart = false;
      try { result = pluginUpdatesChange(await manager.installBundle(b.source, { enabled: b.enabled })); }
      catch (e) {
        if (e.code !== 'already-installed') throw e;
        if (detached) return;
        var removal = pluginUpdatesChange(await manager.removeBundle(options.pluginId));
        removed = true;
        restart = removal.application === 'restart-required';
        result = pluginUpdatesChange(await manager.installBundle(b.source, { enabled: b.enabled }));
      }
      if (result.bundle && result.bundle !== options.pluginId) throw new Error('Installed bundle name mismatch');
      var installedVersion = result.version;
      if (!installedVersion) {
        var installed = await bundle();
        if (installed.source !== b.source || installed.enabled !== b.enabled) throw new Error('Installed source/activation state does not match the requested update');
        installedVersion = installed.version;
      }
      pluginUpdatesVersion(installedVersion);
      if (pluginUpdatesCompare(installedVersion, checked.latest) < 0) throw new Error('Installed version is older than the checked GitHub manifest; check again');
      emit({ phase: options.restartRequired || restart || result.application === 'restart-required' ? 'restart' : 'updated', current: installedVersion });
    } catch (e) {
      emit({ phase: 'error', error: String(e.message || e) + (removed ? ' — Reinstall manually from: ' + checked.source : '') });
    } finally { updating = false; }
  }
  return {
    getSnapshot: function () { return state; },
    subscribe: function (f) { listeners.add(f); return function () { listeners.delete(f); }; },
    check: check, update: update,
    dispose: function () { detached = true; generation++; if (abort) abort.abort(); listeners.clear(); }
  };
}
function createPluginUpdates(config) {
  var React = require('react');
  var namespace = 'pluginUpdates.' + config.pluginId + '.' + config.entryId;
  var en = {
    sessionWarning: 'Session Delete needs a DSH restart. Pending deletion requests may execute then; review /session-delete status first.',
    check: 'Check latest GitHub version', again: 'Check again', update: 'Update',
    idle: 'Check the installed GitHub source for updates.', checking: 'Checking…',
    available: 'Update available', current: 'Up to date', confirming: 'Awaiting confirmation…',
    updating: 'Updating…', updated: 'Updated. Refresh this page.', restart: 'Updated. Restart DSH, then refresh this page.', error: 'Update failed',
    confirm: 'Update by reinstalling this exact GitHub source? If already installed, the bundle will first be removed. Saved configuration is retained by the manager, but reinstall can fail and leave the plugin removed. You may need to reinstall manually. Do not close the page until finished. Source:'
  };
  var ko = {
    sessionWarning: '세션 삭제는 DSH 재시작이 필요합니다. 예약된 삭제가 그때 처리될 수 있으므로 먼저 /session-delete status로 확인하세요.',
    check: 'GitHub 최신 버전 확인', again: '다시 확인', update: '업데이트',
    idle: '설치된 GitHub 소스의 최신 버전을 확인합니다.', checking: '확인 중…',
    available: '업데이트 가능', current: '최신 버전입니다', confirming: '확인 대기 중…',
    updating: '업데이트 중…', updated: '업데이트 완료. 페이지를 새로고침하세요.', restart: '업데이트 완료. DSH를 재시작한 뒤 새로고침하세요.', error: '업데이트 실패',
    confirm: '동일한 GitHub 소스를 다시 설치할까요? 이미 설치되어 있으면 먼저 번들을 제거합니다. 관리자가 저장된 설정을 유지하지만 재설치 실패 시 플러그인이 제거된 채 남을 수 있습니다. 수동 재설치가 필요할 수 있습니다. 완료될 때까지 페이지를 닫지 마세요. 소스:'
  };
  return { inject: ['slots', 'locale'], apply: function (ctx) {
    var t = ctx.locale.bind(namespace);
    ctx.effect(function () { return ctx.locale.register(namespace, { en: en, ko: ko }); });
    ctx.inject(['remote', 'remote.pluginManager'], function (live) {
      var controller = createPluginUpdatesController({ pluginId: config.pluginId, restartRequired: config.pluginId === 'dsh-session-delete', manager: live.remote.pluginManager,
        confirm: function (s) { return globalThis.confirm(t('confirm') + '\n' + s.source + (config.pluginId === 'dsh-session-delete' ? '\n' + t('sessionWarning') : '')); } });
      live.effect(function () { return function () { controller.dispose(); }; });
      function Card(props) {
        var s = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
        if (props && props.view === 'summary') return React.createElement('span', null, t('update'));
        var busy = ['checking', 'confirming', 'updating'].includes(s.phase);
        var buttonStyle = { border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 'var(--dsw-radius-md)', background: 'transparent', color: 'inherit', padding: '6px 10px', font: 'inherit', cursor: busy ? 'default' : 'pointer' };
        return React.createElement('div', { style: { display: 'grid', gap: 8, fontSize: 13 } },
          React.createElement('strong', null, config.title + ' · ' + t('update')),
          React.createElement('div', { role: s.phase === 'error' ? 'alert' : 'status', 'aria-live': 'polite' },
            t(s.phase), s.current ? ' (' + s.current + (s.latest ? ' → ' + s.latest : '') + ')' : '', s.error ? ': ' + s.error : ''),
          React.createElement('div', { style: { display: 'flex', gap: 8 } },
            React.createElement('button', { type: 'button', style: buttonStyle, disabled: busy, onClick: function () { void controller.check(); } }, t(s.phase === 'idle' ? 'check' : 'again')),
            s.phase === 'available' ? React.createElement('button', { type: 'button', style: buttonStyle, disabled: busy, onClick: function () { void controller.update(); } }, t('update')) : null));
      }
      live.effect(function () { return live.slots.inject('plugins.row.config', function () {
        return live.slots.register({ name: 'plugins.row.config', key: config.pluginId + '#' + config.entryId, locale: namespace }, Card);
      }); });
    });
  } };
}

function pluginCollectionSpec(repository, dir, ref) {
  var base = String(repository || '').trim().replace(/\/+$/, '').replace(/\.git$/, '');
  var path = String(dir || '').replace(/^\/+/, '').replace(/\/+$/, '');
  var fragment = [ref && ref !== 'HEAD' ? ref : '', path ? 'path:/' + path : ''].filter(Boolean).join('&');
  return 'git+' + base + '.git' + (fragment ? '#' + fragment : '');
}
function pluginCollectionParsed(source) {
  try { return pluginUpdatesSource(source); } catch (_) { return null; }
}
function pluginCollectionSameSource(left, right) {
  var a = pluginCollectionParsed(left), b = pluginCollectionParsed(right);
  if (!a || !b) return false;
  if (a.owner.toLowerCase() !== b.owner.toLowerCase()) return false;
  if (a.repo.toLowerCase() !== b.repo.toLowerCase()) return false;
  if (a.path !== b.path) return false;
  if (a.ref.toLowerCase() === b.ref.toLowerCase()) return true;
  return a.ref === 'HEAD' || b.ref === 'HEAD';
}
function pluginCollectionRepo(source, fallback, branch) {
  var parsed = pluginCollectionParsed(source);
  if (parsed) return { owner: parsed.owner, repo: parsed.repo, ref: parsed.ref };
  var url = null;
  try { url = new URL(String(fallback || '')); } catch (_) { url = null; }
  var match = url && /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.pathname);
  if (!match) throw new Error('The collection source is not a GitHub repository');
  return { owner: match[1], repo: match[2], ref: branch || 'main' };
}
function pluginCollectionManifestURL(repo, dir) {
  var path = String(dir || '').replace(/^\/+/, '').replace(/\/+$/, '');
  return 'https://raw.githubusercontent.com/' + repo.owner + '/' + repo.repo + '/' + encodeURIComponent(repo.ref) + '/' +
    (path ? path.split('/').map(encodeURIComponent).join('/') + '/' : '') + 'package.json';
}
function pluginCollectionRowStatus(row, spec) {
  if (!row.installed) return 'missing';
  if (!pluginCollectionSameSource(row.source, spec)) return 'foreign';
  return pluginCollectionStatus(row.version, row.latest);
}
function pluginCollectionStatus(installedVersion, latest) {
  if (!installedVersion || !latest) return 'unknown';
  try { return pluginUpdatesCompare(latest, installedVersion) > 0 ? 'available' : 'current'; } catch (_) { return 'unknown'; }
}
function pluginCollectionAlreadyInstalled(result) {
  if (!result) return false;
  if (result.ok === true) {
    var value = result.value;
    return !!(value && value.error && value.error.code === 'already-installed');
  }
  return !!(result.error && result.error.code === 'already-installed');
}
function pluginCollectionFetchVersion(fetcher, repo, dir, name, signal, timeoutMs) {
  var timer;
  var request = (async function () {
    var response = await fetcher(pluginCollectionManifestURL(repo, dir), { signal: signal, cache: 'no-store', credentials: 'omit' });
    if (!response.ok) throw new Error('GitHub manifest HTTP ' + response.status);
    var data = await response.json();
    if (!data || data.name !== name) throw new Error('GitHub manifest package name mismatch');
    pluginUpdatesVersion(data.version);
    return data.version;
  })();
  var timeout = new Promise(function (_, reject) {
    timer = setTimeout(function () { reject(new Error('GitHub manifest request timed out')); }, timeoutMs || 15000);
  });
  return Promise.race([request, timeout]).finally(function () { clearTimeout(timer); });
}
function createPluginCollectionController(options) {
  var manager = options.manager;
  var fetcher = options.fetch || globalThis.fetch;
  var plugins = (options.plugins || []).map(function (entry) {
    return { name: entry.name, dir: entry.dir || '', title: entry.title, description: entry.description, restart: entry.restart === true,
      spec: pluginCollectionSpec(options.repository, entry.dir || '') };
  });
  var byName = {};
  plugins.forEach(function (plugin) { byName[plugin.name] = plugin; });
  var state = {
    phase: 'idle', repo: null, hubVersion: null, error: null, restart: false,
    rows: plugins.map(function (plugin) {
      return { name: plugin.name, installed: false, enabled: false, version: null, latest: null, status: 'unknown', source: null, busy: false, error: null };
    })
  };
  var listeners = new Set(), detached = false, generation = 0, abort = null, applying = false;
  function emit(patch) {
    state = Object.assign({}, state, patch || {});
    if (!detached) listeners.forEach(function (listener) { listener(); });
  }
  function rowOf(name) { return state.rows.filter(function (row) { return row.name === name; })[0]; }
  function patchRow(name, patch) {
    emit({ rows: state.rows.map(function (row) { return row.name === name ? Object.assign({}, row, patch) : row; }) });
  }
  async function bundleRecords() {
    var list = pluginUpdatesUnwrap(await manager.listBundles());
    if (!Array.isArray(list)) throw new Error('Invalid bundle list');
    return list;
  }
  function bundleOf(list, name) {
    var matches = list.filter(function (bundle) { return bundle && bundle.name === name; });
    if (matches.length > 1) throw new Error('Bundle is listed more than once: ' + name);
    return matches.length === 1 ? matches[0] : null;
  }
  function repoOf(list) {
    var hub = bundleOf(list, options.packageName);
    return pluginCollectionRepo(hub && hub.source, options.repository, options.branch);
  }
  function specFor(plugin) {
    var repo = state.repo;
    return repo ? pluginCollectionSpec('https://github.com/' + repo.owner + '/' + repo.repo, plugin.dir, repo.ref) : plugin.spec;
  }
  function describe(list, plugin, previous) {
    var bundle = bundleOf(list, plugin.name);
    var installed = !!(bundle && bundle.installed);
    var source = bundle && typeof bundle.source === 'string' ? bundle.source : null;
    var version = installed && typeof bundle.version === 'string' ? bundle.version : null;
    var latest = previous && typeof previous.latest === 'string' ? previous.latest : null;
    var row = {
      name: plugin.name, installed: installed, enabled: installed && bundle.enabled === true,
      version: version, latest: latest, source: source, busy: false, error: null
    };
    row.status = pluginCollectionRowStatus(row, specFor(plugin));
    return row;
  }
  function hubVersionOf(list) {
    var self = bundleOf(list, options.packageName);
    return self && typeof self.version === 'string' ? self.version : null;
  }
  async function refresh() {
    if (detached || applying) return;
    var token = ++generation;
    try {
      var list = await bundleRecords();
      if (detached || token !== generation) return;
      emit({ repo: repoOf(list) });
      emit({ rows: state.rows.map(function (row) { return describe(list, byName[row.name], row); }), hubVersion: hubVersionOf(list), error: null });
    } catch (error) {
      if (!detached && token === generation) emit({ phase: 'error', error: String(error.message || error) });
    }
  }
  async function check() {
    if (detached || applying) return;
    var token = ++generation;
    if (abort) abort.abort();
    abort = new AbortController();
    var request = abort;
    emit({ phase: 'checking', error: null });
    try {
      var list = await bundleRecords();
      if (detached || token !== generation) return;
      var repo = repoOf(list);
      emit({ repo: repo });
      var rows = state.rows.map(function (row) { return describe(list, byName[row.name], row); });
      emit({ rows: rows, repo: repo, hubVersion: hubVersionOf(list) });
      var results = await Promise.all(rows.map(function (row) {
        var plugin = byName[row.name];
        return pluginCollectionFetchVersion(fetcher, repo, plugin.dir, plugin.name, request.signal, options.timeoutMs)
          .then(function (version) { return { name: plugin.name, version: version }; },
            function (error) { return { name: plugin.name, error: String((error && error.message) || error) }; });
      }));
      if (detached || token !== generation) return;
      var versions = {}, failures = {};
      results.forEach(function (result) { if (result.error) failures[result.name] = result.error; else versions[result.name] = result.version; });
      emit({ phase: 'checked', rows: state.rows.map(function (row) {
        var latest = versions[row.name] !== undefined ? versions[row.name] : row.latest;
        var patch = { latest: failures[row.name] ? null : latest, error: failures[row.name] || null };
        patch.status = pluginCollectionRowStatus(Object.assign({}, row, patch), specFor(byName[row.name]));
        return Object.assign({}, row, patch);
      }) });
    } catch (error) {
      if (!detached && token === generation) emit({ phase: 'error', error: String((error && error.message) || error) });
    } finally { request.abort(); }
  }
  async function applyRow(name, skipConfirm) {
    var row = rowOf(name), plugin = byName[name];
    if (!row || !plugin || detached) return;
    if (row.status !== 'missing' && row.status !== 'available') return;
    if (!skipConfirm && options.confirm && !options.confirm(row.status === 'missing' ? 'confirmInstall' : 'confirmUpdate', plugin)) return;
    generation++;
    if (abort) abort.abort();
    var restart = state.restart;
    patchRow(name, { busy: true, error: null });
    emit({ phase: 'applying', error: null });
    try {
      var list = await bundleRecords();
      var bundle = bundleOf(list, name);
      var installed = !!(bundle && bundle.installed);
      var target = specFor(plugin);
      var spec = installed && pluginCollectionSameSource(bundle.source, target) ? bundle.source : target;
      var enabled = installed ? bundle.enabled : true;
      if (installed && typeof bundle.enabled !== 'boolean') throw new Error('Plugin activation state is unknown; refusing to change it');
      var raw = await manager.installBundle(spec, { enabled: enabled });
      if (pluginCollectionAlreadyInstalled(raw)) {
        pluginUpdatesChange(await manager.removeBundle(name));
        restart = true;
        raw = await manager.installBundle(spec, { enabled: enabled });
      }
      var result = pluginUpdatesChange(raw);
      if (result.application === 'restart-required' || plugin.restart) restart = true;
      if (detached) return;
      var after = await bundleRecords();
      var afterBundle = bundleOf(after, name);
      if (!afterBundle || afterBundle.installed !== true) throw new Error('The plugin manager did not report the plugin as installed');
      var version = typeof afterBundle.version === 'string' ? afterBundle.version : null;
      if (!version) throw new Error('Installed version is unknown; check again');
      if (row.latest && pluginUpdatesCompare(version, row.latest) < 0) throw new Error('Installed version is older than the checked GitHub version; check again');
      emit({ rows: state.rows.map(function (item) {
        return item.name === name ? describe(after, plugin, item) : item;
      }), hubVersion: hubVersionOf(after), phase: 'checked', restart: restart });
    } catch (error) {
      var message = String((error && error.message) || error);
      patchRow(name, { busy: false, error: message });
      emit({ phase: 'error', error: message, restart: restart });
    }
  }
  async function applyOne(name) {
    if (detached || applying) return;
    applying = true;
    try { await applyRow(name, false); } finally { applying = false; }
  }
  async function applyAll() {
    if (detached || applying) return;
    var actionable = state.rows.filter(function (row) { return row.status === 'missing' || row.status === 'available'; });
    if (!actionable.length) return;
    if (options.confirm && !options.confirm('confirmAll', actionable.map(function (row) { return byName[row.name]; }))) return;
    applying = true;
    try {
      for (var index = 0; index < actionable.length; index++) {
        if (detached) return;
        await applyRow(actionable[index].name, true);
      }
    } finally { applying = false; }
  }
  return {
    getSnapshot: function () { return state; },
    subscribe: function (listener) { listeners.add(listener); return function () { listeners.delete(listener); }; },
    refresh: refresh, check: check, applyOne: applyOne, applyAll: applyAll,
    dispose: function () { detached = true; generation++; if (abort) abort.abort(); listeners.clear(); }
  };
}
function createPluginCollection(config) {
  var React = require('react');
  var h = React.createElement;
  var namespace = 'pluginCollection.' + config.packageName;
  var en = {
    title: 'Plugin collection', hubVersion: 'Collection manager', empty: 'This collection declares no plugins.',
    check: 'Check for updates', recheck: 'Check again', checking: 'Checking GitHub versions…',
    applyAll: 'Install or update all', idle: 'Check the installed GitHub source for each plugin version.',
    checked: 'Versions checked.', applying: 'Applying changes…', error: 'Collection error',
    restart: 'Restart DSH and refresh this page to load the changes.',
    install: 'Install', update: 'Update',
    'status.missing': 'Not installed', 'status.available': 'Update available', 'status.current': 'Up to date',
    'status.unknown': 'Version unknown', 'status.foreign': 'Installed from another source',
    confirmInstall: 'Install this plugin from its GitHub source now?', confirmUpdate: 'Update this plugin by reinstalling its GitHub source? Saved configuration is retained, but reinstalling can fail and leave the plugin removed.',
    confirmAll: 'Install or update the listed plugins from their GitHub sources now? Saved configuration is retained, but reinstalling can fail and leave a plugin removed. Do not close the page until finished.',
    foreignNote: 'This plugin is installed from a source this collection does not manage. Install it from the collection source to manage updates here.'
  };
  var ko = {
    title: '플러그인 컬렉션', hubVersion: '컬렉션 관리자', empty: '이 컬렉션에는 플러그인이 없습니다.',
    check: '업데이트 확인', recheck: '다시 확인', checking: 'GitHub 버전 확인 중…',
    applyAll: '전체 설치·업데이트', idle: '설치된 GitHub 소스에서 각 플러그인의 최신 버전을 확인합니다.',
    checked: '버전을 확인했습니다.', applying: '변경 적용 중…', error: '컬렉션 오류',
    restart: 'DSH를 재시작한 뒤 이 페이지를 새로고침하면 변경 사항이 적용됩니다.',
    install: '설치', update: '업데이트',
    'status.missing': '미설치', 'status.available': '업데이트 가능', 'status.current': '최신 버전',
    'status.unknown': '버전 확인 불가', 'status.foreign': '다른 소스로 설치됨',
    confirmInstall: '이 플러그인을 GitHub 소스에서 지금 설치할까요?', confirmUpdate: '동일한 GitHub 소스로 다시 설치해 업데이트할까요? 저장된 설정은 유지되지만 재설치가 실패하면 플러그인이 제거된 채 남을 수 있습니다.',
    confirmAll: '목록의 플러그인을 GitHub 소스에서 지금 설치·업데이트할까요? 저장된 설정은 유지되지만 재설치가 실패하면 플러그인이 제거된 채 남을 수 있습니다. 완료될 때까지 페이지를 닫지 마세요.',
    foreignNote: '이 플러그인은 이 컬렉션이 관리하지 않는 소스로 설치되어 있습니다. 여기서 업데이트하려면 컬렉션 소스로 설치하세요.'
  };
  var zh = {
    title: '插件合集', hubVersion: '合集管理', empty: '此合集未声明插件。',
    check: '检查更新', recheck: '重新检查', checking: '正在检查 GitHub 版本…',
    applyAll: '安装或更新全部', idle: '从已安装的 GitHub 源检查各插件的版本。',
    checked: '版本已检查。', applying: '正在应用更改…', error: '合集错误',
    restart: '请重新启动 DSH 并刷新此页面以应用更改。',
    install: '安装', update: '更新',
    'status.missing': '未安装', 'status.available': '有可用更新', 'status.current': '已是最新',
    'status.unknown': '版本未知', 'status.foreign': '从其他源安装',
    confirmInstall: '现在从 GitHub 源安装此插件吗？', confirmUpdate: '通过重新安装其 GitHub 源来更新此插件吗？已保存的配置会保留，但重新安装失败可能导致插件被移除。',
    confirmAll: '现在从 GitHub 源安装或更新列出的插件吗？已保存的配置会保留，但重新安装失败可能导致插件被移除。完成前请勿关闭页面。',
    foreignNote: '此插件是从本合集不管理的源安装的。若要在此管理更新，请使用合集源安装。'
  };
  return { inject: ['slots', 'locale'], apply: function (ctx) {
    var t = ctx.locale.bind(namespace);
    ctx.effect(function () { return ctx.locale.register(namespace, { en: en, ko: ko, zh: zh }); });
    ctx.inject(['remote', 'remote.pluginManager'], function (live) {
      var controller = createPluginCollectionController({
        manager: live.remote.pluginManager, packageName: config.packageName, repository: config.repository, branch: config.branch,
        plugins: config.plugins,
        confirm: function (key, detail) {
          var subject = Array.isArray(detail) ? detail.map(function (plugin) { return ctx.locale.resolveText(plugin.title) || plugin.name; }).join('\n') : detail ? (ctx.locale.resolveText(detail.title) || detail.name) : '';
          return globalThis.confirm(t(key) + (subject ? '\n' + subject : ''));
        }
      });
      live.effect(function () { return function () { controller.dispose(); }; });
      var buttonStyle = { border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 'var(--dsw-radius-md)', background: 'transparent', color: 'inherit', padding: '6px 10px', font: 'inherit', cursor: 'pointer' };
      var hintStyle = { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: 1.5 };
      function button(label, disabled, onClick, key) {
        return h('button', { key: key, type: 'button', style: Object.assign({}, buttonStyle, disabled ? { opacity: 0.5, cursor: 'default' } : null), disabled: disabled, onClick: onClick }, label);
      }
      function Card(props) {
        var snapshot = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
        React.useEffect(function () { void controller.refresh(); }, []);
        if (props && props.view === 'summary') return h('span', null, t('title'));
        var busy = snapshot.phase === 'checking' || snapshot.phase === 'applying';
        var actionable = snapshot.rows.filter(function (row) { return row.status === 'missing' || row.status === 'available'; }).length;
        var rows = snapshot.rows.map(function (row) {
          var plugin = config.plugins.filter(function (entry) { return entry.name === row.name; })[0];
          var label = plugin ? (ctx.locale.resolveText(plugin.title) || plugin.name) : row.name;
          var versionText = !row.installed ? t('status.missing') : (row.version || '—') + (row.latest ? ' → ' + row.latest : '');
          var action = row.status === 'missing' ? button(t('install'), busy || row.busy, function () { void controller.applyOne(row.name); }, 'a')
            : row.status === 'available' ? button(t('update'), busy || row.busy, function () { void controller.applyOne(row.name); }, 'a') : null;
          return h('div', { key: row.name, style: { display: 'grid', gap: 8, gridTemplateColumns: 'minmax(0, 1fr) auto auto', alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--dsw-alias-border-l3)' } }, [
            h('div', { key: 'id', style: { display: 'grid', gap: 2, minWidth: 0 } }, [
              h('span', { key: 'n', style: { fontWeight: 500 } }, label),
              h('span', { key: 'm', style: hintStyle }, row.name + ' · ' + versionText + (row.error ? ' · ' + row.error : row.status === 'foreign' ? ' · ' + t('foreignNote') : ''))
            ]),
            h('span', { key: 's', style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, t('status.' + row.status)),
            action
          ]);
        });
        return h('div', { style: { display: 'grid', gap: 10, fontSize: 13 } }, [
          h('div', { key: 'head', style: { display: 'grid', gap: 2 } }, [
            h('strong', { key: 't' }, t('title')),
            h('span', { key: 'v', style: hintStyle }, t('hubVersion') + ' ' + (snapshot.hubVersion || '—'))
          ]),
          h('div', { key: 'status', role: snapshot.phase === 'error' ? 'alert' : 'status', 'aria-live': 'polite' }, t(snapshot.phase)),
          h('div', { key: 'actions', style: { display: 'flex', flexWrap: 'wrap', gap: 8 } }, [
            button(busy && snapshot.phase === 'checking' ? t('checking') : t(snapshot.phase === 'idle' ? 'check' : 'recheck'), busy, function () { void controller.check(); }, 'c'),
            actionable ? button(t('applyAll') + ' (' + actionable + ')', busy, function () { void controller.applyAll(); }, 'all') : null
          ]),
          rows.length ? h('div', { key: 'rows' }, rows) : h('p', { key: 'rows', style: hintStyle }, t('empty')),
          snapshot.restart ? h('p', { key: 'restart', role: 'status', style: { margin: 0 } }, t('restart')) : null,
          snapshot.error ? h('p', { key: 'err', role: 'alert', style: { margin: 0 } }, t('error') + ': ' + snapshot.error) : null
        ]);
      }
      live.effect(function () { return ctx.on('connection/reset', function () { void controller.refresh(); }); });
      live.effect(function () { return live.slots.inject('plugins.bundle.config', function () {
        return live.slots.register({ name: 'plugins.bundle.config', key: config.packageName, locale: namespace }, Card);
      }); });
    });
  } };
}
    return createPluginCollection({"packageName":"dsh-plugins","repository":"https://github.com/chdigda/plugins","branch":"main","plugins":[{"name":"dsh-web-search","dir":"packages/dsh-web-search","title":{"en":"Web Search","ko":"웹 검색","zh":"网页搜索"},"description":{"en":"Switchable Tavily and Brave search with secure API key settings.","ko":"Tavily·Brave 검색 전환과 안전한 API 키 설정 화면을 제공합니다.","zh":"可切换 Tavily 与 Brave 搜索，并提供安全的 API 密钥设置。"},"restart":false},{"name":"dsh-session-delete","dir":"packages/dsh-session-delete","title":{"en":"Session Delete","ko":"세션 영구 삭제","zh":"会话永久删除"},"description":{"en":"Confirmed permanent session deletion on the next DSH restart.","ko":"확인 후 다음 DSH 재시작 때 세션을 영구 삭제합니다.","zh":"确认后在下一次 DSH 重启时永久删除会话。"},"restart":true}]});
  },
});
