import assert from 'node:assert';
import { createMcqHandlers } from '../shared/mcqApi.js';
import { hasStaffCapability } from '../shared/staffCapabilities.js';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
    failed++;
  }
}

async function runTests() {
  console.log('\n🧪 Starting MCQ Paid Fallback & Permission Tests...\n');

  // Test 1: Capability resolution
  console.log('--- Testing Capability Resolution ---');
  const masterAdminStaff = { isMasterAdmin: true, role: 'master_admin' };
  check('master admin has managePaidMcq', hasStaffCapability(masterAdminStaff, 'managePaidMcq'));

  const supportWithPerm = { role: 'support', permissions: { managePaidMcq: true } };
  check('support with managePaidMcq has capability', hasStaffCapability(supportWithPerm, 'managePaidMcq'));

  const supportWithoutPerm = { role: 'support', permissions: { managePaidMcq: false } };
  check('support without managePaidMcq denied', !hasStaffCapability(supportWithoutPerm, 'managePaidMcq'));

  const adminRole = { role: 'admin', permissions: { managePaidMcq: true } };
  check('representative denied managePaidMcq even if ticked', !hasStaffCapability(adminRole, 'managePaidMcq'));

  const moderatorRole = { role: 'moderator', permissions: { managePaidMcq: true } };
  check('moderator denied managePaidMcq even if ticked', !hasStaffCapability(moderatorRole, 'managePaidMcq'));

  // Test 2: Handler authorization & execution
  console.log('\n--- Testing API Handler with Mock Environment ---');

  const mockQuestionsJson = JSON.stringify({
    questions: Array.from({ length: 20 }, (_, i) => ({
      stem: `Question ${i + 1}: What is pharmacology?`,
      choices: [
        { label: 'A', text: 'The study of drugs' },
        { label: 'B', text: 'Study of plants' },
        { label: 'C', text: 'Study of stars' },
        { label: 'D', text: 'None of the above' },
      ],
      correctAnswer: 'A',
      explanation: `Pharmacology is the study of drugs. (Q${i + 1})`,
    })),
  });

  // Mock PDF fetch
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: any) => {
    if (url === 'https://example.com/lecture.pdf') {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from('%PDF-1.4 mock content'),
      } as any;
    }
    return { ok: false, status: 404 } as any;
  };

  function createMockEnv() {
    const firestoreData: Record<string, any> = {
      lectures: {
        'lec-1': {
          id: 'lec-1',
          title: 'Pharmacology Lecture 1',
          stageId: 'stage-1',
          pdfUrl: 'https://example.com/lecture.pdf',
        },
      },
      mcqs: {},
      adminAlerts: [],
    };

    const mockDb = {
      collection: (coll: string) => ({
        doc: (id: string) => ({
          get: async () => ({
            exists: !!firestoreData[coll]?.[id],
            data: () => firestoreData[coll]?.[id],
          }),
          set: async (data: any, options?: any) => {
            if (options?.merge && firestoreData[coll]?.[id]) {
              firestoreData[coll][id] = { ...firestoreData[coll][id], ...data };
            } else {
              firestoreData[coll][id] = data;
            }
          },
        }),
        where: () => ({
          limit: () => ({
            get: async () => ({ docs: [] }),
          }),
        }),
        add: async (data: any) => {
          firestoreData.adminAlerts.push(data);
          return { id: 'alert-' + Date.now() };
        },
      }),
    };

    const mockAdmin = {
      firestore: () => mockDb,
      messaging: () => ({
        send: async () => {},
      }),
    };
    (mockAdmin.firestore as any).FieldValue = {
      serverTimestamp: () => new Date(),
      delete: () => undefined,
    };

    return { mockAdmin, firestoreData };
  }

  // Subtest 2A: Support without permission tries to usePaidKey -> 403
  {
    const { mockAdmin } = createMockEnv();
    const handlers = createMcqHandlers({
      admin: mockAdmin,
      ai: { models: { generateContent: async () => ({ text: mockQuestionsJson }) } },
      paidAi: { models: { generateContent: async () => ({ text: mockQuestionsJson }) } },
    });

    let statusCode = 0;
    let jsonBody: any = null;
    const req = {
      body: { lectureId: 'lec-1', usePaidKey: true },
      staff: { role: 'support', managedStageId: 'stage-1', permissions: { manageLectures: true, managePaidMcq: false } },
      user: { uid: 'sup-1', email: 'sup@test.com' },
    };
    const res = {
      status: (code: number) => {
        statusCode = code;
        return { json: (b: any) => { jsonBody = b; } };
      },
      json: (b: any) => { jsonBody = b; },
    };

    await handlers.generate(req, res);
    check('unauthorized support receives 403', statusCode === 403);
    check('error is forbidden_paid_ai', jsonBody?.error === 'forbidden_paid_ai');
  }

  // Subtest 2B: Master Admin uses usePaidKey -> succeeds, stamps paidFallbackUsed and logs alert
  {
    const { mockAdmin, firestoreData } = createMockEnv();
    let paidAiCalled = false;
    let freeAiCalled = false;

    const mockFreeAi = {
      models: {
        generateContent: async () => {
          freeAiCalled = true;
          return { text: mockQuestionsJson };
        },
      },
    };
    const mockPaidAi = {
      models: {
        generateContent: async () => {
          paidAiCalled = true;
          return { text: mockQuestionsJson };
        },
      },
    };

    const handlers = createMcqHandlers({
      admin: mockAdmin,
      ai: mockFreeAi,
      paidAi: mockPaidAi,
    });

    let statusCode = 200;
    let jsonBody: any = null;
    const req = {
      body: { lectureId: 'lec-1', usePaidKey: true },
      staff: { isMasterAdmin: true, role: 'master_admin' },
      user: { uid: 'master-uid', email: 'master@test.com' },
    };
    const res = {
      status: (code: number) => {
        statusCode = code;
        return { json: (b: any) => { jsonBody = b; } };
      },
      json: (b: any) => { jsonBody = b; },
    };

    await handlers.generate(req, res);
    check('master admin paid generation succeeds', jsonBody?.ok === true);
    check('paidAi was invoked', paidAiCalled);
    check('freeAi was NOT invoked', !freeAiCalled);

    const savedMcq = firestoreData.mcqs['lec-1'];
    check('mcq saved status is ready', savedMcq?.status === 'ready');
    check('paidFallbackUsed is true', savedMcq?.paidFallbackUsed === true);
    check('generatedBy is gemini-paid', savedMcq?.generatedBy === 'gemini-paid');
    check('paidTriggeredBy is master-uid', savedMcq?.paidTriggeredBy === 'master-uid');
    check('paidTriggeredByEmail is master@test.com', savedMcq?.paidTriggeredByEmail === 'master@test.com');

    const alert = firestoreData.adminAlerts[0];
    check('adminAlert recorded for paid generation', alert?.type === 'ai_paid_generation');
    check('adminAlert note contains operator email', alert?.note?.includes('master@test.com'));
  }

  // Subtest 2C: Support WITH managePaidMcq permission -> succeeds
  {
    const { mockAdmin, firestoreData } = createMockEnv();
    let paidAiCalled = false;

    const handlers = createMcqHandlers({
      admin: mockAdmin,
      ai: { models: { generateContent: async () => ({ text: mockQuestionsJson }) } },
      paidAi: {
        models: {
          generateContent: async () => {
            paidAiCalled = true;
            return { text: mockQuestionsJson };
          },
        },
      },
    });

    let jsonBody: any = null;
    const req = {
      body: { lectureId: 'lec-1', usePaidKey: true },
      staff: { role: 'support', managedStageId: 'stage-1', permissions: { manageLectures: true, managePaidMcq: true } },
      user: { uid: 'support-allowed', email: 'support@test.com' },
    };
    const res = {
      status: (code: number) => ({ json: (b: any) => { jsonBody = b; } }),
      json: (b: any) => { jsonBody = b; },
    };

    await handlers.generate(req, res);
    check('support with managePaidMcq succeeds', jsonBody?.ok === true);
    check('paidAi was invoked for authorized support', paidAiCalled);
    check('paidFallbackUsed is stamped for support', firestoreData.mcqs['lec-1']?.paidFallbackUsed === true);
    check('paidTriggeredBy records support uid', firestoreData.mcqs['lec-1']?.paidTriggeredBy === 'support-allowed');
  }

  // Restore fetch
  globalThis.fetch = originalFetch;

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Test run error:', err);
  process.exit(1);
});
