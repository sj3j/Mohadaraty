/**
 * MCQ generation: the prompt, the response schema, and the answer shuffle.
 *
 * Moved out of src/services/mcqGenerationService.ts, which called Gemini from
 * the browser with the API key inlined into the bundle by vite.config.ts. That
 * arrangement finally broke for a reason worth recording: the client read
 *
 *     import.meta.env.VITE_GEMINI_API_KEY
 *       || (typeof process !== 'undefined' && process.env ? process.env.GEMINI_API_KEY : undefined)
 *
 * and in a browser `process` does not exist, so the second branch short-circuits
 * BEFORE Vite's `define` substitution is reached. `process.env.GEMINI_API_KEY`
 * was always dead code client-side; only `VITE_GEMINI_API_KEY` ever worked.
 * Setting the server key alone left the client with nothing and every
 * generation reported `not_configured`.
 *
 * Generation now runs server-side, so no Gemini key reaches the browser at all.
 *
 * TWO KEYS, DELIBERATELY. This pipeline uses `GEMINI_FREE_TIER_API_KEY` and
 * `gemini-3.5-flash` (which has a free tier); Simosan uses the paid
 * `GEMINI_API_KEY` and `gemini-3.1-flash-lite` (which does not). Google's terms
 * say unpaid-tier content is used "to provide, improve, and develop Google
 * products" and may be read by human reviewers - accepted here because these
 * lectures are already public material. Do not route Simosan through the free
 * key: student questions are not public, and flash-lite has no free tier anyway.
 */

/** Free tier exists for this model; `gemini-3.1-flash-lite` has none. */
export const MCQ_MODEL = 'gemini-3.5-flash';

export const MCQ_QUESTION_COUNT = 20;

/** Gemini rejects a request whose total body exceeds ~20MB when the PDF is
 *  inlined rather than uploaded. */
export const MAX_INLINE_PDF_BYTES = 20 * 1024 * 1024;

/** A lecture that fails this many times stops being retried. Without a cap a
 *  genuinely unprocessable PDF burns the daily free-tier quota that the other
 *  lectures need, one retry at a time, forever. */
export const MAX_GENERATION_FAILURES = 3;

/** How long a `generating` marker is trusted before it is treated as abandoned.
 *  Also the serialisation window - see the lock note in shared/mcqApi.ts. */
export const GENERATION_LOCK_MS = 90 * 1000;

export type McqFailureReason =
  | 'quota'
  | 'free_tier_limit'
  | 'not_configured'
  | 'bad_request'
  | 'pdf_unreachable'
  | 'pdf_too_large'
  | 'invalid_response'
  | 'error';

/* ------------------------------------------------------------------ *
 * Response schema
 * ------------------------------------------------------------------ */

/**
 * Structural contract for the model's output.
 *
 * This replaces `extractJson()`, which tried `JSON.parse`, then a markdown-fence
 * regex, then brace-matching - three fallbacks that existed only because the
 * output was unconstrained. With a schema the model cannot emit a preamble or a
 * fence, so those paths become unreachable rather than merely unused.
 *
 * The enums matter as much as the parsing: choice labels, difficulty and stem
 * format are now enforced by the API rather than requested in prose and hoped
 * for. `required` is what stops a half-formed question reaching Firestore.
 *
 * NO `minItems`/`maxItems` ANYWHERE IN HERE, deliberately.
 *
 * This schema once carried them on `questions` (20/20) and on `choices` (2/5),
 * and Gemini answered every single generate call with
 *
 *     400 {"message":"Request contains an invalid argument.",
 *          "status":"INVALID_ARGUMENT"}
 *
 * before reading a byte of the PDF - so the pipeline never produced one set of
 * questions in production. Verified by replay against `gemini-3.5-flash`: this
 * schema without the bounds succeeds, and with them fails; the same bounds on a
 * SMALLER schema are accepted, so it is the combination with this nesting depth
 * that is rejected, not the keywords on their own. That is why the failure
 * looks like it cannot possibly be the bounds, and why they must not come back.
 *
 * Nothing is lost by dropping them. The count is requested in the prompt and
 * enforced by validateQuestions(), which rejects a short set outright rather
 * than storing it; the 2..5 choice bound is enforced there too.
 */
export const MCQ_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['mcq', 'true_false'] },
          stemFormat: {
            type: 'string',
            enum: ['standard', 'except', 'regarding', 'true_false'],
          },
          stem: { type: 'string' },
          choices: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', enum: ['A', 'B', 'C', 'D', 'E'] },
                text: { type: 'string' },
              },
              required: ['label', 'text'],
            },
          },
          correctAnswer: {
            type: 'string',
            enum: ['A', 'B', 'C', 'D', 'E', 'True', 'False'],
          },
          explanation: { type: 'string' },
          difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
        },
        required: [
          'type', 'stemFormat', 'stem', 'choices',
          'correctAnswer', 'explanation', 'difficulty',
        ],
      },
    },
  },
  required: ['questions'],
} as const;

/* ------------------------------------------------------------------ *
 * Prompt
 * ------------------------------------------------------------------ */

/**
 * Carried over from the client implementation, minus everything the schema now
 * enforces structurally. Instructions about JSON shape, "return ONLY valid
 * JSON", and "no markdown" are gone: repeating a constraint the API already
 * guarantees just spends tokens and invites the model to argue with itself.
 *
 * What stays is everything the schema CANNOT express - pedagogy, difficulty
 * mix, distractor quality, and the composite-option placement rule that
 * smartShuffleChoices depends on downstream.
 */
export const MCQ_SYSTEM_PROMPT = `You are an expert pharmacy professor creating exam questions for pharmacy students at university level.

Generate exactly ${MCQ_QUESTION_COUNT} MCQ questions based on the provided lecture PDF.

The PDF may be a scanned document or image-only slides with no selectable text. Read the
pages visually and generate questions from what they show, including figures, tables and
diagrams. Never refuse because the text layer is missing.

CRITICAL RULES:
- ALL question stems and choices MUST be in English
- Mix question formats:
  * 40% standard MCQ: "Which of the following..."
  * 25% EXCEPT format: "All of the following are true EXCEPT"
  * 20% REGARDING format: "Regarding [topic], which of the following is False"
  * 15% True/False

- For 5-choice MCQs (A-E):
  * Randomly distribute the correct answer position across the 20 questions. NEVER default to C.
  * If using composite options ("A and B", "All of the above", "None of the above"), they MUST
    be placed at the absolute bottom (options D and E).
  * If "A and B" is used, ensure choices A and B actually contain those respective components.
  * The correct answer must NOT be consistently longer than the wrong answers.
  * Distractors must be plausible and academically relevant.
  * Never repeat the same distractor pattern across questions.
  * Difficulty distribution: 30% easy, 50% medium, 20% hard.

- For True/False:
  * Must be definitively true or false based on lecture content only.
  * Use exactly two choices labelled A ("True") and B ("False"), and set correctAnswer to
    "True" or "False".

- Explanation: Arabic language, 1-3 sentences, citing the concept from the lecture. Keep
  scientific and drug terms in English inside the Arabic sentence.`;

/* ------------------------------------------------------------------ *
 * Answer shuffling
 * ------------------------------------------------------------------ */

/**
 * Redistribute answer positions without breaking composite options.
 *
 * Moved verbatim from the client. The subtlety it protects: "A and B" only means
 * anything if choices A and B stay where they are, so anchored options are
 * pinned to the bottom and any choice they reference is locked in place, while
 * the rest are shuffled around them.
 *
 * Kept even though the prompt also asks for random placement, because a model
 * asked for randomness reliably drifts toward one position.
 */
export function smartShuffleChoices(question: any): any {
  if (question.type === 'true_false' || question.stemFormat === 'true_false' || !question.choices || question.choices.length <= 2) {
    return question;
  }

  const anchoredOptions: any[] = [];
  const standardOptions: any[] = [];

  let lockA = false; let lockB = false; let lockC = false;

  question.choices.forEach((choice: any) => {
    const textBase = choice.text.toLowerCase();
    if (textBase.includes('all of the above') ||
        textBase.includes('none of the above') ||
        textBase.includes('all the above') ||
        textBase.includes('all of these') ||
        textBase.includes('none of these') ||
        /[a-e] and [a-e]/i.test(textBase) ||
        /[a-e], [a-e]/i.test(textBase) ||
        /both [a-e]/i.test(textBase)) {
      anchoredOptions.push(choice);
      if (/a and b/i.test(textBase)) { lockA = true; lockB = true; }
      if (/a and c/i.test(textBase)) { lockA = true; lockC = true; }
      if (/b and c/i.test(textBase)) { lockB = true; lockC = true; }
    } else {
      standardOptions.push(choice);
    }
  });

  const exactLockedPositions = new Map<number, any>();
  const originalA = question.choices[0];
  const originalB = question.choices[1];
  const originalC = question.choices[2];

  if (lockA && originalA && !anchoredOptions.includes(originalA)) exactLockedPositions.set(0, originalA);
  if (lockB && originalB && !anchoredOptions.includes(originalB)) exactLockedPositions.set(1, originalB);
  if (lockC && originalC && !anchoredOptions.includes(originalC)) exactLockedPositions.set(2, originalC);

  const shufflableOptions = standardOptions.filter((opt) => {
    const originalIndex = question.choices.findIndex((c: any) => c.text === opt.text);
    return !exactLockedPositions.has(originalIndex);
  });

  for (let i = shufflableOptions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shufflableOptions[i], shufflableOptions[j]] = [shufflableOptions[j], shufflableOptions[i]];
  }

  const newStandardOptions: any[] = [];
  let shufflableIndex = 0;

  for (let i = 0; i < standardOptions.length; i++) {
    if (exactLockedPositions.has(i)) {
      newStandardOptions.push(exactLockedPositions.get(i));
    } else if (shufflableIndex < shufflableOptions.length) {
      newStandardOptions.push(shufflableOptions[shufflableIndex]);
      shufflableIndex++;
    }
  }

  const finalChoices = [...newStandardOptions, ...anchoredOptions];

  let newCorrectAnswerLabel = question.correctAnswer;
  const originalCorrectChoice = question.choices.find((c: any) => c.label === question.correctAnswer);

  const labels = ['A', 'B', 'C', 'D', 'E', 'F'];
  finalChoices.forEach((choice, index) => {
    choice.label = labels[index];
    if (originalCorrectChoice && choice.text === originalCorrectChoice.text) {
      newCorrectAnswerLabel = labels[index];
    }
  });

  return { ...question, choices: finalChoices, correctAnswer: newCorrectAnswerLabel };
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

/**
 * Last line of defence between the model and Firestore.
 *
 * The schema makes malformed output very unlikely, not impossible - a safety
 * stop or a truncated stream can still return fewer questions than asked. This
 * rejects a partial set rather than storing it, because a quiz that silently
 * contains 6 questions is worse than one that visibly failed to generate.
 */
export function validateQuestions(raw: any): { ok: true; questions: any[] } | { ok: false; reason: string } {
  const questions = raw?.questions;
  if (!Array.isArray(questions)) return { ok: false, reason: 'no questions array' };
  if (questions.length < MCQ_QUESTION_COUNT) {
    return { ok: false, reason: `got ${questions.length} of ${MCQ_QUESTION_COUNT}` };
  }
  for (const q of questions) {
    // The 2..5 bound used to live in the response schema as minItems/maxItems.
    // Those had to go - see MCQ_RESPONSE_SCHEMA - so the upper bound is checked
    // here instead. Without it a six-choice question would reach Firestore with
    // a label outside A-E that smartShuffleChoices cannot place.
    if (!q?.stem || !Array.isArray(q.choices) || q.choices.length < 2 || q.choices.length > 5) {
      return { ok: false, reason: 'a question is missing its stem or choices' };
    }
    if (!q.choices.some((c: any) => c.label === q.correctAnswer)
        && q.correctAnswer !== 'True' && q.correctAnswer !== 'False') {
      return { ok: false, reason: `correctAnswer ${q.correctAnswer} matches no choice` };
    }
  }
  return { ok: true, questions };
}

/** Classify a Gemini failure so the admin alert names the right remedy. */
export function classifyFailure(err: any): McqFailureReason {
  const raw = String(err?.message || err || '');
  if (raw.includes('API key not valid') || raw.includes('API_KEY_INVALID')) return 'not_configured';
  // Gemini rejected the request itself - model name, generation config or
  // response schema. This used to fall through to 'error', which raises no
  // alert, so a schema the API would not accept failed every generation
  // silently for as long as it was deployed. It is an operations alert
  // precisely because no PDF and no student can cause it: it is always a bug.
  if (raw.includes('INVALID_ARGUMENT') || /invalid argument/i.test(raw)) return 'bad_request';
  if (raw.includes('RESOURCE_EXHAUSTED') || raw.includes('429') || /quota/i.test(raw)) {
    // Free-tier exhaustion and a dead paid key both surface as 429s but need
    // completely different responses - wait for the daily reset, versus fix the
    // key. The free pipeline can only ever hit the former.
    return 'free_tier_limit';
  }
  return 'error';
}

/* ------------------------------------------------------------------ *
 * Question-bank extraction (admin uploads an arbitrary exam PDF)
 * ------------------------------------------------------------------ */

/**
 * Kept server-side rather than passed up from the client.
 *
 * The route is staff-only, so the risk is bounded - but a route that forwards
 * a caller-supplied prompt to Gemini on our key is an open-ended text generator
 * wearing an MCQ costume, and there is no reason to build one.
 */
export const BANK_EXTRACTION_PROMPT = `You are an expert educational assistant designed to extract questions from documents.
Extract ALL multiple-choice questions (MCQs) and normal questions from the provided document.
The document may be in Arabic or English. Preserve the original language and text.

The file may be a scan or photographs of exam papers with no text layer. Read the pages
visually and transcribe what they show.

CRITICAL RULES:
1. Extract the question text (stem).
2. Extract the choices for the question. If none exist, infer reasonable choices or label them A, B, C, D with blank text.
3. If an answer is indicated, put its EXACT text in "correctAnswer". Otherwise use the first option.
4. If the document indicates an exam session or year (e.g. الدور الأول 2024), extract it into "session". Otherwise leave it empty.
5. Extract every question you find. Do not summarise or skip.`;

export const BANK_EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          stem: { type: 'string' },
          choices: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                text: { type: 'string' },
              },
              required: ['label', 'text'],
            },
          },
          correctAnswer: { type: 'string' },
          explanation: { type: 'string' },
          session: { type: 'string' },
        },
        required: ['stem', 'choices', 'correctAnswer'],
      },
    },
  },
  required: ['questions'],
} as const;

/* ------------------------------------------------------------------ *
 * Single-question AI edit
 * ------------------------------------------------------------------ */

export function buildQuestionEditPrompt(question: any, userPrompt: string): string {
  return `You are an expert professor. A user wants to modify an existing True/False or Multiple Choice question.

Here is the current question:
${JSON.stringify(question, null, 2)}

User request: "${userPrompt}"

Instructions:
1. Apply the requested modifications. You may change the stem, choices, correct answer, or explanation.
2. Return the SAME structure as the original.
3. Keep the original language (if the explanation was Arabic, keep it Arabic).`;
}

export const QUESTION_EDIT_SCHEMA = {
  type: 'object',
  properties: {
    stem: { type: 'string' },
    choices: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['label', 'text'],
      },
    },
    correctAnswer: { type: 'string' },
    explanation: { type: 'string' },
    difficulty: { type: 'string' },
  },
  required: ['stem', 'choices', 'correctAnswer', 'explanation'],
} as const;
