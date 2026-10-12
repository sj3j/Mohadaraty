/**
 * Audits the allowed_admins appointment registry against live users runtime
 * projections. Dry-run by default; pass --commit to synchronize mismatches and
 * demote non-master staff users that no longer have an appointment.
 */
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { pathToFileURL } from 'node:url';
import 'dotenv/config';
import { isMasterAdminEmail } from '../shared/masterAdmins';

type Db = FirebaseFirestore.Firestore;
const STAFF_ROLES = new Set(['admin', 'moderator', 'support']);

export interface StaffConsistencyResult {
  appointments: number;
  projectedUsers: number;
  mismatchedUsers: number;
  repairedUsers: number;
  orphanStaff: number;
  demotedUsers: number;
  exemptMasters: number;
}

const stablePermissions = (value: any) => JSON.stringify(
  Object.fromEntries(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b))),
);

export async function repairStaffConsistency(
  db: Db,
  opts: { commit: boolean },
): Promise<StaffConsistencyResult> {
  const [appointmentsSnap, usersSnap] = await Promise.all([
    db.collection('allowed_admins').get(),
    db.collection('users').get(),
  ]);
  const usersByEmail = new Map<string, FirebaseFirestore.QueryDocumentSnapshot[]>();
  for (const user of usersSnap.docs) {
    const email = String(user.data().email || '').toLowerCase();
    if (!email) continue;
    const list = usersByEmail.get(email) || [];
    list.push(user);
    usersByEmail.set(email, list);
  }

  const result: StaffConsistencyResult = {
    appointments: appointmentsSnap.size,
    projectedUsers: 0,
    mismatchedUsers: 0,
    repairedUsers: 0,
    orphanStaff: 0,
    demotedUsers: 0,
    exemptMasters: 0,
  };
  const appointedEmails = new Set<string>();

  for (const appointment of appointmentsSnap.docs) {
    const email = String(appointment.data().email || appointment.id).toLowerCase();
    appointedEmails.add(email);
    const registry = appointment.data() || {};
    const matching = usersByEmail.get(email) || [];
    const mismatches = matching.filter(user => {
      const live = user.data() || {};
      return live.role !== (registry.role || 'admin')
        || String(live.managedStageId || '') !== String(registry.managedStageId || '')
        || stablePermissions(live.permissions) !== stablePermissions(registry.permissions);
    });
    result.projectedUsers += matching.length;
    result.mismatchedUsers += mismatches.length;
    if (opts.commit && mismatches.length) {
      const batch = db.batch();
      for (const user of mismatches) {
        batch.set(user.ref, {
          role: registry.role || 'admin',
          managedStageId: registry.managedStageId || FieldValue.delete(),
          permissions: registry.permissions || {},
          staffProjectionRepairedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      await batch.commit();
      result.repairedUsers += mismatches.length;
    }
  }

  for (const user of usersSnap.docs) {
    const data = user.data() || {};
    if (!STAFF_ROLES.has(data.role)) continue;
    const email = String(data.email || '').toLowerCase();
    if (isMasterAdminEmail(email) || data.isMasterAdmin === true) {
      result.exemptMasters++;
      continue;
    }
    if (appointedEmails.has(email)) continue;
    result.orphanStaff++;
    if (opts.commit) {
      await user.ref.set({
        role: 'student',
        managedStageId: FieldValue.delete(),
        permissions: FieldValue.delete(),
        staffProjectionRepairedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      result.demotedUsers++;
    }
  }

  return result;
}

async function main() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!projectId || !clientEmail || !privateKey) throw new Error('Firebase Admin credentials are missing');
  if (!getApps().length) initializeApp({ credential: cert({ projectId, clientEmail, privateKey }), projectId });
  const commit = process.argv.includes('--commit');
  const result = await repairStaffConsistency(getFirestore(), { commit });
  console.log(JSON.stringify({ mode: commit ? 'COMMIT' : 'DRY_RUN', ...result }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
