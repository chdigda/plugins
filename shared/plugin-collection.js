function pluginCollectionSpec(repository, dir) {
  var base = String(repository || '').trim().replace(/\/+$/, '').replace(/\.git$/, '');
  var path = String(dir || '').replace(/^\/+/, '').replace(/\/+$/, '');
  return 'git+' + base + '.git' + (path ? '#path:/' + path : '');
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
      return { name: plugin.name, installed: false, enabled: false, version: null, latest: null, status: 'missing', source: null, busy: false, error: null };
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
    row.status = !installed ? 'missing' : !pluginCollectionParsed(source) ? 'foreign' : latest ? pluginCollectionStatus(version, latest) : 'unknown';
    return row;
  }
  function hubVersionOf(list) {
    var self = bundleOf(list, options.packageName);
    return self && typeof self.version === 'string' ? self.version : null;
  }
  async function refresh() {
    if (detached || applying) return;
    var list = await bundleRecords();
    emit({ rows: state.rows.map(function (row) { return describe(list, byName[row.name], row); }), hubVersion: hubVersionOf(list), error: null });
  }
  async function check() {
    if (detached || applying) return;
    var token = ++generation;
    if (abort) abort.abort();
    abort = new AbortController();
    var request = abort;
    emit({ phase: 'checking', error: null, restart: false });
    try {
      var list = await bundleRecords();
      var repo = pluginCollectionRepo(bundleOf(list, options.packageName) && bundleOf(list, options.packageName).source, options.repository, options.branch);
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
        var patch = { latest: latest };
        if (failures[row.name]) { patch.error = failures[row.name]; patch.status = row.installed ? 'unknown' : 'missing'; }
        else patch.status = row.installed ? pluginCollectionStatus(row.version, latest) : 'missing';
        return Object.assign({}, row, patch);
      }) });
    } catch (error) {
      if (!detached && token === generation) emit({ phase: 'error', error: String((error && error.message) || error) });
    } finally { request.abort(); }
  }
  async function applyRow(name, skipConfirm) {
    var row = rowOf(name), plugin = byName[name];
    if (!row || !plugin || detached || applying) return;
    if (row.status !== 'missing' && row.status !== 'available') return;
    if (!skipConfirm && options.confirm && !options.confirm(row.status === 'missing' ? 'confirmInstall' : 'confirmUpdate', plugin)) return;
    applying = true;
    var restart = state.restart;
    patchRow(name, { busy: true, error: null });
    emit({ phase: 'applying', error: null });
    try {
      var list = await bundleRecords();
      var bundle = bundleOf(list, name);
      var installed = !!(bundle && bundle.installed);
      var spec = installed && typeof bundle.source === 'string' ? bundle.source : plugin.spec;
      var enabled = installed ? bundle.enabled : true;
      if (installed && typeof bundle.enabled !== 'boolean') throw new Error('Plugin activation state is unknown; refusing to change it');
      pluginCollectionParsed(spec);
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
      var repo = state.repo || pluginCollectionRepo(afterBundle.source, options.repository, options.branch);
      emit({ rows: state.rows.map(function (item) {
        if (item.name !== name) return item;
        return Object.assign({}, item, { installed: true, enabled: enabled, version: version, source: afterBundle.source || item.source,
          status: row.latest ? pluginCollectionStatus(version, row.latest) : 'unknown', busy: false, error: null });
      }), repo: repo, hubVersion: hubVersionOf(after), phase: 'checked', restart: restart });
    } catch (error) {
      var message = String((error && error.message) || error);
      patchRow(name, { busy: false, error: message });
      emit({ phase: 'error', error: message, restart: restart });
    } finally { applying = false; }
  }
  async function applyAll() {
    if (detached || applying) return;
    var actionable = state.rows.filter(function (row) { return row.status === 'missing' || row.status === 'available'; });
    if (!actionable.length) return;
    if (options.confirm && !options.confirm('confirmAll', actionable.map(function (row) { return byName[row.name]; }))) return;
    for (var index = 0; index < actionable.length; index++) {
      if (detached) return;
      var row = rowOf(actionable[index].name);
      if (!row || (row.status !== 'missing' && row.status !== 'available')) continue;
      await applyRow(row.name, true);
    }
  }
  return {
    getSnapshot: function () { return state; },
    subscribe: function (listener) { listeners.add(listener); return function () { listeners.delete(listener); }; },
    refresh: refresh, check: check, applyOne: function (name) { return applyRow(name, false); }, applyAll: applyAll,
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