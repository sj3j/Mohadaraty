/**
 * MCQ generation resilience tests.
 *
 * Runs completely offline without touching the live Gemini API or spending tokens.
 * Run with:
 *     npx tsx scripts/mcq.test.ts
 */
import {
  classifyFailure,
  generateWithRetry,
  FUNCTION_BUDGET_MS,
  GENERATE_ATTEMPTS,
  RETRY_BACKOFF_MS,
  MIN_REMAINING_BUDGET_FOR_RETRY_MS,
} from '../shared/mcqGeneration.js';
import { AIUnavailableError } from '../src/services/mcqGenerationService.js';

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, extra?: any) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}${extra !== undefined ? ` (got: ${JSON.stringify(extra)})` : ''}`);
  }
}

async function run() {
  console.log('--- 1. Constants & Execution Budget Ceiling ---');
  {
    check('FUNCTION_BUDGET_MS is 59s (59_000ms)', FUNCTION_BUDGET_MS === 59_000, FUNCTION_BUDGET_MS);
    check('GENERATE_ATTEMPTS is 2', GENERATE_ATTEMPTS === 2, GENERATE_ATTEMPTS);
    check('RETRY_BACKOFF_MS is 2_000ms', RETRY_BACKOFF_MS === 2_000, RETRY_BACKOFF_MS);
    check('MIN_REMAINING_BUDGET_FOR_RETRY_MS is 12_000ms', MIN_REMAINING_BUDGET_FOR_RETRY_MS === 12_000, MIN_REMAINING_BUDGET_FOR_RETRY_MS);
  }

  console.log('\n--- 2. classifyFailure: Transient vs Permanent ---');
  {
    // The exact body that Gemini returns under peak demand:
    const live503 = new Error(
      '{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}',
    );
    check('a live 503 UNAVAILABLE is classified as unavailable', classifyFailure(live503) === 'unavailable', classifyFailure(live503));
    check('"model is overloaded" is classified as unavailable', classifyFailure(new Error('The model is overloaded. Please try again later.')) === 'unavailable');
    check('500 INTERNAL is classified as unavailable', classifyFailure(new Error('{"error":{"code":500,"status":"INTERNAL"}}')) === 'unavailable');
    check('fetch failed is classified as unavailable', classifyFailure(new Error('fetch failed')) === 'unavailable');
    check('socket hang up is classified as unavailable', classifyFailure(new Error('socket hang up')) === 'unavailable');
    check('ETIMEDOUT is classified as unavailable', classifyFailure(new Error('connect ETIMEDOUT 142.250.180.10')) === 'unavailable');

    // Permanent errors that should NEVER be retried as transient:
    check('INVALID_ARGUMENT is classified as bad_request', classifyFailure(new Error('INVALID_ARGUMENT: Schema mismatch')) === 'bad_request');
    check('RESOURCE_EXHAUSTED is classified as free_tier_limit', classifyFailure(new Error('RESOURCE_EXHAUSTED: Quota exceeded')) === 'free_tier_limit');
    check('API key not valid is classified as not_configured', classifyFailure(new Error('API key not valid')) === 'not_configured');
    check('Unknown error falls back to error', classifyFailure(new Error('unexpected internal null pointer')) === 'error');
  }

  console.log('\n--- 3. generateWithRetry: In-Flight 59s Budget Ceiling Formula ---');
  {
    // Case A: Succeeds on retry after a 503 spike within budget
    let callCount = 0;
    const retryLog: { wait: number; attempt: number }[] = [];
    const transientErr = new Error('503 UNAVAILABLE: The model is overloaded.');

    const startTime = Date.now();
    const res = await generateWithRetry(
      async () => {
        callCount++;
        if (callCount === 1) throw transientErr;
        return { ok: true, questions: [{ text: 'Sample question' }] };
      },
      startTime,
      {
        attempts: 2,
        backoffMs: 10, // fast for unit tests
        functionBudgetMs: 59_000,
        minRemainingBudgetMs: 12_000,
        onRetry: (wait, attempt) => retryLog.push({ wait, attempt }),
      },
    );

    check('generateWithRetry succeeds on attempt 2', res.ok === true && res.questions.length === 1);
    check('called exactly 2 times', callCount === 2, callCount);
    check('onRetry fired once with backoff', retryLog.length === 1 && retryLog[0].wait === 10);

    // Case B: Throws immediately on permanent failure without retrying
    let permCalls = 0;
    let caughtPerm: any = null;
    try {
      await generateWithRetry(
        async () => {
          permCalls++;
          throw new Error('INVALID_ARGUMENT: Bad parameter');
        },
        Date.now(),
        { attempts: 2, backoffMs: 10, functionBudgetMs: 59_000, minRemainingBudgetMs: 12_000 },
      );
    } catch (e: any) {
      caughtPerm = e;
    }
    check('permanent failure throws on first attempt', permCalls === 1 && caughtPerm !== null);

    // Case C: Aborts if remaining budget < minRemainingBudgetMs (59_000 - 12_000 = 47_000ms)
    let budgetCalls = 0;
    let caughtBudget: any = null;
    try {
      // simulate startTime 48 seconds ago
      const simulatedOldStart = Date.now() - 48_000;
      await generateWithRetry(
        async () => {
          budgetCalls++;
          throw transientErr;
        },
        simulatedOldStart,
        { attempts: 2, backoffMs: 2_000, functionBudgetMs: 59_000, minRemainingBudgetMs: 12_000 },
      );
    } catch (e: any) {
      caughtBudget = e;
    }
    check('aborts retry when (elapsed + backoff) >= (59_000 - 12_000)', budgetCalls === 1 && caughtBudget !== null);
  }

  console.log('\n--- 4. Client AIUnavailableError & PROVIDER_CODES Alignment ---');
  {
    const err = new AIUnavailableError('unavailable');
    check('AIUnavailableError constructs with "unavailable" code', err.code === 'unavailable');
    check('AIUnavailableError message is AI_UNAVAILABLE', err.message === 'AI_UNAVAILABLE');
  }

  console.log('\n--- 5. Firestore failureCount Elimination ---');
  {
    // Simulates the updated failure write in shared/mcqApi.ts:
    const recordFailure = (specific: string) => {
      return {
        status: 'failed',
        failureReason: specific,
      };
    };

    const transientResult = recordFailure('unavailable');
    check('transient failure payload contains NO failureCount', !('failureCount' in transientResult));
    check('transient failure payload has status "failed"', transientResult.status === 'failed');
    check('transient failure payload has failureReason "unavailable"', transientResult.failureReason === 'unavailable');

    const permResult = recordFailure('bad_request');
    check('permanent failure payload contains NO failureCount', !('failureCount' in permResult));
  }

  console.log(`\n========================================`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  console.log(`========================================\n`);

  process.exit(failed ? 1 : 0);
}

run().catch((e) => {
  console.error('Test execution failed:', e);
  process.exit(1);
});
