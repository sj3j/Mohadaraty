import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveLectureLoadDecision } from '../src/lib/lectureLoadState';

test('cached profile waits for its matching Firebase session, then subscribes without a stage change', () => {
  const cached = resolveLectureLoadDecision({
    profileUid: 'student-1', authenticatedUid: null, isAuthReady: false,
    effectiveStageId: 'stage_3', canBrowseLectures: true,
  });
  const restored = resolveLectureLoadDecision({
    profileUid: 'student-1', authenticatedUid: 'student-1', isAuthReady: true,
    effectiveStageId: 'stage_3', canBrowseLectures: true,
  });

  assert.equal(cached.shouldSubscribe, false);
  assert.equal(cached.state, 'waiting-auth');
  assert.equal(restored.shouldSubscribe, true);
  assert.equal(restored.scope, cached.scope);
});

test('a different restored account cannot reuse the visible profile query', () => {
  const decision = resolveLectureLoadDecision({
    profileUid: 'student-1', authenticatedUid: 'student-2', isAuthReady: true,
    effectiveStageId: 'stage_3', canBrowseLectures: true,
  });
  assert.equal(decision.shouldSubscribe, false);
});
