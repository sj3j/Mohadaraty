/**
 * Firestore Rules cannot import the subscription permission matrix. This test
 * keeps its two literal lists exactly aligned with shared/staffCapabilities.ts.
 *
 *   npx tsx scripts/subscriptionPermissionsParity.test.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SUBSCRIPTION_MASTER_CAPABILITIES,
  SUBSCRIPTION_SUPPORT_CAPABILITIES,
} from '../shared/staffCapabilities';

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) console.log(`  ok    ${name}`);
  else {
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`);
    failed++;
  }
};

const root = join(import.meta.dirname, '..');
const rules = readFileSync(join(root, 'firestore.rules'), 'utf8');
const quotedMembers = (functionName: string): string[] => {
  const match = rules.match(new RegExp(
    `function\\s+${functionName}\\(capability\\)\\s*\\{[\\s\\S]*?capability\\s+in\\s+\\[([^\\]]*)\\]`,
  ));
  if (!match) return [];
  return [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1]).sort();
};

const expectedSupport = [...SUBSCRIPTION_SUPPORT_CAPABILITIES].sort();
const expectedMaster = [...SUBSCRIPTION_MASTER_CAPABILITIES].sort();
const rulesSupport = quotedMembers('supportSubscriptionCan');
const rulesMaster = quotedMembers('isMasterSubscriptionCapability');

console.log('\nSubscription permission matrix parity');
check(
  'Rules Support keys match shared/staffCapabilities.ts',
  JSON.stringify(rulesSupport) === JSON.stringify(expectedSupport),
  `rules=${JSON.stringify(rulesSupport)} shared=${JSON.stringify(expectedSupport)}`,
);
check(
  'Rules Master-only keys match shared/staffCapabilities.ts',
  JSON.stringify(rulesMaster) === JSON.stringify(expectedMaster),
  `rules=${JSON.stringify(rulesMaster)} shared=${JSON.stringify(expectedMaster)}`,
);
check(
  'Support and Master-only permission sets do not overlap',
  expectedSupport.every((key) => !expectedMaster.includes(key as never)),
);
check(
  'Rules enforce staffDisabled in the Support predicate',
  /function\s+isSupport\(\)[\s\S]*?get\('staffDisabled',\s*false\)\s*!=\s*true/.test(rules),
);
check(
  'legacy manageSubscriptions is not a subscriptions read authority',
  !/match\s+\/subscriptions\/\{subId\}[\s\S]*?allow\s+read:[^;]*manageSubscriptions/.test(rules),
);
check(
  'representatives are hard-denied every Support subscription capability',
  expectedSupport.every((key) => {
    const block = rules.match(/function\s+representativeCan\(capability\)\s*\{[\s\S]*?capability\s+in\s+\[([^\]]*)\]/)?.[1] || '';
    return block.includes(`'${key}'`);
  }),
);

console.log(failed === 0 ? '\nAll subscription permission parity checks passed.\n' : `\n${failed} check(s) FAILED.\n`);
process.exit(failed === 0 ? 0 : 1);
