import assert from 'node:assert';
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
  console.log('\n🧪 Starting Timetable Quota Fallback Tests...\n');

  // Sample timetable JSON returned by model
  const mockModelJson = JSON.stringify({
    weekLabel: 'Week 1',
    sessions: [
      {
        day: 'sunday',
        start: '08:30',
        end: '10:30',
        kind: 'theory',
        groups: [],
        title: 'Physiology I',
      },
    ],
  });

  // Mock photo fetch
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: any) => {
    if (url === 'https://example.com/timetable.jpg') {
      return {
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name.toLowerCase() === 'content-type' ? 'image/jpeg' : null),
        },
        arrayBuffer: async () => Buffer.from('mock-jpeg-bytes'),
      } as any;
    }
    return { ok: false, status: 404 } as any;
  };

  function createMockEnv(initialDraftData: any = null) {
    let draftData = initialDraftData ? { ...initialDraftData } : null;
    const adminAlerts: any[] = [];
    const systemNotifications: any[] = [];

    const mockDb = {
      collection: (collName: string) => {
        if (collName === 'settings') {
          return {
            doc: (docId: string) => ({
              get: async () => ({
                exists: true,
                data: () => ({ photoUrl: 'https://example.com/timetable.jpg' }),
              }),
            }),
          };
        }
        if (collName === 'stages') {
          return {
            doc: (docId: string) => ({
              get: async () => ({
                exists: true,
                data: () => ({
                  groupConfig: {
                    groups: [{ id: 'A', subgroupCount: 2 }, { id: 'B', subgroupCount: 2 }],
                  },
                }),
              }),
            }),
          };
        }
        if (collName === 'timetableDrafts') {
          return {
            doc: (docId: string) => ({
              get: async () => ({
                exists: !!draftData,
                data: () => draftData,
              }),
              set: async (data: any, options: any) => {
                if (options?.merge && draftData) {
                  draftData = { ...draftData, ...data };
                } else {
                  draftData = { ...data };
                }
              },
            }),
          };
        }
        if (collName === 'adminAlerts') {
          return {
            add: async (alert: any) => {
              adminAlerts.push(alert);
              return { id: `alert-${adminAlerts.length}` };
            },
          };
        }
        if (collName === 'users') {
          return {
            where: () => ({
              limit: () => ({
                get: async () => ({ docs: [] }),
              }),
            }),
          };
        }
        if (collName === 'systemNotifications') {
          return {
            doc: () => ({
              set: async (notification: any) => {
                systemNotifications.push(notification);
              },
            }),
          };
        }
        throw new Error(`Unexpected collection: ${collName}`);
      },
      runTransaction: async (updateFn: any) => {
        const tx = {
          get: async () => ({
            exists: !!draftData,
            data: () => draftData,
          }),
          set: (docRef: any, data: any, options: any) => {
            if (options?.merge && draftData) {
              draftData = { ...draftData, ...data };
            } else {
              draftData = { ...data };
            }
          },
        };
        return await updateFn(tx);
      },
      batch: () => ({
        set: (docRef: any, data: any) => {},
        commit: async () => {},
      }),
    };

    const mockAdmin = {
      firestore: Object.assign(() => mockDb, {
        FieldValue: {
          serverTimestamp: () => 'MOCK_TIMESTAMP',
          increment: (n: number) => n,
          delete: () => undefined,
        },
      }),
      messaging: () => ({
        send: async () => {},
      }),
    };

    return {
      admin: mockAdmin,
      getDraft: () => draftData,
      getAlerts: () => adminAlerts,
    };
  }

  function createMockReqRes(stageId = 'stage-1') {
    const req = {
      body: { stageId },
      staff: {
        isMasterAdmin: true,
        isSupport: false,
        role: 'master_admin',
        managedStageId: null,
        permissions: {},
      },
      user: { uid: 'user-admin-1' },
    } as any;

    const resState: { statusCode: number; payload: any } = {
      statusCode: 200,
      payload: null,
    };

    const res = {
      status: (code: number) => {
        resState.statusCode = code;
        return res;
      },
      json: (payload: any) => {
        resState.payload = payload;
        return res;
      },
    } as any;

    return { req, res, resState };
  }

  try {
    // 1. Missing free tier key returns not_configured
    {
      const env = createMockEnv();
      const handlers = createTimetableHandlers({
        admin: env.admin,
        ai: null,
        paidAi: { models: { generateContent: async () => ({}) } },
      });
      const { req, res, resState } = createMockReqRes();
      await handlers.parse(req, res);

      check('missing free key returns 503', resState.statusCode === 503);
      check('error is not_configured', resState.payload?.error === 'not_configured');
      check('raises not_configured alert', env.getAlerts().some(a => a.reason === 'not_configured'));
    }

    // 2. Free tier quota exceeded without paid key returns free_tier_limit
    {
      const env = createMockEnv();
      const mockFreeAi = {
        models: {
          generateContent: async () => {
            throw new Error('429 RESOURCE_EXHAUSTED: Quota exceeded for quota metric');
          },
        },
      };

      const handlers = createTimetableHandlers({
        admin: env.admin,
        ai: mockFreeAi,
        paidAi: null,
      });
      const { req, res, resState } = createMockReqRes();
      await handlers.parse(req, res);

      check('quota exceeded without paid key returns 502', resState.statusCode === 502);
      check('error is free_tier_limit', resState.payload?.error === 'free_tier_limit');
      check('draft status set to failed', env.getDraft()?.status === 'failed');
      check('critical alert raised for quota', env.getAlerts().some(a => a.reason === 'free_tier_limit' && a.resolved === false));
    }

    // 3. Free tier quota exceeded WITH paid key succeeds via fallback trial
    {
      const env = createMockEnv();
      let freeKeyAttempts = 0;
      let paidKeyAttempts = 0;

      const mockFreeAi = {
        models: {
          generateContent: async () => {
            freeKeyAttempts++;
            throw new Error('429 RESOURCE_EXHAUSTED: Quota exceeded');
          },
        },
      };

      const mockPaidAi = {
        models: {
          generateContent: async () => {
            paidKeyAttempts++;
            return { text: mockModelJson };
          },
        },
      };

      const handlers = createTimetableHandlers({
        admin: env.admin,
        ai: mockFreeAi,
        paidAi: mockPaidAi,
      });
      const { req, res, resState } = createMockReqRes();
      await handlers.parse(req, res);

      check('fallback parse returns 200', resState.statusCode === 200);
      check('response indicates success', resState.payload?.ok === true);
      check('response indicates fallbackUsed: true', resState.payload?.fallbackUsed === true);
      check('free key was attempted', freeKeyAttempts === 1);
      check('paid key was called exactly once', paidKeyAttempts === 1);
      check('draft status is draft', env.getDraft()?.status === 'draft');
      check('draft stamps fallbackUsed: true', env.getDraft()?.fallbackUsed === true);
      const informationalAlert = env.getAlerts().find(a => a.resolved === true);
      check('informational admin alert created with resolved: true', !!informationalAlert);
      check('informational note mentions GEMINI_API_KEY fallback', informationalAlert?.note?.includes('GEMINI_API_KEY fallback trial'));
    }

    // 4. Free tier quota exceeded, paid key also fails -> records failure and raises critical alert
    {
      const env = createMockEnv();
      let paidKeyAttempts = 0;

      const mockFreeAi = {
        models: {
          generateContent: async () => {
            throw new Error('429 RESOURCE_EXHAUSTED: Free tier quota reached');
          },
        },
      };

      const mockPaidAi = {
        models: {
          generateContent: async () => {
            paidKeyAttempts++;
            throw new Error('API key not valid. Please pass a valid API key.');
          },
        },
      };

      const handlers = createTimetableHandlers({
        admin: env.admin,
        ai: mockFreeAi,
        paidAi: mockPaidAi,
      });
      const { req, res, resState } = createMockReqRes();
      await handlers.parse(req, res);

      check('paid failure returns 502', resState.statusCode === 502);
      check('paid key was called once before failing', paidKeyAttempts === 1);
      check('error is not_configured (from paid key failure)', resState.payload?.error === 'not_configured');
      check('draft status set to failed', env.getDraft()?.status === 'failed');
      check('critical alert raised for paid failure', env.getAlerts().some(a => a.reason === 'not_configured' && a.resolved === false));
    }

    // 5. Normal parse without quota error does NOT use paid key
    {
      const env = createMockEnv();
      let paidKeyAttempts = 0;

      const mockFreeAi = {
        models: {
          generateContent: async () => ({ text: mockModelJson }),
        },
      };

      const mockPaidAi = {
        models: {
          generateContent: async () => {
            paidKeyAttempts++;
            return { text: mockModelJson };
          },
        },
      };

      const handlers = createTimetableHandlers({
        admin: env.admin,
        ai: mockFreeAi,
        paidAi: mockPaidAi,
      });
      const { req, res, resState } = createMockReqRes();
      await handlers.parse(req, res);

      check('normal parse returns 200', resState.statusCode === 200);
      check('response indicates fallbackUsed: false', resState.payload?.fallbackUsed === false);
      check('paid key was never called', paidKeyAttempts === 0);
      check('draft stamps fallbackUsed: false', env.getDraft()?.fallbackUsed === false);
      check('no fallback admin alert created', !env.getAlerts().some(a => a.resolved === true));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
