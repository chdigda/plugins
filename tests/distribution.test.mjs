import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
for (const name of ['dsh-web-search', 'dsh-session-delete']) {
  test(name + ' has standalone distribution files and valid client factory', async () => {
    const base = new URL('packages/' + name + '/', root);
    const p = JSON.parse(await readFile(new URL('package.json', base), 'utf8'));
    assert.equal(p.name, name);
    assert.equal(p.version, '0.3.0');
    assert.equal(p.dsh.client.platform, 'web');
    assert.ok(!p.scripts.prepare && !p.scripts.postinstall && !p.scripts.install);
    for (const path of [...p.files, ...Object.values(p.exports), p.dsh.bundle.patch]) await access(new URL(path, base));
    for (const file of p.files.filter(f => f.endsWith('.mjs'))) {
      const code = await readFile(new URL(file, base), 'utf8');
      for (const [, target] of code.matchAll(/from ['"]([^'"]+)['"]/g)) if (target.startsWith('.')) {
        assert.ok(!target.includes('../'), 'no monorepo parent imports');
        assert.ok(p.files.includes(target.slice(2)), target + ' must ship');
      }
    }
    const code = await readFile(new URL(p.exports['./client'], base), 'utf8');
    let record;
    vm.runInNewContext(code, { window: { __ModuleLoader__: { load: r => { assert.equal(record, undefined); record = r; } } } });
    assert.equal(record.id, name);
    const plugin = record.factory(spec => {
      if (spec === 'react') return {};
      if (spec === 'react/jsx-runtime') return { jsx() {}, jsxs() {} };
      if (spec === '@deepseek-ai/dsh-client-ui-primitives') return { SettingsFormModel: class {} };
      if (spec === '@deepseek-ai/dsh-client-store') return { createSnapshotStore() {} };
      throw new Error('Unexpected browser dependency: ' + spec);
    });
    assert.equal(typeof plugin.apply, 'function');
    assert.ok(Array.from(plugin.inject).includes('slots'));
    assert.ok(Array.from(plugin.inject).includes('locale'));
    assert.match(code, /createPluginUpdates/);
    assert.match(code, /plugins.row.config/);
  });
}
