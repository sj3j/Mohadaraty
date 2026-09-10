import React, { useState, useEffect, useRef } from 'react';
import { Language, TRANSLATIONS, UserProfile, Lecture } from '../types';
import { Loader2, Megaphone, RefreshCw, X, Link, Trash2, Check, ArrowRight, ArrowLeft, Pencil, Settings2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useStageContext } from '../contexts/StageContext';
import { canManage } from '../lib/permissions';
import { collection, query, orderBy, onSnapshot, deleteDoc, doc, where, setDoc, updateDoc, arrayUnion, arrayRemove } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import type { Announcement } from '../types/announcement.types';
import { safeUrl } from '../lib/richText';
import LectureCard from './LectureCard';
import SpotlightTooltip from './SpotlightTooltip';
import { ConfirmShareDialog } from './ui/ConfirmShareDialog';
import RichContent from './announcements/RichContent';
import AttachmentGrid from './announcements/AttachmentGrid';
import PollCard from './announcements/PollCard';
import Composer from './announcements/Composer';

interface AnnouncementsScreenProps {
  user: UserProfile | null;
  lang: Language;
  lectures: Lecture[];
  onNavigateToChat?: () => void;
  onOpenMCQ?: (lecture: Lecture) => void;
  onOpenReader?: (lecture: Lecture) => void;
  /** Staff only. The floating nav is hidden while the composer owns the bottom
   *  edge, so this is their one way back out of the screen. */
  onBack?: () => void;
}

export default function AnnouncementsScreen({
  user, lang, lectures, onNavigateToChat, onOpenMCQ, onOpenReader, onBack,
}: AnnouncementsScreenProps) {
  const t = TRANSLATIONS[lang];
  const isRtl = lang === 'ar';
  const BackIcon = isRtl ? ArrowRight : ArrowLeft;

  const [posts, setPosts] = useState<Announcement[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [editing, setEditing] = useState<Announcement | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [shareItem, setShareItem] = useState<{ id: string; content: string; authorName: string } | null>(null);

  const { effectiveStageId } = useStageContext();
  const postsEndRef = useRef<HTMLDivElement>(null);
  const hasInitiallyScrolled = useRef(false);
  const prevPostsLength = useRef(0);

  const canPost = canManage(user, 'manageAnnouncements');

  const [allowedReactions, setAllowedReactions] = useState<string[]>(['👍', '❤️', '🙏', '🔥']);
  /** Which stages the Telegram mirror is live for. Written by the bot into the
   *  same settings doc, deliberately as bare stage ids: the channel map itself
   *  is master-admin-read-only, but a moderator still needs to know whether the
   *  "post to Telegram" toggle on their composer will do anything. */
  const [telegramStages, setTelegramStages] = useState<string[]>([]);
  const [showReactionsConfig, setShowReactionsConfig] = useState(false);
  const [showReactionPickerForPost, setShowReactionPickerForPost] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading && posts.length > 0) {
      if (!hasInitiallyScrolled.current || posts.length > prevPostsLength.current) {
        setTimeout(() => {
          postsEndRef.current?.scrollIntoView({ behavior: 'auto' });
          hasInitiallyScrolled.current = true;
        }, 100);
      }
      prevPostsLength.current = posts.length;
    }
  }, [posts.length, isLoading]);

  useEffect(() => {
    setIsLoading(true);

    const unsubscribeReactions = onSnapshot(doc(db, 'settings', 'announcements'), snap => {
      if (snap.exists() && snap.data().allowedReactions) setAllowedReactions(snap.data().allowedReactions);
      setTelegramStages(snap.exists() && Array.isArray(snap.data().telegramStages) ? snap.data().telegramStages : []);
    }, error => handleFirestoreError(error, OperationType.GET, 'settings/announcements'));

    // An unresolved stage used to fall through to an unfiltered query, showing
    // every stage's announcements. Show nothing instead. The reactions listener
    // above is already live, so its teardown still has to run.
    if (!effectiveStageId) {
      setPosts([]);
      setIsLoading(false);
      setIsRefreshing(false);
      return () => unsubscribeReactions();
    }

    const q = query(
      collection(db, 'announcements'),
      where('stageId', '==', effectiveStageId),
      orderBy('createdAt', 'asc'),
    );

    const unsubscribe = onSnapshot(q, snapshot => {
      setPosts(snapshot.docs.map(d => ({ id: d.id, ...d.data() } as Announcement)));
      setLastUpdated(new Date());
      setIsLoading(false);
      setIsRefreshing(false);
    }, error => {
      handleFirestoreError(error, OperationType.LIST, 'announcements');
      setIsLoading(false);
      setIsRefreshing(false);
    });

    return () => { unsubscribe(); unsubscribeReactions(); };
  }, [effectiveStageId]);

  const millisOf = (post: Announcement): number => {
    const created = post.createdAt as { toMillis?: () => number } | undefined;
    return created?.toMillis ? created.toMillis() : Date.now();
  };

  const formatMessageDate = (date: Date) => {
    const today = new Date();
    const isToday = date.getDate() === today.getDate()
      && date.getMonth() === today.getMonth()
      && date.getFullYear() === today.getFullYear();
    if (isToday) return isRtl ? 'اليوم' : 'Today';
    return date.toLocaleDateString(isRtl ? 'ar-EG' : 'en-US', { month: 'long', day: 'numeric' });
  };

  const groupedPosts: Record<string, Announcement[]> = {};
  for (const post of posts) {
    const key = formatMessageDate(new Date(millisOf(post)));
    (groupedPosts[key] ||= []).push(post);
  }

  const handleShareToChat = async () => {
    if (!user || !shareItem) return;
    try {
      const { addDoc, collection: coll, serverTimestamp } = await import('firebase/firestore');
      await addDoc(coll(db, 'chat_messages'), {
        text: '',
        senderName: user.name,
        senderEmail: user.email,
        senderId: user.uid,
        senderAvatar: user.photoUrl || user.name.charAt(0).toUpperCase(),
        timestamp: serverTimestamp(),
        createdAt: Date.now(),
        reactions: { like: [], heart: [], thanks: [] },
        isAnonymous: false,
        originalSenderName: user.name,
        embeddedItem: {
          type: 'announcement',
          id: shareItem.id,
          title: shareItem.content?.substring(0, 50) || 'تبليغ جديد',
          subtitle: shareItem.authorName,
        },
      });
      onNavigateToChat?.();
    } catch (err) {
      console.error(err);
    }
  };

  const handleDeletePost = async (postId: string) => {
    try {
      await deleteDoc(doc(db, 'announcements', postId));
      setDeletingId(null);
      if (editing?.id === postId) setEditing(null);
    } catch (err) {
      console.error('Error deleting post:', err);
    }
  };

  const handleReaction = async (postId: string, emoji: string) => {
    if (!user) return;
    try {
      const post = posts.find(p => p.id === postId);
      if (!post) return;
      const hasReacted = (post.reactions?.[emoji] ?? []).includes(user.uid);
      await updateDoc(doc(db, 'announcements', postId), {
        [`reactions.${emoji}`]: hasReacted ? arrayRemove(user.uid) : arrayUnion(user.uid),
      });
    } catch (err) {
      console.error('Error toggling reaction:', err);
    }
  };

  const saveReactionsConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canPost) return;
    try {
      await setDoc(doc(db, 'settings', 'announcements'), { allowedReactions }, { merge: true });
      setShowReactionsConfig(false);
    } catch (err) {
      console.error('Error saving reactions config:', err);
    }
  };

  const timeString = lastUpdated.toLocaleTimeString(isRtl ? 'ar-EG' : 'en-US', { hour: '2-digit', minute: '2-digit' });

  return (
    <div
      className="max-w-xl mx-auto px-3 sm:px-4 pt-3"
      dir={isRtl ? 'rtl' : 'ltr'}
      // App's root drops its pb-[104px] for staff on this tab, because the
      // floating nav is hidden while the docked composer owns the bottom edge.
      // The clearance the composer needs is therefore this screen's to supply -
      // its collapsed bar is one 40px control row inside 0.5rem of padding.
      style={canPost ? { paddingBottom: 'calc(60px + max(env(safe-area-inset-bottom), 0.5rem))' } : undefined}
    >
      {/* Sticky offsets are measured from the viewport, not from App's padded
          root, so the status-bar inset has to be repeated here or the title
          parks under the system clock. */}
      <div className="flex justify-between items-center gap-2 mb-4 sticky top-[env(safe-area-inset-top)] z-30 bg-stone-50/90 dark:bg-zinc-900/90 backdrop-blur-md py-2 -mx-3 px-3 sm:-mx-4 sm:px-4">
        <h1 className="text-xl font-black text-slate-900 dark:text-stone-100 flex items-center gap-2 min-w-0">
          {canPost && onBack && (
            <button
              onClick={onBack}
              aria-label={isRtl ? 'رجوع' : 'Back'}
              className="p-1.5 -ms-1.5 shrink-0 rounded-xl text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
            >
              <BackIcon className="w-5 h-5" strokeWidth={2.5} />
            </button>
          )}
          <span className="w-9 h-9 rounded-xl bg-sky-100 dark:bg-sky-900/30 flex items-center justify-center shrink-0">
            <Megaphone className="w-5 h-5 text-sky-600 dark:text-sky-400" strokeWidth={2.5} />
          </span>
          <span className="truncate">{t.navAnnouncements}</span>
        </h1>

        <div className="flex items-center gap-1 shrink-0">
          <span className="hidden sm:inline text-xs font-bold text-slate-400 dark:text-slate-500">
            {isRtl ? 'آخر تحديث:' : 'Last updated:'} {timeString}
          </span>
          <button
            onClick={() => { setIsRefreshing(true); setTimeout(() => setIsRefreshing(false), 1000); }}
            className="p-2 text-slate-400 hover:text-sky-600 dark:hover:text-sky-400 hover:bg-slate-100 dark:hover:bg-zinc-800 rounded-xl transition-colors"
            title={isRtl ? 'تحديث' : 'Refresh'}
            aria-label={isRtl ? 'تحديث' : 'Refresh'}
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin text-sky-500' : ''}`} strokeWidth={2.5} />
          </button>

          {canPost && (
            <button
              onClick={() => setShowReactionsConfig(true)}
              className="p-2 text-slate-400 hover:text-sky-600 dark:hover:text-sky-400 hover:bg-slate-100 dark:hover:bg-zinc-800 rounded-xl transition-colors"
              title={isRtl ? 'إعدادات التفاعلات' : 'Reactions settings'}
              aria-label={isRtl ? 'إعدادات التفاعلات' : 'Reactions settings'}
            >
              <Settings2 className="w-5 h-5" strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="w-8 h-8 text-sky-600 dark:text-sky-400 animate-spin" />
        </div>
      ) : Object.keys(groupedPosts).length > 0 ? (
        <div className="space-y-8">
          {Object.entries(groupedPosts).map(([dateKey, datePosts]) => (
            <div key={dateKey} className="flex flex-col gap-3">
              {/* 3.75rem is the screen header's own height (py-2 around a 40px
                  row); without it the date pill sticks inside the title bar and
                  shows through its blur. */}
              <div className="flex justify-center sticky top-[calc(env(safe-area-inset-top)+3.75rem)] z-20">
                <span className="bg-slate-200/80 dark:bg-zinc-700/80 backdrop-blur-md text-slate-600 dark:text-zinc-300 px-3 py-1 rounded-full text-xs font-bold leading-none shadow-sm">
                  {dateKey}
                </span>
              </div>

              <div className="flex flex-col relative w-full">
                <div className={`absolute top-0 bottom-0 w-0.5 bg-slate-200 dark:bg-zinc-700 ${isRtl ? 'right-4' : 'left-4'}`} />

                {datePosts.map(post => {
                  const postTime = new Date(millisOf(post)).toLocaleTimeString(isRtl ? 'ar-EG' : 'en-US', { hour: '2-digit', minute: '2-digit' });

                  return (
                    <motion.div
                      layout
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      key={post.id}
                      className={`relative group w-full mb-4 flex gap-4 ${isRtl ? 'pr-12' : 'pl-12'}`}
                      id={post.id === posts[posts.length - 1]?.id ? 'announcement-timeline-0' : undefined}
                    >
                      <div className={`absolute top-4 w-3 h-3 bg-[#2196F3] rounded-full border-4 border-[#F5F7FA] dark:border-zinc-950 ${isRtl ? 'right-[11px]' : 'left-[11px]'}`} />

                      <div className="bg-white dark:bg-zinc-800 p-3 sm:p-3.5 shadow-sm rounded-[16px] border border-slate-100 dark:border-zinc-700 w-full relative">
                        {canPost && (
                          <div className={`absolute top-2 z-10 flex gap-1 ${isRtl ? 'left-2' : 'right-2'}`}>
                            <button
                              onClick={() => setEditing(post)}
                              aria-label={isRtl ? 'تعديل' : 'Edit'}
                              className="p-1.5 text-slate-400 hover:text-[#2196F3] hover:bg-sky-50 dark:hover:bg-sky-900/30 rounded-full transition-colors opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                            >
                              <Pencil className="w-4 h-4" />
                            </button>

                            {deletingId === post.id ? (
                              <div className="flex items-center gap-1 bg-white dark:bg-zinc-800 p-1 rounded-lg shadow-sm border border-slate-200 dark:border-zinc-700">
                                <button
                                  onClick={() => handleDeletePost(post.id)}
                                  className="px-2 py-1 text-xs font-bold bg-red-100 text-red-600 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 rounded-md transition-colors"
                                >
                                  {isRtl ? 'تأكيد' : 'Confirm'}
                                </button>
                                <button
                                  onClick={() => setDeletingId(null)}
                                  className="px-2 py-1 text-xs font-bold bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-zinc-700 dark:text-slate-300 rounded-md transition-colors"
                                >
                                  {isRtl ? 'إلغاء' : 'Cancel'}
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => setDeletingId(post.id)}
                                aria-label={isRtl ? 'حذف' : 'Delete'}
                                className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-full transition-colors opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        )}

                        <div className="inline-block bg-[#2196F3]/10 text-[#2196F3] dark:text-sky-400 font-bold text-[11px] px-2 py-0.5 rounded-full mb-2">
                          {post.authorName || (isRtl ? 'إعلان جديد' : 'New Announcement')}
                        </div>

                        <AttachmentGrid attachments={post.attachments ?? []} isRtl={isRtl} />

                        <RichContent blocks={post.richBlocks} text={post.text} className="px-1 mb-1" />

                        {post.poll && (
                          <PollCard postId={post.id} poll={post.poll} uid={user?.uid ?? null} isRtl={isRtl} />
                        )}

                        {/* Sanitised again at render, not only on write: a doc
                            written by an older build (or by anything other than
                            the composer) can still carry a javascript: href,
                            and React does not block those. */}
                        {safeUrl(post.linkUrl) && (
                          <a href={safeUrl(post.linkUrl)!} target="_blank" rel="noopener noreferrer" className="mt-2 block w-full">
                            <div className="px-4 py-3 bg-sky-50 dark:bg-sky-900/20 hover:bg-sky-100 dark:hover:bg-sky-900/30 transition-colors rounded-xl border border-sky-200 dark:border-sky-800/50 flex items-center gap-3 w-full">
                              <div className="w-8 h-8 rounded-full bg-sky-200 dark:bg-sky-800 text-sky-700 dark:text-sky-300 flex items-center justify-center shrink-0">
                                <Link className="w-4 h-4 shrink-0" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-bold text-sky-900 dark:text-sky-100 truncate">{post.linkTitle || post.linkUrl}</p>
                                <p className="text-xs text-sky-600 dark:text-sky-400 truncate text-left" dir="ltr">{post.linkUrl}</p>
                              </div>
                            </div>
                          </a>
                        )}

                        {!!post.embeddedLectures?.length && (
                          <div className="mt-2 mb-1 ps-3 border-s-2 border-sky-500">
                            <div className="grid gap-2">
                              {post.embeddedLectures.map((lectureId, i) => {
                                const lecture = lectures.find(l => l.id === lectureId);
                                if (!lecture) return null;
                                return (
                                  <LectureCard
                                    key={`${lecture.id}-${i}`}
                                    lecture={lecture}
                                    lang={lang}
                                    user={user}
                                    onNavigateToChat={onNavigateToChat}
                                    onOpenMCQ={onOpenMCQ}
                                    onOpenReader={onOpenReader}
                                  />
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {user && (
                          <button
                            onClick={() => setShareItem({ id: post.id, content: post.text || '', authorName: post.authorName || '' })}
                            className="w-full mt-3 p-2 flex items-center justify-center gap-2 bg-slate-50 hover:bg-slate-100 dark:bg-zinc-800/50 dark:hover:bg-zinc-800 text-slate-500 hover:text-sky-600 dark:hover:text-sky-400 rounded-xl transition-colors font-bold text-sm border border-slate-200 dark:border-zinc-700/50"
                          >
                            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                            {isRtl ? 'مناقشة في الشات' : 'Discuss in Chat'}
                          </button>
                        )}

                        {user && (
                          <div className="relative mt-3 mb-1">
                            <div className="flex flex-wrap items-center gap-2">
                              {allowedReactions.map(emoji => {
                                const reactionArray = post.reactions?.[emoji] || [];
                                const count = reactionArray.length;
                                const hasReacted = reactionArray.includes(user.uid);
                                if (count === 0 && !hasReacted) return null;

                                return (
                                  <button
                                    key={emoji}
                                    onClick={() => handleReaction(post.id, emoji)}
                                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold transition-all border ${
                                      hasReacted
                                        ? 'bg-sky-50 dark:bg-sky-900/40 border-sky-300 dark:border-sky-700/50 text-sky-700 dark:text-sky-300 shadow-sm'
                                        : 'bg-slate-50 dark:bg-zinc-800/80 border-slate-200 dark:border-zinc-700/50 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-700'
                                    }`}
                                  >
                                    <span className="text-sm">{emoji}</span>
                                    <span className="font-semibold">{count}</span>
                                  </button>
                                );
                              })}

                              <button
                                onClick={() => setShowReactionPickerForPost(showReactionPickerForPost === post.id ? null : post.id)}
                                aria-label={isRtl ? 'إضافة تفاعل' : 'Add reaction'}
                                className="flex items-center justify-center w-7 h-7 rounded-full bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-400 hover:text-sky-500 hover:bg-slate-100 transition-colors"
                              >
                                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="M12 5v14" /></svg>
                              </button>
                            </div>

                            <AnimatePresence>
                              {showReactionPickerForPost === post.id && (
                                <motion.div
                                  initial={{ opacity: 0, scale: 0.9, y: 10 }}
                                  animate={{ opacity: 1, scale: 1, y: 0 }}
                                  exit={{ opacity: 0, scale: 0.9, y: 10 }}
                                  className="absolute start-0 bottom-full mb-2 bg-white dark:bg-zinc-800 p-2 rounded-2xl shadow-xl border border-slate-200 dark:border-zinc-700 flex items-center gap-2 z-10"
                                >
                                  {allowedReactions.map(emoji => (
                                    <button
                                      key={emoji}
                                      onClick={() => { handleReaction(post.id, emoji); setShowReactionPickerForPost(null); }}
                                      className="w-10 h-10 flex items-center justify-center text-xl hover:bg-slate-100 dark:hover:bg-zinc-700 rounded-full transition-transform hover:scale-125 focus:scale-90"
                                    >
                                      {emoji}
                                    </button>
                                  ))}
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </div>
                        )}

                        <div className="flex items-center justify-end mt-1">
                          <span className="text-[11px] text-slate-400 dark:text-slate-500 font-medium">{postTime}</span>
                        </div>
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            </div>
          ))}
          <div ref={postsEndRef} className="h-6" />
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-20 px-4 text-center">
          <div className="w-24 h-24 bg-slate-100 dark:bg-zinc-800 rounded-full flex items-center justify-center mb-6 shadow-sm relative">
            <Megaphone className="w-10 h-10 text-slate-400 dark:text-zinc-500" />
            <div className="absolute top-0 end-0 w-6 h-6 bg-sky-100 dark:bg-sky-900/50 rounded-full flex items-center justify-center">
              <div className="w-2 h-2 bg-[#2196F3] rounded-full" />
            </div>
          </div>
          <h2 className="text-2xl font-bold text-slate-900 dark:text-stone-100 mb-2">{t.noPosts}</h2>
          <p className="text-slate-500 dark:text-slate-400 max-w-[260px] leading-relaxed">
            {isRtl
              ? 'لم يتم إضافة أي تبليغات حتى الآن. ستظهر الإشعارات هنا عند توفرها.'
              : 'No announcements have been added yet. Notifications will appear here when available.'}
          </p>
        </div>
      )}

      <SpotlightTooltip targetSelector="#announcement-timeline-0" text="إشعارات القناة تظهر هنا تلقائياً" tooltipKey="announcements" />

      {canPost && effectiveStageId && (
        <Composer
          user={user}
          stageId={effectiveStageId}
          telegramEnabled={telegramStages.includes(effectiveStageId)}
          lang={lang}
          lectures={lectures}
          editing={editing}
          onCancelEdit={() => setEditing(null)}
        />
      )}

      <AnimatePresence>
        {showReactionsConfig && (
          <div className="fixed inset-0 z-[150] flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white dark:bg-zinc-900 rounded-3xl shadow-xl w-full max-w-sm overflow-hidden flex flex-col"
            >
              <div className="flex items-center justify-between p-4 sm:p-6 border-b border-slate-100 dark:border-zinc-800">
                <h2 className="text-xl font-bold text-slate-900 dark:text-stone-100">{isRtl ? 'إعدادات التفاعلات' : 'Reactions Settings'}</h2>
                <button
                  onClick={() => setShowReactionsConfig(false)}
                  aria-label={isRtl ? 'إغلاق' : 'Close'}
                  className="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-zinc-800 rounded-full transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <form onSubmit={saveReactionsConfig} className="p-4 sm:p-6 space-y-4">
                <div>
                  <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">
                    {isRtl ? 'التفاعلات المسموحة (ايموجي، مفصولة بمسافة)' : 'Allowed Reactions (Emojis, space-separated)'}
                  </label>
                  <input
                    type="text"
                    value={allowedReactions.join(' ')}
                    onChange={e => setAllowedReactions(e.target.value.trim().split(/\s+/).filter(Boolean))}
                    className="w-full bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 rounded-xl px-4 py-3 outline-none focus:border-sky-500 text-slate-900 dark:text-stone-100 text-lg"
                    placeholder="👍 ❤️ 🙏 🔥"
                  />
                </div>

                <button
                  type="submit"
                  className="w-full flex items-center justify-center gap-2 bg-sky-600 hover:bg-sky-700 text-white px-6 py-3 rounded-xl font-bold transition-colors"
                >
                  <Check className="w-5 h-5" />
                  {isRtl ? 'حفظ إعدادات التفاعلات' : 'Save Reactions Settings'}
                </button>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <ConfirmShareDialog
        isOpen={!!shareItem}
        onClose={() => setShareItem(null)}
        onConfirm={handleShareToChat}
        itemName={isRtl ? 'هذا التبليغ' : 'this announcement'}
        lang={lang}
      />
    </div>
  );
}
