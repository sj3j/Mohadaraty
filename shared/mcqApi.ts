/**
 * MCQ generation's HTTP surface, built once and mounted by both route files.
 *
 * Same factory shape as shared/simosanApi.ts and for the same reason:
 * vercel.json sends production /api/* to api/index.ts while npm run dev runs
 * server.ts, and the two have already drifted by 14 routes.
 */
import { GoogleGenAI } from '@google/genai';
import {
  GENERATION_LOCK_MS,
  MAX_GENERATION_FAILURES,
  MAX_INLINE_PDF_BYTES,
  MCQ_MODEL,
  MCQ_RESPONSE_SCHEMA,
  MCQ_SYSTEM_PROMPT,
  BANK_EXTRACTION_PROMPT,
  BANK_EXTRACTION_SCHEMA,
  QUESTION_EDIT_SCHEMA,
  buildQuestionEditPrompt,
  classifyFailure,
  smartShuffleChoices,
  validateQuestions,
  type McqFailureReason,
} from './mcqGeneration.js';

export interface McqDeps {
  admin: any;
  /** Free-tier key, server-only. Separate from Simosan's paid GEMINI_API_KEY. */
  apiKey?: string;
}

export function createMcqHandlers(deps: McqDeps) {
  const { admin } = deps;
  const apiKey = deps.apiKey || process.env.GEMINI_FREE_TIER_API_KEY;
  const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

  async function raiseAlert(
    reason: McqFailureReason,
    detail: { lectureId: string; lectureTitle?: string; note?: string },
  ) {
    const db = admin.firestore();
    try {
      await db.collection('adminAlerts').add({
        type: 'ai_quota_exhausted',
        reason,
        source: 'mcq',
        lectureId: detail.lectureId,
        lectureTitle: detail.lectureTitle || null,
        note: detail.note || null,
        resolved: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.warn('[mcq] could not write adminAlerts', e);
    }

    // The remedies are completely different, so the push must say which it is.
    const body =
      reason === 'free_tier_limit'
        ? 'Free-tier daily limit reached. Generation resumes after the quota resets.'
        : reason === 'not_configured'
          ? 'GEMINI_FREE_TIER_API_KEY is missing or invalid.'
          : reason === 'bad_request'
            // Neither the key nor the quota - waiting or re-keying fixes nothing
            // here, so the alert has to say so or it reads as the one above.
            ? 'Gemini rejected the request itself (model, config or response schema). Needs a code fix, not a key or a quota.'
            : `MCQ generation failed (${reason}).`;
    try {
      await admin.messaging().send({
        topic: 'admins',
        notification: { title: 'MCQ generation', body },
      });
    } catch (e) {
      console.warn('[mcq] FCM alert failed', e);
    }
  }

  /* ---------------------------------------------------------------- *
   * POST /api/mcq/generate   (staff only)
   * ---------------------------------------------------------------- */
  async function generate(req: any, res: any) {
    const db = admin.firestore();
    const { lectureId } = req.body || {};
    if (!lectureId) return res.status(400).json({ error: 'lectureId is required' });
    if (!ai) {
      await raiseAlert('not_configured', { lectureId });
      return res.status(503).json({ error: 'not_configured' });
    }

    const mcqRef = db.collection('mcqs').doc(lectureId);

    try {
      // The client sends an id, never a URL. Vercel caps request bodies near
      // 4.5MB so a base64 PDF could not be posted anyway - but the deciding
      // reason is that accepting a caller-supplied URL would let anyone make
      // this server fetch arbitrary hosts. Resolve it from Firestore instead.
      const lectureSnap = await db.collection('lectures').doc(lectureId).get();
      if (!lectureSnap.exists) return res.status(404).json({ error: 'lecture_not_found' });
      const lecture = lectureSnap.data();
      if (!lecture?.pdfUrl) return res.status(400).json({ error: 'lecture_has_no_pdf' });
      if (lecture.version === 'translated') {
        // A translation is raw source material; generating exam questions from
        // it is unsound. Both client callers already refused - keep the rule
        // where it cannot be lost to a UI edit.
        return res.status(400).json({ error: 'translated_lecture' });
      }

      const existing = await mcqRef.get();
      const data = existing.exists ? existing.data() : null;

      if (data?.status === 'ready' && Array.isArray(data.questions) && data.questions.length) {
        return res.json({ ok: true, alreadyReady: true, count: data.questions.length });
      }
      if ((Number(data?.failureCount) || 0) >= MAX_GENERATION_FAILURES) {
        return res.status(409).json({ error: 'too_many_failures' });
      }

      /*
       * Serialisation lock.
       *
       * Vercel invocations share no process, so an in-memory queue would
       * serialise nothing. The lock has to be a document every invocation can
       * see. Two things are guarded here: the same lecture being generated
       * twice, and several lectures generating at once - the latter matters
       * because a bulk upload would otherwise fire N concurrent requests at a
       * free-tier key and collect N rate-limit failures instead of N successes.
       */
      const now = Date.now();
      const fresh = (t: any) => {
        const ms = t?.toMillis ? t.toMillis() : 0;
        return ms > 0 && now - ms < GENERATION_LOCK_MS;
      };
      if (data?.status === 'generating' && fresh(data.startedAt)) {
        return res.status(409).json({ error: 'already_generating' });
      }
      const busy = await db.collection('mcqs')
        .where('status', '==', 'generating')
        .limit(5).get();
      const someoneElse = busy.docs.some((d: any) => d.id !== lectureId && fresh(d.data()?.startedAt));
      if (someoneElse) return res.status(429).json({ error: 'queue_busy' });

      await mcqRef.set(
        {
          lectureId,
          subjectId: lecture.subjectId || lecture.category || '',
          stageId: lecture.stageId || '',
          status: 'generating',
          startedAt: admin.firestore.FieldValue.serverTimestamp(),
          totalQuestions: 0,
        },
        { merge: true },
      );

      // Downloaded here, not uploaded by the client. Inline rather than the
      // Files API because generation is one call per lecture, ever - a cache
      // that is never read twice is an extra round trip, and Simosan's files
      // live in a different project (paid key) so they are unreachable anyway.
      const pdfRes = await fetch(lecture.pdfUrl);
      if (!pdfRes.ok) throw new Error(`pdf_unreachable:${pdfRes.status}`);
      const buf = Buffer.from(await pdfRes.arrayBuffer());
      if (buf.length > MAX_INLINE_PDF_BYTES) throw new Error('pdf_too_large');

      const response = await ai.models.generateContent({
        model: MCQ_MODEL,
        contents: [{
          role: 'user',
          parts: [
            // application/pdf, not extracted text: scanned and image-only
            // slides have no text layer, and Gemini reads the pages visually.
            { inlineData: { data: buf.toString('base64'), mimeType: 'application/pdf' } },
            { text: MCQ_SYSTEM_PROMPT },
          ],
        }],
        config: {
          responseMimeType: 'application/json',
          responseSchema: MCQ_RESPONSE_SCHEMA as any,
        },
      });

      // `text` is a getter on GenerateContentResponse, not a method.
      const parsed = JSON.parse(response.text || '{}');
      // Destructured rather than narrowed through `valid.ok`: tsconfig sets no
      // strictNullChecks, so discriminated-union narrowing is unreliable here.
      const valid = validateQuestions(parsed) as { ok: boolean; questions?: any[]; reason?: string };
      if (!valid.ok) throw new Error(`invalid_response:${valid.reason}`);

      const questions = (valid.questions || []).map(smartShuffleChoices).map((q: any, i: number) => ({
        ...q,
        id: `q_${lectureId}_${i}_${Date.now()}`,
        addedBy: 'ai',
        createdAt: new Date().toISOString(),
      }));

      await mcqRef.set({
        lectureId,
        subjectId: lecture.subjectId || lecture.category || '',
        stageId: lecture.stageId || '',
        questions,
        generatedAt: admin.firestore.FieldValue.serverTimestamp(),
        generatedBy: 'gemini-ai',
        status: 'ready',
        totalQuestions: questions.length,
        failureCount: 0,
        failureReason: admin.firestore.FieldValue.delete(),
      }, { merge: true });

      res.json({ ok: true, count: questions.length });
    } catch (e: any) {
      const reason = classifyFailure(e);
      const msg = String(e?.message || '');
      const specific: McqFailureReason =
        msg.startsWith('pdf_unreachable') ? 'pdf_unreachable'
        : msg === 'pdf_too_large' ? 'pdf_too_large'
        : msg.startsWith('invalid_response') ? 'invalid_response'
        : reason;

      console.error('[mcq] generation failed', lectureId, msg);
      try {
        await mcqRef.set({
          status: 'failed',
          failureReason: specific,
          failureCount: admin.firestore.FieldValue.increment(1),
        }, { merge: true });
      } catch (writeErr) {
        console.warn('[mcq] could not record failure', writeErr);
      }

      // Only provider-level problems are an operations alert. A malformed PDF
      // is one lecture's problem and would just be noise at scale.
      if (specific === 'free_tier_limit' || specific === 'not_configured' || specific === 'bad_request') {
        await raiseAlert(specific, { lectureId, note: msg.slice(0, 200) });
      }
      res.status(500).json({ error: specific });
    }
  }

  /* ---------------------------------------------------------------- *
   * POST /api/mcq/request   (any student)
   * ---------------------------------------------------------------- */
  async function request(req: any, res: any) {
    const db = admin.firestore();
    const uid = req.user.uid;
    const { lectureId } = req.body || {};
    if (!lectureId) return res.status(400).json({ error: 'lectureId is required' });

    try {
      const [lectureSnap, userSnap, mcqSnap] = await Promise.all([
        db.collection('lectures').doc(lectureId).get(),
        db.collection('users').doc(uid).get(),
        db.collection('mcqs').doc(lectureId).get(),
      ]);
      if (!lectureSnap.exists) return res.status(404).json({ error: 'lecture_not_found' });
      if (mcqSnap.exists && mcqSnap.data()?.status === 'ready') {
        return res.json({ ok: true, alreadyReady: true });
      }

      const lecture = lectureSnap.data();
      const user = userSnap.exists ? userSnap.data() : null;
      const subjectId = lecture?.subjectId || lecture?.category || '';

      // Resolve the subject's display name so staff can act on the notification
      // without opening the app and looking up a slug.
      let subjectName = subjectId;
      if (subjectId) {
        try {
          const s = await db.collection('subjects').doc(subjectId).get();
          if (s.exists) subjectName = s.data()?.name || s.data()?.nameAr || subjectId;
        } catch { /* slug is an acceptable fallback */ }
      }

      const requestRef = db.collection('mcqRequests').doc(`${lectureId}_${uid}`);
      if ((await requestRef.get()).exists) {
        return res.json({ ok: true, alreadyRequested: true });
      }
      await requestRef.set({
        lectureId,
        lectureTitle: lecture?.title || '',
        subjectId,
        subjectName,
        stageId: lecture?.stageId || '',
        requestedBy: uid,
        requestedByName: user?.name || '',
        resolved: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Staff need stage, subject and lecture in the message itself.
      const label = [lecture?.stageId, subjectName, lecture?.title]
        .filter(Boolean).join(' — ');
      const staff = await db.collection('users')
        .where('role', 'in', ['admin', 'moderator'])
        .limit(50).get();

      const batch = db.batch();
      staff.docs.forEach((d: any) => {
        const s = d.data();
        // Support and master admins only; a stage rep is notified for content
        // on the stage they actually manage.
        const scoped = s.isMasterAdmin || !s.managedStageId || s.managedStageId === lecture?.stageId;
        if (!scoped) return;
        batch.set(db.collection('systemNotifications').doc(), {
          userId: d.id,
          title: 'طلب توليد أسئلة',
          body: label,
          type: 'mcq_request',
          lectureId,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          read: false,
        });
      });
      await batch.commit();

      try {
        await admin.messaging().send({
          topic: 'admins',
          notification: { title: 'طلب توليد أسئلة', body: label },
        });
      } catch { /* the inbox rows above are the durable channel */ }

      res.json({ ok: true });
    } catch (e: any) {
      console.error('[mcq] request failed', e);
      res.status(500).json({ error: 'internal' });
    }
  }

  /* ---------------------------------------------------------------- *
   * POST /api/mcq/extract   (staff only) - question bank PDF import
   * ---------------------------------------------------------------- */
  /**
   * Takes a Cloud Storage PATH, never a URL and never the bytes.
   *
   * Not the bytes, because Vercel caps request bodies near 4.5MB and these are
   * scanned exam papers that routinely exceed it - the old client-side flow
   * base64'd up to 20MB in the browser, which only worked because it called
   * Gemini directly.
   *
   * Not a URL, because the server would then fetch whatever it was handed.
   * A path is resolved against this project's own bucket through the Admin SDK,
   * so there is nothing else it can reach.
   */
  async function extract(req: any, res: any) {
    const { storagePath } = req.body || {};
    if (!storagePath || typeof storagePath !== 'string') {
      return res.status(400).json({ error: 'storagePath is required' });
    }
    if (storagePath.includes('..')) return res.status(400).json({ error: 'bad_path' });
    if (!ai) return res.status(503).json({ error: 'not_configured' });

    try {
      const file = admin.storage().bucket().file(storagePath);
      const [exists] = await file.exists();
      if (!exists) return res.status(404).json({ error: 'file_not_found' });

      const [buf] = await file.download();
      if (buf.length > MAX_INLINE_PDF_BYTES) return res.status(413).json({ error: 'pdf_too_large' });

      const response = await ai.models.generateContent({
        model: MCQ_MODEL,
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { data: buf.toString('base64'), mimeType: 'application/pdf' } },
            { text: BANK_EXTRACTION_PROMPT },
          ],
        }],
        config: {
          responseMimeType: 'application/json',
          responseSchema: BANK_EXTRACTION_SCHEMA as any,
        },
      });

      const parsed = JSON.parse(response.text || '{}');
      res.json({ ok: true, questions: Array.isArray(parsed.questions) ? parsed.questions : [] });
    } catch (e: any) {
      const reason = classifyFailure(e);
      console.error('[mcq] extract failed', String(e?.message || e).slice(0, 200));
      if (reason === 'free_tier_limit' || reason === 'not_configured' || reason === 'bad_request') {
        await raiseAlert(reason, { lectureId: '(bank import)' });
      }
      res.status(500).json({ error: reason });
    }
  }

  /* ---------------------------------------------------------------- *
   * POST /api/mcq/modify   (staff only) - AI edit of one question
   * ---------------------------------------------------------------- */
  async function modify(req: any, res: any) {
    const db = admin.firestore();
    const { question, prompt, lectureId } = req.body || {};
    if (!question || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'question and prompt are required' });
    }
    if (!ai) return res.status(503).json({ error: 'not_configured' });

    try {
      const parts: any[] = [];

      // lectureId, not pdfUrl - same SSRF reasoning as /generate. Grounding is
      // optional here: the caller decides whether the edit needs the lecture.
      if (lectureId) {
        const snap = await db.collection('lectures').doc(lectureId).get();
        const url = snap.exists ? snap.data()?.pdfUrl : null;
        if (url) {
          try {
            const r = await fetch(url);
            if (r.ok) {
              const buf = Buffer.from(await r.arrayBuffer());
              if (buf.length <= MAX_INLINE_PDF_BYTES) {
                parts.push({ inlineData: { data: buf.toString('base64'), mimeType: 'application/pdf' } });
              }
            }
          } catch {
            // An edit without the lecture attached is degraded, not broken.
          }
        }
      }

      parts.push({ text: buildQuestionEditPrompt(question, prompt) });

      const response = await ai.models.generateContent({
        model: MCQ_MODEL,
        contents: [{ role: 'user', parts }],
        config: {
          responseMimeType: 'application/json',
          responseSchema: QUESTION_EDIT_SCHEMA as any,
        },
      });

      const updated = JSON.parse(response.text || '{}');
      // The id is ours, not the model's.
      updated.id = question.id;
      res.json({ ok: true, question: updated });
    } catch (e: any) {
      const reason = classifyFailure(e);
      console.error('[mcq] modify failed', String(e?.message || e).slice(0, 200));
      res.status(500).json({ error: reason });
    }
  }

  return { generate, request, extract, modify };
}
