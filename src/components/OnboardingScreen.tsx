import React, { useState } from 'react';
import { db } from '../lib/firebase';
import { doc, updateDoc, setDoc } from 'firebase/firestore';
import { Language, TRANSLATIONS, UserProfile } from '../types';
import { Loader2, UserCheck } from 'lucide-react';
import { useStageContext } from '../contexts/StageContext';

interface OnboardingScreenProps {
  user: UserProfile;
  lang: Language;
}

export default function OnboardingScreen({ user, lang }: OnboardingScreenProps) {
  const t = TRANSLATIONS[lang];
  const isRtl = lang === 'ar';
  
  const [group, setGroup] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // Offer only the subgroups the representative configured for this student's
  // stage, instead of letting them type anything into the field.
  const { groupConfig } = useStageContext();
  const subgroupOptions = groupConfig.groups.flatMap(g =>
    Array.from({ length: g.subgroupCount }, (_, i) => `${g.id}${i + 1}`)
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!group.trim()) return;

    setIsLoading(true);
    try {
      const trimmedGroup = group.trim();
      await updateDoc(doc(db, 'users', user.uid), {
        group: trimmedGroup
      });
      if (user.email) {
        try {
          await setDoc(doc(db, 'students', user.email.toLowerCase()), {
            subgroup: trimmedGroup,
            updatedAt: new Date().toISOString(),
          }, { merge: true });
        } catch (studentSyncErr) {
          console.warn('[OnboardingScreen] Optional students subgroup sync failed:', studentSyncErr);
        }
      }
      // App.tsx will automatically re-render because user.group will be updated
    } catch (error) {
      console.error('Error updating profile:', error);
      alert(isRtl ? 'حدث خطأ أثناء حفظ البيانات' : 'Error saving data');
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 dark:bg-zinc-950 p-4" dir={isRtl ? 'rtl' : 'ltr'}>
      <div className="w-full max-w-md bg-white dark:bg-zinc-900 rounded-3xl p-8 shadow-xl border border-slate-200 dark:border-zinc-800">
        <div className="w-16 h-16 bg-sky-100 dark:bg-sky-900/30 rounded-full flex items-center justify-center mx-auto mb-6">
          <UserCheck className="w-8 h-8 text-sky-600 dark:text-sky-400" />
        </div>
        
        <h1 className="text-2xl font-black text-center text-slate-900 dark:text-stone-100 mb-2">
          {isRtl ? 'أكمل ملفك الشخصي' : 'Complete Your Profile'}
        </h1>
        <p className="text-center text-slate-500 dark:text-slate-400 mb-8 text-sm">
          {isRtl ? 'يرجى إدخال الجروب للمتابعة' : 'Please enter your group to continue'}
        </p>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">
              {isRtl ? 'الجروب (Group)' : 'Group'}
            </label>
            <select
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              required
              className="w-full bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded-xl px-4 py-3 outline-none focus:border-sky-500 dark:text-stone-100 transition-colors"
            >
              <option value="">{isRtl ? 'اختر الجروب' : 'Select your group'}</option>
              {subgroupOptions.map(sub => (
                <option key={sub} value={sub}>
                  {isRtl ? `المجموعة ${sub}` : `Group ${sub}`}
                </option>
              ))}
            </select>
          </div>

          <button
            type="submit"
            disabled={isLoading || !group.trim()}
            className="w-full py-4 bg-sky-600 text-white rounded-xl font-bold hover:bg-sky-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2 mt-4"
          >
            {isLoading && <Loader2 className="w-5 h-5 animate-spin" />}
            <span>{isRtl ? 'حفظ ومتابعة' : 'Save and Continue'}</span>
          </button>
        </form>
      </div>
    </div>
  );
}
