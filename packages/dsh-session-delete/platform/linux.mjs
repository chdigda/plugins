import { open, readFile, readdir, lstat } from 'node:fs/promises';

export function assertOwner(info, path) {
  if (info.uid !== process.getuid()) throw new Error('다른 사용자의 파일은 삭제하지 않습니다: ' + path);
}
export async function syncDirectory(path) {
  const dir = await open(path, 'r');
  try { await dir.sync(); } finally { await dir.close(); }
}

export async function assertOffline() {
  if (process.platform !== 'linux') throw new Error('이 버전의 오프라인 삭제는 Linux 전용입니다.');
  if (process.env.DSH_SESSION_ID) throw new Error('DSH 내부에서는 실행할 수 없습니다. 모든 DSH를 종료하고 일반 터미널에서 실행하세요.');
  const running = [];
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    try {
      if ((await lstat('/proc/' + pid)).uid !== process.getuid()) continue;
      const args = (await readFile('/proc/' + pid + '/cmdline', 'utf8')).split('\0');
      if (args.some(a => /(?:^|\/)dsh(?:$|\.(?:mjs|cjs|js)$)/.test(a) || /\/dsh\/lib\//.test(a))) running.push(pid);
    } catch (e) { if (!['ENOENT', 'ESRCH'].includes(e.code)) throw e; }
  }
  if (running.length) throw new Error('실행 중인 DSH 프로세스를 먼저 종료하세요: ' + running.join(', '));
}

export async function processIdentity() {
  const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const stat = await readFile('/proc/self/stat', 'utf8');
  const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  return boot + ':' + process.pid + ':' + start;
}
