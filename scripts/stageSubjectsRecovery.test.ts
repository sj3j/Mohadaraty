import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

test('SubjectBrowser has completely eliminated the legacy CATEGORIES.map fallback', () => {
  const browserSource = readFileSync(new URL('../src/components/SubjectBrowser.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(
    browserSource,
    /CATEGORIES\.map\(/,
    'SubjectBrowser must never map over the obsolete 5 Stage 3 CATEGORIES',
  );
  assert.match(
    browserSource,
    /derivedSubjectsFromLectures/,
    'SubjectBrowser must derive subjects from lectures when the subjects query is unavailable',
  );
  assert.match(
    browserSource,
    /LectureLoadFailure/,
    'SubjectBrowser must provide an error/retry UI when subjects and lectures fail to load',
  );
});

test('useStageSubjects uses real-time onSnapshot and local cache persistence', () => {
  const hookSource = readFileSync(new URL('../src/hooks/useStageSubjects.ts', import.meta.url), 'utf8');
  assert.match(hookSource, /onSnapshot\(/, 'useStageSubjects must use onSnapshot instead of one-shot getDocs');
  assert.doesNotMatch(hookSource, /getDocs\(/, 'useStageSubjects must not use getDocs');
  assert.match(hookSource, /localStorage/, 'useStageSubjects must use localStorage for immediate 0ms hydration');
  assert.doesNotMatch(hookSource, /!isAuthenticated/, 'useStageSubjects must not block public subjects query on isAuthenticated');
});

test('WeeklyListScreen does not render legacy CATEGORIES.map as fallback', () => {
  const weeklySource = readFileSync(new URL('../src/components/WeeklyListScreen.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(
    weeklySource,
    /CATEGORIES\.map\(/,
    'WeeklyListScreen must not fall back to CATEGORIES.map in the subject select',
  );
});

