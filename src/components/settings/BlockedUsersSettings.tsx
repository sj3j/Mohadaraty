import React, { useEffect, useState } from 'react';
import { collection, documentId, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { Ban, Loader2 } from 'lucide-react';
import { Language, UserProfile } from '../../types';
import { unblockUser } from '../../services/moderationService';

/**
 * The list of people this user has blocked, with an unblock action.
 *
 * Apple 1.2 wants blocking to be reversible from inside the app - blockUser()
 * shipped with the group chat's report sheet, but nothing exposed
 * unblockUser(), which left the action one-way. The chat is gone and its report
 * sheet with it; this screen is what still makes an existing block reversible.
 */
export default function BlockedUsersSettings({ user, lang }: { user: UserProfile | null; lang: Language }) {
  const isRtl = lang === 'ar';
  const [profiles, setProfiles] = useState<{ uid: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const ids = user?.blockedUsers || [];

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (ids.length === 0) { setProfiles([]); setLoading(false); return; }
      setLoading(true);
      try {
        const found: { uid: string; name: string }[] = [];
        // Chunked to respect the 'in' limit.
        for (let i = 0; i < ids.length; i += 10) {
          const chunk = ids.slice(i, i + 10);
          const snap = await getDocs(query(collection(db, 'users'), where(documentId(), 'in', chunk)));
          snap.forEach(d => found.push({ uid: d.id, name: (d.data() as any).name || d.id }));
        }
        // An account that has since been deleted still deserves an unblock row.
        for (const id of ids) {
          if (!found.some(f => f.uid === id)) {
            found.push({ uid: id, name: isRtl ? 'مستخدم محذوف' : 'Deleted user' });
          }
        }
        if (!cancelled) setProfiles(found);
      } catch (err) {
        console.error('Failed to load blocked users:', err);
        if (!cancelled) setProfiles(ids.map(id => ({ uid: id, name: id })));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [ids.join(','), isRtl]);

  const handleUnblock = async (uid: string) => {
    setBusy(uid);
    try {
      await unblockUser(uid);
      setProfiles(prev => prev.filter(p => p.uid !== uid));
    } catch (err) {
      console.error('Unblock failed:', err);
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-sky-500" /></div>;
  }

  if (profiles.length === 0) {
    return (
      <div className="text-center py-12">
        <Ban className="w-12 h-12 text-slate-300 dark:text-zinc-700 mx-auto mb-3" />
        <p className="text-slate-500 dark:text-slate-400 font-bold">
          {isRtl ? 'لم تحظر أي أحد' : 'You have not blocked anyone'}
        </p>
        <p className="text-sm text-slate-400 dark:text-slate-500 mt-1">
          {isRtl
            ? 'يمكنك حظر أي مستخدم من زر الإبلاغ على رسالته.'
            : 'You can block someone from the report button on their message.'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {profiles.map(p => (
        <div key={p.uid} className="flex items-center gap-3 p-3.5 rounded-2xl bg-white dark:bg-zinc-900 border-2 border-slate-100 dark:border-zinc-800">
          <div className="w-9 h-9 rounded-full bg-slate-100 dark:bg-zinc-800 flex items-center justify-center font-bold text-slate-500 shrink-0">
            {p.name.charAt(0).toUpperCase()}
          </div>
          <span className="flex-1 min-w-0 font-bold text-slate-800 dark:text-slate-100 truncate">{p.name}</span>
          <button
            onClick={() => handleUnblock(p.uid)}
            disabled={busy === p.uid}
            className="shrink-0 px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-slate-300 text-xs font-black disabled:opacity-50 flex items-center gap-1.5"
          >
            {busy === p.uid && <Loader2 className="w-3 h-3 animate-spin" />}
            {isRtl ? 'إلغاء الحظر' : 'Unblock'}
          </button>
        </div>
      ))}
    </div>
  );
}
