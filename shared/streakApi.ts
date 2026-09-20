/**
 * The streak system's HTTP surface, built once and mounted by both route files.
 *
 * server.ts and api/index.ts are divergent copies of the same Express app and
 * vercel.json sends production /api/* to api/index.ts, so a handler written
 * inline in one of them is a handler that silently never runs somewhere. These
 * ten had already drifted: production grew a `globalFreeze` gap-skip and a
 * `streakLog` audit trail that dev never had, dev grew a recovery push that
 * production never sent, and the two computed the same "effective date" by
 * different means. Exporting a factory means each file mounts them with one
 * line and the bodies cannot diverge again - the same fix shared/simosanApi.ts
 * applies to Simosan's four routes.
 *
 * Middleware is deliberately NOT shared: verifyAuth / verifyAdmin genuinely
 * differ between the two files, and each surface keeps its own.
 */
import {
  activeDaysBetween,
  addDays,
  isLiveDay,
  startsFreshSeason,
} from './academicCalendar.js';
import { resolveCurrentPhase } from './seasonRollover.js';

export interface StreakDeps {
  admin: any;
}

/** How a day was credited. Written to streakLog so a disputed streak can be
 *  reconstructed without guessing which branch ran. */
export type StreakMethod =
  | 'normal'
  | 'freeze_token'
  | 'pending_loss'
  | 'new_season'
  | 'no_op';

const DEFAULT_GRACE_HOURS = 2;
const MAX_FREEZE_TOKENS = 3;

// ---------------------------------------------------------------------------
// Dates. One implementation, in Baghdad, anchored on the repo's own addDays.
// ---------------------------------------------------------------------------

/** 'YYYY-MM-DD' in Asia/Baghdad. en-CA is already that format - no parsing. */
export function getBaghdadDate(date: Date = new Date()): string {
  return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Baghdad' });
}

/** Hour 0-23 in Asia/Baghdad. The %24 is for the ICU builds that say "24". */
export function getBaghdadHour(date: Date = new Date()): number {
  const h = date.toLocaleString('en-US', {
    timeZone: 'Asia/Baghdad',
    hour12: false,
    hour: '2-digit',
  });
  return parseInt(h, 10) % 24;
}

/**
 * The day a visit right now is CREDITED to.
 *
 * Before `gracePeriodHours` in the morning that is still yesterday, so a
 * student studying past midnight does not lose the day they were working on.
 *
 * Replaces two implementations that agreed only by luck: one parsed
 * toLocaleString('en-GB') by splitting on ', ' (ICU emits a narrow no-break
 * space in some builds), the other did setDate() on a live instant in the
 * HOST's timezone and reformatted in Baghdad. This walks the day with addDays,
 * which is noon-UTC anchored and already covered by npm run test:calendar.
 */
export function getEffectiveDateString(
  gracePeriodHours: number = DEFAULT_GRACE_HOURS,
  now: Date = new Date(),
): string {
  const today = getBaghdadDate(now);
  return getBaghdadHour(now) < gracePeriodHours ? addDays(today, -1) : today;
}

export function createStreakHandlers(deps: StreakDeps) {
  const { admin } = deps;
  const FieldValue = () => admin.firestore.FieldValue;

  const readGraceHours = async (db: any): Promise<number> => {
    const snap = await db.collection('app_settings').doc('streak').get();
    return snap.exists ? (snap.data()?.gracePeriodHours ?? DEFAULT_GRACE_HOURS) : DEFAULT_GRACE_HOURS;
  };

  // -------------------------------------------------------------------------
  // POST /api/record-activity
  // -------------------------------------------------------------------------
  const recordActivity = async (req: any, res: any) => {
    try {
      const user = req.user;
      const db = admin.firestore();

      // Whether streaks count today is derived from the academic calendar, not
      // from a stored flag, so a break pauses the app whether or not the
      // nightly rollover ever ran. Resolved against the day being CREDITED
      // (grace period applied), so the gate and the arithmetic agree on a date.
      const graceHours = await readGraceHours(db);
      const { calendar, phase } = await resolveCurrentPhase(db, getEffectiveDateString(graceHours));
      if (phase.isPaused) {
        return res.json({
          success: true,
          vacationMode: true,
          phase: phase.phase,
          resumesOn: phase.nextStart,
          message: 'The competition is paused for the break. Streaks are frozen.',
        });
      }

      const userRef = db.collection('users').doc(user.uid);

      const txResult = await db.runTransaction(async (t: any) => {
        const appSettingsDoc = await t.get(db.collection('app_settings').doc('streak'));
        const gracePeriodHours = appSettingsDoc.exists
          ? (appSettingsDoc.data()?.gracePeriodHours ?? DEFAULT_GRACE_HOURS)
          : DEFAULT_GRACE_HOURS;

        const effectiveDate = getEffectiveDateString(gracePeriodHours);
        const historyRef = db.collection('streak_history').doc(`${user.uid}_${effectiveDate}`);
        const pendingDocRef = db.collection('pending_streak_resets').doc(user.uid);

        const userDoc = await t.get(userRef);
        const historyDoc = await t.get(historyRef);
        const pendingDoc = await t.get(pendingDocRef);

        if (!userDoc.exists) throw new Error('User not found');

        // Already recorded today - only refresh the heartbeat.
        if (historyDoc.exists) {
          if (historyDoc.data()?.freezeUsed === true) {
            t.update(historyRef, { freezeUsed: false });
          }
          t.update(userRef, { lastActiveAt: FieldValue().serverTimestamp() });
          return { freezeUsed: false };
        }

        const data = userDoc.data()!;
        let streakCount = data.streakCount || 0;
        let longestStreak = data.longestStreak || 0;
        let bestStreakAllTime = data.bestStreakAllTime || 0;
        let freezeTokens = data.freezeTokens ?? 1;
        // Declared inside the transaction, not outside: a retried transaction
        // has to recompute these, or a replay reports a freeze that did not
        // happen.
        let hasUsedFreeze = false;
        let method: StreakMethod = 'normal';
        let missedDaysForLog = 0;
        const initialStreakCount = streakCount;
        const initialFreezeTokens = freezeTokens;

        let processedLastDate: string | null = data.lastActiveDate ?? null;
        if (processedLastDate && processedLastDate.includes('T')) {
          processedLastDate = processedLastDate.split('T')[0];
        }

        // A lastActiveDate from before the academic year opened belongs to no
        // season this calendar describes. Every preseason day is paused, so
        // activeDaysBetween reports a gap of ONE from any of them - last June
        // included - and the branch below would increment a stale counter that
        // no rollover can ever zero, because the year's first term has no
        // predecessor for closableTerm() to close. That is the bug that had one
        // student reading 2 on day 1 with everyone else on 1.
        if (startsFreshSeason(calendar, processedLastDate, effectiveDate)) {
          // Bank the closing peak BEFORE zeroing it: nothing may lower
          // longestStreak without raising bestStreakAllTime, or "الأطول"
          // silently loses the record.
          bestStreakAllTime = Math.max(bestStreakAllTime, longestStreak, streakCount);
          longestStreak = 0;
          freezeTokens = MAX_FREEZE_TOKENS;
          processedLastDate = null;
          method = 'new_season';
        }

        if (!processedLastDate) {
          streakCount = 1;
        } else {
          // Paused days are not misses: a student active on the last live day
          // before a break and again on the first day of the new term is one
          // day apart. Without this every student loses their streak across a
          // break the rollover failed to archive.
          const daysDiff = activeDaysBetween(calendar, processedLastDate, effectiveDate);

          if (daysDiff === 1) {
            streakCount += 1;
          } else if (daysDiff > 1) {
            const missedDays = daysDiff - 1;
            missedDaysForLog = missedDays;

            if (freezeTokens >= missedDays) {
              freezeTokens -= missedDays;
              streakCount += 1; // continues from before + covers the gap
              hasUsedFreeze = true;
              if (method !== 'new_season') method = 'freeze_token';

              // Stamp only the LIVE days that were missed. Walking raw calendar
              // days here would mark break days as covered by a freeze token.
              let gapDate = processedLastDate;
              for (let stamped = 0; stamped < missedDays; ) {
                gapDate = addDays(gapDate, 1);
                if (gapDate >= effectiveDate) break;
                if (!isLiveDay(calendar, gapDate)) continue;
                stamped++;

                t.set(db.collection('streak_history').doc(`${user.uid}_${gapDate}`), {
                  userId: user.uid,
                  date: gapDate,
                  wasActive: true,
                  freezeUsed: true,
                  timestamp: FieldValue().serverTimestamp(),
                });
              }
            } else {
              const previousStreak = streakCount;
              streakCount = 1; // lost IMMEDIATELY
              method = 'pending_loss';

              let canCreatePending = false;
              if (!data.hasPendingStreakReset) {
                canCreatePending = true;
              } else if (pendingDoc.exists) {
                const pData = pendingDoc.data();
                if (pData && pData.expiresAt) {
                  const exp = pData.expiresAt.toDate ? pData.expiresAt.toDate() : new Date(pData.expiresAt);
                  if (exp < new Date()) canCreatePending = true;
                }
              } else {
                canCreatePending = true; // flag is true but the doc is gone
              }

              if (canCreatePending) {
                const expiresAt = new Date();
                expiresAt.setDate(expiresAt.getDate() + 7);

                t.set(pendingDocRef, {
                  userId: user.uid,
                  email: user.email || '',
                  name: data.name || '',
                  missedDays,
                  streakAtRisk: previousStreak,
                  dateRecorded: effectiveDate,
                  expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
                  createdAt: FieldValue().serverTimestamp(),
                });
              }
            }
          } else {
            // daysDiff === 0: lastActiveDate is already at or past the day
            // being credited - clock skew, a date written forward by
            // time-freeze, or a streak_history doc deleted underneath us. The
            // chain used to have no arm for this, so the visit was recorded and
            // the streak silently stood still with no trace of why.
            method = 'no_op';
          }
        }

        longestStreak = Math.max(longestStreak, streakCount);
        // Per-season peak (longestStreak) is zeroed by startNewSeason; this one
        // is not, and is what the profile's "الأطول" reads.
        bestStreakAllTime = Math.max(bestStreakAllTime, streakCount);

        const updateData: any = {
          streakCount,
          longestStreak,
          bestStreakAllTime,
          freezeTokens,
          lastActiveDate: effectiveDate,
          lastActiveAt: FieldValue().serverTimestamp(),
        };
        if (method === 'pending_loss' && !data.hasPendingStreakReset) {
          updateData.hasPendingStreakReset = true;
        }
        // A fresh season clears the flag along with the streak it guarded -
        // left behind it strands the student on a permanent "you are about to
        // lose your streak" banner.
        if (method === 'new_season' && data.hasPendingStreakReset) {
          updateData.hasPendingStreakReset = FieldValue().delete();
          t.delete(pendingDocRef);
        }

        t.update(userRef, updateData);

        t.set(historyRef, {
          userId: user.uid,
          date: effectiveDate,
          wasActive: true,
          freezeUsed: false,
          timestamp: FieldValue().serverTimestamp(),
        });

        t.set(
          db.collection('streakLog').doc(user.uid).collection('days').doc(effectiveDate),
          {
            date: effectiveDate,
            recordedAt: FieldValue().serverTimestamp(),
            streakBefore: initialStreakCount,
            streakAfter: streakCount,
            method,
            tokensBefore: initialFreezeTokens,
            tokensAfter: freezeTokens,
            missedDays: missedDaysForLog,
            gracePeriodApplied: getBaghdadDate() !== effectiveDate,
          },
          { merge: true },
        );

        return { freezeUsed: hasUsedFreeze };
      });

      const updatedUser = await userRef.get();
      // Reported from the transaction. This used to read
      // `freezeTokens < (freezeTokens ?? 1)` off the post-commit document - the
      // same value compared to itself, so the client was told `false` every
      // time even when a shield had just been spent.
      res.json({
        success: true,
        streakCount: updatedUser.data()?.streakCount,
        freezeUsed: txResult?.freezeUsed === true,
      });
    } catch (error) {
      console.error('Error recording activity:', error);
      res.status(500).json({ error: 'Failed to record activity' });
    }
  };

  // -------------------------------------------------------------------------
  // GET /api/streak-history/:uid
  // -------------------------------------------------------------------------
  const history = async (req: any, res: any) => {
    try {
      const authUser = req.user;
      const targetUid = req.params.uid;
      const db = admin.firestore();

      if (authUser.uid !== targetUid) {
        const userDoc = await db.collection('users').doc(authUser.uid).get();
        const role = userDoc.data()?.role;
        if (role !== 'admin' && role !== 'moderator') {
          return res.status(403).json({ error: 'Forbidden' });
        }
      }

      const snapshot = await db.collection('streak_history').where('userId', '==', targetUid).get();
      const rows = snapshot.docs.map((doc: any) => {
        const data = doc.data();
        return {
          ...data,
          timestamp: data.timestamp?.toDate
            ? data.timestamp.toDate().toISOString()
            : new Date().toISOString(),
        };
      });

      res.json({ history: rows });
    } catch (error) {
      console.error('Error fetching streak history:', error);
      res.status(500).json({ error: 'Failed to fetch streak history' });
    }
  };

  // -------------------------------------------------------------------------
  // POST /api/admin/time-freeze
  //
  // "Forgive everyone": move every live streak's lastActiveDate up to the most
  // recent live day, so nobody is penalised for a day the app itself lost.
  // -------------------------------------------------------------------------
  const timeFreeze = async (_req: any, res: any) => {
    try {
      const db = admin.firestore();
      const { calendar } = await resolveCurrentPhase(db);

      // Anchored on Baghdad WALL-CLOCK today, not the effective date. Run
      // inside the grace window the effective date is already yesterday, so
      // stepping back from it lands two days out - and every student it
      // "protected" then burns a shield on their next visit.
      let target = addDays(getBaghdadDate(), -1);
      // Step back to the last day that actually counted. A raw calendar day can
      // be a break day, which is not a day anyone could have been credited for.
      for (let guard = 0; guard < 400 && !isLiveDay(calendar, target); guard++) {
        target = addDays(target, -1);
      }

      const snapshot = await db.collection('users').get();
      const commits: Promise<any>[] = [];
      let currentBatch = db.batch();
      let countInBatch = 0;
      let totalUpdated = 0;

      snapshot.forEach((doc: any) => {
        const data = doc.data();
        if (!(data.streakCount > 0)) return;

        let processedLastDate = data.lastActiveDate;
        if (processedLastDate && typeof processedLastDate === 'string' && processedLastDate.includes('T')) {
          processedLastDate = processedLastDate.split('T')[0];
        }
        if (processedLastDate && processedLastDate >= target) return;

        currentBatch.update(doc.ref, { lastActiveDate: target });
        countInBatch++;
        totalUpdated++;

        if (countInBatch >= 400) {
          commits.push(currentBatch.commit());
          currentBatch = db.batch();
          countInBatch = 0;
        }
      });

      if (countInBatch > 0) commits.push(currentBatch.commit());
      await Promise.all(commits);

      res.json({ success: true, count: totalUpdated, forgivenUpTo: target });
    } catch (e) {
      console.error('Error freezing time', e);
      res.status(500).json({ error: 'Error freezing time' });
    }
  };

  // -------------------------------------------------------------------------
  // POST /api/admin/grant-freeze-global
  // -------------------------------------------------------------------------
  const grantFreezeGlobal = async (_req: any, res: any) => {
    try {
      const db = admin.firestore();
      const snapshot = await db.collection('users').get();

      const commits: Promise<any>[] = [];
      let currentBatch = db.batch();
      let count = 0;
      let countInBatch = 0;

      snapshot.forEach((doc: any) => {
        currentBatch.update(doc.ref, { freezeTokens: MAX_FREEZE_TOKENS });
        count++;
        countInBatch++;
        if (countInBatch >= 400) {
          commits.push(currentBatch.commit());
          currentBatch = db.batch();
          countInBatch = 0;
        }
      });

      if (countInBatch > 0) commits.push(currentBatch.commit());
      await Promise.all(commits);

      res.json({ success: true, count });
    } catch (e) {
      console.error('Error granting global freeze tokens', e);
      res.status(500).json({ error: 'Error granting global freeze tokens' });
    }
  };

  // -------------------------------------------------------------------------
  // POST /api/admin/grant-freeze
  // -------------------------------------------------------------------------
  const grantFreeze = async (req: any, res: any) => {
    try {
      const { userUid } = req.body;
      const amount = Number(req.body?.amount);
      if (!userUid || !Number.isInteger(amount) || amount < 1 || amount > MAX_FREEZE_TOKENS) {
        return res.status(400).json({ error: 'userUid and an amount of 1..3 are required' });
      }

      const db = admin.firestore();
      const userRef = db.collection('users').doc(userUid);

      await db.runTransaction(async (t: any) => {
        const doc = await t.get(userRef);
        if (!doc.exists) throw new Error('Not found');
        const currentTokens = doc.data()?.freezeTokens ?? 1;
        t.update(userRef, { freezeTokens: Math.min(currentTokens + amount, MAX_FREEZE_TOKENS) });
      });

      res.json({ success: true });
    } catch (e) {
      console.error('Error granting freeze token', e);
      res.status(500).json({ error: 'Error granting freeze token' });
    }
  };

  // -------------------------------------------------------------------------
  // POST /api/admin/streak-recovery
  // -------------------------------------------------------------------------
  const recovery = async (req: any, res: any) => {
    try {
      const { userUid, studentEmail, reason } = req.body;
      const adminUser = req.user;

      // newStreak arrived unvalidated and untyped. A string body wrote a string
      // into streakCount, which breaks orderBy('streakCount') ordering and then
      // trips firestore.rules' `streakCount is number`, silently refusing that
      // student's own profile edits from then on.
      const newStreak = Number(req.body?.newStreak);
      if (!userUid || !Number.isInteger(newStreak) || newStreak < 0 || newStreak > 3650) {
        return res.status(400).json({ error: 'userUid and an integer newStreak of 0..3650 are required' });
      }

      const db = admin.firestore();
      const userRef = db.collection('users').doc(userUid);
      const graceHours = await readGraceHours(db);
      const effectiveDate = getEffectiveDateString(graceHours);

      await db.runTransaction(async (t: any) => {
        const doc = await t.get(userRef);
        if (!doc.exists) throw new Error('Not found');
        const oldStreak = doc.data()?.streakCount || 0;

        const patch: any = {
          streakCount: newStreak,
          longestStreak: Math.max(doc.data()?.longestStreak || 0, newStreak),
          bestStreakAllTime: Math.max(doc.data()?.bestStreakAllTime || 0, newStreak),
        };
        // Without this the restored streak counts as untouched since whenever
        // they last visited, so the very next visit re-breaks it and the
        // recovery has to be done again.
        if (newStreak > 0) patch.lastActiveDate = effectiveDate;

        t.update(userRef, patch);

        t.set(db.collection('streak_recoveries').doc(), {
          studentEmail,
          userId: userUid,
          oldStreak,
          newStreak,
          reason,
          recoveredBy: adminUser.email,
          recoveredAt: FieldValue().serverTimestamp(),
        });
      });

      // Dev-only until now, so in production students were never told.
      try {
        const fcmToken = (await userRef.get()).data()?.fcmToken;
        if (fcmToken) {
          await admin.messaging().send({
            notification: {
              title: '🔥 تم استرجاع الستريك!',
              body: 'قام الإداري باسترجاع الستريك الخاص بك بنجاح. استمر في التألق!',
            },
            data: { type: 'streak_recovery' },
            token: fcmToken,
          });
        }
      } catch (notifyErr) {
        console.error('Failed to send streak recovery notification', notifyErr);
      }

      res.json({ success: true });
    } catch (e) {
      console.error('Streak recovery error:', e);
      res.status(500).json({ error: 'Error recovering streak' });
    }
  };

  // -------------------------------------------------------------------------
  // POST /api/admin/resolve-pending-streak
  // -------------------------------------------------------------------------
  const resolvePending = async (req: any, res: any) => {
    try {
      const { userUid, action } = req.body;
      if (action !== 'reset' && action !== 'forgive') {
        return res.status(400).json({ error: 'Invalid action' });
      }

      const db = admin.firestore();
      const userRef = db.collection('users').doc(userUid);
      const pendingRef = db.collection('pending_streak_resets').doc(userUid);
      const { calendar } = await resolveCurrentPhase(db);

      await db.runTransaction(async (t: any) => {
        const pendingDoc = await t.get(pendingRef);
        if (!pendingDoc.exists) throw new Error('Pending streak reset not found');

        const pendingData = pendingDoc.data();
        const userDoc = await t.get(userRef);

        if (action === 'reset') {
          // It was already reset when the opportunity was created. Clean up.
          t.update(userRef, { hasPendingStreakReset: FieldValue().delete() });
        } else {
          // The doc stores an expiresAt that only the two clients filtered on,
          // so an expired forgiveness was still fully grantable from the route.
          const exp = pendingData?.expiresAt?.toDate
            ? pendingData.expiresAt.toDate()
            : pendingData?.expiresAt
              ? new Date(pendingData.expiresAt)
              : null;
          if (exp && exp < new Date()) {
            throw new Error('This streak forgiveness has expired');
          }

          let newStreakCount = userDoc.exists ? (userDoc.data()?.streakCount || 0) : 0;

          if (pendingData && pendingData.dateRecorded && pendingData.missedDays) {
            const missedDays = pendingData.missedDays;
            newStreakCount += pendingData.streakAtRisk || 0;

            // Walk LIVE days backwards. The forward walk in record-activity has
            // this rule already; walking raw calendar days here stamped break
            // days as covered by a shield.
            let gapDate = pendingData.dateRecorded;
            for (let stamped = 0, guard = 0; stamped < missedDays && guard < 400; guard++) {
              gapDate = addDays(gapDate, -1);
              if (!isLiveDay(calendar, gapDate)) continue;
              stamped++;

              t.set(db.collection('streak_history').doc(`${userUid}_${gapDate}`), {
                userId: userUid,
                date: gapDate,
                wasActive: true,
                freezeUsed: true,
                timestamp: FieldValue().serverTimestamp(),
              });
            }
          }

          t.update(userRef, {
            streakCount: newStreakCount,
            longestStreak: Math.max(userDoc.data()?.longestStreak || 0, newStreakCount),
            bestStreakAllTime: Math.max(userDoc.data()?.bestStreakAllTime || 0, newStreakCount),
            hasPendingStreakReset: FieldValue().delete(),
          });
        }

        t.delete(pendingRef);
      });

      res.json({ success: true });
    } catch (error: any) {
      console.error('Error resolving pending streak', error);
      res.status(500).json({ error: error.message || 'Error resolving pending streak' });
    }
  };

  // -------------------------------------------------------------------------
  // POST /api/admin/fix-calendar
  //
  // Backfills the streak CALENDAR (streak_history) for one student. Never
  // touches the counters.
  // -------------------------------------------------------------------------
  const fixCalendar = async (req: any, res: any) => {
    try {
      const { userUid } = req.body;
      if (!userUid) return res.status(400).json({ error: 'userUid is required' });

      const db = admin.firestore();
      const graceHours = await readGraceHours(db);
      const { calendar } = await resolveCurrentPhase(db);

      // Was raw UTC, which between 21:00 and 24:00 UTC is a whole day behind
      // the student's Baghdad calendar - so the most recent hole, the one being
      // complained about, was the one day never filled.
      const effectiveDate = getEffectiveDateString(graceHours);
      const datesToCheck: string[] = [];
      for (let i = 1, walked = 0; walked < 10 && i <= 400; i++) {
        const dateStr = addDays(effectiveDate, -i);
        // A paused day was never creditable, so stamping it wasActive invents
        // activity on a day the competition was not running.
        if (!isLiveDay(calendar, dateStr)) continue;
        walked++;
        datesToCheck.push(dateStr);
      }
      datesToCheck.reverse(); // oldest to newest

      let fixedCount = 0;
      await db.runTransaction(async (t: any) => {
        const refs = datesToCheck.map(d => db.collection('streak_history').doc(`${userUid}_${d}`));
        const snaps = await Promise.all(refs.map((r: any) => t.get(r)));

        snaps.forEach((snap: any, i: number) => {
          if (snap.exists) return;
          t.set(refs[i], {
            userId: userUid,
            date: datesToCheck[i],
            wasActive: true,
            freezeUsed: true,
            timestamp: FieldValue().serverTimestamp(),
          });
          fixedCount++;
        });
      });

      res.json({ success: true, fixedCount });
    } catch (e: any) {
      console.error('Error fixing streak calendar', e);
      res.status(500).json({ error: e.message || 'Error' });
    }
  };

  // -------------------------------------------------------------------------
  // POST /api/cron/streak-warnings
  // -------------------------------------------------------------------------
  const warningsCron = async (req: any, res: any) => {
    // Fails CLOSED, like the season rollover. It used to read
    // `header !== SECRET && SECRET`, so with no secret configured any
    // unauthenticated POST fanned a push out to every user in the app.
    const secret = process.env.CRON_SECRET;
    if (!secret) {
      console.error('Streak warnings blocked: CRON_SECRET is not configured.');
      return res.status(401).send('Cron secret not configured');
    }
    const header = req.headers['x-cron-secret'];
    const bearer = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    if (header !== secret && bearer !== secret) return res.status(403).send('Forbidden');

    try {
      const db = admin.firestore();
      // Honours the configured grace period. Called bare, it assumed 2 hours
      // while record-activity honoured the setting, so the two disagreed about
      // what "today" was and it nagged students already credited.
      const graceHours = await readGraceHours(db);
      const effectiveDate = getEffectiveDateString(graceHours);

      // Nothing to protect while the competition is paused.
      const { phase } = await resolveCurrentPhase(db, effectiveDate);
      if (phase.isPaused) {
        return res.json({ success: true, skipped: 'paused', phase: phase.phase, notifiedCount: 0 });
      }

      const usersSnap = await db.collection('users').where('fcmToken', '!=', null).get();
      const tokens: string[] = [];
      usersSnap.forEach((doc: any) => {
        const data = doc.data();
        if (data.lastActiveDate !== effectiveDate && data.fcmToken) tokens.push(data.fcmToken);
      });

      // sendEachForMulticast caps at 500 tokens per call.
      let notifiedCount = 0;
      for (let i = 0; i < tokens.length; i += 500) {
        await admin.messaging().sendEachForMulticast({
          notification: {
            title: 'لا تنسَ نشاطك اليومي 🔥',
            body: 'ستريكك في خطر! افتح التطبيق الآن لتحافظ عليه.',
          },
          tokens: tokens.slice(i, i + 500),
        });
        notifiedCount += tokens.slice(i, i + 500).length;
      }

      res.json({ success: true, notifiedCount });
    } catch (e) {
      console.error('Cron streak warnings error', e);
      res.status(500).json({ error: 'Error sending warnings' });
    }
  };

  return {
    recordActivity,
    history,
    timeFreeze,
    grantFreeze,
    grantFreezeGlobal,
    recovery,
    resolvePending,
    fixCalendar,
    warningsCron,
  };
}
