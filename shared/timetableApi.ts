/**
 * The weekly timetable's HTTP surface, built once and mounted by both route
 * files.
 *
 * Same factory shape as shared/mcqApi.ts and shared/simosanApi.ts, for the same
 * reason: vercel.json sends production /api/* to api/index.ts while npm run dev
 * runs server.ts, and the two have already drifted by 14 routes once.
 *
 * ONE route. Reading a draft, editing it and publishing it all go straight to
 * Firestore under firestore.rules - the only thing that needs a server is the
 * Gemini call, because it spends quota on a key that must never reach a
 * browser.
 */
import { GoogleGenAI } from '@google/genai';
import {
  GENERATION_LOCK_MS,
  MAX_GENERATION_FAILURES,
  MCQ_MODEL,
  classifyFailure,
  type McqFailureReason,
} from './mcqGeneration.js';
import {
  ALLOWED_IMAGE_MIME,
  MAX_INLINE_IMAGE_BYTES,
  TIMETABLE_PROMPT,
  TIMETABLE_RESPONSE_SCHEMA,
  validateTimetable,
  type TimetableFailureReason,
} from './timetable.js';
import { FALLBACK_GROUP_CONFIG, type GroupConfigLike } from './groups.js';

export interface TimetableDeps {
  admin: any;
  /** Free-tier key, server-only. The same key MCQ generation uses - a timetable
   *  is public institutional material, so the free tier's "Google may train on
   *  this" terms are as acceptable here as they are for lecture PDFs. Simosan
   *  stays on the paid key because student questions are NOT public. */
  apiKey?: string;
}

type Reason = McqFailureReason | TimetableFailureReason;

/** What verifyAdmin stamps onto the request. Declared locally: both route files
 *  define their own copy of CallerStage and neither exports it. */
interface CallerStage {
  isMasterAdmin: boolean;
  isSupport: boolean;
  role: string;
  managedStageId: string | null;
  permissions: Record<string, boolean>;
}

const EMPTY_STAGE: CallerStage = {
  isMasterAdmin: false, isSupport: false, role: '', managedStageId: null, permissions: {},
};

/** Attempts at the model call, including the first. */
const GENERATE_ATTEMPTS = 3;
/** Waits before attempt 2 and 3. Short: the caller is a human watching a
 *  spinner, and Vercel kills the function at 60s regardless. */
const RETRY_BACKOFF_MS = [1500, 4000];
/** Room a retry needs to be worth starting. A call killed mid-flight by the
 *  platform is worse than a clean failure the user can act on. */
const MIN_CALL_BUDGET_MS = 15_000;
/** vercel.json sets maxDuration 60 for api/index.ts; stop short of it. */
const FUNCTION_BUDGET_MS = 50_000;

/**
 * Run the model call, retrying only what is worth retrying.
 *
 * Gemini answers a demand spike with `503 UNAVAILABLE` whose own message reads
 * "Spikes in demand are usually temporary. Please try again later." Taking that
 * at face value is the difference between a timetable that parses and a
 * representative being told their image is unreadable - which is what happened:
 * three separate 503s burned the whole retry budget and locked the stage out.
 *
 * Everything else throws on the first attempt. A schema Gemini rejects or an
 * image it cannot read fails the same way however many times it is sent.
 */
async function generateWithRetry<T>(call: () => Promise<T>, deadlineAt: number): Promise<T> {
  let last: any;
  for (let attempt = 0; attempt < GENERATE_ATTEMPTS; attempt++) {
    try {
      return await call();
    } catch (e: any) {
      last = e;
      if (classifyFailure(e) !== 'unavailable') throw e;
      const wait = RETRY_BACKOFF_MS[attempt];
      if (!wait || Date.now() + wait + MIN_CALL_BUDGET_MS > deadlineAt) throw e;
      console.warn(`[timetable] provider unavailable, retrying in ${wait}ms`);
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }
  throw last;
}

/**
 * The server-side twin of canManage(user, 'manageTimetable') in
 * src/lib/permissions.ts. The arms and their ORDER match it exactly.
 *
 * staffCan() in the two route files is not enough on its own: it is only the
 * cross-stage bypass and returns false for a representative by design, which is
 * precisely the role that should hold this capability by default.
 */
function mayManageTimetable(staff: CallerStage): boolean {
  if (staff.isMasterAdmin) return true;
  // Support before representative: a support account promoted from a
  // representative keeps its managedStageId, and its permissions map is built
  // as "denied unless true".
  if (staff.isSupport) return staff.permissions?.manageTimetable === true;
  if (staff.role === 'admin') return staff.permissions?.manageTimetable !== false;
  if (staff.role === 'moderator') return staff.permissions?.manageTimetable === true;
  return false;
}

export function createTimetableHandlers(deps: TimetableDeps) {
  const { admin } = deps;
  const apiKey = deps.apiKey || process.env.GEMINI_FREE_TIER_API_KEY;
  const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

  async function raiseAlert(reason: Reason, detail: { stageId: string; note?: string }) {
    const db = admin.firestore();
    try {
      await db.collection('adminAlerts').add({
        type: 'ai_quota_exhausted',
        reason,
        source: 'timetable',
        stageId: detail.stageId,
        note: detail.note || null,
        resolved: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.warn('[timetable] could not write adminAlerts', e);
    }

    const body =
      reason === 'free_tier_limit'
        ? 'Free-tier daily limit reached. Timetable parsing resumes after the quota resets.'
        : reason === 'not_configured'
          ? 'GEMINI_FREE_TIER_API_KEY is missing or invalid.'
          : reason === 'bad_request'
            ? 'Gemini rejected the request itself (model, config or response schema). Needs a code fix, not a key or a quota.'
            : `Timetable parsing failed (${reason}).`;
    try {
      await admin.messaging().send({
        topic: 'admins',
        notification: { title: 'Timetable parsing', body },
      });
    } catch (e) {
      console.warn('[timetable] FCM alert failed', e);
    }
  }

  /** Tell this stage's staff there is a parse waiting to be reviewed. One
   *  systemNotifications row per person is also one FCM push, via
   *  sendSystemNotificationV3 in functions/index.js. */
  async function notifyStaff(stageId: string, body: string) {
    const db = admin.firestore();
    try {
      // 'support' is included here. shared/mcqApi.ts omits it, which means a
      // support account never learns a student asked for questions - do not
      // copy that omission forward.
      const staff = await db.collection('users')
        .where('role', 'in', ['admin', 'moderator', 'support'])
        .limit(50).get();

      const batch = db.batch();
      let any = false;
      staff.docs.forEach((d: any) => {
        const s = d.data();
        const scoped = s.isMasterAdmin || s.role === 'support'
          || !s.managedStageId || s.managedStageId === stageId;
        if (!scoped) return;
        any = true;
        batch.set(db.collection('systemNotifications').doc(), {
          userId: d.id,
          title: 'الجدول الأسبوعي جاهز للمراجعة',
          body,
          type: 'timetable_parsed',
          stageId,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          read: false,
        });
      });
      if (any) await batch.commit();
    } catch (e) {
      console.warn('[timetable] staff notification failed', e);
    }
  }

  /* ---------------------------------------------------------------- *
   * POST /api/timetable/parse   (staff, manageTimetable, own stage)
   * ---------------------------------------------------------------- */
  async function parse(req: any, res: any) {
    const db = admin.firestore();
    const deadlineAt = Date.now() + FUNCTION_BUDGET_MS;
    const staff: CallerStage = (req as any).staff || EMPTY_STAGE;

    if (!mayManageTimetable(staff)) {
      return res.status(403).json({
        error: staff.isSupport ? 'support_not_granted' : 'forbidden',
      });
    }

    /*
     * The stage is resolved HERE, never taken on trust. A representative or a
     * moderator parses their own stage and nothing else, so their body
     * `stageId` is ignored outright rather than validated.
     *
     * The `!staff.managedStageId` arm mirrors the `myManagedStage() == ''`
     * grace in canWriteStage (firestore.rules) and is removed at the same time:
     * production still has staff with no managedStageId, and without it they
     * could not parse anything at all.
     */
    const unassigned = !staff.managedStageId;
    const mayName = staff.isMasterAdmin || staff.isSupport || unassigned;
    const stageId = String(
      (mayName ? (req.body?.stageId || staff.managedStageId) : staff.managedStageId) || '',
    ).trim();
    if (!stageId) return res.status(400).json({ error: 'no_stage' });

    if (!ai) {
      await raiseAlert('not_configured', { stageId });
      return res.status(503).json({ error: 'not_configured' });
    }

    const draftRef = db.collection('timetableDrafts').doc(stageId);

    try {
      /*
       * The image is resolved from Firestore, never posted by the caller.
       * Same contract as /api/mcq/generate: a caller-supplied URL would let
       * anyone make this server fetch arbitrary hosts, and Vercel caps request
       * bodies near 4.5MB so the bytes could not be posted anyway.
       *
       * Note this does NOT go through admin.storage().bucket(). Neither route
       * file passes a storageBucket to admin.initializeApp(), so .bucket()
       * throws "Bucket name not specified" at runtime.
       */
      const photoSnap = await db.collection('settings').doc(`weekly_schedule_${stageId}`).get();
      const photoUrl = photoSnap.exists ? photoSnap.data()?.photoUrl : null;
      if (!photoUrl) return res.status(400).json({ error: 'no_image' });

      /*
       * Serialisation lock, claimed transactionally on the one document it
       * concerns - stronger than the read-then-write in shared/mcqApi.ts and
       * cheap at this size.
       *
       * There is deliberately NO cross-stage "queue_busy" guard here. MCQ has
       * one because a bulk lecture upload fires N concurrent calls at a free
       * key; this is five stages with one hand-triggered image each, so a
       * global lock would block stage 2 while stage 3 parses for no quota
       * benefit at all.
       */
      const claim = await db.runTransaction(async (tx: any) => {
        const snap = await tx.get(draftRef);
        const data = snap.exists ? snap.data() : null;
        const startedMs = data?.startedAt?.toMillis ? data.startedAt.toMillis() : 0;
        if (data?.status === 'parsing' && startedMs > 0 && Date.now() - startedMs < GENERATION_LOCK_MS) {
          return 'already_parsing';
        }
        /*
         * The retry cap counts failures against ONE image. Uploading a new one
         * clears it, because that is exactly what the cap's own message tells
         * the user to do - and before this, doing so changed nothing and left
         * them permanently locked out with no way back.
         */
        const failedOn = data?.failedPhotoUrl;
        const staleCount = !!failedOn && failedOn !== photoUrl;
        const failureCount = staleCount ? 0 : (Number(data?.failureCount) || 0);

        tx.set(draftRef, {
          stageId,
          status: 'parsing',
          startedAt: admin.firestore.FieldValue.serverTimestamp(),
          ...(staleCount ? { failureCount: 0 } : {}),
        }, { merge: true });
        return 'ok';
      });
      if (claim === 'already_parsing') return res.status(409).json({ error: 'already_parsing' });


      try {
        const imageRes = await fetch(photoUrl);
        if (!imageRes.ok) throw new Error(`image_unreachable:${imageRes.status}`);

        // Gemini refuses an inlineData part whose mimeType does not describe
        // the bytes, so an unrecognised content-type is refused rather than
        // guessed at.
        const rawType = String(imageRes.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        const mimeType = ALLOWED_IMAGE_MIME.includes(rawType) ? rawType : 'image/jpeg';

        const buf = Buffer.from(await imageRes.arrayBuffer());
        if (!buf.length) throw new Error('image_unreachable:empty');
        if (buf.length > MAX_INLINE_IMAGE_BYTES) throw new Error('image_too_large');

        const response = await generateWithRetry(() => ai.models.generateContent({
          model: MCQ_MODEL,
          contents: [{
            role: 'user',
            parts: [
              { inlineData: { data: buf.toString('base64'), mimeType } },
              { text: TIMETABLE_PROMPT },
            ],
          }],
          config: {
            responseMimeType: 'application/json',
            responseSchema: TIMETABLE_RESPONSE_SCHEMA as any,
          },
        }), deadlineAt);

        // `text` is a getter on GenerateContentResponse, not a method.
        const parsed = JSON.parse(response.text || '{}');

        const stageSnap = await db.collection('stages').doc(stageId).get();
        const config: GroupConfigLike =
          (stageSnap.exists && stageSnap.data()?.groupConfig) || FALLBACK_GROUP_CONFIG;

        const result = validateTimetable(parsed, config);
        if (!result.ok) throw new Error(`invalid_response:${result.reason}`);

        await draftRef.set({
          stageId,
          sessions: result.sessions,
          sourcePhotoUrl: photoUrl,
          weekLabel: String(parsed?.weekLabel || '').slice(0, 120),
          droppedLabels: result.droppedLabels,
          status: 'draft',
          parsedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedBy: (req as any).user?.uid || '',
          model: MCQ_MODEL,
          failureCount: 0,
          failureReason: admin.firestore.FieldValue.delete(),
          failedPhotoUrl: admin.firestore.FieldValue.delete(),
        }, { merge: true });

        await notifyStaff(stageId, `${stageId} — ${result.sessions.length} محاضرة بانتظار المراجعة`);

        return res.json({
          ok: true,
          count: result.sessions.length,
          dropped: result.dropped,
          truncated: result.truncated,
          droppedLabels: result.droppedLabels,
        });
      } catch (e: any) {
        const msg = String(e?.message || '');
        const specific: Reason =
          msg.startsWith('image_unreachable') ? 'image_unreachable'
            : msg === 'image_too_large' ? 'image_too_large'
              : msg.startsWith('invalid_response') ? 'invalid_response'
                : classifyFailure(e);

        /*
         * The retry cap exists to stop an unprocessable IMAGE from draining the
         * daily free quota. A provider outage is not the image's fault and not
         * something the user can fix, so it must not spend that budget - three
         * transient 503s once locked a stage out permanently and told the
         * representative to upload a clearer picture.
         *
         * `failedPhotoUrl` records which image the count belongs to, so
         * uploading a different one resets it in the claim above.
         *
         * `sessions` is deliberately NOT touched: a failed re-parse must leave
         * the previous draft intact, and the published week is in a different
         * document that this route never writes at all.
         */
        const transient = specific === 'unavailable';
        await draftRef.set({
          stageId,
          status: 'failed',
          failureReason: `${specific}${msg ? `: ${msg.slice(0, 200)}` : ''}`,
          ...(transient ? {} : {
            failedPhotoUrl: photoUrl,
            failureCount: admin.firestore.FieldValue.increment(1),
          }),
        }, { merge: true });

        // Only provider-level problems are an operations alert. A sheet this
        // model cannot read is one stage's problem and would be noise.
        if (specific === 'free_tier_limit' || specific === 'not_configured' || specific === 'bad_request') {
          await raiseAlert(specific, { stageId, note: msg.slice(0, 200) });
        }

        console.error('[timetable] parse failed', specific, msg);
        // 503, not 502, when the provider was the thing that was down: it is
        // the one failure here that is worth simply trying again.
        return res
          .status(transient ? 503 : 502)
          .json({ error: specific, detail: msg.slice(0, 200) });
      }
    } catch (e: any) {
      console.error('[timetable] parse failed before the lock', e);
      return res.status(500).json({ error: 'internal' });
    }
  }

  return { parse };
}
