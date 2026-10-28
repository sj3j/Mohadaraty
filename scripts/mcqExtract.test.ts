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
  console.log('\n🧪 Starting MCQ PDF Extraction Unit Tests...\n');

  const mockExtractionJson = JSON.stringify({
    questions: [
      {
        stem: 'Which of the following is an NSAID?',
        choices: [
          { label: 'A', text: 'Paracetamol' },
          { label: 'B', text: 'Ibuprofen' },
          { label: 'C', text: 'Amoxicillin' },
          { label: 'D', text: 'Omeprazole' },
        ],
        correctAnswer: 'B', // Raw letter label from model
        explanation: 'Ibuprofen is a non-steroidal anti-inflammatory drug.',
        session: 'الدور 1 2024',
      },
      {
        stem: 'What is the primary action of beta blockers?',
        choices: [
          { label: 'A', text: 'Block beta-adrenergic receptors' },
          { label: 'B', text: 'Inhibit ACE enzyme' },
        ],
        correctAnswer: 'Block beta-adrenergic receptors', // Full text
        explanation: 'Beta blockers block beta receptors.',
      },
    ],
  });

  function createMockEnv() {
    let requestedBucketName: string | null = null;
    let downloadedPath: string | null = null;

    const mockAdmin = {
      storage: () => ({
        bucket: (name?: string) => {
          requestedBucketName = name || 'default-called';
          return {
            name: requestedBucketName,
            file: (path: string) => ({
              exists: async () => [true],
              download: async () => {
                downloadedPath = path;
                return [Buffer.from('%PDF-1.4 test exam paper')];
              },
            }),
          };
        },
      }),
      firestore: () => ({
        collection: (coll: string) => ({
          doc: (id: string) => ({
            get: async () => ({ exists: false, data: () => null }),
            set: async () => {},
          }),
          where: () => ({
            get: async () => ({ docs: [] }),
          }),
          add: async () => {},
        }),
      }),
      messaging: () => ({
        send: async () => {},
      }),
    };

    return {
      mockAdmin,
      getBucketName: () => requestedBucketName,
      getDownloadedPath: () => downloadedPath,
    };
  }

  // --- Test 1: Capability checks ---
  console.log('--- Testing Authorization & Permissions ---');
  {
    const { mockAdmin } = createMockEnv();
    const handlers = createMcqHandlers({ admin: mockAdmin });

    let statusCode = 0;
    let jsonBody: any = null;
    const req = {
      body: { storagePath: 'bank-imports/exam.pdf' },
      staff: { role: 'admin', permissions: { manageMcqSystem: false } },
    };
    const res = {
      status: (code: number) => {
        statusCode = code;
        return { json: (b: any) => { jsonBody = b; } };
      },
      json: (b: any) => { jsonBody = b; },
    };

    await handlers.extract(req, res);
    check('user without manageMcqSystem is denied 403', statusCode === 403);
    check('error is manageMcqSystem is required', jsonBody?.error === 'manageMcqSystem is required');
  }

  // --- Test 2: Input validation ---
  console.log('\n--- Testing Input Validation ---');
  {
    const { mockAdmin } = createMockEnv();
    const handlers = createMcqHandlers({ admin: mockAdmin });

    let statusCode = 0;
    let jsonBody: any = null;
    const res = {
      status: (code: number) => {
        statusCode = code;
        return { json: (b: any) => { jsonBody = b; } };
      },
      json: (b: any) => { jsonBody = b; },
    };

    await handlers.extract({ body: {}, staff: { isMasterAdmin: true } }, res);
    check('missing storagePath returns 400', statusCode === 400);

    await handlers.extract({ body: { storagePath: '../secret/file.pdf' }, staff: { isMasterAdmin: true } }, res);
    check('path traversal returns 400 bad_path', statusCode === 400 && jsonBody?.error === 'bad_path');
  }

  // --- Test 3: Storage Bucket resolution & Download ---
  console.log('\n--- Testing Storage Bucket & Successful Extraction ---');
  {
    const { mockAdmin, getBucketName, getDownloadedPath } = createMockEnv();
    let aiCalled = false;

    const handlers = createMcqHandlers({
      admin: mockAdmin,
      ai: {
        models: {
          generateContent: async () => {
            aiCalled = true;
            return { text: mockExtractionJson };
          },
        },
      },
    });

    let statusCode = 200;
    let jsonBody: any = null;
    const req = {
      body: { storagePath: 'bank-imports/123_exam.pdf' },
      staff: { isMasterAdmin: true },
    };
    const res = {
      status: (code: number) => {
        statusCode = code;
        return { json: (b: any) => { jsonBody = b; } };
      },
      json: (b: any) => { jsonBody = b; },
    };

    await handlers.extract(req, res);
    check('extract succeeds with status 200', statusCode === 200 && jsonBody?.ok === true);
    check('resolves explicit storage bucket', getBucketName() === 'mylectures-app.firebasestorage.app');
    check('downloads correct storagePath', getDownloadedPath() === 'bank-imports/123_exam.pdf');
    check('ai was called', aiCalled);
    check('returned questions count is 2', jsonBody?.questions?.length === 2);
  }

  // --- Test 4: Fallback to Paid AI when primary Free AI is exhausted ---
  console.log('\n--- Testing Fallback to Paid AI on Free Quota Limit ---');
  {
    const { mockAdmin } = createMockEnv();
    let freeAiAttempts = 0;
    let paidAiCalled = false;

    const mockFreeAi = {
      models: {
        generateContent: async () => {
          freeAiAttempts++;
          throw new Error('429 RESOURCE_EXHAUSTED: quota exceeded');
        },
      },
    };

    const mockPaidAi = {
      models: {
        generateContent: async () => {
          paidAiCalled = true;
          return { text: mockExtractionJson };
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
      body: { storagePath: 'bank-imports/456_exam.pdf' },
      staff: { isMasterAdmin: true },
    };
    const res = {
      status: (code: number) => {
        statusCode = code;
        return { json: (b: any) => { jsonBody = b; } };
      },
      json: (b: any) => { jsonBody = b; },
    };

    await handlers.extract(req, res);
    check('extract succeeds via fallback', statusCode === 200 && jsonBody?.ok === true);
    check('freeAi was attempted', freeAiAttempts > 0);
    check('paidAi was invoked as fallback', paidAiCalled);
  }

  // --- Test 5: Client-side question normalization logic ---
  console.log('\n--- Testing Question & Choice Normalization ---');
  {
    const rawParsed = [
      {
        stem: 'Question 1',
        choices: [
          { label: 'A', text: 'First choice' },
          { label: 'B', text: 'Second choice' },
        ],
        correctAnswer: 'B', // label
      },
      {
        stem: 'Question 2',
        choices: [
          { label: 'A', text: 'Alpha' },
          { label: 'B', text: 'Beta' },
        ],
        correctAnswer: 'A. Alpha', // prefixed
      },
    ];

    const normalized = rawParsed.map(q => {
      const choices = q.choices;
      let ans = q.correctAnswer.trim();
      const byLabel = choices.find(c => c.label.toUpperCase() === ans.toUpperCase());
      if (byLabel) {
        ans = byLabel.text;
      } else {
        const byPrefixed = choices.find(c =>
          ans.toUpperCase().startsWith(`${c.label.toUpperCase()}.`)
        );
        if (byPrefixed) ans = byPrefixed.text;
      }
      return { ...q, correctAnswer: ans };
    });

    check('letter label B resolves to Second choice', normalized[0].correctAnswer === 'Second choice');
    check('prefixed label A. Alpha resolves to Alpha', normalized[1].correctAnswer === 'Alpha');
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
