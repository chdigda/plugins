import { readFile, writeFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const read = async path => (await readFile(new URL(path, root), 'utf8')).replace(/\r\n/g, '\n');
const shared = await read('shared/plugin-updates.js');
const collection = await read('shared/plugin-collection.js');
const manifest = JSON.parse(await read('collection.json'));
const checking = process.argv.includes('--check');
async function output(path, content) {
  if (checking) {
    if (await read(path) !== content) throw new Error(path + ' is stale. Run npm run build.');
  } else await writeFile(new URL(path, root), content);
}
const nl = String.fromCharCode(10);
const source = await read('packages/dsh-web-search/client.mjs');
const marker = '    return { apply, inject, NS, SETTINGS_NS, WebSearchCardController, WebSearchCard };';
if (source.split(marker).length !== 2) throw new Error('Web search client integration marker changed');
const web = source.replace(marker, shared + nl + [
  '    const updates = createPluginUpdates({ pluginId: "dsh-web-search", entryId: "web-search", title: "Web Search" });',
  '    return { inject: [...new Set([...inject, ...updates.inject])], apply(ctx) { apply(ctx); updates.apply(ctx); } };',
].join(nl));
await output('packages/dsh-web-search/client-bundle.mjs', web);
await output('packages/dsh-session-delete/client.mjs', [
  'window.__ModuleLoader__.load({',
  '  id: "dsh-session-delete",',
  '  factory(require) {', shared,
  '    return createPluginUpdates({ pluginId: "dsh-session-delete", entryId: "session-delete", title: "Session Delete" });',
  '  },', '});', '',
].join(nl));
const config = {
  packageName: 'dsh-plugins',
  repository: manifest.repository,
  branch: manifest.branch,
  plugins: manifest.plugins.map(plugin => ({
    name: plugin.name,
    dir: plugin.dir,
    title: plugin.title,
    description: plugin.description,
    restart: plugin.restart === true,
  })),
};
await output('client-bundle.mjs', [
  'window.__ModuleLoader__.load({',
  '  id: "dsh-plugins",',
  '  factory(require) {', shared, collection,
  '    return createPluginCollection(' + JSON.stringify(config) + ');',
  '  },', '});', '',
].join(nl));
console.log(checking ? 'Client artifacts are current.' : 'Built independent plugin clients.');