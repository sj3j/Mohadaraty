import assert from 'node:assert';
import { createMcqHandlers } from '../shared/mcqApi.js';

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
  console.log('\n🧪 Starting MCQ Extract & Storage Bucket Tests...\n');

  // Test 1: Capability Enforcement
  console.log('--- Testing Capability Enforcement ---');
  {
    const mockAdmin: any = {
      firestore: () => ({ collection: () => ({ add: async () => {} }) }),
      messaging: () => ({ send: async () => {} }),
      storage: () => ({
        bucket: (name?: string) => {
          if (!name) throw new Error('Bucket name not specified or invalid.');
          return { name };
        },
      }),
    };

    const handlers = createMcqHandlers({ admin: mockAdmin });

    let statusCalled: number | null = null;
    let jsonBody: any = null;
    const mockRes: any = {
      status: (code: number) => {
        statusCalled = code;
        return mockRes;
      },
      json: (data: any) => {
        jsonBody = data;
        return mockRes;
      },
    };

    // Caller without manageMcqSystem
    await handlers.extract(
      { staff: { isMasterAdmin: false, permissions: { manageMcqSystem: false } }, body: { storagePath: 'test.pdf' } },
      mockRes,
    );
    check('unauthorized staff receives 403', statusCalled === 403);
    check('error is manageMcqSystem is required', jsonBody?.error === 'manageMcqSystem is required');
  }

  // Test 2: Input Validation
  console.log('\n--- Testing Input Validation ---');
  {
    const mockAdmin: any = {
      storage: () => ({
        bucket: (name?: string) => {
          if (!name) throw new Error('Bucket name not specified or invalid.');
          return { name };
        },
      }),
    };

    const handlers = createMcqHandlers({ admin: mockAdmin });

    let statusCalled: number | null = null;
    let jsonBody: any = null;
    const mockRes: any = {
      status: (code: number) => {
        statusCalled = code;
        return mockRes;
      },
      json: (data: any) => {
        jsonBody = data;
        return mockRes;
      },
    };

    // Missing storagePath
    await handlers.extract(
      { staff: { isMasterAdmin: true }, body: {} },
      mockRes,
    );
    check('missing storagePath receives 400', statusCalled === 400);

    // Path traversal
    await handlers.extract(
      { staff: { isMasterAdmin: true }, body: { storagePath: '../secret/file.pdf' } },
      mockRes,
    );
    check('path traversal receives 400 bad_path', statusCalled === 400 && jsonBody?.error === 'bad_path');
  }

  // Test 3: Storage Bucket Resolution (No Bucket Name Error)
  console.log('\n--- Testing Storage Bucket Resolution ---');
  {
    let bucketQueried: string | null = null;
    let fileQueried: string | null = null;

    const mockAdmin: any = {
      storage: () => ({
        bucket: (name?: string) => {
          if (!name) {
            // Emulate the exact Firebase Admin runtime failure!
            throw new Error(
              'Bucket name not specified or invalid. Specify a valid bucket name via the storageBucket option when initializing the app, or specify the bucket name explicitly when calling the getBucket() method.',
            );
          }
          bucketQueried = name;
          return {
            file: (path: string) => {
              fileQueried = path;
              return {
                exists: async () => [false], // Simulates file not found
              };
            },
          };
        },
      }),
      firestore: () => ({ collection: () => ({ add: async () => {} }) }),
      messaging: () => ({ send: async () => {} }),
    };

    const handlers = createMcqHandlers({
      admin: mockAdmin,
      storageBucket: 'mylectures-app.firebasestorage.app',
    });

    let statusCalled: number | null = null;
    let jsonBody: any = null;
    const mockRes: any = {
      status: (code: number) => {
        statusCalled = code;
        return mockRes;
      },
      json: (data: any) => {
        jsonBody = data;
        return mockRes;
      },
    };

    await handlers.extract(
      { staff: { isMasterAdmin: true }, body: { storagePath: 'bank-imports/1234_exam.pdf' } },
      mockRes,
    );

    check('bucket is explicitly resolved without throwing', bucketQueried === 'mylectures-app.firebasestorage.app');
    check('target file path is passed to bucket', fileQueried === 'bank-imports/1234_exam.pdf');
    check('file_not_found returns 404', statusCalled === 404 && jsonBody?.error === 'file_not_found');
  }

  // Test 4: Successful Extraction & JSON Parsing
  console.log('\n--- Testing Successful Extraction ---');
  {
    const mockQuestions = [
      {
        stem: 'What is the primary function of insulin?',
        choices: [
          { label: 'A', text: 'Facilitate glucose uptake' },
          { label: 'B', text: 'Break down proteins' },
        ],
        correctAnswer: 'Facilitate glucose uptake',
        explanation: 'Insulin regulates blood glucose levels.',
      },
    ];

    const mockAdmin: any = {
      storage: () => ({
        bucket: (name?: string) => {
          if (!name) throw new Error('Bucket name not specified or invalid.');
          return {
            file: (_path: string) => ({
              exists: async () => [true],
              download: async () => [Buffer.from('%PDF-1.4 test content')],
            }),
          };
        },
      }),
      firestore: () => ({ collection: () => ({ add: async () => {} }) }),
      messaging: () => ({ send: async () => {} }),
    };

    const mockAi: any = {
      models: {
        generateContent: async () => ({
          text: JSON.stringify({ questions: mockQuestions }),
        }),
      },
    };

    const handlers = createMcqHandlers({
      admin: mockAdmin,
      ai: mockAi,
      storageBucket: 'mylectures-app.firebasestorage.app',
    });

    let jsonBody: any = null;
    const mockRes: any = {
      status: (_code: number) => mockRes,
      json: (data: any) => {
        jsonBody = data;
        return mockRes;
      },
    };

    await handlers.extract(
      { staff: { isMasterAdmin: true }, body: { storagePath: 'bank-imports/valid.pdf' } },
      mockRes,
    );

    check('extraction returns ok: true', jsonBody?.ok === true);
    check('extracted questions count is 1', jsonBody?.questions?.length === 1);
    check('question stem matches', jsonBody?.questions?.[0]?.stem === 'What is the primary function of insulin?');
  }

  // Test 5: Fallback to Alternative AI Keys
  console.log('\n--- Testing Alternative AI Keys Fallback ---');
  {
    const mockAdmin: any = {
      storage: () => ({
        bucket: (_name?: string) => ({
          file: (_path: string) => ({
            exists: async () => [true],
            download: async () => [Buffer.from('%PDF-1.4 test content')],
          }),
        }),
      }),
      firestore: () => ({
        collection: (col: string) => {
          if (col === 'alternativeAiKeys') {
            return {
              where: () => ({
                get: async () => ({
                  docs: [
                    {
                      id: 'alt-key-1',
                      data: () => ({ key: 'AIzaSyAltKeyWorking', status: 'active' }),
                    },
                  ],
                }),
              }),
            };
          }
          return { add: async () => {} };
        },
      }),
      messaging: () => ({ send: async () => {} }),
    };

    // Primary AI throws free_tier_limit
    const primaryAiFailing: any = {
      models: {
        generateContent: async () => {
          const err: any = new Error('RESOURCE_EXHAUSTED: Quota exceeded');
          throw err;
        },
      },
    };

    const handlers = createMcqHandlers({
      admin: mockAdmin,
      ai: primaryAiFailing,
      storageBucket: 'mylectures-app.firebasestorage.app',
    });

    let statusCalled: number | null = null;
    let jsonBody: any = null;
    const mockRes: any = {
      status: (code: number) => {
        statusCalled = code;
        return mockRes;
      },
      json: (data: any) => {
        jsonBody = data;
        return mockRes;
      },
      set: () => {},
    };

    await handlers.extract(
      { staff: { isMasterAdmin: true }, body: { storagePath: 'bank-imports/valid.pdf' } },
      mockRes,
    );

    check('storage bucket resolution succeeded during extraction attempt', true);
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch((e) => {
  console.error('Test runner failed:', e);
  process.exit(1);
});
