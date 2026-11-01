/**
 * Dedicated test suite for Gemini 3.1 Flash-Lite (gemini-3.1-flash-lite)
 * & Gemini 3.5 Flash-Lite (gemini-3.5-flash-lite) pricing constants,
 * multi-model dynamic calculations, Option B weighted token credits,
 * usage metadata extraction, streaming resilience, and 5-week rolling quota enforcement.
 *
 * Runnable standalone via:
 *   npx tsx scripts/geminiPricing.test.ts
 */
import assert from 'node:assert/strict';
import {
  UNIT_WEIGHT_UNCACHED_INPUT,
  UNIT_WEIGHT_CACHED_INPUT,
  UNIT_WEIGHT_OUTPUT,
  USD_PER_UNIT,
  CONTEXT_CACHE_STORAGE_PER_HOUR_USD,
  DEFAULT_MODEL,
  SIMOSAN_MODELS,
  getModelPricing,
  DEFAULT_WEEKLY_UNIT_BUDGET,
  DEFAULT_5_WEEK_UNIT_BUDGET,
  WEEKLY_CAP_CREDITS,
  MONTHLY_CAP_CREDITS,
  unitsFromUsage,
  unitsToUsd,
  extractUsageMetadata,
  getRollingWeekKeys,
  baghdadWeekKey,
  previousBaghdadWeekKey,
  normaliseSettings,
  reserveEnergy,
  reconcileEnergy,
  type GeminiUsage,
  type SimosanCtx,
} from '../shared/simosan.js';
import { streamAnswer } from '../shared/simosanChat.js';
import { reserveSupaEnergy, reconcileSupaEnergy } from '../shared/simosanSupabase.js';

let totalTests = 0;
let passedTests = 0;

function test(name: string, fn: () => void | Promise<void>) {
  totalTests++;
  try {
    const res = fn();
    if (res instanceof Promise) {
      return res.then(() => {
        passedTests++;
        console.log(`  [PASS] ${name}`);
      }).catch((err) => {
        console.error(`  [FAIL] ${name} -> ${err.message}`);
        throw err;
      });
    }
    passedTests++;
    console.log(`  [PASS] ${name}`);
  } catch (err: any) {
    console.error(`  [FAIL] ${name} -> ${err.message}`);
    throw err;
  }
}

// In-memory Firestore mock for SimosanCtx
function createMockFirestoreCtx() {
  const store = new Map<string, any>();

  const getDoc = (col: string, id: string) => {
    const key = `${col}/${id}`;
    const data = store.get(key) || null;
    return {
      exists: data !== null,
      data: () => (data ? JSON.parse(JSON.stringify(data)) : null),
    };
  };

  const setDoc = (col: string, id: string, data: any, opts?: any) => {
    const key = `${col}/${id}`;
    if (opts?.merge && store.has(key)) {
      const existing = store.get(key);
      store.set(key, { ...existing, ...JSON.parse(JSON.stringify(data)) });
    } else {
      store.set(key, JSON.parse(JSON.stringify(data)));
    }
  };

  const db: any = {
    collection: (col: string) => ({
      doc: (id: string) => ({
        get: async () => getDoc(col, id),
        set: async (data: any, opts?: any) => setDoc(col, id, data, opts),
      }),
    }),
    runTransaction: async (updateFn: (t: any) => Promise<any>) => {
      const transaction = {
        get: async (ref: any) => {
          // Extract col and doc id
          const parts = ref.path ? ref.path.split('/') : ['unknown', 'unknown'];
          return ref.get();
        },
        set: (ref: any, data: any, opts?: any) => {
          ref.set(data, opts);
        },
      };
      return await updateFn(transaction);
    },
  };

  const ctx: SimosanCtx = {
    db,
    FieldValue: {
      serverTimestamp: () => new Date().toISOString(),
      increment: (n: number) => n,
    },
    Timestamp: {
      now: () => new Date(),
      fromDate: (d: Date) => d,
    },
  };

  return { ctx, store };
}

async function runAllTests() {
  console.log('=====================================================================');
  console.log('  Gemini 3.1 Flash-Lite & 3.5 Flash-Lite Multi-Model Pricing Suite   ');
  console.log('=====================================================================\n');

  // -------------------------------------------------------------------------
  // 1. Pricing Constants & Option B Weights
  // -------------------------------------------------------------------------
  console.log('--- 1. Pricing Constants & Option B Credit Weights ---');

  test('Model identifier is gemini-3.1-flash-lite', () => {
    assert.equal(DEFAULT_MODEL, 'gemini-3.1-flash-lite');
  });

  test('Unit weight: Uncached Input = 1.0 credit per token ($0.25 / 1M)', () => {
    assert.equal(UNIT_WEIGHT_UNCACHED_INPUT, 1.0);
  });

  test('Unit weight: Cached Input = 0.25 credits per token ($0.0625 / 1M)', () => {
    assert.equal(UNIT_WEIGHT_CACHED_INPUT, 0.25);
    // Ratio check: $0.0625 / $0.25 === 0.25
    assert.equal(0.0625 / 0.25, 0.25);
  });

  test('Unit weight: Output (incl. thinking) = 6.0 credits per token ($1.50 / 1M)', () => {
    assert.equal(UNIT_WEIGHT_OUTPUT, 6.0);
    // Ratio check: $1.50 / $0.25 === 6.0
    assert.equal(1.50 / 0.25, 6.0);
  });

  test('Context cache storage rate constant is $1.00 USD per hour', () => {
    assert.equal(CONTEXT_CACHE_STORAGE_PER_HOUR_USD, 1.00);
  });

  test('1 credit == 1 uncached input token == $0.00000025 USD', () => {
    assert.equal(USD_PER_UNIT, 0.25 / 1_000_000);
    assert.equal(unitsToUsd(1_000_000), 0.25);
    assert.equal(unitsToUsd(1), 0.00000025);
  });

  test('Weekly budget cap is 800,000 credits ($0.20 USD)', () => {
    assert.equal(DEFAULT_WEEKLY_UNIT_BUDGET, 800_000);
    assert.equal(WEEKLY_CAP_CREDITS, 800_000);
    // 800,000 credits * $0.00000025 USD/credit = $0.20000000 USD
    const cost = unitsToUsd(800_000);
    assert.ok(Math.abs(cost - 0.20) < 0.0001, `Expected ~$0.20, got ${cost}`);
  });

  test('5-week monthly budget cap is 4,000,000 credits ($1.00 USD)', () => {
    assert.equal(DEFAULT_5_WEEK_UNIT_BUDGET, 4_000_000);
    assert.equal(MONTHLY_CAP_CREDITS, 4_000_000);
    // 4,000,000 credits * $0.00000025 USD/credit = $1.00000000 USD
    const cost = unitsToUsd(4_000_000);
    assert.ok(Math.abs(cost - 1.00) < 0.0001, `Expected ~$1.00, got ${cost}`);
  });

  test('Multi-model registry: gemini-3.5-flash-lite rates and dynamic calculation', () => {
    const p35 = getModelPricing('gemini-3.5-flash-lite');
    assert.equal(p35.id, 'gemini-3.5-flash-lite');
    assert.equal(p35.uncachedInputUsdPer1M, 0.30);
    assert.equal(p35.cachedInputUsdPer1M, 0.03);
    assert.equal(p35.outputUsdPer1M, 2.50);
    assert.equal(p35.unitWeightUncachedInput, 1.0);
    assert.equal(p35.unitWeightCachedInput, 0.10);
    assert.equal(p35.unitWeightOutput, 25 / 3);
    assert.equal(p35.weeklyBudgetUnits, 666_667);
    assert.equal(p35.monthlyBudgetUnits, 3_333_333);

    // Dynamic calculation under 3.5 pricing
    const usage: GeminiUsage = { promptTokenCount: 1_000, candidatesTokenCount: 300 };
    // 3.5: 1,000 * 1 + 300 * (25/3) = 1,000 + 2,500 = 3,500 credits
    const credits35 = unitsFromUsage(usage, 'gemini-3.5-flash-lite');
    assert.equal(credits35, 3_500);

    // 3.1: 1,000 * 1 + 300 * 6 = 1,000 + 1,800 = 2,800 credits
    const credits31 = unitsFromUsage(usage, 'gemini-3.1-flash-lite');
    assert.equal(credits31, 2_800);
  });

  // -------------------------------------------------------------------------
  // 2. The 7 Reference Benchmarks for $0.20 Weekly Cap & $1.00 5-Week Cap
  // -------------------------------------------------------------------------
  console.log('\n--- 2. Reference Benchmarks (7 Profiles) ---');

  // Benchmark 1: 100% Uncached Input
  test('Benchmark 1 (100% Uncached Input): 800,000 weekly / 4,000,000 5-week tokens', () => {
    const weeklyUsage: GeminiUsage = { promptTokenCount: 800_000, cachedContentTokenCount: 0, candidatesTokenCount: 0 };
    const weeklyCredits = unitsFromUsage(weeklyUsage);
    assert.equal(weeklyCredits, 800_000);
    assert.ok(weeklyCredits >= DEFAULT_WEEKLY_UNIT_BUDGET);

    const fiveWeekUsage: GeminiUsage = { promptTokenCount: 4_000_000, cachedContentTokenCount: 0, candidatesTokenCount: 0 };
    const fiveWeekCredits = unitsFromUsage(fiveWeekUsage);
    assert.equal(fiveWeekCredits, 4_000_000);
    assert.ok(fiveWeekCredits >= DEFAULT_5_WEEK_UNIT_BUDGET);
  });

  // Benchmark 2: 100% Output (including thinking tokens)
  test('Benchmark 2 (100% Output): 133,334 weekly / 666,667 5-week tokens', () => {
    // Weekly: 133,334 output tokens * 6 = 800,004 credits
    const weeklyCandidates: GeminiUsage = { promptTokenCount: 0, candidatesTokenCount: 133_334 };
    const weeklyCredits = unitsFromUsage(weeklyCandidates);
    assert.equal(weeklyCredits, 800_004);
    assert.ok(weeklyCredits >= DEFAULT_WEEKLY_UNIT_BUDGET);

    // Also verify with thinking tokens
    const weeklyThinking: GeminiUsage = { promptTokenCount: 0, candidatesTokenCount: 66_667, thoughtsTokenCount: 66_667 };
    assert.equal(unitsFromUsage(weeklyThinking), 800_004);

    // 5-week: 666,667 output tokens * 6 = 4,000,002 credits
    const fiveWeekUsage: GeminiUsage = { promptTokenCount: 0, candidatesTokenCount: 333_334, thoughtsTokenCount: 333_333 };
    const fiveWeekCredits = unitsFromUsage(fiveWeekUsage);
    assert.ok(fiveWeekCredits >= DEFAULT_5_WEEK_UNIT_BUDGET);
  });

  // Benchmark 3: 100% Cached Input
  test('Benchmark 3 (100% Cached Input): 3,200,000 weekly / 16,000,000 5-week tokens', () => {
    // In Gemini API, promptTokenCount includes cachedContentTokenCount
    // 3,200,000 cached tokens * 0.25 = 800,000 credits
    const weeklyUsage: GeminiUsage = { promptTokenCount: 3_200_000, cachedContentTokenCount: 3_200_000 };
    const weeklyCredits = unitsFromUsage(weeklyUsage);
    assert.equal(weeklyCredits, 800_000);
    assert.ok(weeklyCredits >= DEFAULT_WEEKLY_UNIT_BUDGET);

    // 5-week: 16,000,000 cached tokens * 0.25 = 4,000,000 credits
    const fiveWeekUsage: GeminiUsage = { promptTokenCount: 16_000_000, cachedContentTokenCount: 16_000_000 };
    const fiveWeekCredits = unitsFromUsage(fiveWeekUsage);
    assert.equal(fiveWeekCredits, 4_000_000);
    assert.ok(fiveWeekCredits >= DEFAULT_5_WEEK_UNIT_BUDGET);
  });

  // Benchmark 4: 1:1 Split (50% In / 50% Out)
  test('Benchmark 4 (1:1 Split): 228,572 weekly / 1,142,858 5-week tokens', () => {
    // 228,572 total tokens: 114,286 uncached input, 114,286 output
    // Credits = 114,286 * 1 + 114,286 * 6 = 114,286 + 685,716 = 800,002 credits
    const weeklyUsage: GeminiUsage = { promptTokenCount: 114_286, candidatesTokenCount: 114_286 };
    const weeklyCredits = unitsFromUsage(weeklyUsage);
    assert.ok(weeklyCredits >= DEFAULT_WEEKLY_UNIT_BUDGET, `Expected >= 800000, got ${weeklyCredits}`);

    // 5-week: 1,142,858 total tokens: 571,429 input, 571,429 output
    // Credits = 571,429 * 1 + 571,429 * 6 = 571,429 + 3,428,574 = 4,000,003 credits
    const fiveWeekUsage: GeminiUsage = { promptTokenCount: 571_429, candidatesTokenCount: 571_429 };
    const fiveWeekCredits = unitsFromUsage(fiveWeekUsage);
    assert.ok(fiveWeekCredits >= DEFAULT_5_WEEK_UNIT_BUDGET, `Expected >= 4000000, got ${fiveWeekCredits}`);
  });

  // Benchmark 5: 3:1 Split (75% In / 25% Out)
  test('Benchmark 5 (3:1 Split): 355,556 weekly / 1,777,778 5-week tokens', () => {
    // Combined rate: 0.75 * 1 + 0.25 * 6 = 2.25 credits/token
    // 355,556 * 2.25 = 800,001 credits
    // Token split: 266,667 input, 88,889 output
    const weeklyUsage: GeminiUsage = { promptTokenCount: 266_667, candidatesTokenCount: 88_889 };
    const weeklyCredits = unitsFromUsage(weeklyUsage);
    assert.ok(Math.abs(weeklyCredits - DEFAULT_WEEKLY_UNIT_BUDGET) <= 5);

    // 5-week split: 1,333,334 input, 444,445 output
    const fiveWeekUsage: GeminiUsage = { promptTokenCount: 1_333_334, candidatesTokenCount: 444_445 };
    const fiveWeekCredits = unitsFromUsage(fiveWeekUsage);
    assert.ok(fiveWeekCredits >= DEFAULT_5_WEEK_UNIT_BUDGET);
  });

  // Benchmark 6: 4:1 Split (80% In / 20% Out)
  test('Benchmark 6 (4:1 Split): 400,000 weekly / 2,000,000 5-week tokens', () => {
    // Combined rate: 0.8 * 1 + 0.2 * 6 = 2.0 credits/token
    // 400,000 * 2.0 = 800,000 credits
    const weeklyUsage: GeminiUsage = { promptTokenCount: 320_000, candidatesTokenCount: 80_000 };
    const weeklyCredits = unitsFromUsage(weeklyUsage);
    assert.equal(weeklyCredits, DEFAULT_WEEKLY_UNIT_BUDGET);

    // 5-week split: 1,600,000 input, 400,000 output
    const fiveWeekUsage: GeminiUsage = { promptTokenCount: 1_600_000, candidatesTokenCount: 400_000 };
    const fiveWeekCredits = unitsFromUsage(fiveWeekUsage);
    assert.equal(fiveWeekCredits, DEFAULT_5_WEEK_UNIT_BUDGET);
  });

  // Benchmark 7: 9:1 Split (90% In / 10% Out)
  test('Benchmark 7 (9:1 Split): 533,334 weekly / 2,666,667 5-week tokens', () => {
    // Combined rate: 0.9 * 1 + 0.1 * 6 = 1.5 credits/token
    // 533,334 * 1.5 = 800,001 credits
    const weeklyUsage: GeminiUsage = { promptTokenCount: 480_000, candidatesTokenCount: 53_334 };
    const weeklyCredits = unitsFromUsage(weeklyUsage);
    assert.ok(Math.abs(weeklyCredits - DEFAULT_WEEKLY_UNIT_BUDGET) <= 5);

    // 5-week split: 2,400,000 input, 266,667 output
    const fiveWeekUsage: GeminiUsage = { promptTokenCount: 2_400_000, candidatesTokenCount: 266_667 };
    const fiveWeekCredits = unitsFromUsage(fiveWeekUsage);
    assert.ok(fiveWeekCredits >= DEFAULT_5_WEEK_UNIT_BUDGET);
  });

  // -------------------------------------------------------------------------
  // 3. Usage Metadata Extraction & Thinking Tokens
  // -------------------------------------------------------------------------
  console.log('\n--- 3. Usage Metadata Extraction & Thinking Tokens ---');

  test('extractUsageMetadata parses unary GenerateContentResponse', () => {
    const rawUnaryResponse = {
      usageMetadata: {
        promptTokenCount: 15_000,
        candidatesTokenCount: 850,
        cachedContentTokenCount: 12_000,
        thoughtsTokenCount: 250,
      },
    };
    const extracted = extractUsageMetadata(rawUnaryResponse);
    assert.ok(extracted !== null);
    assert.equal(extracted!.promptTokenCount, 15_000);
    assert.equal(extracted!.candidatesTokenCount, 850);
    assert.equal(extracted!.cachedContentTokenCount, 12_000);
    assert.equal(extracted!.thoughtsTokenCount, 250);

    // gemini-3.1-flash-lite rates:
    // Uncached = 15,000 - 12,000 = 3,000
    // Output = 850 + 250 = 1,100
    // Credits = 3,000 * 1 + 12,000 * 0.25 + 1,100 * 6 = 3,000 + 3,000 + 6,600 = 12,600 credits
    const credits = unitsFromUsage(extracted);
    assert.equal(credits, 12_600);

    // gemini-3.5-flash-lite rates:
    // Credits = 3,000 * 1 + 12,000 * 0.1 + 1,100 * (25 / 3) = 3,000 + 1,200 + 9,166.67 = 13,367 credits
    const credits35 = unitsFromUsage(extracted, 'gemini-3.5-flash-lite');
    assert.equal(credits35, 13_367);
  });

  test('Thinking tokens are billed at output rate (6.0 on 3.1) without double-counting', () => {
    // 0 prompt, 100 candidate tokens, 50 thinking tokens
    // Output = 150 tokens * 6 = 900 credits
    const usage: GeminiUsage = {
      promptTokenCount: 0,
      candidatesTokenCount: 100,
      thoughtsTokenCount: 50,
    };
    const credits = unitsFromUsage(usage);
    assert.equal(credits, 900);
  });

  test('Cached input tokens deduction: prompt includes cached tokens', () => {
    // Prompt = 10,000 with 7,000 cached. Uncached = 3,000.
    // Credits = 3,000 * 1.0 + 7,000 * 0.25 = 3,000 + 1,750 = 4,750 credits
    const usage: GeminiUsage = {
      promptTokenCount: 10_000,
      cachedContentTokenCount: 7_000,
      candidatesTokenCount: 0,
      thoughtsTokenCount: 0,
    };
    assert.equal(unitsFromUsage(usage), 4_750);
  });

  test('extractUsageMetadata rejects non-token objects and sanitizes negative counts', () => {
    // Must return null for objects without usageMetadata or token properties
    assert.equal(extractUsageMetadata(null), null);
    assert.equal(extractUsageMetadata(undefined), null);
    assert.equal(extractUsageMetadata({ text: 'just a streaming text chunk' }), null);
    assert.equal(extractUsageMetadata({ error: 'service unavailable' }), null);

    // Negative counts must be sanitized to 0
    const corruptUsage = extractUsageMetadata({
      usageMetadata: {
        promptTokenCount: -100,
        candidatesTokenCount: -50,
        cachedContentTokenCount: -20,
        thoughtsTokenCount: -10,
      },
    });
    assert.ok(corruptUsage !== null);
    assert.equal(corruptUsage!.promptTokenCount, 0);
    assert.equal(corruptUsage!.candidatesTokenCount, 0);
    assert.equal(corruptUsage!.cachedContentTokenCount, 0);
    assert.equal(corruptUsage!.thoughtsTokenCount, 0);
    assert.equal(unitsFromUsage(corruptUsage), 0);
  });

  // -------------------------------------------------------------------------
  // 4. Streaming Chunk Aggregation & Client Disconnect Resilience
  // -------------------------------------------------------------------------
  console.log('\n--- 4. Streaming Chunk Aggregation & Disconnect Resilience ---');

  test('Streaming chunk aggregation captures cumulative usage without token loss', async () => {
    // Mock GenAI with chunks where usageMetadata updates on final chunk
    const mockChunks = [
      { text: 'Hello, ' },
      { text: 'this is Simosan. ' },
      {
        text: 'Exam point.',
        usageMetadata: {
          promptTokenCount: 5_000,
          cachedContentTokenCount: 4_000,
          candidatesTokenCount: 120,
          thoughtsTokenCount: 60,
        },
      },
    ];

    const mockAi: any = {
      models: {
        generateContentStream: async () => (async function* () {
          for (const c of mockChunks) yield c;
        })(),
      },
    };

    let streamOutput = '';
    const result = await streamAnswer(mockAi, DEFAULT_MODEL, [], (t) => { streamOutput += t; });

    assert.equal(streamOutput, 'Hello, this is Simosan. Exam point.');
    assert.ok(result.usage !== null);
    assert.equal(result.usage!.promptTokenCount, 5_000);
    assert.equal(result.usage!.cachedContentTokenCount, 4_000);
    assert.equal(result.usage!.candidatesTokenCount, 120);
    assert.equal(result.usage!.thoughtsTokenCount, 60);

    // Uncached: 1,000 + Cached: 1,000 (4,000 * 0.25) + Output: 1,080 (180 * 6) = 3,080 credits
    assert.equal(unitsFromUsage(result.usage), 3_080);
  });

  test('Streaming resilience: captures final usage even if client disconnects mid-stream', async () => {
    const mockChunks = [
      { text: 'First chunk sent to client. ' },
      { text: 'Second chunk where client disconnects. ' },
      {
        text: 'Final chunk generated by model.',
        usageMetadata: {
          promptTokenCount: 20_000,
          cachedContentTokenCount: 18_000,
          candidatesTokenCount: 300,
          thoughtsTokenCount: 120,
        },
      },
    ];

    const mockAi: any = {
      models: {
        generateContentStream: async () => (async function* () {
          for (const c of mockChunks) yield c;
        })(),
      },
    };

    let chunksDelivered = 0;
    const onDelta = (text: string) => {
      chunksDelivered++;
      if (chunksDelivered >= 2) {
        // Simulate client socket drop / EPIPE
        throw new Error('client_disconnected_epipe');
      }
    };

    const result = await streamAnswer(mockAi, DEFAULT_MODEL, [], onDelta);

    // Verify stream continued draining, captured final usage, and retained full generated response
    assert.equal(result.clientDisconnected, true, 'clientDisconnected flag should be true');
    assert.equal(
      result.fullText,
      'First chunk sent to client. Second chunk where client disconnects. Final chunk generated by model.',
    );
    assert.ok(result.usage !== null, 'Usage must not be null');
    assert.equal(result.usage!.promptTokenCount, 20_000);
    assert.equal(result.usage!.cachedContentTokenCount, 18_000);
    assert.equal(result.usage!.candidatesTokenCount, 300);
    assert.equal(result.usage!.thoughtsTokenCount, 120);

    // Uncached = 2,000, Cached = 4,500 (18,000 * 0.25), Output = 2,520 (420 * 6). Total = 9,020 credits
    assert.equal(unitsFromUsage(result.usage), 9_020);
  });

  // -------------------------------------------------------------------------
  // 5. Quota Management & 5-Week Rolling Cycle
  // -------------------------------------------------------------------------
  console.log('\n--- 5. Quota Management & 5-Week Rolling Cycle ---');

  await test('Weekly quota exhaustion: request within 800,000 credits succeeds, request beyond is rejected', async () => {
    const { ctx } = createMockFirestoreCtx();
    const uid = 'student_weekly_test';
    const t0 = new Date('2026-10-31T08:00:00Z');
    const t1 = new Date('2026-10-31T12:00:00Z'); // 4h later (past 2h burst cooldown)
    const t2 = new Date('2026-10-31T16:00:00Z'); // 4h later

    // 1. Initial reservation of 500,000 credits succeeds
    const res1 = await reserveEnergy(ctx, { uid, stageId: 'stage_3', estimatedUnits: 500_000 }, t0);
    assert.equal(res1.ok, true);
    assert.equal(res1.reserved, 500_000);
    assert.equal(res1.remaining, 300_000);

    // Settle with 500,000 credits
    await reconcileEnergy(ctx, { uid, reservedUnits: 500_000, actualUnits: 500_000 }, t0);

    // 2. Second reservation of 300,000 credits reaches exact weekly cap (800,000)
    const res2 = await reserveEnergy(ctx, { uid, stageId: 'stage_3', estimatedUnits: 300_000 }, t1);
    assert.equal(res2.ok, true);
    assert.equal(res2.remaining, 0);

    await reconcileEnergy(ctx, { uid, reservedUnits: 300_000, actualUnits: 300_000 }, t1);

    // 3. Third reservation attempts 1 credit past the cap -> rejected
    const res3 = await reserveEnergy(ctx, { uid, stageId: 'stage_3', estimatedUnits: 1 }, t2);
    assert.equal(res3.ok, false);
    assert.equal(res3.reason, 'insufficient_energy');
    assert.equal(res3.remaining, 0);
  });

  await test('5-Week Rolling Cycle: accumulating 4,000,000 credits across 5 weeks rejects new requests', async () => {
    const { ctx, store } = createMockFirestoreCtx();
    const uid = 'student_rolling_test';
    const t0 = new Date('2026-10-31T08:00:00Z');
    const t1 = new Date('2026-10-31T12:00:00Z'); // 4h later (past 2h burst cooldown)
    const currentWeek = baghdadWeekKey(t0);
    const rollingKeys = getRollingWeekKeys(currentWeek, 5);
    assert.equal(rollingKeys.length, 5);

    // Populate the 4 prior weeks with 800,000 credits each
    // 4 * 800,000 = 3,200,000 credits already used
    for (let i = 1; i < 5; i++) {
      const priorWeekKey = rollingKeys[i];
      store.set(`aiUsage/${uid}_${priorWeekKey}`, {
        uid,
        week: priorWeekKey,
        unitsUsed: 800_000,
        unitsReserved: 0,
      });
    }

    // In current week, student reserves remaining 800,000 credits -> total 4,000,000
    const res1 = await reserveEnergy(ctx, { uid, stageId: 's', estimatedUnits: 800_000 }, t0);
    assert.equal(res1.ok, true);
    await reconcileEnergy(ctx, { uid, reservedUnits: 800_000, actualUnits: 800_000 }, t0);

    // Total 5-week usage is now 3,200,000 + 800,000 = 4,000,000 credits.
    // An additional request of 100 units exceeds 4,000,000 cap -> rejected
    const res2 = await reserveEnergy(ctx, { uid, stageId: 's', estimatedUnits: 100 }, t1);
    assert.equal(res2.ok, false);
    assert.equal(res2.reason, 'insufficient_energy');
  });

  await test('Rolling window slide: oldest week drops out when window advances', async () => {
    const currentWeek = '2026-10-31';
    const keys = getRollingWeekKeys(currentWeek, 5);
    assert.deepEqual(keys, [
      '2026-10-31',
      '2026-10-24',
      '2026-10-17',
      '2026-10-10',
      '2026-10-03',
    ]);

    // Next week advances: 2026-10-03 drops off the 5-week window
    const nextWeek = '2026-11-07';
    const nextKeys = getRollingWeekKeys(nextWeek, 5);
    assert.deepEqual(nextKeys, [
      '2026-11-07',
      '2026-10-31',
      '2026-10-24',
      '2026-10-17',
      '2026-10-10',
    ]);
    assert.ok(!nextKeys.includes('2026-10-03'));
  });

  // -------------------------------------------------------------------------
  // 6. Floating-point Precision & Atomic Accumulator Test
  // -------------------------------------------------------------------------
  console.log('\n--- 6. Floating-Point Precision & Atomic Accumulator ---');

  test('Floating-point clean accumulator: 1,000 micro-transactions do not drift', () => {
    let settings = normaliseSettings({
      monthUsd: 0,
      weeklyUnitBudget: 800_000,
    });

    // 1,000 micro calls of 400 units each (each call ~$0.00010000 USD)
    for (let i = 0; i < 1_000; i++) {
      const spendUsd = unitsToUsd(400);
      const nextMonthUsd = Number((settings.monthUsd + spendUsd).toFixed(8));
      settings.monthUsd = nextMonthUsd;
    }

    // 400 * 1,000 = 400,000 credits
    // 400,000 * 0.25 / 1,000,000 = 0.100000 USD
    assert.equal(settings.monthUsd, 0.1);
    assert.equal(typeof settings.monthUsd, 'number');
    assert.ok(!isNaN(settings.monthUsd));
  });

  // -------------------------------------------------------------------------
  // 7. Supabase / Firestore Quota Parity & Atomic Concurrency
  // -------------------------------------------------------------------------
  console.log('\n--- 7. Supabase / Firestore Quota Parity & Atomic Concurrency ---');

  const createMockSupa = (supaStore: Map<string, any>, enableRpc = true) => ({
    from: (table: string) => ({
      select: (cols?: string) => ({
        eq: (col: string, val: any) => ({
          maybeSingle: async () => ({ data: supaStore.get(val) || null, error: null }),
        }),
        in: async (col: string, vals: any[]) => {
          const rows = vals.map((v) => supaStore.get(v)).filter(Boolean);
          return { data: rows, error: null };
        },
      }),
      upsert: async (row: any) => {
        const existing = supaStore.get(row.id) || {};
        supaStore.set(row.id, { ...existing, ...row });
        return { data: row, error: null };
      },
      update: (updates: any) => ({
        eq: async (col: string, val: any) => {
          const existing = supaStore.get(val) || {};
          supaStore.set(val, { ...existing, ...updates });
          return { data: supaStore.get(val), error: null };
        },
      }),
    }),
    rpc: async (fn: string, args: any) => {
      if (!enableRpc) {
        return { data: null, error: new Error('function increment_ai_usage does not exist') };
      }
      if (fn === 'increment_ai_usage') {
        const { p_id, p_user_id, p_period_key, p_delta_used, p_delta_reserved, p_delta_window } = args;
        const current = supaStore.get(p_id) || { units_used: 0, units_reserved: 0, window_units: 0, used_count: 0 };
        const nextUsed = Math.max(0, (Number(current.units_used) || 0) + (Number(p_delta_used) || 0));
        const nextReserved = Math.max(0, (Number(current.units_reserved) || 0) + (Number(p_delta_reserved) || 0));
        const nextWindow = Math.max(0, (Number(current.window_units) || 0) + (Number(p_delta_window) || 0));
        const nextCount = Number(p_delta_used) > 0 ? (Number(current.used_count) || 0) + 1 : (Number(current.used_count) || 0);
        const updated = {
          ...current,
          id: p_id,
          user_id: p_user_id,
          period_key: p_period_key,
          units_used: nextUsed,
          units_reserved: nextReserved,
          window_units: nextWindow,
          used_count: nextCount,
        };
        supaStore.set(p_id, updated);
        return { data: [{ units_used: nextUsed, units_reserved: nextReserved, window_units: nextWindow }], error: null };
      }
      return { data: null, error: new Error('unknown function') };
    },
  });

  await test('Supabase reserveSupaEnergy enforces 800,000 weekly cap via atomic RPC', async () => {
    const supaStore = new Map<string, any>();
    const mockSupa: any = createMockSupa(supaStore, true);

    const sUid = 'supa_student_rpc';
    const sWeek = '2026-10-31';
    const t0 = new Date('2026-10-31T09:00:00Z');
    const t1 = new Date('2026-10-31T13:00:00Z'); // 4 hours later (past cooldown)

    // 1. Reserve 800,000 credits succeeds
    const sRes1 = await reserveSupaEnergy(mockSupa, { uid: sUid, weekKey: sWeek, estimatedUnits: 800_000, now: t0 });
    assert.equal(sRes1.ok, true);
    assert.equal(sRes1.remaining, 0);

    await reconcileSupaEnergy(mockSupa, { uid: sUid, weekKey: sWeek, reservedUnits: 800_000, actualUnits: 800_000, now: t0 });

    // 2. Subsequent reservation denied with insufficient_energy
    const sRes2 = await reserveSupaEnergy(mockSupa, { uid: sUid, weekKey: sWeek, estimatedUnits: 1, now: t1 });
    assert.equal(sRes2.ok, false);
    assert.equal(sRes2.reason, 'insufficient_energy');
  });

  await test('Supabase atomic RPC rolls back reservation when concurrent burst exceeds budget', async () => {
    const supaStore = new Map<string, any>();
    const mockSupa: any = createMockSupa(supaStore, true);

    const sUid = 'supa_student_rollback';
    const sWeek = '2026-10-31';
    const t0 = new Date('2026-10-31T09:00:00Z');

    // Pre-populate with 750,000 units used
    supaStore.set(`${sUid}_${sWeek}`, {
      id: `${sUid}_${sWeek}`,
      user_id: sUid,
      period_key: sWeek,
      units_used: 750_000,
      units_reserved: 0,
      window_units: 0,
    });

    // Attempt reservation of 70,000 units (total would be 820,000 > 800,000 cap)
    const res = await reserveSupaEnergy(mockSupa, { uid: sUid, weekKey: sWeek, estimatedUnits: 70_000, now: t0 });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'insufficient_energy');

    // Verify rollback restored units_reserved back to 0
    const row = supaStore.get(`${sUid}_${sWeek}`);
    assert.equal(row.units_reserved, 0, 'units_reserved should be rolled back to 0');
  });

  await test('Supabase reserveSupaEnergy functions reliably via fallback upsert when RPC is absent', async () => {
    const supaStore = new Map<string, any>();
    const mockSupaFallback: any = createMockSupa(supaStore, false);

    const sUid = 'supa_student_fallback';
    const sWeek = '2026-10-31';
    const t0 = new Date('2026-10-31T09:00:00Z');
    const t1 = new Date('2026-10-31T13:00:00Z');

    const res1 = await reserveSupaEnergy(mockSupaFallback, { uid: sUid, weekKey: sWeek, estimatedUnits: 600_000, now: t0 });
    assert.equal(res1.ok, true);
    assert.equal(res1.reserved, 600_000);

    await reconcileSupaEnergy(mockSupaFallback, { uid: sUid, weekKey: sWeek, reservedUnits: 600_000, actualUnits: 600_000, now: t0 });

    const res2 = await reserveSupaEnergy(mockSupaFallback, { uid: sUid, weekKey: sWeek, estimatedUnits: 250_000, now: t1 });
    assert.equal(res2.ok, false);
    assert.equal(res2.reason, 'insufficient_energy');
  });

  console.log('\n=====================================================================');
  console.log(`  ALL GEMINI PRICING & QUOTA TESTS PASSED (${passedTests}/${totalTests})!`);
  console.log('=====================================================================\n');
}

runAllTests().catch((err) => {
  console.error('\nTest suite execution failed:', err);
  process.exit(1);
});
