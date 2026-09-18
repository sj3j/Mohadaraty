import React, { useState, useEffect } from 'react';
import { collection, query, getDocs, orderBy, limit, where, addDoc, serverTimestamp, deleteDoc, doc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { X, Bell, BookOpen, Clock, ShieldAlert } from 'lucide-react';
import { Language, TRANSLATIONS, UserProfile, Homework } from '../types';
import { denormalizedSubjectName } from '../lib/subjectDisplay';
import { useStageContext } from '../contexts/StageContext';

const formatTimeAgo = (timestamp: number, isRtl: boolean) => {
  const diffInSeconds = Math.floor((Date.now() - timestamp) / 1000);
  
  if (diffInSeconds < 60) return isRtl ? 'الآن' : 'Just now';
  
  const diffInMinutes = Math.floor(diffInSeconds / 60);
  if (diffInMinutes < 60) return isRtl ? `منذ ${diffInMinutes} دقيقة` : `${diffInMinutes}m ago`;
  
  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) return isRtl ? `منذ ${diffInHours} ساعة` : `${diffInHours}h ago`;
  
  const diffInDays = Math.floor(diffInHours / 24);
  if (diffInDays < 7) return isRtl ? `منذ ${diffInDays} يوم` : `${diffInDays}d ago`;
  
  const date = new Date(timestamp);
  return date.toLocaleDateString(isRtl ? 'ar-IQ' : 'en-US', { month: 'short', day: 'numeric' });
};

interface NotificationsModalProps {
  user: UserProfile;
  lang: Language;
  onClose: () => void;
}

interface NotificationItem {
  id: string;
  type: 'homework' | 'system' | 'report';
  title: string;
  body: string;
  createdAt: any;
  icon: any;
  extraData?: any;
}

export default function NotificationsModal({ user, lang, onClose }: NotificationsModalProps) {
  const isRtl = lang === 'ar';
  const t = TRANSLATIONS[lang];
  const { effectiveStageId } = useStageContext();
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});
  const [reportReplies, setReportReplies] = useState<Record<string, string>>({});
  const [isReplying, setIsReplying] = useState<Record<string, boolean>>({});

  const toggleItem = (id: string) => {
    setExpandedItems(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const handleReplyToReport = async (notificationId: string, reportedBy: string) => {
    const text = reportReplies[notificationId];
    if (!text || !text.trim()) return;

    setIsReplying(prev => ({ ...prev, [notificationId]: true }));
    try {
      await addDoc(collection(db, 'systemNotifications'), {
        userId: reportedBy,
        title: isRtl ? 'رد على التبليغ' : 'Report Reply',
        body: text,
        createdAt: serverTimestamp(),
      });
      
      // Instead of deleting, mark it as replied
      try {
        const { updateDoc } = await import('firebase/firestore');
        await updateDoc(doc(db, 'adminAlerts', notificationId), {
          replied: true,
          replyText: text,
          repliedAt: serverTimestamp()
        });
        
        setNotifications(prev => prev.map(n => 
          n.id === notificationId 
            ? { ...n, extraData: { ...n.extraData, replied: true, replyText: text } }
            : n
        ));
      } catch (e) {
        console.error("Could not update report", e);
      }

      setReportReplies(prev => ({ ...prev, [notificationId]: '' }));
    } catch (e) {
      console.error(e);
    } finally {
      setIsReplying(prev => ({ ...prev, [notificationId]: false }));
    }
  };

  useEffect(() => {
    const fetchNotifications = async () => {
      try {
        const items: NotificationItem[] = [];
        
        // 1. Fetch Weekly Homeworks (latest 10), scoped to the reader's stage -
        //    an unscoped read notified every stage about every stage's homework.
        try {
          const hwQuery = effectiveStageId ? query(
            collection(db, 'homeworks'),
            where('stageId', '==', effectiveStageId),
            orderBy('createdAt', 'desc'),
            limit(10)
          ) : null;
          const hwSnap = hwQuery ? await getDocs(hwQuery) : { forEach: () => {} };

          hwSnap.forEach(docSnap => {
            const data = docSnap.data() as Homework;
            items.push({
              id: docSnap.id,
              type: 'homework',
              title: isRtl ? 'واجب جديد' : 'New Homework',
              // Was a one-off ternary that translated exactly ONE subject and
              // printed the raw slug for every other. denormalizedSubjectName
              // reads the name written onto the homework at save time, so this
              // needs no subject list of its own - and it names subjects from
              // stages this reader has never been in.
              body: isRtl
                ? `تم إضافة واجب جديد لمادة ${denormalizedSubjectName(data as any) || 'غير محددة'}`
                : `New homework added for ${denormalizedSubjectName(data as any) || 'an unspecified subject'}`,
              createdAt: data.createdAt?.toMillis ? data.createdAt.toMillis() : Date.now(),
              icon: BookOpen
            });
          });
        } catch (e) {
          console.error("Homeworks fetch failed", e);
        }

        // 2. Fetch system notifications
        try {
          const sysQuery = query(collection(db, 'systemNotifications'), where('userId', '==', user.uid), orderBy('createdAt', 'desc'), limit(20));
          const sysSnap = await getDocs(sysQuery);
          sysSnap.forEach(docSnap => {
            const data = docSnap.data();
            items.push({
              id: docSnap.id,
              type: 'system',
              title: data.title || (isRtl ? 'إشعار إداري' : 'System Notice'),
              body: data.body || '',
              createdAt: data.createdAt?.toMillis ? data.createdAt.toMillis() : Date.now(),
              icon: ShieldAlert
            });
          });

          if (user.role === 'admin' || user.isMasterAdmin) {
             const adminSysQuery = query(collection(db, 'adminAlerts'), orderBy('createdAt', 'desc'), limit(20));
             const adminSysSnap = await getDocs(adminSysQuery);
             adminSysSnap.forEach(docSnap => {
               const data = docSnap.data();
               let title = isRtl ? 'تنبيه نظام' : 'System Alert';
               let body = data.reason ? `السبب: ${data.reason}` : 'هناك تنبيه يتطلب المراجعة';
               
               if (data.type === 'question_report') {
                 title = isRtl ? 'تبليغ عن سؤال' : 'Question Report';
                 body = `سؤال: ${data.questionStem ? data.questionStem.substring(0, 50) + '...' : 'غير معروف'}`;
               }
               
               items.push({
                 id: docSnap.id,
                 type: data.type === 'question_report' ? 'report' : 'system',
                 title,
                 body,
                 createdAt: data.createdAt?.toMillis ? data.createdAt.toMillis() : Date.now(),
                 icon: ShieldAlert,
                 extraData: data
               });
             });
          }
        } catch (e) {
          console.error("System notifications fetch failed", e);
        }

        // Sort combined
        items.sort((a, b) => b.createdAt - a.createdAt);
        setNotifications(items);
      } catch (err) {
        console.error('Error fetching notifications:', err);
      } finally {
        setIsLoading(false);
      }
    };

    fetchNotifications();
  }, [user.name, user.uid, user.email, isRtl, effectiveStageId]);

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" dir={isRtl ? 'rtl' : 'ltr'}>
      <div className="bg-white dark:bg-zinc-900 rounded-3xl w-full max-w-lg overflow-hidden flex flex-col max-h-[85vh] shadow-2xl border border-slate-200 dark:border-zinc-800 relative animate-in fade-in zoom-in-95 duration-200">
        
        {/* Header */}
        <div className="flex items-center gap-3 p-6 border-b border-slate-100 dark:border-zinc-800 bg-sky-50 dark:bg-sky-900/10">
          <div className="w-10 h-10 rounded-full bg-sky-100 dark:bg-sky-900/50 flex items-center justify-center text-sky-600 dark:text-sky-400">
            <Bell className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h2 className="text-xl font-bold tracking-tight text-slate-800 dark:text-slate-100">
              {isRtl ? 'إشعارات التطبيق' : 'App Notifications'}
            </h2>
          </div>
          <button 
            onClick={onClose}
            className="w-10 h-10 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-200/50 dark:hover:bg-zinc-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50/50 dark:bg-zinc-950">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center h-40 gap-3 text-sky-600 dark:text-sky-400">
              <div className="w-8 h-8 rounded-full border-2 border-current border-t-transparent animate-spin" />
              <p className="text-sm font-medium animate-pulse">{isRtl ? 'جاري تحميل الإشعارات...' : 'Loading notifications...'}</p>
            </div>
          ) : notifications.length > 0 ? (
            notifications.map(item => {
              const isExpanded = expandedItems[item.id];
              return (
              <div 
                key={item.id} 
                onClick={() => toggleItem(item.id)}
                className="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-2xl p-4 flex gap-4 items-start shadow-sm hover:shadow-md transition-all cursor-pointer group"
              >
                <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
                  (item.type === 'system' || item.type === 'report')
                    ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400'
                    : 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400'
                }`}>
                  <item.icon className="w-5 h-5" />
                </div>
                <div className="flex-1 w-full">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <h3 className="font-bold text-slate-800 dark:text-slate-200 text-[15px] leading-tight">
                      {item.title}
                    </h3>
                    <div className="flex items-center gap-1 text-[11px] font-medium text-slate-400 dark:text-slate-500 whitespace-nowrap">
                      <Clock className="w-3 h-3" />
                      {formatTimeAgo(item.createdAt, isRtl)}
                    </div>
                  </div>
                  <p className={`text-sm text-slate-600 dark:text-slate-400 leading-snug whitespace-pre-wrap ${!isExpanded ? 'line-clamp-2' : ''}`}>
                    {item.body}
                  </p>
                  
                  {item.type === 'report' && item.extraData && isExpanded && (
                    <div 
                      className="mt-3 opacity-100 transition-opacity"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="mt-2 p-3 bg-slate-50 dark:bg-zinc-800 rounded-xl border border-slate-100 dark:border-zinc-700 space-y-2 text-sm text-slate-700 dark:text-slate-300">
                        <div>
                          <span className="font-bold text-slate-500 text-xs">{(isRtl ? 'بواسطة:' : 'By:')} </span>
                          <span className="font-bold">{item.extraData.reportedByName || item.extraData.reportedBy}</span>
                        </div>
                        <div>
                          <span className="font-bold text-slate-500 text-xs">{(isRtl ? 'السبب:' : 'Reason:')} </span>
                          <span className="break-words">{item.extraData.reason}</span>
                        </div>
                        
                        {(user.role === 'admin' || user.isMasterAdmin) && (
                          <div className="mt-4 pt-3 border-t border-slate-200 dark:border-zinc-700">
                            {item.extraData.replied ? (
                              <div className="bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 p-2 text-xs rounded-lg font-medium border border-emerald-100 dark:border-emerald-800/30">
                                {isRtl ? 'تم الرد:' : 'Replied:'} <span className="font-bold">{item.extraData.replyText}</span>
                              </div>
                            ) : (
                              <>
                                <label className="block text-xs font-bold text-slate-500 mb-2">
                                  {isRtl ? 'إرسال رد للطالب:' : 'Send reply to student:'}
                                </label>
                                <div className="flex gap-2">
                                  <input 
                                    type="text"
                                    value={reportReplies[item.id] || ''}
                                    onChange={(e) => setReportReplies({...reportReplies, [item.id]: e.target.value})}
                                    placeholder={isRtl ? 'اكتب ردك هنا...' : 'Type your reply...'}
                                    className="flex-1 bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-600 rounded-lg px-3 py-2 text-sm outline-none focus:border-sky-500"
                                  />
                                  <button 
                                    onClick={() => handleReplyToReport(item.id, item.extraData.reportedBy)}
                                    disabled={isReplying[item.id] || !reportReplies[item.id]?.trim()}
                                    className="px-3 py-2 bg-sky-500 hover:bg-sky-600 text-white font-bold text-sm rounded-lg disabled:opacity-50 transition-colors"
                                  >
                                    {isReplying[item.id] ? '...' : (isRtl ? 'إرسال' : 'Send')}
                                  </button>
                                </div>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
              );
            })
          ) : (
             <div className="text-center py-12 px-4 flex flex-col items-center justify-center">
               <div className="w-16 h-16 rounded-full bg-slate-100 dark:bg-zinc-800 flex items-center justify-center text-slate-400 mb-4">
                 <Bell className="w-8 h-8" />
               </div>
               <h3 className="text-lg font-bold text-slate-700 dark:text-slate-300 mb-1">{isRtl ? 'لا توجد إشعارات' : 'No notifications'}</h3>
               <p className="text-slate-500 dark:text-slate-400 text-sm max-w-xs">{isRtl ? 'سوف تظهر الإشعارات عند وجود واجبات جديدة أو تحديثات تخص حسابك.' : 'Notifications will appear when new homework is added or something changes on your account.'}</p>
             </div>
          )}
        </div>
      </div>
    </div>
  );
}
