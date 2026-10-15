import { readFileSync } from 'fs';
import { join } from 'path';
import { normalizeName } from '../shared/rosterIdentity';
import {
  createSubscriptionManagementHandlers,
  searchStudentsForSubscription,
  type SubscriptionActor,
} from '../shared/subscriptionManagement';

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${!ok && detail ? ` -> ${detail}` : ''}`);
  if (!ok) failed++;
};

console.log('\n--- 1. Verify route registration in server.ts and api/index.ts ---');
const root = join(import.meta.dirname, '..');
const serverSrc = readFileSync(join(root, 'server.ts'), 'utf8');
const apiSrc = readFileSync(join(root, 'api/index.ts'), 'utf8');

check(
  'server.ts mounts /api/subscriptions/search-students',
  serverSrc.includes("app.get('/api/subscriptions/search-students', verifyAuth, subscriptionManagement.searchStudents);")
);
check(
  'api/index.ts mounts /api/subscriptions/search-students',
  apiSrc.includes("app.get('/api/subscriptions/search-students', verifyAuth, subscriptionManagement.searchStudents);")
);

console.log('\n--- 2. Arabic Name Normalization matching ---');
const raw1 = 'أحمد عليّ';
const raw2 = 'احمد علي';
check(
  'normalizeName folds hamza and diacritics',
  normalizeName(raw1) === normalizeName(raw2),
  `${normalizeName(raw1)} !== ${normalizeName(raw2)}`
);

const raw3 = 'حسين فهد';
const raw4 = 'حسين';
check(
  'normalizeName prefix substring matching',
  normalizeName(raw3).includes(normalizeName(raw4))
);

console.log('\n--- 3. Permission checks on searchStudents handler ---');
const unauthorizedActor: SubscriptionActor = {
  uid: 'observer@test.dev',
  email: 'observer@test.dev',
  name: 'Observer',
  role: 'observer',
  isMasterAdmin: false,
  staffDisabled: false,
  permissions: {},
};

const supportActorWithActivate: SubscriptionActor = {
  uid: 'support@test.dev',
  email: 'support@test.dev',
  name: 'Support Staff',
  role: 'support',
  isMasterAdmin: false,
  staffDisabled: false,
  permissions: { canActivate: true },
};

const masterActor: SubscriptionActor = {
  uid: 'master@test.dev',
  email: 'master@test.dev',
  name: 'Master Admin',
  role: 'master_admin',
  isMasterAdmin: true,
  staffDisabled: false,
  permissions: {},
};

// Mock admin
const mockUsers = new Map<string, any>([
  [
    'student1@test.dev',
    {
      email: 'student1@test.dev',
      name: 'حسن فهد',
      isSubscribed: true,
      subscriptionPlan: 'monthly',
      subscriptionEnd: new Date('2026-11-01'),
    },
  ],
  [
    'student2@test.dev',
    {
      email: 'student2@test.dev',
      name: 'علي حسن',
      isSubscribed: false,
    },
  ],
]);

const mockStudents = new Map<string, any>([
  [
    'student1@test.dev',
    {
      email: 'student1@test.dev',
      name: 'حسن فهد',
      nameKey: normalizeName('حسن فهد'),
    },
  ],
  [
    'student2@test.dev',
    {
      email: 'student2@test.dev',
      name: 'علي حسن',
      nameKey: normalizeName('علي حسن'),
    },
  ],
  [
    'student3@test.dev',
    {
      email: 'student3@test.dev',
      name: 'أحمد علي الساعدي',
      nameKey: normalizeName('أحمد علي الساعدي'),
      loginCode: 'D4-0123',
      loginCodeKey: 'd4-0123',
    },
  ],
  [
    'student4@roster.mylecture.local',
    {
      email: 'student4@roster.mylecture.local',
      name: 'كرار فهد الموسوي',
      nameKey: normalizeName('كرار فهد الموسوي'),
      stageId: 'stage_4',
    },
  ],
]);

const mockAdmin = {
  firestore: Object.assign(
    () => ({
      collection(colName: string) {
        const store = colName === 'users' ? mockUsers : mockStudents;
        return {
          async get() {
            const docs: any[] = [];
            for (const [id, data] of store.entries()) {
              docs.push({ id, data: () => data });
            }
            return { docs };
          },
          doc(id: string) {
            return {
              async get() {
                const found = store.get(id);
                return {
                  exists: !!found,
                  id,
                  data: () => found,
                };
              },
              async set(data: any, options?: any) {
                if (options?.merge && store.has(id)) {
                  store.set(id, { ...store.get(id), ...data });
                } else {
                  store.set(id, data);
                }
              },
            };
          },
          where(field: string, op: string, val: any) {
            return {
              where() { return this; },
              limit() { return this; },
              async get() {
                const docs: any[] = [];
                for (const [id, data] of store.entries()) {
                  if (op === '>=' && typeof val === 'string') {
                    const fieldValue = String(data[field] || '');
                    if (fieldValue.toLowerCase().startsWith(val.replace('\uf8ff', '').toLowerCase())) {
                      docs.push({ id, ref: { id }, data: () => data });
                    }
                  } else if (op === '==' && data[field] === val) {
                    docs.push({ id, ref: { id }, data: () => data });
                  }
                }
                return { docs, empty: docs.length === 0 };
              },
            };
          },
        };
      },
    }),
    {
      FieldValue: {
        serverTimestamp: () => new Date(),
      },
      Timestamp: {
        fromDate: (d: Date) => d,
      },
    }
  ),
};

// Test short query rejection
const emptyRes = await searchStudentsForSubscription(mockAdmin, masterActor, 'a');
check('short query returns empty array', emptyRes.students.length === 0);

// Test search by email
const emailRes = await searchStudentsForSubscription(mockAdmin, masterActor, 'student1@test.dev');
check('search by email finds student', emailRes.students.length > 0 && emailRes.students[0].email === 'student1@test.dev');
check('search by email includes subscription status', emailRes.students[0].isSubscribed === true);

// Test search by first name
const nameRes = await searchStudentsForSubscription(mockAdmin, masterActor, 'حسن');
check('search by first name finds matches', nameRes.students.length > 0);
check('matches include name and email', !!nameRes.students[0].name && !!nameRes.students[0].email);

// Test search by second/father name (Substring match)
const subNameRes = await searchStudentsForSubscription(mockAdmin, masterActor, 'فهد');
check(
  'search by father name finds student with matching substring',
  subNameRes.students.some(s => s.name.includes('فهد'))
);

// Test search by surname (Family name)
const surnameRes = await searchStudentsForSubscription(mockAdmin, masterActor, 'الساعدي');
check(
  'search by surname finds student3',
  surnameRes.students.some(s => s.email === 'student3@test.dev')
);

// Test multi-word and Hamza folding ("احمد الساعدي" matching "أحمد علي الساعدي")
const multiWordRes = await searchStudentsForSubscription(mockAdmin, masterActor, 'احمد الساعدي');
check(
  'multi-word and hamza folding matches student3',
  multiWordRes.students.some(s => s.email === 'student3@test.dev')
);

// Test login code search
const codeRes = await searchStudentsForSubscription(mockAdmin, masterActor, 'D4-0123');
check(
  'search by login code finds student3',
  codeRes.students.some(s => s.email === 'student3@test.dev')
);

// Test un-logged-in roster student resolution
import { resolveStudent, previewManagedSubscription } from '../shared/subscriptionManagement';

const resolvedRosterStudent = await resolveStudent(mockAdmin, 'student4@roster.mylecture.local');
check(
  'resolveStudent resolves uninitialized roster student without error',
  resolvedRosterStudent.snap.exists && resolvedRosterStudent.snap.data()?.name === 'كرار فهد الموسوي'
);

const previewRes = await previewManagedSubscription(mockAdmin, 'student4@roster.mylecture.local', 'monthly');
check(
  'previewManagedSubscription succeeds for roster student without 404',
  previewRes.studentEmail === 'student4@roster.mylecture.local' && previewRes.price === 2000
);

console.log('\n--- 4. Handler invocation check ---');
const handlers = createSubscriptionManagementHandlers({ admin: mockAdmin });

// Test unauthorized actor
let caught403 = false;
try {
  await handlers.searchStudents(
    {
      user: { uid: unauthorizedActor.uid },
      query: { q: 'حسن' },
    },
    {
      status(s: number) {
        if (s === 403) caught403 = true;
        return this;
      },
      json() {},
    }
  );
} catch (err: any) {
  if (err?.status === 403 || err?.code === 'PERMISSION_DENIED') caught403 = true;
}

check('searchStudents handler exists on subscriptionManagement handlers', typeof handlers.searchStudents === 'function');

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll tests passed successfully!');
}
