import assert from 'node:assert/strict';
import { parseSimosanQuiz } from '../src/services/simosanService';

function runTests() {
  console.log('--- Simosan Quiz Parser Unit Tests ---');

  // Test 1: Plain text without quiz
  {
    const raw = 'هذا شرح عادي لمحاضرة علم الأدوية.';
    const res = parseSimosanQuiz(raw);
    assert.equal(res.markdownText, raw);
    assert.equal(res.quizzes.length, 0);
    assert.equal(res.isQuizStreaming, undefined);
    console.log('  PASS  Plain text without quiz');
  }

  // Test 2: Text with completed ```simosan-quiz block
  {
    const raw = `هذا شرح وافٍ لـ Cimetidine و H2 blockers.
    
\`\`\`simosan-quiz
[
  {
    "id": 1,
    "question": "Which of the following is a key adverse effect of Cimetidine?",
    "options": ["Gynecomastia", "Hypertension", "Hyperglycemia", "Bronchospasm"],
    "correctIndex": 0,
    "explanation": "Cimetidine has antiandrogenic effects leading to gynecomastia."
  },
  {
    "id": 2,
    "question": "What is the primary target of Omeprazole?",
    "options": ["H+/K+ ATPase", "H2 receptor", "Muscarinic M1 receptor", "Prostaglandin EP3"],
    "correctIndex": 0,
    "explanation": "Omeprazole irreversibly inhibits the H+/K+ ATPase proton pump."
  },
  {
    "id": 3,
    "question": "Which drug requires an acidic environment for optimal absorption?",
    "options": ["Ketoconazole", "Amoxicillin", "Paracetamol", "Metformin"],
    "correctIndex": 0,
    "explanation": "Ketoconazole absorption is reduced when gastric acidity is decreased by H2 blockers or PPIs."
  }
]
\`\`\``;

    const res = parseSimosanQuiz(raw);
    assert.ok(res.markdownText.includes('هذا شرح وافٍ لـ Cimetidine'));
    assert.ok(!res.markdownText.includes('simosan-quiz'));
    assert.equal(res.quizzes.length, 3);
    assert.equal(res.quizzes[0].question, 'Which of the following is a key adverse effect of Cimetidine?');
    assert.equal(res.quizzes[0].correctIndex, 0);
    assert.equal(res.quizzes[0].options.length, 4);
    assert.equal(res.quizzes[1].correctIndex, 0);
    assert.equal(res.isQuizStreaming, false);
    console.log('  PASS  Completed simosan-quiz block parsed with 3 English questions');
  }

  // Test 3: Partial streaming JSON block
  {
    const raw = `شرح مستمر...
\`\`\`simosan-quiz
[
  {
    "id": 1,
    "question": "Which drug`;

    const res = parseSimosanQuiz(raw);
    assert.equal(res.markdownText, 'شرح مستمر...');
    assert.equal(res.quizzes.length, 0);
    assert.equal(res.isQuizStreaming, true);
    console.log('  PASS  Partial streaming JSON suppresses raw text and flags isQuizStreaming');
  }

  // Test 4: Malformed JSON recovery
  {
    const raw = `شرح المحاضرة.
\`\`\`simosan-quiz
INVALID JSON SYNTAX HERE
\`\`\``;

    const res = parseSimosanQuiz(raw);
    assert.equal(res.markdownText, 'شرح المحاضرة.');
    assert.equal(res.quizzes.length, 0);
    assert.equal(res.isQuizStreaming, false);
    console.log('  PASS  Malformed JSON handled gracefully without exception');
  }

  console.log('\nAll Simosan quiz parser tests passed!');
}

runTests();
