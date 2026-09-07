import React, { useEffect, useState, useRef } from 'react';
import { collection, query, orderBy, limit, getDocs, where, documentId, getCountFromServer, doc, getDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { UserProfile, Language } from '../types';
import { Flame, Medal, Crown, Loader2, Target, RefreshCw, Palmtree, MoreVertical, Users } from 'lucide-react';
import { UserMCQStats } from '../types/mcq.types';
import Podium from './ui/Podium';
import { useStageContext } from '../contexts/StageContext';
import { useAcademicPhase } from '../hooks/useAcademicPhase';

interface LeaderboardTabProps {
  user: UserProfile | null;
  lang: Language;
}

const STREAK_LIMIT = 20;
const MCQ_LIMIT = 10;

/** One row, shared by both boards so they cannot drift apart again. */
interface RowData {
  key: string;
  rank: number;
  name?: string;
  photoUrl?: string | null;
  isMe: boolean;
  hideName?: boolean;
  hidePhoto?: boolean;
  primary: React.ReactNode;
  secondary?: string;
  /** Renders a "gap" marker above the row - used for the appended self row. */
  detached?: boolean;
}

/** '2027-01-31' -> '2027/1/31'. */
function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${y}/${parseInt(m, 10)}/${parseInt(d, 10)}`;
}

function rankBadge(rank: number) {
  switch (rank) {
    case 1: return <Crown className="w-5 h-5 text-yellow-500" />;
    case 2: return <Medal className="w-5 h-5 text-slate-400" />;
    case 3: return <Medal className="w-5 h-5 text-amber-700" />;
    default: return <span className="font-bold text-slate-400 px-1">{rank}</span>;
  }
}

function LeaderboardRow({ row, isRtl, accent }: { row: RowData; isRtl: boolean; accent: 'orange' | 'sky' }) {
  const anonymous = row.hideName && !row.isMe;
  const displayName = anonymous ? (isRtl ? 'مستخدم مجهول' : 'Anonymous User') : row.name;
  const displayPhoto = row.hidePhoto && !row.isMe ? null : row.photoUrl;
  const accentText = accent === 'orange' ? 'text-orange-600 dark:text-orange-400' : 'text-sky-600 dark:text-sky-400';

  return (
    <>
      {row.detached && (
        <div className="flex justify-center py-2">
          <MoreVertical className="w-5 h-5 text-slate-300 dark:text-zinc-600" />
        </div>
      )}
      <div
        className={`flex items-center justify-between p-3 sm:p-4 rounded-2xl transition-all ${
          row.isMe
            ? 'bg-sky-50 dark:bg-sky-900/20 border-2 border-sky-100 dark:border-sky-900/50'
            : 'bg-slate-50 dark:bg-zinc-900 border border-transparent hover:border-slate-200 dark:hover:border-zinc-700'
        }`}
      >
        <div className="flex items-center gap-3 sm:gap-4 min-w-0">
          <div className="w-8 flex justify-center shrink-0">{rankBadge(row.rank)}</div>

          {displayPhoto ? (
            <img
              src={displayPhoto}
              alt={displayName}
              referrerPolicy="no-referrer"
              className="w-10 h-10 rounded-full object-cover border-2 border-white dark:border-zinc-800 shadow-sm shrink-0"
            />
          ) : (
            <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-sky-400 to-[#2196F3] flex items-center justify-center text-white font-bold text-lg shadow-sm border-2 border-white dark:border-zinc-800 shrink-0">
              {anonymous ? '?' : displayName?.charAt(0).toUpperCase()}
            </div>
          )}

          <div className="min-w-0">
            <h3 className={`font-bold sm:text-lg truncate ${row.isMe ? accentText : 'text-slate-800 dark:text-slate-200'}`}>
              {displayName} {row.isMe && (isRtl ? '(أنت)' : '(You)')}
            </h3>
            {row.secondary && (
              <p className={`text-xs truncate ${row.isMe ? accentText : 'text-slate-500'}`}>{row.secondary}</p>
            )}
          </div>
        </div>

        <div className={`flex items-center gap-1.5 font-black text-lg sm:text-xl shrink-0 ${
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
      limit(STREAK_LIMIT),
    ));
    // Graduated students keep read-only access in their final stage, so the
    // stage query still returns them. Filtered here rather than with a where
    // clause, because an inequality would also drop everyone lacking the field.
    const leaders: any[] = snap.docs
      .map(d => ({ uid: d.id, ...(d.data() as any) }))
      .filter(u => u.graduated !== true)
      .map((u, i) => ({ ...u, _rank: i + 1 }));

    // Append the signed-in user below the cut if they are not already listed.
    if (user && !leaders.some(l => (l.uid || l.userId) === user.uid) && (user.streakCount || 0) > 0) {
      const countSnap = await getCountFromServer(query(
        collection(db, 'users'),
        where('role', '==', 'student'),
        where('stageId', '==', effectiveStageId),
        where('streakCount', '>', user.streakCount || 0),
      ));
      leaders.push({
        uid: user.uid, name: user.name, photoUrl: user.photoUrl,
        streakCount: user.streakCount || 0,
        hideNameOnLeaderboard: user.hideNameOnLeaderboard,
        hidePhotoOnLeaderboard: user.hidePhotoOnLeaderboard,
        _rank: countSnap.data().count + 1,
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

    // Ordered by mcqRankScore: accuracy first, volume as tie-break. Documents
    // without the field (under the qualifying threshold) are skipped by orderBy.
    const snap = await getDocs(query(
      collection(db, 'userMCQStats'),
      where('stageId', '==', effectiveStageId),
      orderBy('mcqRankScore', 'desc'),
      limit(MCQ_LIMIT),
    ));
    const leaders: any[] = snap.docs.map((d, i) => ({ id: d.id, ...d.data(), _rank: i + 1 }));

    setMcqUnranked(false);

    if (user && !leaders.some(l => l.userId === user.uid)) {
      const mine = await getDoc(doc(db, 'userMCQStats', user.uid));
      const data = mine.exists() ? mine.data() : null;

      if (data?.mcqRankScore != null) {
        const countSnap = await getCountFromServer(query(
          collection(db, 'userMCQStats'),
          where('stageId', '==', effectiveStageId),
          where('mcqRankScore', '>', data.mcqRankScore),
        ));
        leaders.push({ id: mine.id, ...data, _rank: countSnap.data().count + 1, _detached: true });
      } else {
        // No answers yet - nothing to rank.
        setMcqUnranked(true);
      }
    }

    const profiles = await fetchProfiles(leaders.map(l => l.userId).filter(Boolean));
    setMcqLeaders(leaders.map(stat => ({ ...stat, profile: profiles.get(stat.userId) })));
  };

  const fetchLeaderboard = async () => {
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
    hideName: l.hideNameOnLeaderboard,
    hidePhoto: l.hidePhotoOnLeaderboard,
    detached: l._detached,
    primary: <><Flame className="w-5 h-5 text-orange-500" />{l.streakCount || 0}</>,
    secondary: `${l.streakCount || 0} ${isRtl ? 'أيام' : 'days'}`,
  }));

  const mcqRows: RowData[] = mcqLeaders.map(l => ({
    key: `${l.userId}-${l._rank}`,
    rank: l._rank!,
    name: l.profile?.name,
    photoUrl: l.profile?.photoUrl || (l.profile as any)?.photoURL,
    isMe: user?.uid === l.userId,
    hideName: l.profile?.hideNameOnLeaderboard,
    hidePhoto: l.profile?.hidePhotoOnLeaderboard,
    detached: (l as any)._detached,
    // Headline is the ranking score itself, so the list visibly descends by the
    // number shown. Effort and precision are both spelled out underneath.
    primary: <>{Math.round(((l as any).mcqRankScore || 0) / 100)}<span className="text-sm font-medium pe-1">{isRtl ? 'نقطة' : 'pts'}</span></>,
    secondary: `${l.totalFirstAttemptCorrect}/${l.totalFirstAttemptAnswered} ${isRtl ? 'صحيحة' : 'correct'} • ${Math.round(l.accuracy)}% ${isRtl ? 'دقة' : 'accuracy'}`,
  }));

  const rows = activeTab === 'streak' ? streakRows : mcqRows;
  const accent = activeTab === 'streak' ? 'orange' : 'sky';

  return (
    <div className="max-w-2xl mx-auto relative" dir={isRtl ? 'rtl' : 'ltr'}>
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
          activeTab === 'mcq' && mcqUnranked ? (
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
