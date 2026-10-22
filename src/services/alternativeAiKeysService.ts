import { auth } from '../lib/firebase';
import { apiUrl } from '../lib/apiBase';
import type { AlternativeKeyDoc } from '../../shared/alternativeKeysApi';

async function authHeaders(): Promise<Record<string, string>> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error('غير مصرح. يرجى تسجيل الدخول مرة أخرى.');
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

export async function fetchAlternativeAiKeys(): Promise<AlternativeKeyDoc[]> {
  const headers = await authHeaders();
  const res = await fetch(apiUrl('/api/admin/ai-keys/list'), { headers });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || data.error || 'فشل تحميل مفاتيح الذكاء الاصطناعي البديلة');
  }
  const data = await res.json();
  return data.keys || [];
}

export async function addAlternativeAiKey(key: string, note?: string): Promise<{ id: string; maskedKey: string; status: string }> {
  const headers = await authHeaders();
  const res = await fetch(apiUrl('/api/admin/ai-keys/add'), {
    method: 'POST',
    headers,
    body: JSON.stringify({ key, note }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || data.error || 'فشل إضافة المفتاح');
  }
  return data;
}

export async function deleteAlternativeAiKey(id: string): Promise<void> {
  const headers = await authHeaders();
  const res = await fetch(apiUrl(`/api/admin/ai-keys/${id}`), {
    method: 'DELETE',
    headers,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || data.error || 'فشل حذف المفتاح');
  }
}

export async function testAlternativeAiKey(id: string): Promise<{ status: 'active' | 'quota_exhausted' | 'invalid' }> {
  const headers = await authHeaders();
  const res = await fetch(apiUrl(`/api/admin/ai-keys/test/${id}`), {
    method: 'POST',
    headers,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || data.error || 'فشل اختبار المفتاح');
  }
  return data;
}
