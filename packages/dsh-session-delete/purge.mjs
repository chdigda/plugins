import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { loadLock } from './platform/index.mjs';
import { assertId, safePath, purge, assertOffline, validateStructure, lockFile } from './core.mjs';
import { runtimeRequire } from './runtime.mjs';

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help')) {
    console.log('일반 삭제는 /session-delete 확인 후 DSH를 재시작하면 자동 처리됩니다. 이 명령은 오프라인 저널 복구용입니다.\n모든 DSH를 종료한 후:\nnode purge.mjs --home <DSH_HOME> --ticket <예약 ID> --confirm <대상 세션 ID>\n삭제 중 DSH를 실행하지 마세요. 공유 첨부파일/작업 파일/외부 복사본은 보존됩니다.');
    return;
  }
  if (args.length !== 6 || args[0] !== '--home' || args[2] !== '--ticket' || args[4] !== '--confirm') throw new Error('인수를 확인하세요. --help로 사용법을 볼 수 있습니다.');
  await assertOffline();
  const home = resolve(args[1]); const ticket = assertId(args[3]); const id = assertId(args[5]);
  const path = join(home, 'session-deletions', ticket + '.json');
  await safePath(home, path);
  const plan = JSON.parse(await readFile(path, 'utf8'));
  if (plan.phase === 'complete') { console.log('이미 삭제 완료된 예약입니다.'); return; }
  if (plan.home !== home || plan.ticket !== ticket || plan.rootId !== id) throw new Error('예약과 확인 ID가 일치하지 않습니다.');
  validateStructure(plan);
  const tryLockExclusive = await loadLock(runtimeRequire());
  // A running plugin host owns this lock, including its workspace/search caches.
  const runtimeDir = join(home, 'session-delete-requests');
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const hostLock = await lockFile(home, join(runtimeDir, 'runtime.lock'), tryLockExclusive);
  let ids;
  try { ids = await purge(plan, path, tryLockExclusive); }
  finally { await hostLock.close(); }
  console.log('대화 로그와 해당 화면 캐시 삭제 완료 (' + ids.length + '개):\n' + ids.join('\n') + '\n이제 DSH를 시작하고 브라우저를 새로고침하세요.');
}
main().catch(error => { console.error('삭제하지 못했습니다: ' + error.message + '\n일부 삭제 이후 실패했다면 DSH를 재시작하지 말고 같은 명령을 다시 실행하세요.'); process.exitCode = 1; });
