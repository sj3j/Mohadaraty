/**
 * Simosan's HTTP surface, built once and mounted by both route files.
 *
 * server.ts and api/index.ts have already drifted by 14 routes, and vercel.json
 * sends production /api/* to api/index.ts — so a handler written inline in one
 * of them is a handler that silently never runs somewhere. Exporting a factory
 * means each file mounts these with a single line and the bodies cannot diverge.
 */
import { GoogleGenAI } from '@google/genai';
import {
  MAX_QUESTIONS_PER_CHAT,
  baghdadDayKey,
  baghdadMonthKey,
  baghdadWeekKey,
  estimateUnits,
  freeUsageDocId,
  hasAiAccess,
  msUntilBaghdadReset,
  msUntilBaghdadWeeklyReset,
  readSettings,
  reconcileEnergy,
  reconcileFreeQuestion,
  releaseEnergy,
  releaseFreeQuestion,
  reserveEnergy,
  reserveFreeQuestion,
  settleOffTopic,
  unitsFromUsage,
  unitsToUsd,
  usageDocId,
  type SimosanCtx,
} from './simosan.js';
import { subjectSlugOf, denormalizedSubjectName } from './subjectSlug.js';
import {
  SimosanError,
  buildContents,
  ensureLectureFile,
  extractCitedPages,
  streamAnswer,
  type ChatMessage,
} from './simosanChat.js';
import { serverCache } from './serverCache.js';
import { getSupabaseAdmin } from './supabaseClient.js';
import {
  resolveSupaThread,
  loadSupaHistory,
  recordSupaTurn,
  getClientMessagesFromSupabase,
} from './simosanSupabase.js';

export interface SimosanDeps {
  admin: any;
  /** Server-only. Never VITE_-prefixed: the whole point is that it stays here. */
  apiKey?: string;
}

/** How many past messages are replayed to the model. The per-chat question cap
 *  bounds the thread, this bounds the request when a thread is near full. */
const HISTORY_WINDOW = 20;

export function createSimosanHandlers(deps: SimosanDeps) {
  const { admin } = deps;
  const apiKey = deps.apiKey || process.env.GEMINI_API_KEY;
  const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

  const ctx = (): SimosanCtx => ({
    db: admin.firestore(),
    FieldValue: admin.firestore.FieldValue,
    Timestamp: admin.firestore.Timestamp,
    alert: async (alertName, detail) => {
      const db = admin.firestore();
      // Two channels on purpose: the FCM topic reaches an admin's phone, the
      // Firestore document survives a missed notification. adminAlerts is the
      // precedent MCQ generation already uses for "AI went wrong, tell someone".
      await db.collection('adminAlerts').add({
        type: 'simosan_budget',
        alert: alertName,
        monthUsd: detail.monthUsd,
        ceilingUsd: detail.ceilingUsd,
        month: detail.month,
        resolved: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      try {
        await admin.messaging().send({
          topic: 'admins',
          notification: {
            title: 'Simosan budget',
            body:
              alertName === 'budget_100'
                ? `Monthly ceiling reached ($${detail.ceilingUsd}). Simosan is now disabled.`
                : `Simosan has used $${detail.monthUsd.toFixed(2)} of $${detail.ceilingUsd}.`,
          },
        });
      } catch (e) {
        console.warn('[simosan] FCM alert failed', e);
      }
    },
  });

  /** The caller's own user document is the only source for stage and access. */
  async function loadCaller(db: any, uid: string) {
    const snap = await db.collection('users').doc(uid).get();
    if (!snap.exists) return null;
    const data = snap.data();
    return {
      data,
      stageId: data?.stageId || '',
      isAdmin: data?.role === 'admin' || !!data?.isMasterAdmin,
    };
  }

  async function getCachedLecture(db: any, lectureId: string) {
    const cacheKey = `lecture:${lectureId}`;
    const cached = serverCache.get<any>(cacheKey);
    if (cached) return cached;
    const snap = await db.collection('lectures').doc(lectureId).get();
    if (!snap.exists) return null;
    const data = snap.data();
    serverCache.set(cacheKey, data, 5 * 60 * 1000);
    return data;
  }

  /* ---------------------------------------------------------------- *
   * GET /api/ai/state
   * ---------------------------------------------------------------- */
  async function state(req: any, res: any) {
    try {
      const db = admin.firestore();
      const uid = req.user.uid;
      const caller = await loadCaller(db, uid);
      if (!caller) return res.status(404).json({ error: 'User not found' });

      const settings = await readSettings(ctx());
      const hasAccess = hasAiAccess(caller.data);
      const isFreeTier = !hasAccess;

      let remaining = 0;
      let dailyBudget = settings.dailyUnitBudget;
      let resetsInMs = msUntilBaghdadReset();
      let freeWeeklyRemaining = 0;
      const freeWeeklyResetsInMs = msUntilBaghdadWeeklyReset();

      if (hasAccess) {
        const day = baghdadDayKey();
        const usageSnap = await db.collection('aiUsage').doc(usageDocId(uid, day)).get();
        const u = usageSnap.exists ? usageSnap.data() : null;
        const spent = (Number(u?.unitsUsed) || 0) + (Number(u?.unitsReserved) || 0);
        remaining = Math.max(0, settings.dailyUnitBudget - spent);
      } else {
        const week = baghdadWeekKey();
        const freeSnap = await db.collection('aiUsage').doc(freeUsageDocId(uid, week)).get();
        const fu = freeSnap.exists ? freeSnap.data() : null;
        const freeSpent = (Number(fu?.usedCount) || 0) + (Number(fu?.reservedCount) || 0);
        freeWeeklyRemaining = Math.max(0, 1 - freeSpent);
        remaining = freeWeeklyRemaining;
        dailyBudget = 1;
        resetsInMs = freeWeeklyResetsInMs;
      }

      res.json({
        available: settings.enabled,
        hasAccess,
        enabled: settings.enabled,
        isFreeTier,
        freeWeeklyAllowance: 1,
        freeWeeklyRemaining,
        freeWeeklyResetsInMs,
        remaining,
        dailyBudget,
        resetsInMs,
        maxQuestionsPerChat: hasAccess ? MAX_QUESTIONS_PER_CHAT : 1,
      });
    } catch (e: any) {
      console.error('[simosan] state failed', e);
      res.status(500).json({ error: 'Failed to read state' });
    }
  }

  /* ---------------------------------------------------------------- *
   * POST /api/ai/ask   (SSE)
   * ---------------------------------------------------------------- */
  async function ask(req: any, res: any) {
    const db = admin.firestore();
    const uid = req.user.uid;
    const { lectureId, question, selection, newThread, walkthrough, languageMode, autoQuiz } = req.body || {};

    if (!ai) return res.status(503).json({ error: 'not_configured' });
    if (!lectureId || typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ error: 'lectureId and question are required' });
    }
    if (question.length > 2000) {
      return res.status(400).json({ error: 'question_too_long' });
    }

    let reserved = 0;
    let isFreeReserved = false;
    let streaming = false;

    const fail = (status: number, code: string, extra: any = {}) => {
      if (streaming) {
        res.write(`data: ${JSON.stringify({ type: 'error', code, ...extra })}\n\n`);
        return res.end();
      }
      return res.status(status).json({ error: code, ...extra });
    };

    try {
      const caller = await loadCaller(db, uid);
      if (!caller) return fail(404, 'user_not_found');
      const hasAccess = hasAiAccess(caller.data);
      const isFreeTier = !hasAccess;

      const lecture = await getCachedLecture(db, lectureId);
      if (!lecture) return fail(404, 'lecture_not_found');
      if (!lecture?.pdfUrl) return fail(400, 'lecture_has_no_pdf');

      const settings = await readSettings(ctx());
      if (!settings.enabled) return fail(503, 'disabled');

      // --- thread & history resolution (Supabase with Firestore fallback) -----
      let threadId = '';
      let questionCount = 0;
      let history: ChatMessage[] = [];
      let isSupabaseActive = false;

      const supabase = getSupabaseAdmin();
      if (supabase) {
        const supaThread = await resolveSupaThread(supabase, {
          userId: uid,
          lectureId,
          stageId: caller.stageId,
          isFreeTier,
          forceNew: newThread === true,
        });
        if (supaThread) {
          threadId = supaThread.threadId;
          questionCount = supaThread.questionCount;
          const supaHist = await loadSupaHistory(supabase, threadId, HISTORY_WINDOW);
          if (supaHist !== null) {
            history = supaHist;
            isSupabaseActive = true;
          }
        }
      }

      const lectureRef = db
        .collection('aiChats').doc(uid)
        .collection('lectures').doc(lectureId);
      const threadsRef = lectureRef.collection('threads');
      let msgsRef: any = null;
      const maxChatQuestions = isFreeTier ? 1 : MAX_QUESTIONS_PER_CHAT;

      if (!isSupabaseActive) {
        const lectureDoc = await lectureRef.get();
        threadId = lectureDoc.exists ? lectureDoc.data()?.activeThreadId : '';
        let threadSnap = threadId ? await threadsRef.doc(threadId).get() : null;
        questionCount = threadSnap?.exists ? Number(threadSnap.data()?.questionCount) || 0 : 0;

        const needsNew =
          newThread === true ||
          !threadSnap?.exists ||
          threadSnap.data()?.isReadOnly === true ||
          questionCount >= maxChatQuestions;

        if (needsNew) {
          const fresh = threadsRef.doc();
          await fresh.set({
            stageId: caller.stageId,
            questionCount: 0,
            isReadOnly: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          threadId = fresh.id;
          questionCount = 0;
          threadSnap = await fresh.get();
        }

        msgsRef = threadsRef.doc(threadId).collection('messages');
        const histSnap = await msgsRef.orderBy('createdAt', 'desc').limit(HISTORY_WINDOW).get();
        history = histSnap.docs
          .reverse()
          .map((d: any) => ({ role: d.data().role, text: d.data().text }));
      }

      // --- file + reservation ------------------------------------------------
      const file = await ensureLectureFile(
        ai,
        db,
        admin.firestore.FieldValue,
        lectureId,
        lecture.pdfUrl,
      );

      const historyChars = history.reduce((n, m) => n + m.text.length, 0);
      const estimated = estimateUnits({
        pageCount: file.pageCount,
        historyChars,
        questionChars: question.length + (selection?.length || 0),
      });

      isFreeReserved = false;
      let holdRemaining = 0;
      let holdBudget = settings.dailyUnitBudget;

      if (isFreeTier) {
        const freeHold = await reserveFreeQuestion(ctx(), { uid, stageId: caller.stageId });
        if (!freeHold.ok) {
          return fail(403, freeHold.reason === 'free_weekly_limit_reached' ? 'free_weekly_limit_reached' : (freeHold.reason || 'disabled'), {
            isFreeTier: true,
            remaining: 0,
            resetsInMs: freeHold.resetsInMs,
          });
        }
        isFreeReserved = true;
        holdRemaining = 0;
        holdBudget = 1;
      } else {
        const hold = await reserveEnergy(
          ctx(),
          { uid, stageId: caller.stageId, estimatedUnits: estimated },
        );
        if (!hold.ok) {
          return fail(429, hold.reason as string, {
            remaining: hold.remaining,
            dailyBudget: hold.dailyBudget,
            resetsInMs: hold.resetsInMs,
          });
        }
        reserved = hold.reserved;
        holdRemaining = hold.remaining;
        holdBudget = hold.dailyBudget;
      }

      // --- stream ------------------------------------------------------------
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      // Without this a proxy buffers the whole response and streaming silently
      // degrades to a single delayed blob.
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      streaming = true;

      res.write(
        `data: ${JSON.stringify({
          type: 'meta',
          threadId,
          questionNumber: questionCount + 1,
          maxQuestions: maxChatQuestions,
          remaining: holdRemaining,
          dailyBudget: holdBudget,
          isFreeTier,
        })}\n\n`,
      );

      // First name only: warmth at a fraction of the exposure, and a stable
      // string so it does not disturb the cache the way a varying one would.
      const firstName = String(caller.data?.name || '').trim().split(/[ 	]+/)[0] || undefined;

      // The denormalized name on the lecture answers this without a read. The
      // fallback read is keyed `${stageId}__${slug}` because that is the
      // document id migrateToStages.js writes - the bare slug is the `id` FIELD,
      // so looking the bare slug up as a document id never matched anything.
      const subjectId = subjectSlugOf(lecture);
      let subjectName: string | undefined = subjectId ? denormalizedSubjectName(lecture) : undefined;
      if (subjectId && subjectName === subjectId && lecture.stageId) {
        try {
          const subj = await db.collection('subjects').doc(`${lecture.stageId}__${subjectId}`).get();
          if (subj.exists) subjectName = subj.data()?.nameAr || subj.data()?.nameEn || subjectId;
        } catch { subjectName = subjectId; }
      }

      const turnCtx = {
        studentName: firstName,
        subjectName,
        walkthrough: walkthrough === true,
        languageMode: (languageMode === 'en' || languageMode === 'bilingual') ? languageMode : 'ar',
        autoQuiz: autoQuiz !== false,
      };
      let answer = '';
      const onDelta = (delta: string) => {
        answer += delta;
        res.write(`data: ${JSON.stringify({ type: 'delta', text: delta })}

`);
      };

      /*
       * Files API expiry failsafe.
       *
       * ensureLectureFile refreshes on a 44h clock, which trusts the cached
       * uploadedAtMs. Google can delete a file earlier than that, and the
       * cached URI then 403s and the student gets nothing. Drop the stale row,
       * re-upload, and retry ONCE.
       *
       * The reservation is deliberately still held across the retry - it is the
       * same logical question, and releasing then re-reserving would let a
       * parallel request slip into the gap. Only a second failure gives up, and
       * the outer catch releases the hold in full.
       *
       * Retried only if nothing has streamed yet: once bytes are on the wire
       * the student is already reading an answer, and starting a second one
       * would splice two replies together.
       */
      let usage: any, offTopic = false;
      try {
        const contents = buildContents(file.fileUri, history, question.trim(), selection, turnCtx);
        ({ usage, offTopic } = await streamAnswer(ai, settings.model, contents, onDelta));
      } catch (streamErr: any) {
        const raw = String(streamErr?.message || '');
        const expired = /not found|PERMISSION_DENIED|403|404/i.test(raw) && /file/i.test(raw);
        if (!expired || answer.length > 0) throw streamErr;

        console.warn('[simosan] file URI stale, re-uploading', lectureId);
        await db.collection('aiFiles').doc(lectureId).delete().catch(() => {});
        const rebuilt = await ensureLectureFile(
          ai, db, admin.firestore.FieldValue, lectureId, lecture.pdfUrl,
        );
        const retry = buildContents(rebuilt.fileUri, history, question.trim(), selection, turnCtx);
        ({ usage, offTopic } = await streamAnswer(ai, settings.model, retry, onDelta));
      }

      // --- settle ------------------------------------------------------------
      const actual = unitsFromUsage(usage) || estimated;
      let remaining: number;
      let refunded = false;

      if (isFreeTier) {
        if (offTopic) {
          await releaseFreeQuestion(ctx(), { uid });
          remaining = 1;
          refunded = true;
        } else {
          await reconcileFreeQuestion(ctx(), { uid, actualUnits: actual });
          remaining = 0;
          refunded = false;
        }
        isFreeReserved = false;
      } else {
        if (offTopic) {
          const settled = await settleOffTopic(ctx(), {
            uid,
            reservedUnits: reserved,
            actualUnits: actual,
          });
          remaining = settled.remaining;
          refunded = settled.refunded;
        } else {
          const settled = await reconcileEnergy(ctx(), {
            uid,
            reservedUnits: reserved,
            actualUnits: actual,
          });
          remaining = settled.remaining;
        }
        reserved = 0;
      }

      // An off-topic refusal is not part of the student's study thread, so it
      // is neither stored nor counted against the chat cap.
      const citedPages = extractCitedPages(answer);
      if (!offTopic) {
        if (isSupabaseActive && supabase) {
          await recordSupaTurn(supabase, {
            threadId,
            userId: uid,
            lectureId,
            stageId: caller.stageId,
            question: question.trim(),
            selection,
            answer,
            citedPages,
            isFreeTier,
            currentQuestionCount: questionCount,
          });
        } else {
          const now = admin.firestore.FieldValue.serverTimestamp();
          const batch = db.batch();
          const targetMsgsRef = msgsRef || threadsRef.doc(threadId).collection('messages');
          batch.set(targetMsgsRef.doc(), {
            role: 'user',
            text: question.trim(),
            selection: selection?.slice(0, 4000) || null,
            createdAt: now,
          });
          batch.set(targetMsgsRef.doc(), {
            role: 'model',
            text: answer,
            citedPages,
            units: actual,
            createdAt: now,
          });
          const nextCount = questionCount + 1;
          const chatLimit = isFreeTier ? 1 : MAX_QUESTIONS_PER_CHAT;
          batch.set(
            threadsRef.doc(threadId),
            {
              questionCount: nextCount,
              isReadOnly: nextCount >= chatLimit,
              stageId: caller.stageId,
              updatedAt: now,
            },
            { merge: true },
          );
          batch.set(
            lectureRef,
            { activeThreadId: threadId, stageId: caller.stageId, updatedAt: now },
            { merge: true },
          );
          await batch.commit();
        }
      }

      res.write(
        `data: ${JSON.stringify({
          type: 'done',
          threadId,
          offTopic,
          refunded,
          citedPages,
          remaining,
          questionNumber: offTopic ? questionCount : questionCount + 1,
          isReadOnly: !offTopic && questionCount + 1 >= (isFreeTier ? 1 : MAX_QUESTIONS_PER_CHAT),
          isFreeTier,
        })}\n\n`,
      );
      res.end();
    } catch (e: any) {
      console.error('[simosan] ask failed', e);
      // Any path that did not produce an answer hands the energy or free question back.
      // A student must never lose budget to an outage on our side.
      if (reserved > 0) {
        try {
          await releaseEnergy(ctx(), { uid, reservedUnits: reserved });
        } catch (releaseErr) {
          console.error('[simosan] release failed', releaseErr);
        }
      }
      if (isFreeReserved) {
        try {
          await releaseFreeQuestion(ctx(), { uid });
        } catch (releaseErr) {
          console.error('[simosan] release free question failed', releaseErr);
        }
      }
      // A quota/auth failure at the provider is an outage, not a bad request:
      // it hits every student at once and nobody would otherwise find out. The
      // student is told nothing about keys, vendors or billing.
      const raw = String(e?.message || '');
      const quota =
        e?.status === 429 ||
        raw.includes('429') ||
        raw.includes('RESOURCE_EXHAUSTED') ||
        raw.toLowerCase().includes('quota') ||
        raw.includes('API key not valid') ||
        raw.includes('API_KEY_INVALID');

      if (quota) {
        try {
          await admin.firestore().collection('adminAlerts').add({
            type: 'ai_quota_exhausted',
            reason: raw.includes('API') && raw.includes('key') ? 'not_configured' : 'quota',
            source: 'simosan',
            lectureId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            resolved: false,
          });
        } catch (alertErr) {
          console.warn('[simosan] could not raise admin alert', alertErr);
        }
      }

      const code = quota
        ? 'ai_unavailable'
        : (e instanceof SimosanError ? e.code : 'internal');
      fail(quota ? 503 : 500, code);
    }
  }

  /* ---------------------------------------------------------------- *
   * GET /api/ai/admin/stats
   * ---------------------------------------------------------------- */
  async function adminStats(_req: any, res: any) {
    try {
      const db = admin.firestore();
      const settings = await readSettings(ctx());
      const day = baghdadDayKey();

      const todaySnap = await db
        .collection('aiUsage')
        .where('day', '==', day)
        .orderBy('unitsUsed', 'desc')
        .limit(20)
        .get();

      const top = todaySnap.docs.map((d: any) => {
        const u = d.data();
        return {
          uid: u.uid,
          stageId: u.stageId || '',
          unitsUsed: Number(u.unitsUsed) || 0,
          requestCount: Number(u.requestCount) || 0,
          usd: unitsToUsd(Number(u.unitsUsed) || 0),
        };
      });

      const todayUnits = top.reduce((n, r) => n + r.unitsUsed, 0);

      res.json({
        month: baghdadMonthKey(),
        monthUsd: settings.monthUsd,
        ceilingUsd: settings.monthlyCeilingUsd,
        enabled: settings.enabled,
        model: settings.model,
        dailyUnitBudget: settings.dailyUnitBudget,
        todayUnits,
        todayUsd: unitsToUsd(todayUnits),
        activeUsersToday: top.length,
        top,
      });
    } catch (e: any) {
      console.error('[simosan] adminStats failed', e);
      res.status(500).json({ error: 'Failed to read stats' });
    }
  }

  /* ---------------------------------------------------------------- *
   * PATCH /api/ai/admin/settings
   * ---------------------------------------------------------------- */
  async function adminSettings(req: any, res: any) {
    try {
      const db = admin.firestore();
      const { enabled, dailyUnitBudget, monthlyCeilingUsd, model } = req.body || {};
      const patch: any = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };

      if (typeof enabled === 'boolean') {
        patch.enabled = enabled;
        // Re-enabling after the ceiling tripped would otherwise be undone by
        // the next reconcile, which re-evaluates the same threshold.
        if (enabled) patch.alertsSent = [];
      }
      if (Number(dailyUnitBudget) > 0) patch.dailyUnitBudget = Number(dailyUnitBudget);
      if (Number(monthlyCeilingUsd) > 0) patch.monthlyCeilingUsd = Number(monthlyCeilingUsd);
      if (typeof model === 'string' && model.trim()) patch.model = model.trim();

      await db.collection('app_settings').doc('simosan').set(patch, { merge: true });
      serverCache.delete('simosan:settings');
      res.json({ ok: true, settings: await readSettings(ctx(), new Date(), true) });
    } catch (e: any) {
      console.error('[simosan] adminSettings failed', e);
      res.status(500).json({ error: 'Failed to update settings' });
    }
  }

  /* ---------------------------------------------------------------- *
   * GET /api/ai/history
   * ---------------------------------------------------------------- */
  async function history(req: any, res: any) {
    try {
      const uid = req.user.uid;
      const lectureId = String(req.query.lectureId || '');
      if (!lectureId) return res.status(400).json({ error: 'lectureId is required' });

      const supabase = getSupabaseAdmin();
      if (supabase) {
        const supaResult = await getClientMessagesFromSupabase(supabase, { userId: uid, lectureId });
        if (supaResult && supaResult.threadId) {
          return res.json({
            threadId: supaResult.threadId,
            messages: supaResult.messages,
          });
        }
      }

      // Fallback to Firestore
      const db = admin.firestore();
      const lectureRef = db.collection('aiChats').doc(uid).collection('lectures').doc(lectureId);
      const lectureDoc = await lectureRef.get();
      const activeThreadId = lectureDoc.exists ? lectureDoc.data()?.activeThreadId : '';
      if (!activeThreadId) {
        return res.json({ threadId: '', messages: [] });
      }

      const msgsSnap = await lectureRef
        .collection('threads')
        .doc(activeThreadId)
        .collection('messages')
        .orderBy('createdAt', 'asc')
        .limit(60)
        .get();

      const messages = msgsSnap.docs.map((d: any) => ({
        id: d.id,
        role: d.data().role,
        text: d.data().text || '',
        citedPages: d.data().citedPages || [],
        selection: d.data().selection ?? null,
      }));

      res.json({ threadId: activeThreadId, messages });
    } catch (err: any) {
      console.error('[simosan] history failed', err);
      res.status(500).json({ error: 'Failed to load history' });
    }
  }

  return { ask, state, adminStats, adminSettings, history };
}
