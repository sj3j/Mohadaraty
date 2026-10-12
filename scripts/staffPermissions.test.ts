import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { hasStaffCapability, hasStageCapability } from '../shared/staffCapabilities';
import { repairStaffConsistency } from './repairStaffConsistency';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('FIRESTORE_EMULATOR_HOST is required');
initializeApp({ projectId: 'mylectures-rules-test' });
const db = getFirestore();
let failed = 0;
const check = (name: string, ok: boolean) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
};

const representative = { role: 'admin', managedStageId: 'stage_3', permissions: {} };
const disabledRepresentative = { role: 'admin', managedStageId: 'stage_3', permissions: { manageLectures: false } };
const helper = { role: 'moderator', managedStageId: 'stage_3', permissions: { manageLectures: true } };
const support = { role: 'support', permissions: { manageLectures: true, manageAntiCheat: false } };
const observer = { role: 'observer', permissions: { manageLectures: true } };
check('master has every capability across stages', hasStageCapability({ role: 'admin', isMasterAdmin: true }, 'manageCalendar', 'stage_5'));
check('representative gets own-stage content by default', hasStageCapability(representative, 'manageLectures', 'stage_3'));
check('representative explicit disable is honored', !hasStageCapability(disabledRepresentative, 'manageLectures', 'stage_3'));
check('representative is denied cross-stage', !hasStageCapability(representative, 'manageLectures', 'stage_4'));
check('representative is denied system capability', !hasStaffCapability(representative, 'manageMcqSystem'));
check('helper gets only explicit own-stage content', hasStageCapability(helper, 'manageLectures', 'stage_3'));
check('helper is denied unstated content', !hasStaffCapability(helper, 'manageRecords'));
check('helper is denied roster and system capabilities', !hasStaffCapability(helper, 'manageStudents') && !hasStaffCapability(helper, 'manageAntiCheat'));
check('support explicit grant reaches every stage', hasStageCapability(support, 'manageLectures', 'stage_5'));
check('support unstated/false capability is denied', !hasStaffCapability(support, 'manageAntiCheat'));
check('observer has no mutation capability', !hasStaffCapability(observer, 'manageLectures'));

await db.doc('allowed_admins/rep@example.com').set({
  email: 'rep@example.com', role: 'admin', managedStageId: 'stage_3', permissions: { manageLectures: false },
});
await db.doc('users/rep_uid').set({
  email: 'rep@example.com', role: 'moderator', managedStageId: 'stage_4', permissions: { manageLectures: true },
});
await db.doc('users/orphan_uid').set({
  email: 'orphan@example.com', role: 'support', permissions: { manageLectures: true },
});
await db.doc('users/master_uid').set({
  email: 'jempe.kn@gmail.com', role: 'admin', isMasterAdmin: true,
});
const dry = await repairStaffConsistency(db, { commit: false });
check('staff audit finds mismatch and non-master orphan', dry.mismatchedUsers === 1 && dry.orphanStaff === 1 && dry.exemptMasters === 1);
const committed = await repairStaffConsistency(db, { commit: true });
check('staff repair synchronizes and demotes atomically per appointment', committed.repairedUsers === 1 && committed.demotedUsers === 1);
const projected = (await db.doc('users/rep_uid').get()).data() || {};
const orphan = (await db.doc('users/orphan_uid').get()).data() || {};
check('live projection matches appointment', projected.role === 'admin' && projected.managedStageId === 'stage_3' && projected.permissions?.manageLectures === false);
check('orphan is demoted and master remains exempt', orphan.role === 'student' && (await db.doc('users/master_uid').get()).data()?.role === 'admin');
const again = await repairStaffConsistency(db, { commit: true });
check('staff repair rerun is idempotent', again.mismatchedUsers === 0 && again.orphanStaff === 0);

console.log(`\n${failed ? 'FAILED' : 'OK'} (${failed} failures)`);
process.exit(failed ? 1 : 0);
