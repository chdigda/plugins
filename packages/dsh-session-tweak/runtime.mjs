import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function loadRuntime() {
  let req;
  for (const entry of [process.env.DSH_RUNTIME_ENTRY, process.argv[1], fileURLToPath(import.meta.url)].filter(Boolean)) {
    const candidate = createRequire(resolve(entry));
    try {
      const version = candidate('@deepseek-ai/dsh/package.json').version;
      if (version !== '0.2.2-rc.1') throw Object.assign(new Error('Session rewriting requires DSH 0.2.2-rc.1.'), { code: 'runtime-unsupported' });
      req = candidate;
      break;
    } catch (error) {
      if (!['MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error.code)) throw error;
    }
  }
  if (!req) throw Object.assign(new Error('Cannot resolve the installed DSH 0.2.2-rc.1 runtime.'), { code: 'runtime-unsupported' });
  const { symbols } = req('@deepseek-ai/cordis');
  const { Session, KNOWN_SESSION_EVENT_TYPES } = req('@deepseek-ai/dsh-session');
  const { assertReleasedV4Relationships } = req('@deepseek-ai/dsh-session-format-v3-to-v4');
  const { sessionFormatCatalog } = req('@deepseek-ai/dsh-session-format-catalog');
  const { currentSessionMessageProjections } = req('@deepseek-ai/dsh-session-format-catalog/message-projections');
  return { symbols, Session, sessionFormatCatalog, currentSessionMessageProjections, assertReleasedV4Relationships, KNOWN_SESSION_EVENT_TYPES };
}
