import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ApiSearchProvider, FallbackSearchProvider } from './provider.mjs';

async function runtimeModule(specifier) {
  const anchors = [import.meta.url, process.env.DSH_RUNTIME_ENTRY, process.argv[1]];
  for (const anchor of anchors) {
    if (!anchor || !(anchor.startsWith('file:') || isAbsolute(anchor))) continue;
    try {
      const manifestPath = createRequire(anchor).resolve(specifier + '/package.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      const exported = manifest.exports?.['.'];
      const entry = typeof exported === 'string' ? exported : exported?.import ?? exported?.default ?? manifest.module ?? manifest.main;
      if (typeof entry !== 'string') throw new Error('DSH module has no supported ESM entry: ' + specifier);
      return await import(new URL(entry, pathToFileURL(manifestPath)).href);
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error('dsh-web-search must run inside DSH (or set DSH_RUNTIME_ENTRY to its CLI entry).');
}

const { default: z } = await runtimeModule('@deepseek-ai/schemastery');
const { credentialRef } = await runtimeModule('@deepseek-ai/dsh-credentials');
const { launchEnvironmentOf } = await runtimeModule('@deepseek-ai/dsh-launch-environment');
const { WebError } = await runtimeModule('@deepseek-ai/dsh-web');

export const name = 'web-search';
export const inject = ['web'];
export const Config = z.object({
  tavilyEnabled: z.boolean().default(true).volatile(),
  braveEnabled: z.boolean().default(true).volatile(),
  tavilyApiKeyEnv: z.string().role('credential-ref').default('TAVILY_API_KEY').volatile(),
  braveApiKeyEnv: z.string().role('credential-ref').default('BRAVE_SEARCH_API_KEY').volatile(),
  timeoutMs: z.number().step(1).min(500).max(25000).default(12000).volatile(),
  maxResponseBytes: z.number().step(1).min(1024).max(10000000).default(2000000).volatile(),
});

export function apply(ctx, config) {
  const makeError = (message, code) => new WebError(message, code);
  const create = (id, field) => new ApiSearchProvider(id, {
    makeError,
    options: () => ({ enabled: config[id + 'Enabled'].get(), apiKeyEnv: config[field].get(), timeoutMs: config.timeoutMs.get(), maxResponseBytes: config.maxResponseBytes.get() }),
    resolveKey: async options => {
      const ref = credentialRef(options.apiKeyEnv);
      const credentials = ctx.get('credentials');
      if (credentials) return (await credentials.resolve(ref))?.value;
      return launchEnvironmentOf(ctx).get(ref)?.value;
    },
  });
  const tavily = create('tavily', 'tavilyApiKeyEnv');
  const brave = create('brave', 'braveApiKeyEnv');
  ctx.web.registerSearchProvider(tavily);
  ctx.web.registerSearchProvider(brave);
  ctx.web.registerSearchProvider(new FallbackSearchProvider(tavily, brave, makeError));
  ctx.web.registerSearchProvider(new FallbackSearchProvider(brave, tavily, makeError));
}
