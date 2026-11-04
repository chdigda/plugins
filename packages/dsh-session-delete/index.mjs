import { resolve, join } from 'node:path';
import { assertId } from './core.mjs';
import { reviewTargets, queueRequest, readRequests, cancelRequests } from './requests.mjs';
import { runtimeRequire, dshHome } from './runtime.mjs';

export const name = 'session-delete';
export const inject = ['commands', 'sessionPersistence', 'sessionQuery', 'userQuestions', 'sessionDeleteReady'];
export function createHandler(ctx, home) {
  const reviewing = new Set();
  return async invocation => {
    let reviewingId;
    try {
      const args = invocation.rawInput.trim().split(/\s+/).filter(Boolean);
      if (args[0] === 'help') return { kind: 'success', text: '/session-delete → 현재 세션 삭제 확인 → DSH 재시작 → 브라우저 새로고침.\n/session-delete <세션 ID>로 다른 세션도 예약할 수 있습니다.\n/session-delete cancel [세션 ID]: 예약 취소\n/session-delete status: 예약/결과 확인\n보관이나 별도 터미널 삭제 명령은 필요하지 않습니다.' };
      if (args[0] === 'status') {
        const requests = await readRequests(home);
        return { kind: 'success', text: requests.length ? requests.map(r => r.rootId + ': ' + ({pending:'재시작 대기',executing:'삭제 복구 필요',complete:'삭제 완료',cancelled:'취소됨',failed:'삭제 보류'}[r.phase]) + (r.error ? ' — ' + r.error : '')).join('\n') : '삭제 예약이 없습니다.' };
      }
      if (args[0] === 'cancel' && args.length <= 2) {
        const id = assertId(args[1] || invocation.agent.session.id);
        const count = await cancelRequests(home, id);
        return { kind: 'success', text: count ? '삭제 예약을 취소했습니다.' : '취소할 삭제 예약이 없습니다.' };
      }
      if (args.length > 1) throw new Error('사용법: /session-delete [세션 ID]');
      const rootId = assertId(args[0] || invocation.agent.session.id);
      if (reviewing.has(rootId)) throw new Error('이 세션의 삭제 확인이 이미 진행 중입니다.');
      reviewing.add(rootId); reviewingId = rootId;
      await ctx.sessionPersistence.flush();
      const targets = await reviewTargets(home, rootId);
      const answer = await ctx.userQuestions.ask({
        agent: invocation.agent,
        signal: invocation.signal,
        questions: [{ id: 'delete-session', header: '세션 영구 삭제', question: targets.length + '개 세션을 다음 DSH 재시작 때 영구 삭제할까요?',
          detail: targets.map(t => t.id).join('\n') + '\n하위·분기 세션을 포함하며 복구할 수 없습니다. 예약 후 추가된 대화도 삭제됩니다. 새 하위 세션이 생기면 삭제를 보류합니다. 공유 첨부파일·작업 파일·외부 복사본은 보존합니다.',
          options: [{ label: '취소' }, { label: '재시작 시 영구 삭제' }], multiSelect: false }],
      });
      const choice = answer.answers.find(a => a.id === 'delete-session');
      if (!choice || choice.custom || choice.selected.length !== 1 || choice.selected[0] !== '재시작 시 영구 삭제') return { kind: 'success', text: '삭제하지 않았습니다.' };
      await ctx.sessionPersistence.flush();
      if (JSON.stringify(await reviewTargets(home, rootId)) !== JSON.stringify(targets)) throw new Error('확인 중 삭제 대상이 변경되었습니다. 명령을 다시 실행하세요.');
      invocation.signal?.throwIfAborted();
      await queueRequest(home, rootId, targets, ctx.sessionQuery.config.path, ctx.sessionDeleteReady.bootId);
      return { kind: 'success', text: '삭제 예약 완료. 다음 DSH 재시작 때 ' + targets.length + '개 세션의 기록을 삭제합니다. 이후 브라우저를 새로고침하세요.\n아직 대화는 삭제되지 않았습니다. 취소: /session-delete cancel ' + rootId };
    } catch (error) { return { kind: 'error', text: error.message }; }
    finally { if (reviewingId) reviewing.delete(reviewingId); }
  };
}
export function apply(ctx) {
  runtimeRequire();
  const home = dshHome();
  if (resolve(ctx.sessionPersistence.config.root) !== join(home, 'sessions')) throw new Error('사용자 지정 세션 저장소는 지원하지 않습니다.');
  ctx.commands.register({ name: 'session-delete', description: '현재 세션을 다음 DSH 재시작 때 영구 삭제', input: { hint: '[세션 ID] | cancel [세션 ID] | status | help' }, recordInput: false, handler: createHandler(ctx, home) });
}
