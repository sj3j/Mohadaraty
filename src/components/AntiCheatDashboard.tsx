import React, { useState, useEffect } from 'react';
import { collection, query, where, getDocs, updateDoc, limit, doc, deleteDoc, orderBy, addDoc, serverTimestamp, getDoc, setDoc } from 'firebase/firestore';
import { db, auth } from '../lib/firebase';
import { X, ShieldAlert, Trash2, Ban, UserX, AlertTriangle, Eye, RefreshCw } from 'lucide-react';
import { TRANSLATIONS, Language } from '../types';
import { logAdminAction } from '../services/adminLogService';
import { useStageContext } from '../contexts/StageContext';

interface AntiCheatDashboardProps {
  isOpen: boolean;
  onClose: () => void;
  lang: Language;
}

export default function AntiCheatDashboard({ isOpen, onClose, lang }: AntiCheatDashboardProps) {
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [lecturesMap, setLecturesMap] = useState<Record<string, string>>({});
  const [usersMap, setUsersMap] = useState<Record<string, string>>({});
  const { effectiveStageId } = useStageContext();

  const [dialogConfig, setDialogConfig] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    type: 'confirm' | 'alert';
    onConfirm?: () => void;
  } | null>(null);

  const confirmAction = (title: string, message: string, onConfirm: () => void) => {
    setDialogConfig({
      isOpen: true,
      title,
      message,
      type: 'confirm',
      onConfirm
    });
  };

  const showAlert = (title: string, message: string) => {
    setDialogConfig({
      isOpen: true,
      title,
      message,
      type: 'alert'
    });
  };

  const fetchLogs = async () => {
    setLoading(true);
    setErrorMsg('');
    try {
      // Fetch lectures for mapping
      const lecturesSnap = await getDocs(query(collection(db, 'lectures'), limit(100)));
      const lMap: Record<string, string> = {};
      lecturesSnap.forEach(d => {
        lMap[d.id] = d.data().title;
      });
      setLecturesMap(lMap);

      // Fetch users for mapping (filtered by current stage)
      const usersQuery = query(collection(db, 'users'), where('stageId', '==', effectiveStageId));
      const usersSnap = await getDocs(usersQuery);
      const uMap: Record<string, string> = {};
      usersSnap.forEach(d => {
        uMap[d.id] = d.data().name || d.data().email || d.id;
      });
      setUsersMap(uMap);

      const q = query(collection(db, 'antiCheatLogs'), orderBy('timestamp', 'desc'), limit(150));
      const snap = await getDocs(q);
      const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      // Group by user+lecture (only for users in the current stage)
      const grouped = data.reduce((acc: any, log: any) => {
        if (!uMap[log.userId]) return acc; // Skip logs for users not in this stage
        
        const key = `${log.userId}_${log.lectureId}`;
        if (!acc[key]) {
          acc[key] = {
            userId: log.userId,
            lectureId: log.lectureId,
            logs: [],
            latestTimestamp: log.timestamp?.toDate ? log.timestamp.toDate() : new Date()
          };
        }
        acc[key].logs.push(log);
        return acc;
      }, {});

      setLogs(Object.values(grouped));
    } catch (err: any) {
      console.error(err);
      setErrorMsg(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      setLogs([]);
      setUsersMap({});
      fetchLogs();
    }
  }, [isOpen, effectiveStageId]);

  const handleCancelResult = async (group: any) => {
    confirmAction('تأكيد الإلغاء', 'هل أنت متأكد من إلغاء نتيجة هذا الطالب لهذه المحاضرة؟ ومعاقبته بدرجة الصفر؟', async () => {
      try {
        // 1. Delete first attempt answer doc and adjust stats
        try {
          const answerRef = doc(db, `userMCQAnswers/${group.userId}/lectures/${group.lectureId}`);
          
          const ansDocSnap = await getDoc(answerRef);
          
          if (ansDocSnap.exists() && ansDocSnap.data().hasCompletedFirstAttempt) {
               const ansData = ansDocSnap.data();
               const correctCount = ansData.firstAttemptCorrect || 0;
               const totalCount = ansData.firstAttemptTotal || 0;
               
               const statsRef = doc(db, `userMCQStats/${group.userId}`);
               const statsDoc = await getDoc(statsRef);
               
               await updateDoc(answerRef, {
                 firstAttemptCorrect: 0,
                 firstAttemptScore: 0,
                 isCancelledByAdmin: true,
                 lockedAnswers: {}
               });
               
               if (statsDoc.exists()) {
                 const existing = statsDoc.data();
                 const newTotalCorrect = Math.max(0, (existing.totalFirstAttemptCorrect || 0) - correctCount);
                 const newTotalAnswered = existing.totalFirstAttemptAnswered || 0; // Keep answered to penalize accuracy
                 const newLecturesAttempted = existing.lecturesAttempted || 0;
                 
                 await updateDoc(statsRef, {
                   totalFirstAttemptCorrect: newTotalCorrect,
                   totalFirstAttemptAnswered: newTotalAnswered,
                   lecturesAttempted: newLecturesAttempted,
                   mcqLeaderboardScore: newTotalCorrect * 10,
                   accuracy: newTotalAnswered > 0 ? (newTotalCorrect / newTotalAnswered) * 100 : 0
                 });
               }
          } else {
               // If they haven't finished, force complete it with zero to penalize
               const statsRef = doc(db, `userMCQStats/${group.userId}`);
               const statsDoc = await getDoc(statsRef);
               
               await updateDoc(answerRef, {
                 hasCompletedFirstAttempt: true,
                 firstAttemptCorrect: 0, 
                 firstAttemptScore: 0,
                 firstAttemptTotal: 20,
                 isCancelledByAdmin: true,
                 lockedAnswers: {}
               }).catch(async () => {
                   // Document might not exist, use setDoc instead
                  await setDoc(answerRef, {
                     hasCompletedFirstAttempt: true,
                     firstAttemptCorrect: 0, 
                     firstAttemptScore: 0,
                     firstAttemptTotal: 20,
                     isCancelledByAdmin: true,
                     lockedAnswers: {}
                  });
               });
               
               if (statsDoc.exists()) {
                 const existing = statsDoc.data();
                 const newTotalCorrect = existing.totalFirstAttemptCorrect || 0;
                 const newTotalAnswered = (existing.totalFirstAttemptAnswered || 0) + 20;
                 const newLecturesAttempted = (existing.lecturesAttempted || 0) + 1;
                 
                 await updateDoc(statsRef, {
                   totalFirstAttemptCorrect: newTotalCorrect,
                   totalFirstAttemptAnswered: newTotalAnswered,
                   lecturesAttempted: newLecturesAttempted,
                   mcqLeaderboardScore: newTotalCorrect * 10,
                   accuracy: newTotalAnswered > 0 ? (newTotalCorrect / newTotalAnswered) * 100 : 0
                 });
               } else {
                 await setDoc(statsRef, {
                   totalFirstAttemptCorrect: 0,
                   totalFirstAttemptAnswered: 20,
                   lecturesAttempted: 1,
                   mcqLeaderboardScore: 0,
                   accuracy: 0
                 });
               }
          }
        } catch (err: any) {
          console.error("Delete answer error:", err);
          throw new Error("فشل مسح إجابة الطالب: " + err.message);
        }

        // 2. Clear the logs for this incident so it doesn't stay in the dashboard
        try {
          for (const log of group.logs) {
             await deleteDoc(doc(db, 'antiCheatLogs', log.id));
          }
        } catch (err: any) {
          console.error("Delete logs error:", err);
          throw new Error("فشل مسح سجلات الغش: " + err.message);
        }

        // 3. Send Notification to User
        try {
          const lectureTitle = lecturesMap[group.lectureId] || group.lectureId;
          await addDoc(collection(db, 'systemNotifications'), {
            userId: group.userId,
            type: 'anti_cheat_action',
            title: 'إلغاء نتيجة المسابقة/الاختبار',
            body: `تم إلغاء نتيجتك في اختبار محاضرة (${lectureTitle}) بسبب رصد مخالفة لشروط الاختبار (محاولة الخروج أو تصوير الشاشة). نرجو الالتزام في المرات القادمة.`,
            createdAt: serverTimestamp(),
            read: false
          });
        } catch (err: any) {
          console.error("Send notification error:", err);
          throw new Error("فشل إرسال الإشعار: " + err.message);
        }

        setDialogConfig(null);
        showAlert('نجاح', 'تم إلغاء النتيجة والإرسال إشعار للطالب بنجاح.');
        await logAdminAction('CANCEL_USER_RESULT', `Cancelled result for student in lecture ${group.lectureId}`, group.userId);
        fetchLogs();
      } catch (e: any) {
        console.error('Cancel result error:', e);
        setDialogConfig(null);
        showAlert('خطأ', e.message);
      }
    });
  };

  const handleBanMCQ = async (userId: string) => {
    confirmAction('تأكيد الحظر', 'هل أنت متأكد من تعليق وصول الطالب للاختبارات؟', async () => {
      try {
        const userRef = doc(db, `users/${userId}`);
        await updateDoc(userRef, { mcqBanned: true });
        
        await addDoc(collection(db, 'systemNotifications'), {
          userId: userId,
          type: 'anti_cheat_action',
          title: 'تعليق وصولك للاختبارات',
          body: `تم تعليق وصولك للاختبارات (MCQ) بسبب تكرار مخالفة شروط الاختبار أو الغش. يرجى مراجعة إدارة المنصة.`,
          createdAt: serverTimestamp(),
          read: false
        });

        setDialogConfig(null);
        showAlert('نجاح', 'تم إيقاف الطالب عن الاختبارات وإرسال إشعار له.');
        await logAdminAction('BAN_USER_MCQ', `Banned student from taking MCQs`, userId);
      } catch (e: any) {
        setDialogConfig(null);
        showAlert('خطأ', 'خطأ: ' + e.message);
      }
    });
  };

  const handleIgnore = async (logGroup: any) => {
    confirmAction('تجاهل', 'هل أنت متأكد من تجاهل هذه التنبيهات؟', async () => {
      try {
        for (const log of logGroup.logs) {
           await deleteDoc(doc(db, 'antiCheatLogs', log.id));
        }
        setDialogConfig(null);
        await logAdminAction('IGNORE_CHEAT_LOG', `Ignored cheat alerts for student in lecture ${logGroup.lectureId}`, logGroup.userId);
        fetchLogs();
      } catch (e: any) {
        setDialogConfig(null);
        showAlert('خطأ', 'خطأ: ' + e.message);
      }
    });
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" dir="rtl">
      <div className="bg-white dark:bg-zinc-900 w-full max-w-4xl rounded-2xl shadow-xl overflow-hidden flex flex-col max-h-[90vh]">
        
        <div className="flex items-center justify-between p-4 border-b border-gray-100 dark:border-zinc-800 bg-red-50 dark:bg-red-900/10">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-red-600" />
            <h2 className="text-xl font-bold text-gray-900 dark:text-white">مراقبة الغش (MCQ)</h2>
          </div>
          <div className="flex gap-2">
             <button onClick={fetchLogs} className="p-2 hover:bg-red-100 dark:hover:bg-red-900/30 rounded-full transition-colors text-red-600">
               <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
             </button>
             <button onClick={onClose} className="p-2 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded-full transition-colors text-gray-500">
               <X className="w-6 h-6" />
             </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 sm:p-6 pb-20">
          {errorMsg && (
            <div className="p-4 mb-4 bg-red-50 text-red-600 rounded-xl">
              {errorMsg}
            </div>
          )}

          {logs.length === 0 ? (
            <div className="text-center py-12">
               <ShieldAlert className="w-16 h-16 text-emerald-500 mx-auto mb-4 opacity-50" />
               <p className="text-gray-500 dark:text-zinc-400 font-medium">لا توجد أي نشاطات مشبوهة حالياً. النظام آمن.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {logs.map((group: any, idx) => {
                 const screenshotCount = group.logs.filter((l: any) => l.type === 'screenshot').length;
                 const backgroundCount = group.logs.filter((l: any) => l.type === 'app_backgrounded').length;

                 return (
                   <div key={idx} className="bg-white dark:bg-zinc-800 border border-red-100 dark:border-red-900/30 rounded-2xl p-5 shadow-sm">
                      <div className="flex items-start justify-between gap-4 mb-4">
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                             <UserX className="w-4 h-4 text-slate-500" />
                             <span className="font-bold text-slate-900 dark:text-white">{usersMap[group.userId] || group.userId}</span>
                             <span className="px-2 py-0.5 bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400 rounded text-xs font-bold">⚠️ مشبوه</span>
                          </div>
                          <p className="text-sm text-slate-500 dark:text-slate-400 font-medium">المحاضرة: {lecturesMap[group.lectureId] || group.lectureId}</p>
                          <p className="text-xs text-slate-400 mt-1">آخر نشاط: {group.latestTimestamp.toLocaleString('ar-EG')}</p>
                        </div>
                      </div>

                      <div className="flex gap-4 mb-6">
                         {screenshotCount > 0 && (
                            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-50 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 rounded-lg text-sm font-bold text-slate-700 dark:text-slate-300">
                               📸 تصوير شاشة <span className="text-red-600 px-1 bg-red-100 dark:bg-red-900/30 rounded">{screenshotCount}</span>
                            </div>
                         )}
                         {backgroundCount > 0 && (
                            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-50 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 rounded-lg text-sm font-bold text-slate-700 dark:text-slate-300">
                               📱 خروج من التطبيق <span className="text-amber-600 px-1 bg-amber-100 dark:bg-amber-900/30 rounded">{backgroundCount}</span>
                            </div>
                         )}
                      </div>

                      <div className="flex flex-wrap gap-2">
                         <button 
                           onClick={() => handleCancelResult(group)}
                           className="flex items-center gap-1.5 px-4 py-2 bg-red-50 hover:bg-red-100 text-red-700 dark:bg-red-900/20 dark:hover:bg-red-900/40 dark:text-red-400 font-bold text-sm rounded-xl transition-colors"
                         >
                           <Trash2 className="w-4 h-4" />
                           إلغاء النتيجة
                         </button>
                         <button 
                           onClick={() => handleBanMCQ(group.userId)}
                           className="flex items-center gap-1.5 px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white dark:bg-white dark:hover:bg-slate-200 dark:text-slate-900 font-bold text-sm rounded-xl transition-colors"
                         >
                           <Ban className="w-4 h-4" />
                           حظر MCQ
                         </button>
                         <button 
                           onClick={() => handleIgnore(group)}
                           className="flex items-center gap-1.5 px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:text-slate-400 font-bold text-sm rounded-xl transition-colors"
                         >
                           <Eye className="w-4 h-4" />
                           تجاهل وحذف
                         </button>
                      </div>
                   </div>
                 );
              })}
            </div>
          )}
        </div>
      </div>

      {dialogConfig && dialogConfig.isOpen && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="bg-white dark:bg-zinc-900 w-full max-w-sm rounded-2xl shadow-xl overflow-hidden animate-in fade-in zoom-in duration-200">
            <div className="p-5">
              <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-2">{dialogConfig.title}</h3>
              <p className="text-slate-600 dark:text-slate-400 font-medium">{dialogConfig.message}</p>
            </div>
            <div className="flex bg-gray-50 dark:bg-zinc-800/50 p-4 justify-end gap-2 border-t border-gray-100 dark:border-zinc-800">
               {dialogConfig.type === 'confirm' ? (
                 <>
                   <button 
                     onClick={() => setDialogConfig(null)}
                     className="px-4 py-2 font-bold text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 transition-colors"
                   >
                     إلغاء
                   </button>
                   <button 
                     onClick={dialogConfig.onConfirm}
                     className="px-4 py-2 font-bold bg-sky-600 text-white rounded-xl hover:bg-sky-700 transition-colors"
                   >
                     تأكيد
                   </button>
                 </>
               ) : (
                 <button 
                   onClick={() => setDialogConfig(null)}
                   className="px-6 py-2 font-bold bg-sky-600 text-white rounded-xl hover:bg-sky-700 transition-colors"
                 >
                   حسناً
                 </button>
               )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
