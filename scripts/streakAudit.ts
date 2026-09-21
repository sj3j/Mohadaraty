/**
 * Audits and repairs the streak system's stored history.
 *
 *   npx tsx scripts/streakAudit.ts                                    # report only
 *   npx tsx scripts/streakAudit.ts --only preseason                    # the day-1 bug
 *   npx tsx scripts/streakAudit.ts --commit                           # apply repairs
 *   npx tsx scripts/streakAudit.ts --archive semester_123 --commit
 *   npx tsx scripts/streakAudit.ts --backfill-stage stage_3 --commit
 *
 * DRY RUN IS THE DEFAULT. Nothing is written without --commit.
 *
 * Four independent passes, each reported separately so a partial run is legible:
 *
 *   1. archive-stage   semesterArchives rows written before stage scoping carry no
 *                      stageId. LeaderboardTab then had to guess, and guessed from
 *                      the VIEWER's current stage, which collapses a finished board
 *                      to whoever happens to share it. Requires --backfill-stage:
 *                      the stage is not derivable after the fact and is not guessed.
 *
 *   2. cards           users/{uid}/streakHistory/{seasonId} vs the archive's own
 *                      topStudents row. seasonReset writes both from one in-memory
 *                      object in a single pass, so they cannot legitimately differ;
 *                      a divergence means the card was overwritten afterwards.
 *                      Only the top 50 per stage are in the archive - see below.
 *
 *   3. pending         pending_streak_resets docs recorded before the last archive,
 *                      plus their users.hasPendingStreakReset flags. The docs carry
 *                      an expiresAt that nothing reads and the season reset used not
 *                      to clear them, so they accumulated indefinitely.
 *
 *   4. best            users.bestStreakAllTime backfilled from the highest value the
 *                      account can prove: its live counters and every archived card.
 *                      Without this the new all-time field starts at 0 for everyone.
 *
 *   5. preseason       accounts whose lastActiveDate predates the RUNNING term, which
 *                      the year's opening day silently incremented instead of starting
 *                      fresh: every preseason day is paused, so activeDaysBetween reads
 *                      a gap of one from any of them, and closableTerm can never close
 *                      a first term so startNewSeason never zeroed them. Needs no
 *                      archive, so it runs before the archive is resolved.
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { hasBridgedSeasonOpen, hasPreTermStreakState, openSeason } from '../shared/seasonReset.js';
import { getEffectiveDateString } from '../shared/streakApi.js';
import { loadCalendar } from '../shared/seasonRollover.js';
import { baghdadToday, resolvePhase, seasonOpeningDay } from '../shared/academicCalendar.js';
import 'dotenv/config';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name: string, fallback = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name: string) => argv.includes(`--${name}`);

const commit = has('commit');
const archiveIdFlag = flag('archive');
const backfillStage = flag('backfill-stage');
const only = flag('only'); // archive-stage | cards | pending | best | preseason

const runs = (pass: string) => !only || only === pass;

// ---------------------------------------------------------------------------
const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
  console.error('.env is missing FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY.');
  process.exit(1);
}
initializeApp({
  credential: cert({
    projectId: FIREBASE_PROJECT_ID,
    clientEmail: FIREBASE_CLIENT_EMAIL,
    privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
  projectId: FIREBASE_PROJECT_ID,
});
const db = getFirestore();

console.log(`\nTarget: project ${FIREBASE_PROJECT_ID}${process.env.FIRESTORE_EMULATOR_HOST ? ' (EMULATOR)' : ' (LIVE)'}`);
console.log(commit ? 'Mode  : COMMIT - changes will be written\n' : 'Mode  : DRY RUN - nothing will be written\n');

/** Commits an array of writes in chunks, respecting the 500-op batch limit. */
async function writeAll(label: string, ops: ((b: FirebaseFirestore.WriteBatch) => void)[]) {
  if (!commit || ops.length === 0) return;
  for (let i = 0; i < ops.length; i += 400) {
    const batch = db.batch();
    ops.slice(i, i + 400).forEach(op => op(batch));
    await batch.commit();
  }
  console.log(`  -> committed ${ops.length} write(s) for ${label}`);
}

async function main() {
  // -------------------------------------------------------------------------
  // PASS 5 - streak state left over from before the running term opened
  //
  // First, and outside the archive requirement below: the case this exists for
  // is a calendar's FIRST term, where there is no closed season and so no
  // archive to audit against.
  // -------------------------------------------------------------------------
  if (runs('preseason')) {
    console.log('== 5. pre-term streak state ==');

    const calendar = await loadCalendar(db);
    const today = baghdadToday(calendar.timezone);
    const phase = resolvePhase(calendar, today);

    if (!phase.term || phase.isPaused) {
      console.log(`  ${today} is ${phase.phase}${phase.isPaused ? ' (paused)' : ''} - no running term to measure against.`);
      console.log('');
    } else {
      const termStart = phase.term.startDate;
      const yearOpens = seasonOpeningDay(calendar);
      // The bridged sweep is armed only while opening the YEAR's first term.
      // On term 2's opening day a streak above 1 is legitimate.
      const sweepBridged = !!yearOpens && yearOpens === termStart;

      const usersSnap = await db.collection('users').get();
      const affected = usersSnap.docs.filter(d => hasPreTermStreakState(d.data(), termStart));
      const bridged = sweepBridged
        ? usersSnap.docs.filter(d => hasBridgedSeasonOpen(d.data(), yearOpens as string))
        : [];

      const listRows = (docs: FirebaseFirestore.QueryDocumentSnapshot[]) => {
        for (const d of docs.slice(0, 50)) {
          const u = d.data() as any;
          console.log(
            `    ${d.id}` +
            `  streak=${u.streakCount || 0}` +
            `  longest=${u.longestStreak || 0}` +
            `  best=${u.bestStreakAllTime || 0}` +
            `  lastActive=${u.lastActiveDate ?? 'null'}` +
            `  ${u.name || ''}`,
          );
        }
        if (docs.length > 50) console.log(`    ... and ${docs.length - 50} more`);
      };

      console.log(`  term ${phase.term.id} opened ${termStart}; ${usersSnap.size} account(s) scanned`);

      if (affected.length === 0) {
        console.log('  no account carries streak state from before the term opened.');
      } else {
        console.log(`  ${affected.length} account(s) carry pre-term state:\n`);
        listRows(affected);
      }

      // The accounts the staleness test above cannot see: the bridge overwrote
      // their lastActiveDate with the opening day itself, which reads as "this
      // season" and skips them. They are clamped to 1, not zeroed - zeroing a
      // row that already holds today's streak_history marker strands it at 0
      // until tomorrow.
      if (!sweepBridged) {
        if (yearOpens) {
          console.log(`  (bridged sweep off - ${termStart} is not the year's opening day ${yearOpens})`);
        }
      } else if (bridged.length === 0) {
        console.log(`  no account was bridged into the opening day ${yearOpens}.`);
      } else {
        console.log(`\n  ${bridged.length} account(s) were bridged into the opening day:\n`);
        listRows(bridged);
      }

      if (affected.length > 0 || bridged.length > 0) {
        if (commit) {
          // Reuses the rollover's own patch, so the repair and the thing that
          // prevents a recurrence cannot drift. It also stamps seasonOpenedFor,
          // which is what stops the next rollover redoing this.
          const result = await openSeason(db, FieldValue, {
            termId: phase.term.id,
            termStart,
            // Without this the bridged sweep is disarmed and the pass silently
            // repairs only half of what it just listed.
            yearOpens,
            // The day record-activity is CURRENTLY crediting, not the calendar
            // date. The 2-hour grace window means that between 00:00 and 02:00
            // Baghdad they differ - and an operator running this at 01:00 would
            // otherwise stamp lastActiveDate a day into the future and look for
            // the wrong streak_history marker.
            creditedDay: getEffectiveDateString(),
            performedBy: 'scripts/streakAudit.ts',
          });
          console.log(
            `\n  -> cleared ${result.cleared} account(s), clamped ${result.bridged}; ` +
            `seasonOpenedFor = ${result.termId}`,
          );
          // A repair that writes less than it just listed is the dangerous
          // failure here: it prints a healthy-looking summary, stamps
          // seasonOpenedFor so the cron will not revisit, and leaves the rows
          // on screen still wrong. Say so loudly and exit non-zero.
          if (result.cleared < affected.length || result.bridged < bridged.length) {
            console.error(
              `\n  MISMATCH: listed ${affected.length} stale and ${bridged.length} bridged, ` +
              `but wrote ${result.cleared} and ${result.bridged}. Re-run after fixing.`,
            );
            process.exit(1);
          }
        } else {
          console.log('\n  DRY RUN - rerun with --commit to repair these and bank their peaks.');
        }
      }
      console.log('');
    }

    // Nothing else this pass needs, and the archive lookup below would exit 1
    // on a project whose first season has not closed yet.
    if (only === 'preseason') return;
  }

  // -------------------------------------------------------------------------
  // Which archive are we auditing against?
  // -------------------------------------------------------------------------
  const settingsSnap = await db.collection('app_settings').doc('streak').get();
  const archiveId = archiveIdFlag || settingsSnap.data()?.lastArchiveId;
  if (!archiveId) {
    console.error('No archive id. Pass --archive, or set app_settings/streak.lastArchiveId.');
    process.exit(1);
  }

  const archiveRef = db.collection('semesterArchives').doc(archiveId);
  const archiveSnap = await archiveRef.get();
  if (!archiveSnap.exists) {
    console.error(`semesterArchives/${archiveId} does not exist.`);
    process.exit(1);
  }
  const archive = archiveSnap.data()!;
  const topStudents: any[] = archive.topStudents || [];
  const archivedAt: FirebaseFirestore.Timestamp | undefined = archive.archivedAt;

  console.log(`Archive : ${archiveId}  "${archive.semesterName || archive.seasonName || ''}"`);
  console.log(`          ${topStudents.length} ranked rows, totalStudents ${archive.totalStudents ?? '?'}`);
  console.log(`          archivedAt ${archivedAt?.toDate().toISOString() ?? 'unknown'}\n`);

  // -------------------------------------------------------------------------
  // PASS 1 - backfill stageId onto legacy archive rows
  // -------------------------------------------------------------------------
  if (runs('archive-stage')) {
    console.log('== 1. archive row stageId ==');
    const missing = topStudents.filter(s => !s.stageId).length;
    const missingMcq = (archive.topMcqStudents || []).filter((s: any) => !s.stageId).length;

    if (missing === 0 && missingMcq === 0) {
      console.log('  all rows already carry stageId\n');
    } else if (!backfillStage) {
      console.log(`  ${missing} streak row(s) and ${missingMcq} mcq row(s) have no stageId.`);
      console.log('  Pass --backfill-stage <stageId> to set it. Not guessed: the stage a');
      console.log('  finished season was played in cannot be recovered from the data,');
      console.log('  and writing the wrong one mis-files the board permanently.\n');
    } else {
      console.log(`  setting stageId="${backfillStage}" on ${missing} streak + ${missingMcq} mcq row(s)`);
      const patch = {
        topStudents: topStudents.map(s => ({ ...s, stageId: s.stageId || backfillStage })),
        topMcqStudents: (archive.topMcqStudents || []).map((s: any) => ({ ...s, stageId: s.stageId || backfillStage })),
      };
      await writeAll('archive rows', [b => b.update(archiveRef, patch)]);
      console.log('');
    }
  }

  // -------------------------------------------------------------------------
  // PASS 2 - history cards vs the archive
  // -------------------------------------------------------------------------
  if (runs('cards')) {
    console.log('== 2. streakHistory cards vs archive ==');
    const repairs: ((b: FirebaseFirestore.WriteBatch) => void)[] = [];
    let matched = 0;
    let absent = 0;

    for (const row of topStudents) {
      const uid = row.userId || row.uid;
      if (!uid) continue;
      const cardRef = db.collection('users').doc(uid).collection('streakHistory').doc(archiveId);
      const card = await cardRef.get();

      if (!card.exists) {
        absent++;
        console.log(`  MISSING  rank ${String(row.rank).padStart(3)}  ${uid}  (archive says ${row.streakCount}/${row.longestStreak})`);
        repairs.push(b => b.set(cardRef, {
          seasonId: archiveId,
          semesterId: archiveId,
          semesterName: archive.semesterName || archive.seasonName || '',
          seasonName: archive.seasonName || archive.semesterName || '',
          stageId: row.stageId || backfillStage || null,
          rank: row.rank ?? null,
          finalStreak: row.streakCount || 0,
          longestStreak: row.longestStreak || 0,
          archivedAt: archivedAt ?? FieldValue.serverTimestamp(),
        }, { merge: true }));
        continue;
      }

      const c = card.data()!;
      const finalOk = (c.finalStreak || 0) === (row.streakCount || 0);
      const longOk = (c.longestStreak || 0) === (row.longestStreak || 0);

      if (finalOk && longOk) { matched++; continue; }

      console.log(`  DIVERGED rank ${String(row.rank).padStart(3)}  ${uid}`);
      console.log(`             card    final ${c.finalStreak} / longest ${c.longestStreak}   (updated ${card.updateTime?.toDate().toISOString()})`);
      console.log(`             archive final ${row.streakCount} / longest ${row.longestStreak}`);
      repairs.push(b => b.update(cardRef, {
        finalStreak: row.streakCount || 0,
        longestStreak: row.longestStreak || 0,
        rank: row.rank ?? c.rank ?? null,
        stageId: row.stageId || c.stageId || backfillStage || null,
        repairedBy: 'scripts/streakAudit.ts',
        repairedAt: FieldValue.serverTimestamp(),
      }));
    }

    console.log(`  ${matched} match, ${repairs.length - absent} diverged, ${absent} missing (of ${topStudents.length} archived rows)`);

    // The archive only keeps the top 50 per stage (shared/seasonReset.ts), but a
    // card is written for EVERY student with a non-zero streak. Those below the
    // cut have nothing to be checked against here.
    const cardsGroup = await db.collectionGroup('streakHistory').get();
    const cardsForSeason = cardsGroup.docs.filter(d => d.id === archiveId);
    const archivedUids = new Set(topStudents.map(s => s.userId || s.uid));
    const unverifiable = cardsForSeason.filter(d => !archivedUids.has(d.ref.parent.parent!.id));
    if (unverifiable.length) {
      console.log(`  ${unverifiable.length} card(s) below the archive's top-50 cut have no counterpart to`);
      console.log(`  check against. Reconstruct from streakLog/{uid}/days/* if one is disputed;`);
      console.log(`  this script will not rewrite a card it cannot prove wrong.`);
    }
    await writeAll('cards', repairs);
    console.log('');
  }

  // -------------------------------------------------------------------------
  // PASS 3 - drain stale pending resets
  // -------------------------------------------------------------------------
  if (runs('pending')) {
    console.log('== 3. stale pending_streak_resets ==');
    const cutoff = archivedAt?.toDate();
    const pendingSnap = await db.collection('pending_streak_resets').get();

    const stale = pendingSnap.docs.filter(d => {
      if (!cutoff) return false;
      const created = d.data().createdAt?.toDate?.();
      return created ? created < cutoff : true;
    });

    console.log(`  ${pendingSnap.size} pending doc(s); ${stale.length} predate the archive and can no longer be forgiven`);

    const flagged = await db.collection('users').where('hasPendingStreakReset', '==', true).get();
    console.log(`  ${flagged.size} user(s) still carry hasPendingStreakReset`);

    const ops: ((b: FirebaseFirestore.WriteBatch) => void)[] = [];
    const staleUids = new Set(stale.map(d => d.id));
    stale.forEach(d => ops.push(b => b.delete(d.ref)));
    flagged.docs
      .filter(d => staleUids.has(d.id) || !pendingSnap.docs.some(p => p.id === d.id))
      .forEach(d => ops.push(b => b.update(d.ref, { hasPendingStreakReset: FieldValue.delete() })));

    console.log(`  ${ops.length} write(s) queued`);
    await writeAll('pending', ops);
    console.log('');
  }

  // -------------------------------------------------------------------------
  // PASS 4 - backfill bestStreakAllTime
  // -------------------------------------------------------------------------
  if (runs('best')) {
    console.log('== 4. bestStreakAllTime backfill ==');
    const usersSnap = await db.collection('users').get();
    const ops: ((b: FirebaseFirestore.WriteBatch) => void)[] = [];
    let raised = 0;

    for (const u of usersSnap.docs) {
      const d = u.data();
      let best = Math.max(d.bestStreakAllTime || 0, d.longestStreak || 0, d.streakCount || 0);

      const cards = await u.ref.collection('streakHistory').get();
      for (const c of cards.docs) {
        best = Math.max(best, c.data().longestStreak || 0, c.data().finalStreak || 0);
      }

      if (best > (d.bestStreakAllTime || 0)) {
        raised++;
        ops.push(b => b.update(u.ref, { bestStreakAllTime: best }));
      }
    }

    console.log(`  ${raised} of ${usersSnap.size} account(s) would gain a higher all-time record`);
    await writeAll('bestStreakAllTime', ops);
    console.log('');
  }

  console.log(commit ? 'Done. Changes written.\n' : 'Done. Dry run - re-run with --commit to apply.\n');
}

main().catch(e => { console.error(e); process.exit(1); });
