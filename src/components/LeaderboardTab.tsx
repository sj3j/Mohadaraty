import React, { useEffect, useState, useRef } from 'react';
import { collection, query, orderBy, limit, getDocs, where, documentId, getCountFromServer, doc, getDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { UserProfile, Language } from '../types';
import { Flame, Medal, Crown, Loader2, Target, RefreshCw, Palmtree, MoreVertical, Users, Sparkles } from 'lucide-react';
import { UserMCQStats } from '../types/mcq.types';
import Podium from './ui/Podium';
import { useStageContext } from '../contexts/StageContext';
import { useAcademicPhase } from '../hooks/useAcademicPhase';
import { hasLiveSubscription } from '../../shared/subscriptionAccess';
import { BannerThemeId } from '../hooks/useSubscriptionBannerTheme';

interface LeaderboardTabProps {
  user: UserProfile | null;
  lang: Language;
}

const STREAK_LIMIT = 20;
/** Over-fetch so graduated students, who are filtered client-side below, cannot
 *  eat slots and leave the board rendering short of STREAK_LIMIT. */
const STREAK_OVERFETCH = 10;
const MCQ_LIMIT = 10;

/** One row, shared by both boards so they cannot drift apart again. */
interface RowData {
  key: string;
  /** Absent when the rank count query failed - the row still renders. */
  rank?: number;
  name?: string;
  photoUrl?: string | null;
  isMe: boolean;
  isSubscriber?: boolean;
  bannerTheme?: BannerThemeId;
  hideName?: boolean;
  hidePhoto?: boolean;
  primary: React.ReactNode;
  secondary?: string;
  /** Renders a "gap" marker above the row - used for the appended self row. */
  detached?: boolean;
}

interface LeaderboardVipStyle {
  containerMe: string;
  containerOther: string;
  shimmerColor: string;
  avatarRing: string;
  badgeBg: string;
  crownColor: string;
}

const LEADERBOARD_VIP_STYLES: Record<BannerThemeId, LeaderboardVipStyle> = {
  gold: {
    containerMe: 'bg-gradient-to-r from-amber-500/15 via-sky-50/80 to-amber-500/10 dark:from-amber-950/40 dark:via-sky-900/30 dark:to-amber-950/30 border-2 border-amber-400/90 dark:border-amber-500 shadow-md shadow-amber-500/10',
    containerOther: 'bg-gradient-to-r from-amber-500/[0.08] via-yellow-500/[0.04] to-slate-50 dark:from-amber-950/30 dark:via-yellow-950/20 dark:to-zinc-900 border border-amber-300/80 dark:border-amber-500/40 hover:border-amber-400 dark:hover:border-amber-400/70 shadow-xs shadow-amber-500/5',
    shimmerColor: 'via-amber-300/35 dark:via-yellow-400/20',
    avatarRing: 'bg-gradient-to-tr from-amber-400 to-yellow-300 shadow-xs shadow-amber-500/20',
    badgeBg: 'bg-gradient-to-r from-amber-500 to-yellow-500 text-white',
    crownColor: 'bg-amber-500 text-white',
  },
  pink: {
    containerMe: 'bg-gradient-to-r from-pink-500/15 via-rose-50/80 to-pink-500/10 dark:from-pink-950/40 dark:via-rose-900/30 dark:to-pink-950/30 border-2 border-pink-400/90 dark:border-pink-500 shadow-md shadow-pink-500/10',
    containerOther: 'bg-gradient-to-r from-pink-500/[0.08] via-rose-500/[0.04] to-slate-50 dark:from-pink-950/30 dark:via-rose-950/20 dark:to-zinc-900 border border-pink-300/80 dark:border-pink-500/40 hover:border-pink-400 dark:hover:border-pink-400/70 shadow-xs shadow-pink-500/5',
    shimmerColor: 'via-pink-300/35 dark:via-rose-400/20',
    avatarRing: 'bg-gradient-to-tr from-pink-400 to-rose-400 shadow-xs shadow-pink-500/20',
    badgeBg: 'bg-gradient-to-r from-pink-500 to-rose-500 text-white',
    crownColor: 'bg-pink-500 text-white',
  },
  black: {
    containerMe: 'bg-gradient-to-r from-zinc-900/25 via-slate-100 to-zinc-900/15 dark:from-zinc-950 dark:via-zinc-900 dark:to-black border-2 border-zinc-700 dark:border-zinc-500 shadow-md shadow-black/20',
    containerOther: 'bg-gradient-to-r from-zinc-800/[0.06] via-zinc-900/[0.03] to-slate-50 dark:from-zinc-900/50 dark:via-zinc-950/40 dark:to-zinc-900 border border-zinc-400/80 dark:border-zinc-700/80 hover:border-zinc-600 dark:hover:border-zinc-500 shadow-xs shadow-black/10',
    shimmerColor: 'via-white/30 dark:via-white/20',
    avatarRing: 'bg-gradient-to-tr from-zinc-700 to-black shadow-xs shadow-black/30 border border-zinc-500',
    badgeBg: 'bg-gradient-to-r from-zinc-900 to-black text-white border border-zinc-700',
    crownColor: 'bg-zinc-800 text-white border border-zinc-600',
  },
  white: {
    containerMe: 'bg-gradient-to-r from-slate-100 via-white to-slate-100 dark:from-slate-800/40 dark:via-zinc-900 dark:to-slate-800/30 border-2 border-slate-300 dark:border-slate-400 shadow-md shadow-slate-300/20 dark:shadow-black/20',
    containerOther: 'bg-gradient-to-r from-white via-slate-50 to-slate-100 dark:from-zinc-900 dark:via-slate-900/40 dark:to-zinc-900 border border-slate-300/80 dark:border-slate-500/50 hover:border-slate-400 dark:hover:border-slate-400 shadow-xs shadow-slate-300/10',
    shimmerColor: 'via-sky-300/35 dark:via-sky-400/20',
    avatarRing: 'bg-gradient-to-tr from-slate-200 via-white to-slate-300 shadow-xs border border-slate-300',
    badgeBg: 'bg-gradient-to-r from-slate-100 via-white to-slate-200 text-slate-900 border border-slate-300 shadow-xs dark:text-zinc-900',
    crownColor: 'bg-slate-200 text-slate-800 border border-slate-300',
  },
};

/** '2027-01-31' -> '2027/1/31'. */
function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${y}/${parseInt(m, 10)}/${parseInt(d, 10)}`;
}

function rankBadge(rank?: number) {
  switch (rank) {
    case 1: return <Crown className="w-5 h-5 text-yellow-500" />;
    case 2: return <Medal className="w-5 h-5 text-slate-400" />;
    case 3: return <Medal className="w-5 h-5 text-amber-700" />;
    // A detached self-row whose rank query failed still belongs on the board;
    // it just cannot say where.
    default: return <span className="font-bold text-slate-400 px-1">{rank ?? '—'}</span>;
  }
}

function LeaderboardRow({ row, isRtl, accent }: { row: RowData; isRtl: boolean; accent: 'orange' | 'sky' }) {
  const anonymous = row.hideName && !row.isMe;
  const displayName = anonymous ? (isRtl ? 'مستخدم مجهول' : 'Anonymous User') : row.name;
  const displayPhoto = row.hidePhoto && !row.isMe ? null : row.photoUrl;
  const accentText = accent === 'orange' ? 'text-orange-600 dark:text-orange-400' : 'text-sky-600 dark:text-sky-400';
  const vipStyle = row.isSubscriber ? (LEADERBOARD_VIP_STYLES[row.bannerTheme || 'gold'] || LEADERBOARD_VIP_STYLES.gold) : null;

  // Base styling classes
  let containerStyle = 'bg-slate-50 dark:bg-zinc-900 border border-transparent hover:border-slate-200 dark:hover:border-zinc-700';

  if (row.isMe && row.isSubscriber && vipStyle) {
    containerStyle = vipStyle.containerMe;
  } else if (row.isMe) {
    containerStyle = 'bg-sky-50 dark:bg-sky-900/20 border-2 border-sky-100 dark:border-sky-900/50';
  } else if (row.isSubscriber && vipStyle) {
    containerStyle = vipStyle.containerOther;
  }

  return (
    <>
      {row.detached && (
        <div className="flex justify-center py-2">
          <MoreVertical className="w-5 h-5 text-slate-300 dark:text-zinc-600" />
        </div>
      )}
      <div
        className={`group relative overflow-hidden flex items-center justify-between p-3 sm:p-4 rounded-2xl transition-all ${containerStyle}`}
      >
        {/* Shimmer animation for subscribers */}
        {row.isSubscriber && vipStyle && (
          <div className="absolute inset-0 pointer-events-none overflow-hidden rounded-2xl opacity-70 dark:opacity-40">
            <div className={`w-1/2 h-full bg-gradient-to-r from-transparent ${vipStyle.shimmerColor} to-transparent -skew-x-12 animate-[goldShimmer_4s_infinite]`} />
          </div>
        )}

        <div className="flex items-center gap-3 sm:gap-4 min-w-0 relative z-1">
          <div className="w-8 flex justify-center shrink-0">{rankBadge(row.rank)}</div>

          {displayPhoto ? (
            <div className={`relative shrink-0 rounded-full ${row.isSubscriber && vipStyle ? `p-0.5 ${vipStyle.avatarRing}` : ''}`}>
              <img
                src={displayPhoto}
                alt={displayName}
                referrerPolicy="no-referrer"
                className="w-10 h-10 rounded-full object-cover border-2 border-white dark:border-zinc-800 shadow-sm"
              />
              {row.isSubscriber && vipStyle && (
                <div className={`absolute -bottom-1 -end-1 ${vipStyle.crownColor} rounded-full p-0.5 shadow-xs border border-white dark:border-zinc-800`}>
                  <Crown className="w-2.5 h-2.5 fill-current" />
                </div>
              )}
            </div>
          ) : (
            <div className={`relative shrink-0 rounded-full ${row.isSubscriber && vipStyle ? `p-0.5 ${vipStyle.avatarRing}` : ''}`}>
              <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-sky-400 to-[#2196F3] flex items-center justify-center text-white font-bold text-lg shadow-sm border-2 border-white dark:border-zinc-800">
                {anonymous ? '?' : displayName?.charAt(0).toUpperCase()}
              </div>
              {row.isSubscriber && vipStyle && (
                <div className={`absolute -bottom-1 -end-1 ${vipStyle.crownColor} rounded-full p-0.5 shadow-xs border border-white dark:border-zinc-800`}>
                  <Crown className="w-2.5 h-2.5 fill-current" />
                </div>
              )}
            </div>
          )}

          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <h3 className={`font-bold sm:text-lg truncate ${row.isMe ? accentText : 'text-slate-800 dark:text-slate-200'}`}>
                {displayName} {row.isMe && (isRtl ? '(أنت)' : '(You)')}
              </h3>
              {row.isSubscriber && vipStyle && (
                <span
                  title={isRtl ? 'مشترك مميز' : 'VIP Subscriber'}
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] sm:text-[10px] font-black ${vipStyle.badgeBg} shadow-xs shrink-0 select-none tracking-tight`}
                >
                  <Sparkles className="w-2.5 h-2.5 fill-current" />
                  <span>{isRtl ? 'مشترك مميز' : 'VIP'}</span>
                </span>
              )}
            </div>
            {row.secondary && (
              <p className={`text-xs truncate ${row.isMe ? accentText : 'text-slate-500'}`}>{row.secondary}</p>
            )}
          </div>
        </div>

        <div className={`flex items-center gap-1.5 font-black text-lg sm:text-xl shrink-0 relative z-1 ${
          row.isMe ? accentText : 'text-slate-700 dark:text-slate-300'
        }`}>
          {row.primary}
        </div>
      </div>
    </>
  );
}

function EmptyState({ icon: Icon, text }: { icon: any; text: string }) {
  return (
    <div className="text-center py-12">
      <Icon className="w-12 h-12 text-slate-300 dark:text-zinc-600 mx-auto mb-3" />
      <p className="text-slate-500 font-medium">{text}</p>
    </div>
  );
}

export default function LeaderboardTab({ user, lang }: LeaderboardTabProps) {
  const isRtl = lang === 'ar';
  const [activeTab, setActiveTab] = useState<'streak' | 'mcq'>('streak');
  const [streakLeaders, setStreakLeaders] = useState<any[]>([]);
  const [mcqLeaders, setMcqLeaders] = useState<(UserMCQStats & { profile?: UserProfile; _rank?: number })[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  /** True when the signed-in user has not answered any MCQs yet. */
  const [mcqUnranked, setMcqUnranked] = useState(false);
  const { effectiveStageId } = useStageContext();

  // Whether the season is over is derived from the academic calendar, so the
  // board switches to the archived winners on the first day of the break
  // without waiting for the nightly rollover.
  const { phase } = useAcademicPhase();
  const isPaused = phase.isPaused;
  /** Paused AND an archive was found - the board really is showing last season. */
  const [showingArchive, setShowingArchive] = useState(false);

  /** users/{id} lookups for a list of ids, chunked to respect the 'in' limit. */
  const fetchProfiles = async (ids: string[]) => {
    const map = new Map<string, UserProfile>();
    for (let i = 0; i < ids.length; i += 10) {
      const chunk = ids.slice(i, i + 10);
      if (chunk.length === 0) continue;
      const snap = await getDocs(query(collection(db, 'users'), where(documentId(), 'in', chunk)));
      snap.forEach(d => map.set(d.id, { uid: d.id, ...d.data() } as unknown as UserProfile));
    }
    return map;
  };

  /**
   * The finished season's top list for this stage, newest archive.
   *
   * The stored array is in document order rather than rank order, so it is
   * sorted by the stored rank before being renumbered. That is correct both for
   * per-stage ranks (renumbering is a no-op) and for legacy global ranks, where
   * sorting first is what makes the per-stage order come out right.
   */
  const fetchArchivedRows = async (
    archiveId: string,
    field: 'topStudents' | 'topMcqStudents',
  ): Promise<{ rows: any[]; profiles: Map<string, UserProfile> }> => {
    const archiveDoc = await getDoc(doc(db, 'semesterArchives', archiveId));
    if (!archiveDoc.exists()) return { rows: [], profiles: new Map() };

    const archived: any[] = archiveDoc.data()[field] || [];
    const profiles = await fetchProfiles(archived.map(s => s.userId || s.uid).filter(Boolean));

    // Rows carry the stage they were RANKED IN, captured at archive time. That is
    // the only correct key for a finished season: a student who has since been
    // promoted still belongs to the board they actually played in.
    //
    // Never fall back to the viewer's live stage. Doing so filtered a past season
    // by a stage that did not exist when it was played, which empties the board
    // for every promoted student - and the renumbering below then crowned
    // whoever survived the filter as rank 1.
    //
    // Archives predating stage scoping carry no stageId on any row. Those were a
    // single cohort, so they are shown whole rather than filtered at all.
    // scripts/streakAudit.ts backfills stageId onto them; this is the guard for
    // any that have not been backfilled yet.
    const archiveHasStages = archived.some(s => s.stageId);
    const rows = archived
      .filter(s => !archiveHasStages || s.stageId === effectiveStageId)
      .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))
      // Keep the rank the season actually awarded. Renumbering a filtered subset
      // invents a podium that nobody finished on.
      .map((s, i) => ({ ...s, _rank: s.rank ?? i + 1 }));

    return { rows, profiles };
  };

  const fetchStreakBoard = async (paused: boolean, lastArchiveId: string | null) => {
    // ---- Archived season (break) -----------------------------------------
    if (paused && lastArchiveId) {
      const { rows, profiles } = await fetchArchivedRows(lastArchiveId, 'topStudents');
      setStreakLeaders(rows.map(s => {
        const live = profiles.get(s.userId || s.uid);
        return {
          ...s,
          name: live?.name || s.name,
          photoUrl: live?.photoUrl || (live as any)?.photoURL || s.photoUrl,
          hideNameOnLeaderboard: live?.hideNameOnLeaderboard ?? s.hideNameOnLeaderboard,
          hidePhotoOnLeaderboard: live?.hidePhotoOnLeaderboard ?? s.hidePhotoOnLeaderboard,
          isSubscribed: live?.isSubscribed ?? s.isSubscribed,
          subscriptionEnd: live?.subscriptionEnd ?? s.subscriptionEnd,
          subscriptionBannerTheme: live?.subscriptionBannerTheme ?? s.subscriptionBannerTheme,
        };
      }));
      return;
    }

    // ---- Live board ------------------------------------------------------
    const snap = await getDocs(query(
      collection(db, 'users'),
      where('role', '==', 'student'),
      where('stageId', '==', effectiveStageId),
      orderBy('streakCount', 'desc'),
      limit(STREAK_LIMIT + STREAK_OVERFETCH),
    ));
    // Graduated students keep read-only access in their final stage, so the
    // stage query still returns them. Filtered here rather than with a where
    // clause, because an inequality would also drop everyone lacking the field.
    // Trimmed AFTER the filter, not before: filtering a page that was already
    // cut to STREAK_LIMIT is what let a graduate consume a slot and render the
    // board one row short.
    const leaders: any[] = snap.docs
      .map(d => ({ uid: d.id, ...(d.data() as any) }))
      .filter(u => u.graduated !== true)
      .slice(0, STREAK_LIMIT)
      .map((u, i) => ({ ...u, _rank: i + 1 }));

    // Append the signed-in user below the cut if they are not already listed.
    if (user && !leaders.some(l => (l.uid || l.userId) === user.uid) && (user.streakCount || 0) > 0) {
      // Its own try/catch, the way ProfileScreen already does it. This count
      // needs a composite index of its own - two equalities plus an inequality
      // and no orderBy, so the DESC index serving the list query above does not
      // cover it. While that index was missing it threw FAILED_PRECONDITION, and
      // letting it reach the caller's catch CLEARED the twenty rows already
      // fetched: the whole board read "no students in this stage yet" for every
      // viewer outside the top 20.
      let myRank: number | undefined;
      try {
        const countSnap = await getCountFromServer(query(
          collection(db, 'users'),
          where('role', '==', 'student'),
          where('stageId', '==', effectiveStageId),
          where('streakCount', '>', user.streakCount || 0),
        ));
        myRank = countSnap.data().count + 1;
      } catch (err) {
        console.warn('Could not read streak rank:', err);
      }
      leaders.push({
        uid: user.uid, name: user.name, photoUrl: user.photoUrl,
        streakCount: user.streakCount || 0,
        // App.tsx hydrates this onto the profile; without it the detached row's
        // "best this season" subtitle reads back the current streak instead.
        longestStreak: user.longestStreak || 0,
        hideNameOnLeaderboard: user.hideNameOnLeaderboard,
        hidePhotoOnLeaderboard: user.hidePhotoOnLeaderboard,
        isSubscribed: user.isSubscribed,
        subscriptionEnd: user.subscriptionEnd,
        subscriptionBannerTheme: user.subscriptionBannerTheme,
        _rank: myRank,
        _detached: true,
      });
    }

    setStreakLeaders(leaders);
  };

  const fetchMcqBoard = async (paused: boolean, lastArchiveId: string | null) => {
    // ---- Archived season (break) -----------------------------------------
    // The reset removes mcqRankScore, so without this the MCQ tab would be
    // empty for the whole break instead of showing the season's winners.
    if (paused && lastArchiveId) {
      const { rows, profiles } = await fetchArchivedRows(lastArchiveId, 'topMcqStudents');
      setMcqUnranked(false);
      // Normalised into the live shape so the row mapper below stays single-path.
      setMcqLeaders(rows.map(s => {
        const answered = s.totalAnswered || 0;
        const correct = s.totalCorrect || 0;
        return {
          ...s,
          totalFirstAttemptCorrect: correct,
          totalFirstAttemptAnswered: answered,
          accuracy: answered > 0 ? (correct / answered) * 100 : 0,
          mcqRankScore: (s.score || 0) * 100,
          profile: profiles.get(s.userId),
        } as any;
      }));
      return;
    }

    // Ordered by mcqRankScore: accuracy first, volume as tie-break.
    // Active stage filter ensures only students currently studying in this stage
    // compete in the live race, while promoted students' scores remain archived in that stage.
    let snap: any = null;
    try {
      snap = await getDocs(query(
        collection(db, 'userStageMCQStats'),
        where('stageId', '==', effectiveStageId),
        where('isActiveInStage', '==', true),
        orderBy('mcqRankScore', 'desc'),
        limit(MCQ_LIMIT),
      ));
    } catch (err) {
      console.warn('userStageMCQStats query failed, falling back to legacy userMCQStats:', err);
    }

    // Fallback to legacy userMCQStats if userStageMCQStats failed or returned no docs
    if (!snap || snap.empty) {
      try {
        snap = await getDocs(query(
          collection(db, 'userMCQStats'),
          where('stageId', '==', effectiveStageId),
          orderBy('mcqRankScore', 'desc'),
          limit(MCQ_LIMIT),
        ));
      } catch (legacyErr) {
        console.warn('userMCQStats fallback query failed:', legacyErr);
      }
    }

    const leaders: any[] = (snap?.docs || []).map((d: any, i: number) => ({ id: d.id, ...d.data(), _rank: i + 1 }));

    setMcqUnranked(false);

    if (user && !leaders.some(l => l.userId === user.uid)) {
      try {
        // Check stage-scoped document first
        let mine = await getDoc(doc(db, 'userStageMCQStats', `${user.uid}_${effectiveStageId}`));
        let data = mine.exists() ? mine.data() : null;

        // Fallback to legacy userMCQStats if stage-specific doc is absent
        if (!data) {
          try {
            mine = await getDoc(doc(db, 'userMCQStats', user.uid));
            data = mine.exists() && mine.data().stageId === effectiveStageId ? mine.data() : null;
          } catch (e) {
            console.warn('Could not read userMCQStats personal doc:', e);
          }
        }

        if (data?.mcqRankScore != null) {
          let myRank: number | undefined;
          try {
            const countSnap = await getCountFromServer(query(
              collection(db, 'userStageMCQStats'),
              where('stageId', '==', effectiveStageId),
              where('isActiveInStage', '==', true),
              where('mcqRankScore', '>', data.mcqRankScore),
            ));
            myRank = countSnap.data().count + 1;
          } catch (err) {
            // Fallback rank count on legacy if userStageMCQStats count fails
            try {
              const countSnap = await getCountFromServer(query(
                collection(db, 'userMCQStats'),
                where('stageId', '==', effectiveStageId),
                where('mcqRankScore', '>', data.mcqRankScore),
              ));
              myRank = countSnap.data().count + 1;
            } catch {
              console.warn('Could not read MCQ rank:', err);
            }
          }
          leaders.push({ id: mine.id, ...data, _rank: myRank, _detached: true });
        } else {
          // No answers yet in this stage - nothing to rank.
          setMcqUnranked(true);
        }
      } catch (err) {
        console.warn('Could not evaluate user detached MCQ rank:', err);
        setMcqUnranked(true);
      }
    }

    try {
      const profiles = await fetchProfiles(leaders.map(l => l.userId).filter(Boolean));
      setMcqLeaders(leaders.map(stat => ({ ...stat, profile: profiles.get(stat.userId) })));
    } catch (profErr) {
      console.warn('Could not fetch profiles for MCQ leaderboard:', profErr);
      setMcqLeaders(leaders.map(stat => ({ ...stat, profile: undefined })));
    }
  };

  const fetchLeaderboard = async () => {
    // where('stageId', '==', null) is not an error - it matches nothing, so it
    // renders the same "no students in this stage" as a genuinely empty stage.
    // A master admin whose picker has not resolved yet lands here while
    // StageSettings shows stage 1 as selected, which reads as a broken board.
    if (!effectiveStageId) {
      setStreakLeaders([]);
      setMcqLeaders([]);
      setLoading(false);
      setRefreshing(false);
      return;
    }
    setLoading(true);
    try {
      // Which archive to show still comes from app_settings; WHETHER to show it
      // comes from the calendar.
      const settings = await getDoc(doc(db, 'app_settings', 'streak'));
      const lastArchiveId = settings.exists() ? settings.data().lastArchiveId : null;

      setShowingArchive(isPaused && !!lastArchiveId);

      if (activeTab === 'streak') {
        await fetchStreakBoard(isPaused, lastArchiveId);
      } else {
        await fetchMcqBoard(isPaused, lastArchiveId);
      }
    } catch (error) {
      console.error('Error fetching leaderboard:', error);
      // Clear rather than leave another stage's board on screen.
      if (activeTab === 'streak') setStreakLeaders([]); else setMcqLeaders([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  // Refetch on tab or stage change. Both boards are cleared first so a slow
  // request can never leave the previous stage's names visible.
  const lastKeyRef = useRef('');
  useEffect(() => {
    const key = `${activeTab}:${effectiveStageId}:${isPaused}`;
    if (lastKeyRef.current !== key) {
      lastKeyRef.current = key;
      setStreakLeaders([]);
      setMcqLeaders([]);
    }
    fetchLeaderboard();
  }, [activeTab, effectiveStageId, isPaused]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchLeaderboard();
  };

  const streakRows: RowData[] = streakLeaders.map(l => ({
    key: `${l.uid || l.userId}-${l._rank}`,
    rank: l._rank,
    name: l.name,
    photoUrl: l.photoUrl || l.photoURL,
    isMe: user?.uid === (l.uid || l.userId),
    isSubscriber: hasLiveSubscription(l),
    bannerTheme: ((user?.uid === (l.uid || l.userId) ? user.subscriptionBannerTheme : null) || l.subscriptionBannerTheme || 'gold') as BannerThemeId,
    hideName: l.hideNameOnLeaderboard,
    hidePhoto: l.hidePhotoOnLeaderboard,
    detached: l._detached,
    primary: <><Flame className="w-5 h-5 text-orange-500" />{l.streakCount || 0}</>,
    // The season's peak, not the headline a second time. Archived rows already
    // carry longestStreak (shared/seasonReset.ts writes it onto topStudents[])
    // and it was never shown anywhere; live rows read it off the user doc.
    secondary: `${isRtl ? 'أطول هذا الموسم' : 'best this season'}: ${Math.max(l.longestStreak || 0, l.streakCount || 0)} ${isRtl ? 'يوم' : 'days'}`,
  }));

  const mcqRows: RowData[] = mcqLeaders.map(l => ({
    key: `${l.userId}-${l._rank}`,
    rank: l._rank,
    name: l.profile?.name,
    photoUrl: l.profile?.photoUrl || (l.profile as any)?.photoURL,
    isMe: user?.uid === l.userId,
    isSubscriber: hasLiveSubscription(l.profile || (user?.uid === l.userId ? user : l)),
    bannerTheme: ((user?.uid === l.userId ? user.subscriptionBannerTheme : null) || l.profile?.subscriptionBannerTheme || (l as any).subscriptionBannerTheme || 'gold') as BannerThemeId,
    hideName: l.profile?.hideNameOnLeaderboard,
    hidePhoto: l.profile?.hidePhotoOnLeaderboard,
    detached: (l as any)._detached,
    // Headline is the ranking score itself, so the list visibly descends by the
    // number shown. Effort and precision are both spelled out underneath.
    primary: (() => {
      const rawScore = (l as any).mcqRankScore || 0;
      const cleanScore = rawScore > 100000 && (l.totalFirstAttemptAnswered || 0) > 0
        ? Math.round(((l.totalFirstAttemptCorrect || 0) * (l.totalFirstAttemptCorrect || 0)) / l.totalFirstAttemptAnswered)
        : Math.round(rawScore / 100);
      return <>{cleanScore}<span className="text-sm font-medium pe-1">{isRtl ? 'نقطة' : 'pts'}</span></>;
    })(),
    secondary: `${l.totalFirstAttemptCorrect}/${l.totalFirstAttemptAnswered} ${isRtl ? 'صحيحة' : 'correct'} • ${Math.round(l.accuracy)}% ${isRtl ? 'دقة' : 'accuracy'}`,
  }));

  const rows = activeTab === 'streak' ? streakRows : mcqRows;
  const accent = activeTab === 'streak' ? 'orange' : 'sky';

  return (
    <div className="max-w-2xl mx-auto relative" dir={isRtl ? 'rtl' : 'ltr'}>
      <style>{`
        @keyframes goldShimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(200%); }
        }
      `}</style>
      <div className="flex items-center gap-2 mb-4 mx-2">
        <div className="flex bg-slate-200 dark:bg-zinc-800 p-1 rounded-xl flex-1">
          <button
            onClick={() => setActiveTab('streak')}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-bold rounded-lg transition-all ${activeTab === 'streak' ? 'bg-white dark:bg-zinc-700 text-orange-600 shadow-sm' : 'text-slate-500 hover:text-slate-700 dark:text-zinc-400 dark:hover:text-zinc-200'}`}
          >
            <Flame className="w-4 h-4" />
            {isRtl ? 'الستريك' : 'Streak'}
          </button>
          <button
            onClick={() => setActiveTab('mcq')}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-bold rounded-lg transition-all ${activeTab === 'mcq' ? 'bg-white dark:bg-zinc-700 text-sky-600 shadow-sm' : 'text-slate-500 hover:text-slate-700 dark:text-zinc-400 dark:hover:text-zinc-200'}`}
          >
            <Target className="w-4 h-4" />
            {isRtl ? 'دقة MCQ' : 'MCQ Accuracy'}
          </button>
        </div>
        <button onClick={handleRefresh} className="p-3 bg-white dark:bg-zinc-800 text-slate-500 hover:text-sky-500 rounded-xl shadow-sm border border-slate-200 dark:border-zinc-700">
          <RefreshCw className={`w-5 h-5 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="bg-white dark:bg-zinc-800 rounded-3xl p-4 sm:p-6 shadow-sm border border-slate-200 dark:border-zinc-700">
        {isPaused && (
          <div className="mb-4 bg-sky-50 dark:bg-sky-900/20 text-sky-700 dark:text-sky-300 px-4 py-3 rounded-2xl flex items-start gap-3 text-sm font-bold border border-sky-100 dark:border-sky-800">
            <Palmtree className="w-5 h-5 text-sky-500 shrink-0 mt-0.5" />
            <span>
              {showingArchive
                ? (isRtl
                    ? `انتهى ${phase.term ? `«${phase.term.nameAr}»` : 'الموسم'}، شكرًا لجهودكم. هذه نتائج الموسم الماضي لمرحلتكم.`
                    : `${phase.term ? `"${phase.term.nameEn}"` : 'The season'} has ended. Showing last season's results for your stage.`)
                : (isRtl
                    ? 'المنافسة متوقفة خلال العطلة، والستريك لا يُحتسب.'
                    : 'The competition is paused for the break and streaks are not counting.')}
              {phase.nextStart && (
                <span className="block font-medium opacity-90 mt-0.5">
                  {isRtl
                    ? `يبدأ الموسم الجديد في ${formatDate(phase.nextStart)}.`
                    : `The new season opens on ${formatDate(phase.nextStart)}.`}
                </span>
              )}
            </span>
          </div>
        )}

        {loading && !refreshing ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <Loader2 className="w-8 h-8 text-sky-600 dark:text-sky-400 animate-spin" />
          </div>
        ) : rows.length === 0 ? (
          !effectiveStageId ? (
            <EmptyState
              icon={Users}
              text={isRtl
                ? 'اختر المرحلة من الإعدادات لعرض لوحة الصدارة'
                : 'Pick a stage in Settings to see the leaderboard'}
            />
          ) : activeTab === 'mcq' && mcqUnranked ? (
            <EmptyState
              icon={Target}
              text={isRtl
                ? 'بعدك ما حليت ولا سؤال، ابدأ حتى تدخل التصنيف'
                : 'No MCQ attempts yet - start solving to enter the ranking'}
            />
          ) : (
            <EmptyState
              icon={activeTab === 'streak' ? Users : Target}
              text={isRtl ? 'لا يوجد طلاب في هذه المرحلة بعد' : 'No students in this stage yet'}
            />
          )
        ) : (
          <>
            {/* Podium is reserved for the archived season view. */}
            {showingArchive && (
              activeTab === 'streak'
                ? <Podium topStudents={streakLeaders.slice(0, 3)} isRtl={isRtl} type="streak" />
                : <Podium topStudents={mcqLeaders.slice(0, 3)} isRtl={isRtl} type="mcq" />
            )}

            <div className="space-y-3">
              {rows.map(row => (
                <React.Fragment key={row.key}>
                  <LeaderboardRow row={row} isRtl={isRtl} accent={accent} />
                </React.Fragment>
              ))}
            </div>

            {activeTab === 'mcq' && mcqUnranked && (
              <p className="mt-4 text-center text-xs text-slate-500 dark:text-slate-400">
                {isRtl
                  ? 'ابدأ بحل الأسئلة حتى تدخل التصنيف'
                  : 'Start solving questions to enter the ranking'}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
