import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Sparkles } from 'lucide-react';
import { hasLiveSubscription } from '../../../shared/subscriptionAccess';
import { BannerThemeId } from '../../hooks/useSubscriptionBannerTheme';

interface PodiumProps {
  topStudents: any[];
  isRtl: boolean;
  type: 'streak' | 'mcq';
}

const PODIUM_VIP_THEMES: Record<BannerThemeId, {
  ringBorder: string;
  badgeBg: string;
  haloAnimation: string;
}> = {
  gold: {
    ringBorder: 'border-amber-400',
    badgeBg: 'bg-gradient-to-r from-amber-500 to-yellow-400 text-white',
    haloAnimation: 'subscriberHaloGold 2.5s infinite',
  },
  pink: {
    ringBorder: 'border-pink-400',
    badgeBg: 'bg-gradient-to-r from-pink-500 to-rose-400 text-white',
    haloAnimation: 'subscriberHaloPink 2.5s infinite',
  },
  black: {
    ringBorder: 'border-zinc-700 dark:border-zinc-500',
    badgeBg: 'bg-gradient-to-r from-zinc-900 to-neutral-800 text-zinc-100 border border-zinc-700',
    haloAnimation: 'subscriberHaloBlack 2.5s infinite',
  },
  white: {
    ringBorder: 'border-slate-300 dark:border-slate-200',
    badgeBg: 'bg-gradient-to-r from-slate-100 to-white text-slate-800 border border-slate-300 shadow-xs',
    haloAnimation: 'subscriberHaloWhite 2.5s infinite',
  },
};

export default function Podium({ topStudents, isRtl, type }: PodiumProps) {
  const [showConfetti, setShowConfetti] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setShowConfetti(false), 1500);
    return () => clearTimeout(timer);
  }, []);

  if (!topStudents || topStudents.length === 0) return null;

  const first = topStudents[0];
  const second = topStudents[1];
  const third = topStudents[2];

  const podiumOrder = [];
  // For RTL visual layout: Second is on Visual Right, so it comes FIRST in Arabic dom order.
  // Wait, if it's flex-row and dir="rtl", items flow Right to Left.
  // So array [2nd, 1st, 3rd] will render 2nd on right, 1st in middle, 3rd on left.
  if (second) podiumOrder.push({ ...second, place: 2 });
  if (first) podiumOrder.push({ ...first, place: 1 });
  if (third) podiumOrder.push({ ...third, place: 3 });

  const formatName = (name: string) => {
    if (!name) return '';
    const firstPart = name.split(' ')[0];
    return firstPart.length > 8 ? firstPart.substring(0, 8) + '...' : firstPart;
  };

  const getScoreLabel = (student: any) => {
    if (type === 'streak') {
      return `🔥 ${student.streakCount || 0} ${isRtl ? 'يوم' : 'days'}`;
    }
    // The ranking score (correct x accuracy), matching the headline number on
    // the board itself. mcqLeaderboardScore is the legacy volume metric and is
    // absent from season archives, so it is only a fallback.
    let score = student.mcqRankScore != null
      ? student.mcqRankScore / 100
      : (student.score ?? student.mcqLeaderboardScore ?? 0);
    if (score > 1000 && (student.totalFirstAttemptAnswered || student.totalAnswered || 0) > 0) {
      const correct = student.totalFirstAttemptCorrect ?? student.totalCorrect ?? 0;
      const answered = student.totalFirstAttemptAnswered ?? student.totalAnswered ?? 1;
      score = (correct * correct) / answered;
    }
    return `🎯 ${Math.round(score)} ${isRtl ? 'نقطة' : 'pts'}`;
  };

  const getAvatarFallback = (name: string) => name ? name.charAt(0).toUpperCase() : '?';

  return (
    <div className="relative pt-12 pb-4 flex justify-center items-end gap-2 sm:gap-4 overflow-hidden">
      <style>{`
        @keyframes crownPulse {
          0% { transform: translateY(-4px); }
          100% { transform: translateY(0px); }
        }
        @keyframes starGlow {
          0% { box-shadow: 0 0 10px #FFD70040; }
          50% { box-shadow: 0 0 25px #FFD70080; }
          100% { box-shadow: 0 0 10px #FFD70040; }
        }
        @keyframes subscriberHaloGold {
          0% { box-shadow: 0 0 12px #FFD70060, 0 0 0 2px #FFD700; }
          50% { box-shadow: 0 0 25px #FFD700B0, 0 0 0 3px #FFD700; }
          100% { box-shadow: 0 0 12px #FFD70060, 0 0 0 2px #FFD700; }
        }
        @keyframes subscriberHaloPink {
          0% { box-shadow: 0 0 12px #EC489960, 0 0 0 2px #EC4899; }
          50% { box-shadow: 0 0 25px #EC4899B0, 0 0 0 3px #EC4899; }
          100% { box-shadow: 0 0 12px #EC489960, 0 0 0 2px #EC4899; }
        }
        @keyframes subscriberHaloBlack {
          0% { box-shadow: 0 0 12px #18181B70, 0 0 0 2px #3F3F46; }
          50% { box-shadow: 0 0 25px #18181BB0, 0 0 0 3px #52525B; }
          100% { box-shadow: 0 0 12px #18181B70, 0 0 0 2px #3F3F46; }
        }
        @keyframes subscriberHaloWhite {
          0% { box-shadow: 0 0 12px #E2E8F080, 0 0 0 2px #CBD5E1; }
          50% { box-shadow: 0 0 25px #FFFFFFB0, 0 0 0 3px #FFFFFF; }
          100% { box-shadow: 0 0 12px #E2E8F080, 0 0 0 2px #CBD5E1; }
        }
        @keyframes confettiFall {
          0% { transform: translateY(-30px) rotate(0deg); opacity: 1; }
          100% { transform: translateY(100px) rotate(360deg); opacity: 0; }
        }
        .confetti-particle {
          position: absolute;
          width: 8px;
          height: 8px;
          top: 0;
          animation: confettiFall 1.5s ease-out forwards;
        }
      `}</style>

      {showConfetti && (
        <div className="absolute inset-0 pointer-events-none overflow-hidden z-20">
          {[...Array(8)].map((_, i) => (
            <div 
              key={i}
              className="confetti-particle"
              style={{
                left: `${20 + Math.random() * 60}%`,
                backgroundColor: i % 2 === 0 ? '#FFD700' : '#C0C0C0',
                animationDelay: `${Math.random() * 0.2}s`
              }}
            />
          ))}
        </div>
      )}

      {podiumOrder.map((student, idx) => {
        const isFirst = student.place === 1;
        const isSecond = student.place === 2;
        const isThird = student.place === 3;

        let heightClass = '';
        let gradientClass = '';
        let borderClass = '';
        let ringClass = '';
        let textClass = '';

        if (isFirst) {
          heightClass = 'h-[80px]';
          gradientClass = 'bg-gradient-to-t from-amber-500 to-yellow-400';
          borderClass = 'border-yellow-200';
          ringClass = 'border-4 border-[#FFD700]';
          textClass = 'text-yellow-600 dark:text-yellow-500';
        } else if (isSecond) {
          heightClass = 'h-[55px]';
          gradientClass = 'bg-gradient-to-t from-slate-400 to-slate-300';
          borderClass = 'border-slate-100';
          ringClass = 'border-4 border-[#C0C0C0]';
          textClass = 'text-slate-600 dark:text-slate-400';
        } else {
          heightClass = 'h-[40px]';
          gradientClass = 'bg-gradient-to-t from-orange-500 to-amber-600';
          borderClass = 'border-orange-200';
          ringClass = 'border-4 border-[#CD7F32]';
          textClass = 'text-orange-700 dark:text-orange-500';
        }

        const rawName = student.name || (student.profile ? student.profile.name : '');
        const hideName = student.hideNameOnLeaderboard || (student.profile ? student.profile.hideNameOnLeaderboard : false);
        const displayName = hideName ? (isRtl ? 'مستخدم مجهول' : 'Anon') : formatName(rawName);
        const hidePhoto = student.hidePhotoOnLeaderboard || (student.profile ? student.profile.hidePhotoOnLeaderboard : false);
        const displayPhoto = hidePhoto ? null : ((student.photoUrl || student.photoURL) || (student.profile ? (student.profile.photoUrl || student.profile.photoURL) : null));
        const isSubscriber = hasLiveSubscription(student) || hasLiveSubscription(student.profile);
        const vipThemeKey: BannerThemeId = (student.subscriptionBannerTheme || student.profile?.subscriptionBannerTheme || 'gold') as BannerThemeId;
        const vipTheme = PODIUM_VIP_THEMES[vipThemeKey] || PODIUM_VIP_THEMES.gold;
        const finalRingClass = isSubscriber && !isFirst ? `border-4 ${vipTheme.ringBorder}` : ringClass;

        return (
          <motion.div 
            key={`${student.userId || student.uid || 'podium'}-${idx}`}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: student.place * 0.1 }}
            className="flex flex-col items-center relative"
            style={{ zIndex: isFirst ? 10 : 1 }}
          >
            {isFirst && (
              <div 
                className="absolute -top-10 text-2xl"
                style={{ animation: 'crownPulse 1.5s ease-in-out infinite alternate' }}
              >
                👑
              </div>
            )}
            
            <div className={`relative mb-2 rounded-full ${finalRingClass} overflow-hidden bg-white dark:bg-zinc-800 shadow-lg`}
                 style={isFirst ? { animation: 'starGlow 2s infinite' } : isSubscriber ? { animation: vipTheme.haloAnimation } : {}}
            >
              <div className={`${isFirst ? 'w-16 h-16 sm:w-20 sm:h-20' : 'w-12 h-12 sm:w-16 sm:h-16'} flex items-center justify-center bg-slate-100 dark:bg-zinc-800`}>
                {displayPhoto ? (
                  <img src={displayPhoto} alt={displayName} className="w-full h-full object-cover"  referrerPolicy="no-referrer" />
                ) : (
                  <span className="text-xl sm:text-2xl font-black text-slate-400">
                    {getAvatarFallback(displayName)}
                  </span>
                )}
              </div>
            </div>

            <div className="flex items-center justify-center gap-1 mb-1 max-w-[110px] sm:max-w-[130px]">
              <span className={`font-bold block truncate text-center ${isFirst ? 'text-[14px] sm:text-[15px]' : 'text-[12px] sm:text-[13px]'} text-slate-800 dark:text-slate-200`}>
                {displayName}
              </span>
              {isSubscriber && (
                <span
                  title={isRtl ? 'مشترك مميز' : 'VIP'}
                  className={`inline-flex items-center gap-0.5 px-1 py-0.2 rounded-full text-[8px] sm:text-[9px] font-black ${vipTheme.badgeBg} shadow-xs shrink-0 select-none`}
                >
                  <Sparkles className="w-2 h-2 fill-current" />
                  <span>VIP</span>
                </span>
              )}
            </div>

            <div className="bg-white/80 dark:bg-zinc-800/80 backdrop-blur-sm px-2 py-0.5 rounded-full mb-2 border border-slate-200/50 dark:border-zinc-700/50 shadow-sm">
              <span className={`text-[10px] sm:text-xs font-black ${textClass}`}>
                {getScoreLabel(student)}
              </span>
            </div>

            <div className={`w-20 sm:w-28 rounded-t-xl shadow-inner border-t ${gradientClass} ${borderClass} ${heightClass} flex justify-center pt-2`}>
              {isFirst && <span className="text-white/90 font-black text-xl sm:text-2xl drop-shadow-sm">1</span>}
              {isSecond && <span className="text-white/90 font-black text-lg sm:text-xl drop-shadow-sm">2</span>}
              {isThird && <span className="text-white/90 font-black text-lg sm:text-xl drop-shadow-sm">3</span>}
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}
