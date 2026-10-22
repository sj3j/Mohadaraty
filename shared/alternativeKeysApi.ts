/**
 * Alternative Free Gemini API Keys Pool & Management API.
 *
 * Allows Master Admin (website only) to register community-donated free API keys.
 * When GEMINI_FREE_TIER_API_KEY hits its daily quota, the server automatically
 * iterates through active alternative keys before failing or prompting for paid generation.
 */
import { GoogleGenAI } from '@google/genai';
import { MCQ_MODEL, classifyFailure } from './mcqGeneration.js';

export interface AlternativeKeyDoc {
  id: string;
  maskedKey: string;
  note?: string;
  status: 'active' | 'quota_exhausted' | 'invalid';
  addedAt?: any;
  addedBy?: string;
  lastTestedAt?: any;
  lastQuotaExhaustedAt?: any;
}

export function maskApiKey(key: string): string {
  if (!key || key.length < 8) return '****';
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

export async function testGeminiApiKey(apiKey: string): Promise<{ ok: boolean; status: 'active' | 'quota_exhausted' | 'invalid'; error?: string }> {
  try {
    const ai = new GoogleGenAI({ apiKey });
    await ai.models.generateContent({
      model: MCQ_MODEL,
      contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
    });
    return { ok: true, status: 'active' };
  } catch (err: any) {
    const classified = classifyFailure(err);
    if (classified === 'free_tier_limit') {
      return { ok: false, status: 'quota_exhausted', error: 'quota_exhausted' };
    }
    if (classified === 'not_configured') {
      return { ok: false, status: 'invalid', error: 'invalid_key' };
    }
    return { ok: false, status: 'invalid', error: err?.message || 'unknown_error' };
  }
}

export async function getActiveAlternativeKeys(admin: any): Promise<Array<{ id: string; key: string }>> {
  try {
    const db = admin.firestore();
    const snap = await db.collection('alternativeAiKeys')
      .where('status', 'in', ['active', 'quota_exhausted'])
      .get();

    const docs = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
    // Prioritize active keys over quota_exhausted keys
    docs.sort((a: any, b: any) => {
      if (a.status === 'active' && b.status !== 'active') return -1;
      if (a.status !== 'active' && b.status === 'active') return 1;
      return 0;
    });
    return docs
      .filter((d: any) => d.key && typeof d.key === 'string' && d.status !== 'invalid')
      .map((d: any) => ({ id: d.id, key: d.key }));
  } catch (e) {
    console.warn('[alternativeKeys] failed to fetch active keys', e);
    return [];
  }
}

export async function markAlternativeKeyStatus(
  admin: any,
  keyId: string,
  status: 'active' | 'quota_exhausted' | 'invalid',
) {
  try {
    const db = admin.firestore();
    await db.collection('alternativeAiKeys').doc(keyId).update({
      status,
      lastTestedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...(status === 'quota_exhausted' ? { lastQuotaExhaustedAt: admin.firestore.FieldValue.serverTimestamp() } : {}),
    });
  } catch (e) {
    console.warn('[alternativeKeys] failed to update status', keyId, e);
  }
}

export function createAlternativeKeysHandlers(deps: { admin: any }) {
  const { admin } = deps;

  async function listKeys(_req: any, res: any) {
    const db = admin.firestore();
    try {
      const snap = await db.collection('alternativeAiKeys')
        .orderBy('addedAt', 'desc')
        .get();

      const keys: AlternativeKeyDoc[] = snap.docs.map((d: any) => {
        const data = d.data();
        return {
          id: d.id,
          maskedKey: data.maskedKey || maskApiKey(data.key || ''),
          note: data.note || '',
          status: data.status || 'active',
          addedAt: data.addedAt?.toDate?.()?.toISOString() || null,
          addedBy: data.addedBy || null,
          lastTestedAt: data.lastTestedAt?.toDate?.()?.toISOString() || null,
          lastQuotaExhaustedAt: data.lastQuotaExhaustedAt?.toDate?.()?.toISOString() || null,
        };
      });

      res.json({ ok: true, keys });
    } catch (e: any) {
      console.error('[alternativeKeys] list error', e);
      res.status(500).json({ error: 'failed_to_list_keys' });
    }
  }

  async function addKey(req: any, res: any) {
    const db = admin.firestore();
    const { key, note } = req.body || {};
    if (!key || typeof key !== 'string' || key.trim().length < 20) {
      return res.status(400).json({ error: 'invalid_key_format', message: 'مفتاح API غير صالح' });
    }

    const trimmedKey = key.trim();

    // Verify key against Gemini API
    const testResult = await testGeminiApiKey(trimmedKey);
    if (!testResult.ok && testResult.status === 'invalid') {
      return res.status(400).json({
        error: 'key_verification_failed',
        message: 'المفتاح غير صالح أو ملغى لدى Google AI Studio',
      });
    }

    try {
      const docRef = await db.collection('alternativeAiKeys').add({
        key: trimmedKey,
        maskedKey: maskApiKey(trimmedKey),
        note: String(note || '').trim().slice(0, 200),
        status: testResult.status,
        addedAt: admin.firestore.FieldValue.serverTimestamp(),
        addedBy: req.user?.email || req.user?.uid || 'master_admin',
        lastTestedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      res.json({
        ok: true,
        id: docRef.id,
        maskedKey: maskApiKey(trimmedKey),
        status: testResult.status,
      });
    } catch (e: any) {
      console.error('[alternativeKeys] add error', e);
      res.status(500).json({ error: 'failed_to_save_key' });
    }
  }

  async function deleteKey(req: any, res: any) {
    const db = admin.firestore();
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'missing_id' });

    try {
      await db.collection('alternativeAiKeys').doc(id).delete();
      res.json({ ok: true });
    } catch (e: any) {
      console.error('[alternativeKeys] delete error', e);
      res.status(500).json({ error: 'failed_to_delete_key' });
    }
  }

  async function testKey(req: any, res: any) {
    const db = admin.firestore();
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'missing_id' });

    try {
      const doc = await db.collection('alternativeAiKeys').doc(id).get();
      if (!doc.exists) return res.status(404).json({ error: 'key_not_found' });

      const data = doc.data();
      const testResult = await testGeminiApiKey(data.key);

      await doc.ref.update({
        status: testResult.status,
        lastTestedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      res.json({ ok: true, status: testResult.status });
    } catch (e: any) {
      console.error('[alternativeKeys] test error', e);
      res.status(500).json({ error: 'failed_to_test_key' });
    }
  }

  return { listKeys, addKey, deleteKey, testKey };
}
