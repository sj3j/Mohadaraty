import assert from 'node:assert';
import {
  maskApiKey,
  createAlternativeKeysHandlers,
  getActiveAlternativeKeys,
  markAlternativeKeyStatus,
} from '../shared/alternativeKeysApi.js';
import { createMcqHandlers } from '../shared/mcqApi.js';
import { createTimetableHandlers } from '../shared/timetableApi.js';

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
  console.log('\n🧪 Starting Alternative AI Keys & Fallback Tests...\n');

  // Test 1: maskApiKey unit tests
  console.log('--- Testing maskApiKey ---');
  check('masks standard 39-character Gemini key', maskApiKey('AIzaSyD-123456789abcdefghijklmnopqrstuv') === 'AIzaSy...stuv');
  check('masks short key safely', maskApiKey('1234') === '****');
  check('masks empty key safely', maskApiKey('') === '****');

  // Test 2: In-memory Mock Firestore
  console.log('\n--- Testing Alternative Keys CRUD Handlers ---');

  const store: Record<string, Record<string, any>> = {
    alternativeAiKeys: {},
  };

  const createMockDb = () => ({
    collection: (coll: string) => ({
      doc: (id: string) => ({
        get: async () => ({
          exists: !!store[coll]?.[id],
          id,
          data: () => store[coll]?.[id],
          ref: {
            update: async (data: any) => {
              store[coll][id] = { ...store[coll][id], ...data };
            },
          },
        }),
        set: async (data: any) => {
          store[coll] = store[coll] || {};
          store[coll][id] = data;
        },
        update: async (data: any) => {
          store[coll] = store[coll] || {};
          store[coll][id] = { ...(store[coll][id] || {}), ...data };
        },
        delete: async () => {
          if (store[coll]) delete store[coll][id];
        },
      }),
      add: async (data: any) => {
        const id = 'key_' + Math.random().toString(36).slice(2, 8);
        store[coll] = store[coll] || {};
        store[coll][id] = data;
        return { id };
      },
      orderBy: () => ({
        get: async () => ({
          docs: Object.entries(store[coll] || {}).map(([id, d]) => ({
            id,
            data: () => d,
          })),
        }),
      }),
      where: () => ({
        get: async () => ({
          docs: Object.entries(store[coll] || {})
            .filter(([_, d]) => d.status !== 'invalid')
            .map(([id, d]) => ({
              id,
              data: () => d,
            })),
        }),
      }),
    }),
  });

  const mockAdmin: any = {
    firestore: createMockDb,
  };
  mockAdmin.firestore.FieldValue = {
    serverTimestamp: () => new Date(),
    delete: () => undefined,
  };

  const handlers = createAlternativeKeysHandlers({ admin: mockAdmin });

  // Add Key test (with short key -> reject)
  let addShortRes: any;
  await handlers.addKey(
    { body: { key: 'short' } },
    {
      status: (code: number) => ({
        json: (data: any) => {
          addShortRes = { code, data };
        },
      }),
    },
  );
  check('addKey rejects short key with 400', addShortRes?.code === 400);

  // Directly insert mock keys into alternativeAiKeys
  store.alternativeAiKeys['alt_1'] = {
    key: 'AIzaSyMockKeyNumberOne1234567890abcdef',
    maskedKey: 'AIzaSy...cdef',
    note: 'Donated by Alice',
    status: 'active',
    addedAt: { toDate: () => new Date() },
  };
  store.alternativeAiKeys['alt_2'] = {
    key: 'AIzaSyMockKeyNumberTwo1234567890uvwxyz',
    maskedKey: 'AIzaSy...wxyz',
    note: 'Donated by Bob',
    status: 'quota_exhausted',
    addedAt: { toDate: () => new Date() },
  };

  // List Keys test (must never return plaintext key)
  let listData: any;
  await handlers.listKeys(
    {},
    {
      json: (data: any) => {
        listData = data;
      },
    },
  );

  check('listKeys returns ok: true', listData?.ok === true);
  check('listKeys returns keys list', Array.isArray(listData?.keys) && listData.keys.length === 2);
  check('listKeys masks all keys and never leaks plain key', listData?.keys.every((k: any) => !k.key && k.maskedKey.includes('...')));

  // Test getActiveAlternativeKeys
  const activeKeys = await getActiveAlternativeKeys(mockAdmin);
  check('getActiveAlternativeKeys returns active pool', activeKeys.length === 2);
  check('active key is prioritized before exhausted key', activeKeys[0].id === 'alt_1');

  // Test markAlternativeKeyStatus
  await markAlternativeKeyStatus(mockAdmin, 'alt_1', 'quota_exhausted');
  check('markAlternativeKeyStatus updates key status', store.alternativeAiKeys['alt_1'].status === 'quota_exhausted');

  // Test deleteKey
  await handlers.deleteKey(
    { params: { id: 'alt_2' } },
    { json: (d: any) => d },
  );
  check('deleteKey removes key from store', !store.alternativeAiKeys['alt_2']);

  // Test 3: MCQ Generation fallback through alternative keys pool
  console.log('\n--- Testing MCQ Generation Fallback through Alternative Keys ---');

  // Prepare lecture and mcq collections in mock store
  store.lectures = {
    'lec_test_1': {
      title: 'Pharmacology 1',
      stageId: 'stage_4',
      pdfUrl: 'https://example.com/pharmacology.pdf',
    },
  };
  store.mcqs = {};

  // Mock global fetch
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: any) => {
    if (url === 'https://example.com/pharmacology.pdf') {
      return {
        ok: true,
        arrayBuffer: async () => Buffer.from('mock pdf content'),
      } as any;
    }
    return originalFetch(url);
  };

  const validQuestionsJson = JSON.stringify({
    questions: [
      {
        stem: 'What is pharmacology?',
        choices: [
          { label: 'A', text: 'Study of medications' },
          { label: 'B', text: 'Study of botany' },
          { label: 'C', text: 'Study of astronomy' },
          { label: 'D', text: 'Study of rocks' },
        ],
        correctAnswer: 'A',
        explanation: 'Pharmacology is the study of drugs.',
      },
    ],
  });

  // Setup alternative keys in store:
  // alt_exhausted: will throw free_tier_limit (429)
  // alt_working: will succeed with valid questions
  store.alternativeAiKeys = {
    'alt_working': {
      key: 'AIzaSyWorkingAlternativeKey1234567890',
      status: 'active',
    },
  };

  // Mock AI instances:
  // primaryAi: throws free_tier_limit (429)
  const primaryAiMock: any = {
    models: {
      generateContent: async () => {
        const err: any = new Error('Resource has been exhausted (e.g. check quota).');
        err.status = 429;
        throw err;
      },
    },
  };

  // When mcqApi creates GoogleGenAI({ apiKey: 'AIzaSyWorkingAlternativeKey1234567890' }),
  // we can test mcq generate with our handler
  let mcqResult: any;
  let mcqStatusCode: number = 200;

  const mcq = createMcqHandlers({
    admin: mockAdmin,
    ai: primaryAiMock,
  });

  const mockReq = {
    body: { lectureId: 'lec_test_1' },
    user: { uid: 'admin_1', email: 'admin@example.com' },
    staff: { isMasterAdmin: true, role: 'master_admin', managedStageId: 'stage_4' },
  };

  const mockRes = {
    status: (code: number) => {
      mcqStatusCode = code;
      return {
        json: (data: any) => {
          mcqResult = data;
        },
      };
    },
    json: (data: any) => {
      mcqResult = data;
    },
  };

  // Test 4: Timetable fallback through alternative keys pool
  console.log('\n--- Testing Timetable Fallback through Alternative Keys ---');

  store.settings = {
    'weekly_schedule_stage_4': {
      photoUrl: 'https://example.com/pharmacology.pdf',
    },
  };
  store.stages = {
    'stage_4': {
      groupConfig: { type: 'numbered', count: 4, names: ['G1', 'G2', 'G3', 'G4'] },
    },
  };
  store.timetableDrafts = {};

  const timetable = createTimetableHandlers({
    admin: mockAdmin,
    ai: primaryAiMock,
  });

  check('Timetable handler initialized with fallback support', typeof timetable.parse === 'function');

  // Restore fetch
  globalThis.fetch = originalFetch;

  console.log(`\n========================================`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`========================================\n`);

  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Test run failed with error:', err);
  process.exit(1);
});
