import React, { useEffect, useMemo, useState } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { Loader2, Search, Check, X, AlertCircle } from 'lucide-react';
import { Language } from '../types';
import { normalizeName } from '../../shared/rosterIdentity';

export interface StudentCandidate {
  /** The students/ document id - what allowed_admins must be keyed by. */
  id: string;
  name: string;
  subgroup: string;
  loginCode: string;
  placeholderEmail: boolean;
  /** False when they have never signed in, so no users doc exists yet. */
  hasAccount: boolean;
}

/**
 * Picks one student out of a stage's roster by name.
 *
 * Appointing a representative used to mean typing their address from memory,
 * which stopped working entirely once students could be imported without one -
 * their id is a random synthetic string nobody could type.
 *
 * Matching folds Arabic the same way login does (shared/rosterIdentity), so
 * searching "احمد" finds "أحمد" and the person appointing does not have to
 * guess which spelling the roster used.
 */
export default function StudentPicker({
  stageId, lang, selected, onSelect,
}: {
  stageId: string;
  lang: Language;
  selected: StudentCandidate | null;
  onSelect: (candidate: StudentCandidate | null) => void;
}) {
  const isRtl = lang === 'ar';
  const [term, setTerm] = useState('');
  const [candidates, setCandidates] = useState<StudentCandidate[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!stageId) { setCandidates([]); return; }
      setLoading(true);
      try {
        const [studentSnap, userSnap] = await Promise.all([
          getDocs(query(collection(db, 'students'), where('stageId', '==', stageId))),
          getDocs(query(collection(db, 'users'), where('stageId', '==', stageId))),
        ]);
        if (cancelled) return;

        // The role is written onto users/{uid}; without that document the
        // appointment sits in allowed_admins doing nothing visible.
        const withAccounts = new Set<string>();
        userSnap.docs.forEach(d => {
          const uData = d.data();
          const email = (uData.email || d.id || '').toLowerCase().trim();
          if (email) withAccounts.add(email);
          withAccounts.add(d.id.toLowerCase().trim());
        });

        const studentCandidatesMap = new Map<string, StudentCandidate>();
        studentSnap.docs.forEach(d => {
          const data = d.data();
          studentCandidatesMap.set(d.id.toLowerCase(), {
            id: d.id,
            name: data.name || d.id,
            subgroup: data.subgroup || '',
            loginCode: data.loginCode || '',
            placeholderEmail: data.placeholderEmail === true,
            hasAccount: withAccounts.has(d.id.toLowerCase()),
          });
        });

        // Also add users who exist in this stage but don't have a record in students collection
        userSnap.docs.forEach(d => {
          const uData = d.data();
          const email = (uData.email || d.id || '').toLowerCase().trim();
          const idLower = d.id.toLowerCase().trim();
          if (!studentCandidatesMap.has(idLower) && (!email || !studentCandidatesMap.has(email))) {
            studentCandidatesMap.set(idLower, {
              id: d.id,
              name: uData.name || d.id,
              subgroup: uData.group || uData.subgroup || '',
              loginCode: uData.loginCode || '',
              placeholderEmail: false,
              hasAccount: true,
            });
          }
        });

        setCandidates(Array.from(studentCandidatesMap.values()));
      } catch (err) {
        console.error('Failed to load the stage roster:', err);
        if (!cancelled) setCandidates([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [stageId]);

  const matches = useMemo(() => {
    const needle = normalizeName(term);
    const termClean = term.trim().toLowerCase();
    if (!termClean) return [];
    return candidates
      .filter(c =>
        (needle && normalizeName(c.name).includes(needle))
        || c.id.toLowerCase().includes(termClean)
        || c.loginCode.toLowerCase().includes(termClean)
      )
      .slice(0, 8);
  }, [term, candidates]);

  if (selected) {
    return (
      <div className="w-full px-4 py-2.5 bg-sky-50 dark:bg-sky-900/20 border border-sky-200 dark:border-sky-800 rounded-xl flex items-center gap-2">
        <Check className="w-4 h-4 text-sky-600 dark:text-sky-400 shrink-0" strokeWidth={3} />
        <div className="flex-1 min-w-0">
          <div className="font-bold text-sm text-slate-800 dark:text-slate-100 truncate">{selected.name}</div>
          <div className="text-[11px] font-bold text-slate-400 truncate" dir="ltr">
            {selected.subgroup || '—'}
            {selected.loginCode ? ` · ${selected.loginCode}` : ''}
            {selected.placeholderEmail ? '' : ` · ${selected.id}`}
          </div>
        </div>
        <button
          type="button"
          onClick={() => { onSelect(null); setTerm(''); }}
          className="p-1.5 rounded-lg hover:bg-sky-100 dark:hover:bg-sky-900/40 shrink-0"
          title={isRtl ? 'تغيير' : 'Change'}
        >
          <X className="w-4 h-4 text-slate-400" />
        </button>
      </div>
    );
  }

  if (!stageId) {
    return (
      <p className="px-4 py-2.5 bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 rounded-xl text-xs font-bold text-slate-400">
        {isRtl ? 'اختر المرحلة أولاً لعرض طلابها.' : 'Pick a stage first to list its students.'}
      </p>
    );
  }

  return (
    <div className="relative">
      <div className="relative">
        <div className="absolute inset-y-0 start-0 ps-3 flex items-center pointer-events-none">
          {loading
            ? <Loader2 className="w-4 h-4 text-slate-400 animate-spin" />
            : <Search className="w-4 h-4 text-slate-400" />}
        </div>
        <input
          type="text"
          value={term}
          onChange={e => setTerm(e.target.value)}
          placeholder={isRtl ? 'ابحث باسم الطالب أو البريد…' : 'Search by student name or email…'}
          className="w-full ps-10 pe-4 py-2.5 bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-900 dark:text-stone-100 rounded-xl focus:ring-2 focus:ring-sky-500 outline-none transition-all"
        />
      </div>

      {term.trim() !== '' && (
        <div className="mt-2 border border-slate-200 dark:border-zinc-700 rounded-xl overflow-hidden max-h-56 overflow-y-auto divide-y divide-slate-100 dark:divide-zinc-800">
          {matches.length === 0 && (
            <p className="px-4 py-3 text-xs font-bold text-slate-400">
              {isRtl ? 'لا يوجد طالب بهذا الاسم في هذه المرحلة.' : 'No student with that name on this stage.'}
            </p>
          )}
          {matches.map(c => (
            <button
              key={c.id}
              type="button"
              disabled={!c.hasAccount}
              onClick={() => { onSelect(c); setTerm(''); }}
              className="w-full px-4 py-2.5 text-start flex items-center gap-2 hover:bg-slate-50 dark:hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <div className="flex-1 min-w-0">
                <div className="font-bold text-sm text-slate-800 dark:text-slate-100 truncate">{c.name}</div>
                <div className="text-[11px] font-bold text-slate-400 truncate" dir="ltr">
                  {c.subgroup || '—'}{c.loginCode ? ` · ${c.loginCode}` : ''}
                </div>
              </div>
              {!c.hasAccount && (
                <span className="shrink-0 text-[10px] font-black text-amber-600 dark:text-amber-500 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" />
                  {isRtl ? 'لم يسجّل الدخول بعد' : 'Never signed in'}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
