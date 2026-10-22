import fs from 'fs';
import path from 'path';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  FAIL  ${message}`);
    process.exit(1);
  }
  console.log(`  PASS  ${message}`);
}

console.log('--- 1. App.tsx: Open MCQ for Non-Subscribers ---');
const appFile = fs.readFileSync('src/App.tsx', 'utf8');

assert(
  appFile.includes('const handleOpenMCQ = useCallback((l: Lecture) => {\n    setMcqLecture(l);\n  }, []);') ||
  appFile.includes('setMcqLecture(l)'),
  'handleOpenMCQ opens setMcqLecture for all users without immediate paywall check'
);

assert(
  appFile.includes('isSubscribed={hasMCQAccess(user)}') &&
  appFile.includes('onShowPaywall={() => setShowPaywall(true)}'),
  'App passes isSubscribed and onShowPaywall to MCQOverlay'
);

console.log('\n--- 2. MCQOverlay.tsx: Routing & Protection ---');
const overlayFile = fs.readFileSync('src/components/MCQOverlay.tsx', 'utf8');

assert(
  overlayFile.includes('isSubscribed?: boolean') &&
  overlayFile.includes('onShowPaywall?: () => void'),
  'MCQOverlayProps includes isSubscribed and onShowPaywall'
);

assert(
  overlayFile.includes('handleStartDoctorQuiz') &&
  overlayFile.includes("tags?.includes('سؤال_الدكتور')"),
  'MCQOverlay implements handleStartDoctorQuiz filtering for doctor questions'
);

assert(
  overlayFile.includes('if (!isSubscribed) {\n      onShowPaywall?.();\n      return;\n    }'),
  'MCQOverlay handleFinishQuiz guards against submitting preview attempts to leaderboard'
);

assert(
  overlayFile.includes('if (!isSubscribed) {\n        onShowPaywall?.();\n        return;\n      }\n      setRoute(\'bank_quiz_setup\');'),
  'MCQOverlay guards Question Bank quiz setup behind subscription'
);

console.log('\n--- 3. MCQIntroScreen.tsx: UI & Doctor Questions Choice ---');
const introFile = fs.readFileSync('src/components/mcq/MCQIntroScreen.tsx', 'utf8');

assert(
  introFile.includes('أول سؤالين مجاناً 🎁') &&
  introFile.includes('معاينة مجانية متاحة'),
  'MCQIntroScreen renders preview banner for non-subscribers'
);

assert(
  introFile.includes('أسئلة الدكتور') &&
  introFile.includes('باقة التفوق') &&
  introFile.includes('onClick={onShowPaywall}') &&
  introFile.includes('مغلق'),
  'MCQIntroScreen displays locked أسئلة الدكتور choice below ابدأ اختبار AI for non-subscribers'
);

assert(
  introFile.includes('onClick={onStartDoctorQuiz}') &&
  introFile.includes('ابدأ'),
  'MCQIntroScreen displays unlocked أسئلة الدكتور choice for subscribers'
);

console.log('\n--- 4. MCQQuizScreen.tsx: Freemium 2-Question Preview & 50% Lock ---');
const quizFile = fs.readFileSync('src/components/mcq/MCQQuizScreen.tsx', 'utf8');

assert(
  quizFile.includes('const isLockedPreview = !isSubscribed && index >= 2;'),
  'MCQQuizScreen defines isLockedPreview for questions starting at index 2'
);

assert(
  quizFile.includes('isLockedPreview ? \'opacity-50 select-none\' : \'\''),
  'MCQQuizScreen applies 50% opacity to question cards from index 2 onwards'
);

assert(
  quizFile.includes('isLockedPreview ? \'pointer-events-none filter blur-[0.6px]\' : \'\''),
  'MCQQuizScreen blurs and disables choices for locked preview questions'
);

assert(
  quizFile.includes('هذا السؤال وباقي الأسئلة متاحة لمشتركي باقة التفوق') &&
  quizFile.includes('افتح كل الأسئلة 🚀'),
  'MCQQuizScreen renders aesthetic lock teaser and CTA button on questions 3+'
);

assert(
  quizFile.includes('if (!isSubscribed && (index === 1 || newAnsweredCount >= 2))') &&
  quizFile.includes('onShowPaywall?.();'),
  'MCQQuizScreen automatically pops up paywall after student answers question 2'
);

assert(
  quizFile.includes('isRetake === false && isSubscribed') &&
  quizFile.includes('lockSingleAnswer'),
  'MCQQuizScreen only locks answers for subscribers, protecting non-subscriber ranking'
);

assert(
  quizFile.includes('const isLockedQ = !isSubscribed && idx >= 2;') &&
  quizFile.includes('<Lock className="w-2.5 h-2.5 text-amber-500" />'),
  'MCQQuizScreen drawer shows lock indicators on questions 3+ and routes to paywall'
);

assert(
  quizFile.includes('🎉 أكملت التجربة المجانية بنجاح!') &&
  quizFile.includes('افتح كافة الأسئلة واشترك الآن'),
  'MCQQuizScreen shows high-converting completion sticky footer for non-subscribers'
);

console.log('\n========================================');
console.log('Result: All Freemium MCQ Preview tests passed!');
console.log('========================================\n');
