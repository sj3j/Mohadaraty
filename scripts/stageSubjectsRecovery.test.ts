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

test('SubjectBrowser calls all React hooks unconditionally before any early returns', () => {
  const browserSource = readFileSync(new URL('../src/components/SubjectBrowser.tsx', import.meta.url), 'utf8');
  
  // Find the first conditional return in SubjectBrowser
  const firstReturnIndex = browserSource.indexOf('if (lecturePresentation === \'loading\')');
  assert.ok(firstReturnIndex > 0, 'Could not find early return in SubjectBrowser');

  // Verify that all useMemo, useEffect, useState, useStageContext calls are BEFORE firstReturnIndex
  const hooks = ['useMemo', 'useState', 'useEffect', 'useStageContext', 'useStageSubjects'];
  for (const hook of hooks) {
    let pos = 0;
    while ((pos = browserSource.indexOf(hook, pos)) !== -1) {
      // Ignore imports at the top
      if (pos > 200) {
        assert.ok(
          pos < firstReturnIndex,
          `Hook call ${hook} at char ${pos} must appear before the first early return at ${firstReturnIndex}`,
        );
      }
      pos += hook.length;
    }
  }
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
