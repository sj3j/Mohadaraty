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
  estimateUnits,
  hasAiAccess,
  msUntilBaghdadReset,
  readSettings,
  reconcileEnergy,
  releaseEnergy,
  reserveEnergy,
  settleOffTopic,
  unitsFromUsage,
  unitsToUsd,
  usageDocId,
  type SimosanCtx,
} from './simosan.js';
import {
  SimosanError,
  buildContents,
  ensureLectureFile,
  extractCitedPages,
  streamAnswer,
  type ChatMessage,
} from './simosanChat.js';

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
      const day = baghdadDayKey();
      const usageSnap = await db.collection('aiUsage').doc(usageDocId(uid, day)).get();
      const u = usageSnap.exists ? usageSnap.data() : null;
      const spent = (Number(u?.unitsUsed) || 0) + (Number(u?.unitsReserved) || 0);

      res.json({
        available: hasAiAccess(caller.data) && settings.enabled,
        hasAccess: hasAiAccess(caller.data),
        enabled: settings.enabled,
        remaining: Math.max(0, settings.dailyUnitBudget - spent),
        dailyBudget: settings.dailyUnitBudget,
        resetsInMs: msUntilBaghdadReset(),
        maxQuestionsPerChat: MAX_QUESTIONS_PER_CHAT,
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
    const { lectureId, question, selection, newThread } = req.body || {};

    if (!ai) return res.status(503).json({ error: 'not_configured' });
    if (!lectureId || typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ error: 'lectureId and question are required' });
    }
    if (question.length > 2000) {
      return res.status(400).json({ error: 'question_too_long' });
    }

    let reserved = 0;
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
      // Access is decided here, from the user document, and never from anything
      // the client sent. The client's own gate only decides what to render.
      if (!hasAiAccess(caller.data)) return fail(403, 'not_subscribed');

      const lectureSnap = await db.collection('lectures').doc(lectureId).get();
      if (!lectureSnap.exists) return fail(404, 'lecture_not_found');
      const lecture = lectureSnap.data();
      if (!lecture?.pdfUrl) return fail(400, 'lecture_has_no_pdf');

      const settings = await readSettings(ctx());
      if (!settings.enabled) return fail(503, 'disabled');

      // --- thread resolution -------------------------------------------------
      const lectureRef = db
        .collection('aiChats').doc(uid)
        .collection('lectures').doc(lectureId);
      const threadsRef = lectureRef.collection('threads');

      const lectureDoc = await lectureRef.get();
      let threadId: string = lectureDoc.exists ? lectureDoc.data()?.activeThreadId : '';
      let threadSnap = threadId ? await threadsRef.doc(threadId).get() : null;
      let questionCount = threadSnap?.exists ? Number(threadSnap.data()?.questionCount) || 0 : 0;

      const needsNew =
        newThread === true ||
        !threadSnap?.exists ||
        threadSnap.data()?.isReadOnly === true ||
        questionCount >= MAX_QUESTIONS_PER_CHAT;

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

      // --- history -----------------------------------------------------------
      const msgsRef = threadsRef.doc(threadId).collection('messages');
      const histSnap = await msgsRef.orderBy('createdAt', 'desc').limit(HISTORY_WINDOW).get();
      const history: ChatMessage[] = histSnap.docs
        .reverse()
        .map((d: any) => ({ role: d.data().role, text: d.data().text }));

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
          maxQuestions: MAX_QUESTIONS_PER_CHAT,
          remaining: hold.remaining,
          dailyBudget: hold.dailyBudget,
        })}\n\n`,
      );

      const contents = buildContents(file.fileUri, history, question.trim(), selection);
      let answer = '';
      const { usage, offTopic } = await streamAnswer(ai, settings.model, contents, (delta) => {
        answer += delta;
        res.write(`data: ${JSON.stringify({ type: 'delta', text: delta })}\n\n`);
      });

      // --- settle ------------------------------------------------------------
      const actual = unitsFromUsage(usage) || estimated;
      let remaining: number;
      let refunded = false;

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

      // An off-topic refusal is not part of the student's study thread, so it
      // is neither stored nor counted against the 25.
      const citedPages = extractCitedPages(answer);
      if (!offTopic) {
        const now = admin.firestore.FieldValue.serverTimestamp();
        const batch = db.batch();
        batch.set(msgsRef.doc(), {
          role: 'user',
          text: question.trim(),
          selection: selection?.slice(0, 4000) || null,
          createdAt: now,
        });
        batch.set(msgsRef.doc(), {
          role: 'model',
          text: answer,
          citedPages,
          units: actual,
          createdAt: now,
        });
        const nextCount = questionCount + 1;
        batch.set(
          threadsRef.doc(threadId),
          {
            questionCount: nextCount,
            isReadOnly: nextCount >= MAX_QUESTIONS_PER_CHAT,
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

      res.write(
        `data: ${JSON.stringify({
          type: 'done',
          threadId,
          offTopic,
          refunded,
          citedPages,
          remaining,
          questionNumber: offTopic ? questionCount : questionCount + 1,
          isReadOnly: !offTopic && questionCount + 1 >= MAX_QUESTIONS_PER_CHAT,
        })}\n\n`,
      );
      res.end();
    } catch (e: any) {
      console.error('[simosan] ask failed', e);
      // Any path that did not produce an answer hands the energy back. A
      // student must never lose budget to an outage on our side.
      if (reserved > 0) {
        try {
          await releaseEnergy(ctx(), { uid, reservedUnits: reserved });
        } catch (releaseErr) {
          console.error('[simosan] release failed', releaseErr);
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
      res.json({ ok: true, settings: await readSettings(ctx()) });
    } catch (e: any) {
      console.error('[simosan] adminSettings failed', e);
      res.status(500).json({ error: 'Failed to update settings' });
    }
  }

  return { ask, state, adminStats, adminSettings };
}
