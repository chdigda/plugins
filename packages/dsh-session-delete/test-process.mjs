// Child-process helper: touches only caller-supplied temporary fixture paths.
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { runtimeRequire, processIdentity } from './runtime.mjs';
const [mode, path] = process.argv.slice(2);
if (mode === 'identity') {
  await writeFile(path, await processIdentity());
} else {
  // Independent implementation of DSH rc5's semaphore protocol (not our adapter).
  const req = createRequire(runtimeRequire().resolve('@deepseek-ai/dsh-session-persistence-jsonl'));
  const kernel = req('koffi').load('kernel32.dll');
  const create = kernel.func('__stdcall', 'CreateSemaphoreW', 'intptr', ['void*','int','int','str16']);
  const wait = kernel.func('__stdcall', 'WaitForSingleObject', 'uint', ['intptr','uint']);
  const release = kernel.func('__stdcall', 'ReleaseSemaphore', 'int', ['intptr','int','void*']);
  const close = kernel.func('__stdcall', 'CloseHandle', 'int', ['intptr']);
  const name = 'Local\\dsh-session-lock-' + createHash('sha256').update(resolve(path).toLowerCase()).digest('hex');
  const handle = create(null, 1, 1, name);
  if (!handle) throw new Error('CreateSemaphoreW failed');
  const result = wait(handle, 0);
  if (result === 258) { close(handle); process.exit(23); }
  if (result !== 0) { close(handle); throw new Error('WaitForSingleObject failed: ' + result); }
  if (mode === 'crash') process.exit(0); // Intentionally exit holding the kernel object.
  if (mode !== 'probe') throw new Error('unknown test mode');
  if (!release(handle, 1, null) || !close(handle)) throw new Error('semaphore release failed');
}
