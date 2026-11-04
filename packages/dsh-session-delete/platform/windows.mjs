import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 258;

function win32Error(syscall, win32Code, path, name) {
  const code = ({ 2: 'ENOENT', 3: 'ENOENT', 5: 'EACCES', 17: 'EXDEV', 32: 'EBUSY', 80: 'EEXIST', 123: 'EINVAL', 183: 'EEXIST' })[win32Code] || 'EIO';
  return Object.assign(new Error(syscall + ' ' + code + ' (Win32 ' + win32Code + '): ' + path), {
    code, errno: win32Code, win32Code, syscall, path, dest: name,
  });
}

async function bindings(req) {
  let module;
  try {
    module = req('koffi');
  } catch (error) {
    if (error.code !== 'ERR_REQUIRE_ESM' && error.code !== 'ERR_REQUIRE_ASYNC_MODULE') throw error;
    module = await import(pathToFileURL(req.resolve('koffi')).href);
  }
  const kernel32 = (module.default || module).load('kernel32.dll');
  // HANDLE is pointer-sized on x64 and ARM64. Never coerce it to a 32-bit integer.
  return {
    create: kernel32.func('__stdcall', 'CreateSemaphoreW', 'intptr', ['void*', 'int', 'int', 'str16']),
    wait: kernel32.func('__stdcall', 'WaitForSingleObject', 'uint', ['intptr', 'uint']),
    release: kernel32.func('__stdcall', 'ReleaseSemaphore', 'int', ['intptr', 'int', 'void*']),
    close: kernel32.func('__stdcall', 'CloseHandle', 'int', ['intptr']),
    lastError: kernel32.func('__stdcall', 'GetLastError', 'uint', []),
  };
}

/**
 * Acquire the rc5 Local named semaphore for a session's lock path, without files.
 * req must be the require function supplied by runtimeRequire().
 * Contention rejects with code EBUSY; close releases once and always attempts CloseHandle.
 */
export async function acquireLock(path, req) {
  const api = await bindings(req);
  const name = 'Local\\dsh-session-lock-' + createHash('sha256').update(resolve(path).toLowerCase()).digest('hex');
  const handle = api.create(null, 1, 1, name);
  if (handle === 0 || handle === 0n || handle === null) {
    throw win32Error('CreateSemaphoreW', api.lastError(), path, name);
  }
  try {
    const result = api.wait(handle, 0);
    if (result !== WAIT_OBJECT_0) {
      // Preserve GetLastError before CloseHandle can overwrite it.
      throw win32Error('WaitForSingleObject', result === WAIT_TIMEOUT ? 32 : api.lastError(), path, name);
    }
  } catch (error) {
    try {
      if (api.close(handle) === 0) throw win32Error('CloseHandle', api.lastError(), path, name);
    } catch (cleanupError) {
      error.cleanupError = cleanupError;
    }
    throw error;
  }

  let closed = false;
  return {
    async close() {
      if (closed) return;
      // Set before native calls: concurrent/repeated closes must never double-release.
      closed = true;
      let failure;
      try {
        if (api.release(handle, 1, null) === 0) throw win32Error('ReleaseSemaphore', api.lastError(), path, name);
      } catch (error) {
        failure = error;
      } finally {
        try {
          if (api.close(handle) === 0) throw win32Error('CloseHandle', api.lastError(), path, name);
        } catch (error) {
          if (failure) failure.cleanupError = error;
          else failure = error;
        }
      }
      if (failure) throw failure;
    },
  };
}
