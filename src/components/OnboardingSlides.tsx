import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Sparkles,
  Bot,
  Languages,
  HelpCircle,
  HardDrive,
  Trophy,
  Crown,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  X,
  Flame,
  FileText,
  Volume2,
  Play,
  Pause,
  Clock,
  BookOpen
} from 'lucide-react';
import { Language } from '../types';

interface OnboardingSlidesProps {
  onComplete: () => void;
  lang?: Language;
}

// ---------------------------------------------------------------------------
// Lifelike Interactive Micro-UI Previews (Mimicking Mohadaraty's Real Surfaces)
// ---------------------------------------------------------------------------

function LecturesPreview({ isRtl }: { isRtl: boolean }) {
  return (
    <div className="w-full max-w-sm mx-auto bg-white dark:bg-zinc-900 border-2 border-slate-100 dark:border-zinc-800 rounded-2xl p-3 sm:p-3.5 shadow-sm text-start">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-xs font-black px-2.5 py-0.5 rounded-full bg-sky-50 dark:bg-sky-950/40 text-sky-600 dark:text-sky-400 border border-sky-100 dark:border-sky-800/40">
          {isRtl ? 'علم الأدوية • Pharmacology' : 'Pharmacology • Stage 3'}
        </span>
        <span className="text-[11px] font-bold text-slate-400 dark:text-slate-500">
          {isRtl ? 'المرحلة الثالثة' : 'Stage 3'}
        </span>
      </div>

      <div className="font-black text-xs sm:text-sm text-slate-900 dark:text-white leading-snug mb-1">
        Autonomic Nervous System: Cholinergic Drugs
      </div>

      <div className="text-[11px] sm:text-xs font-medium text-slate-500 dark:text-slate-400 mb-2.5 flex items-center gap-1.5">
        <span>{isRtl ? 'د. حيدر المعموري' : 'Dr. Haider Al-Mamouri'}</span>
        <span>•</span>
        <span>{isRtl ? 'المحاضرة 4' : 'Lecture 4'}</span>
      </div>

      <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-zinc-800 text-[11px] sm:text-xs font-bold">
        <div className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
          <span className="inline-flex items-center gap-1 bg-slate-100 dark:bg-zinc-800 px-2 py-0.5 rounded-md">
            <FileText className="w-3.5 h-3.5 text-sky-500" />
            {isRtl ? '32 صفحة' : '32 pages'}
          </span>
          <span className="inline-flex items-center gap-1 bg-slate-100 dark:bg-zinc-800 px-2 py-0.5 rounded-md">
            <Volume2 className="w-3.5 h-3.5 text-emerald-500" />
            {isRtl ? '45:20 د' : '45:20 min'}
          </span>
        </div>
        <span className="text-emerald-600 dark:text-emerald-400 font-extrabold flex items-center gap-1">
          <CheckCircle2 className="w-3.5 h-3.5" />
          {isRtl ? 'محدثة رسمياً' : 'Updated'}
        </span>
      </div>
    </div>
  );
}

function SimosanPreview({ isRtl }: { isRtl: boolean }) {
  const [showQuiz, setShowQuiz] = useState(false);

  return (
    <div className="w-full max-w-sm mx-auto bg-white dark:bg-zinc-900 border-2 border-slate-100 dark:border-zinc-800 rounded-2xl p-3 sm:p-3.5 shadow-sm text-start">
      {/* Mini Slide excerpt */}
      <div className="p-2 sm:p-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800/60 border border-slate-100 dark:border-zinc-800 text-xs sm:text-sm font-mono text-slate-700 dark:text-slate-300 mb-2">
        <div className="text-[10px] font-sans font-bold text-slate-400 mb-0.5">
          {isRtl ? 'شريحة 14 / Slide 14' : 'Slide 14'}
        </div>
        <div className="font-semibold text-slate-800 dark:text-slate-200 font-sans leading-snug">
          "First-pass hepatic metabolism significantly reduces systemic bioavailability."
        </div>
      </div>

      {/* Simosan bubble */}
      <div className="flex items-start gap-2 bg-violet-50/80 dark:bg-violet-950/30 border border-violet-100 dark:border-violet-900/40 rounded-xl p-2.5 sm:p-3">
        <div className="w-7 h-7 rounded-lg bg-violet-100 dark:bg-violet-900/50 text-violet-600 dark:text-violet-300 flex items-center justify-center shrink-0 mt-0.5">
          <Bot className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs sm:text-[13px] font-black text-violet-900 dark:text-violet-200">
              {isRtl ? 'سيموسان (معلمك الذكي)' : 'Simosan AI Tutor'}
            </span>
            <span className="text-[10px] font-bold text-violet-600 dark:text-violet-400 bg-violet-100/70 dark:bg-violet-900/50 px-1.5 py-0.5 rounded">
              {isRtl ? 'شرح فوري' : 'Instant note'}
            </span>
          </div>
          <p className="text-xs sm:text-[13px] font-medium text-violet-950 dark:text-violet-100 leading-relaxed mb-2">
            {isRtl
              ? '💡 الكبد يستقلب جزءاً كبيراً من الدواء قبل وصوله للدم، لذلك الجرعة الفموية تكون أكبر من الوريدية لنفس التأثير.'
              : '💡 The liver metabolizes a fraction of oral drugs before reaching circulation, which is why oral doses often exceed IV doses.'}
          </p>
          <button
            type="button"
            onClick={() => setShowQuiz(q => !q)}
            className="inline-flex items-center gap-1 text-xs font-bold text-violet-700 dark:text-violet-300 bg-white dark:bg-zinc-900 px-2.5 py-1 rounded-lg border border-violet-200 dark:border-violet-800 cursor-pointer active:scale-95 transition-all shadow-xs"
          >
            <span>{showQuiz ? (isRtl ? 'أحسنت! الإجابة صحيحة 🎉' : 'Great! Correct recall 🎉') : (isRtl ? 'اختبر فهمك بسؤال سريع 🧠' : 'Quick check quiz 🧠')}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function TranslationPreview({ isRtl }: { isRtl: boolean }) {
  const [saved, setSaved] = useState(false);

  return (
    <div className="w-full max-w-sm mx-auto bg-white dark:bg-zinc-900 border-2 border-slate-100 dark:border-zinc-800 rounded-2xl p-3 sm:p-3.5 shadow-sm text-start">
      {/* PDF Text Snippet with highlight */}
      <div className="p-2 sm:p-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800/60 border border-slate-100 dark:border-zinc-800 text-xs sm:text-sm text-slate-700 dark:text-slate-300 leading-relaxed mb-2">
        <span>Histamine release causes bronchoconstriction and increases </span>
        <span className="bg-amber-200 dark:bg-amber-500/40 text-amber-900 dark:text-amber-100 font-bold px-1.5 py-0.5 rounded border border-amber-300 dark:border-amber-600/50">
          vascular permeability
        </span>
        <span>, leading to acute hypotension.</span>
      </div>

      {/* In-line Translation Card */}
      <div className="flex items-center justify-between p-2.5 sm:p-3 rounded-xl bg-emerald-50/80 dark:bg-emerald-950/30 border border-emerald-100 dark:border-emerald-900/40">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-emerald-100 dark:bg-emerald-900/50 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
            <Languages className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <div className="text-[11px] font-bold text-emerald-700 dark:text-emerald-400">
              {isRtl ? 'ترجمة طبية فورية' : 'Instant Medical Translation'}
            </div>
            <div className="text-xs sm:text-sm font-black text-emerald-950 dark:text-emerald-100 truncate">
              {isRtl ? 'النفاذية الوعائية (تسرب السوائل)' : 'Vascular permeability'}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setSaved(s => !s)}
          className={`text-xs font-extrabold px-2.5 py-1 rounded-lg border transition-all active:scale-95 cursor-pointer shrink-0 shadow-xs ${saved
            ? 'bg-emerald-600 text-white border-emerald-600'
            : 'bg-white dark:bg-zinc-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-zinc-700'
            }`}
        >
          {saved ? (isRtl ? 'تم الحفظ ✓' : 'Saved ✓') : (isRtl ? 'حفظ ملاحظة 📝' : 'Save Note 📝')}
        </button>
      </div>
    </div>
  );
}

function MCQPreview({ isRtl }: { isRtl: boolean }) {
  const [selected, setSelected] = useState<'A' | 'B'>('B');

  return (
    <div className="w-full max-w-sm mx-auto bg-white dark:bg-zinc-900 border-2 border-slate-100 dark:border-zinc-800 rounded-2xl p-3 sm:p-3.5 shadow-sm text-start">
      <div className="flex items-center justify-between text-xs font-bold text-slate-400 dark:text-slate-500 mb-2">
        <span>{isRtl ? 'سؤال 8 من 20 • أسئلة وزارية' : 'Question 8 of 20 • Past Exam'}</span>
        <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400 font-extrabold text-xs">
          <Clock className="w-3.5 h-3.5" />
          00:38
        </span>
      </div>

      {/* Prominent Question with clean bidirectional text orientation */}
      <p className="text-sm sm:text-base font-black text-slate-900 dark:text-white mb-2.5 leading-snug">
        {isRtl ? (
          <span>
            ما هو الدواء المفضل كخط علاج أول في الصدمة التأقية{' '}
            <bdi className="text-sky-600 dark:text-sky-400 font-mono text-xs sm:text-sm font-bold" dir="ltr">
              (Anaphylaxis)
            </bdi>
            ؟
          </span>
        ) : (
          'Which drug is the primary first-line choice for acute anaphylactic shock?'
        )}
      </p>

      <div className="space-y-1.5 mb-2.5">
        <button
          type="button"
          onClick={() => setSelected('A')}
          className={`w-full px-3 py-2 rounded-xl border text-xs sm:text-sm font-semibold text-start transition-all cursor-pointer flex items-center justify-between active:scale-[0.99] ${selected === 'A'
            ? 'border-rose-400 bg-rose-50 dark:bg-rose-950/30 text-rose-800 dark:text-rose-200'
            : 'border-slate-200 dark:border-zinc-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-zinc-800/40'
            }`}
        >
          <span>A. Diphenhydramine</span>
          {selected === 'A' && (
            <span className="text-[10px] font-black text-rose-700 dark:text-rose-300 bg-rose-100 dark:bg-rose-900/60 px-1.5 py-0.5 rounded">
              {isRtl ? 'غير دقيق ✕' : 'Incorrect ✕'}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setSelected('B')}
          className={`w-full px-3 py-2 rounded-xl border-2 text-xs sm:text-sm font-bold text-start transition-all cursor-pointer flex items-center justify-between active:scale-[0.99] ${selected === 'B'
            ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-200'
            : 'border-slate-200 dark:border-zinc-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-zinc-800/40'
            }`}
        >
          <span>B. Epinephrine (Adrenaline)</span>
          <span className="text-[10px] font-black text-emerald-700 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-900/60 px-1.5 py-0.5 rounded">
            {isRtl ? 'صحيح ✓' : 'Correct ✓'}
          </span>
        </button>
      </div>

      <div className="p-2 sm:p-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800/50 border border-slate-100 dark:border-zinc-800 text-xs sm:text-[13px] text-slate-600 dark:text-slate-400 leading-relaxed">
        <span className="font-bold text-slate-800 dark:text-slate-200">
          {isRtl ? 'التوضيح: ' : 'Rationale: '}
        </span>
        {isRtl
          ? 'الإبينفرين يعاكس فورياً هبوط الضغط وتضيق القصبات عبر مستقبلات ألفا وبيتا.'
          : 'Epinephrine reverses bronchoconstriction and hypotension rapidly via alpha & beta receptors.'}
      </div>
    </div>
  );
}

function CloudAudioPreview({ isRtl }: { isRtl: boolean }) {
  const [isPlaying, setIsPlaying] = useState(false);

  return (
    <div className="w-full max-w-sm mx-auto bg-white dark:bg-zinc-900 border-2 border-slate-100 dark:border-zinc-800 rounded-2xl p-3 sm:p-3.5 shadow-sm text-start space-y-2">
      {/* Cloud File Item */}
      <div className="flex items-center justify-between p-2 rounded-xl bg-slate-50 dark:bg-zinc-800/60 border border-slate-100 dark:border-zinc-800">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
            <HardDrive className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <div className="text-xs sm:text-sm font-black text-slate-800 dark:text-slate-200 truncate">
              {isRtl ? 'ملخصات_الفارما_الفصل_الأول.pdf' : 'Pharmacology_Summary_Ch1.pdf'}
            </div>
            <div className="text-[11px] font-bold text-slate-400">
              {isRtl ? '4.2 ميغابايت • سحابتك الخاصة' : '4.2 MB • Secure Cloud'}
            </div>
          </div>
        </div>
        <span className="text-[11px] font-extrabold text-indigo-600 dark:text-indigo-400 px-2 py-0.5 rounded-md bg-indigo-50 dark:bg-indigo-950/50 border border-indigo-100 dark:border-indigo-900/40 shrink-0">
          {isRtl ? 'سحابي ☁️' : 'Synced ☁️'}
        </span>
      </div>

      {/* Audio Player Bar */}
      <div className="p-2.5 sm:p-3 rounded-xl bg-slate-900 text-white dark:bg-zinc-800/90 border border-slate-800 dark:border-zinc-700">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => setIsPlaying(p => !p)}
              className="w-7 h-7 rounded-full bg-sky-500 text-white flex items-center justify-center shrink-0 cursor-pointer active:scale-90 transition-transform shadow-xs"
              aria-label={isPlaying ? 'Pause audio' : 'Play audio'}
            >
              {isPlaying ? (
                <Pause className="w-3.5 h-3.5 fill-white" />
              ) : (
                <Play className="w-3.5 h-3.5 fill-white ms-0.5" />
              )}
            </button>
            <div>
              <div className="text-xs sm:text-sm font-bold leading-none mb-1">
                {isRtl ? 'تسجيل المحاضرة 4 - علم الأدوية' : 'Lecture 4 Audio - Pharmacology'}
              </div>
              <div className="text-[11px] text-slate-400 leading-none">
                {isPlaying ? '22:18 / 45:30' : '22:15 / 45:30'}
              </div>
            </div>
          </div>
          <span className="text-[11px] font-black px-1.5 py-0.5 rounded bg-white/10 text-sky-300">
            1.5x
          </span>
        </div>
        {/* Scrubber bar */}
        <div className="w-full bg-white/20 h-1.5 rounded-full overflow-hidden">
          <div className={`bg-sky-400 h-full rounded-full transition-all duration-300 ${isPlaying ? 'w-[54%]' : 'w-[48%]'}`} />
        </div>
        <div className="mt-2 text-[11px] text-slate-400 font-medium flex items-center justify-between">
          <span>{isRtl ? '🎧 يعمل في الخلفية ومع قفل الشاشة' : '🎧 Background & lock screen playback'}</span>
          <span>{isRtl ? 'تخزين خفيف' : 'Zero phone lag'}</span>
        </div>
      </div>
    </div>
  );
}

function StreakPodiumPreview({ isRtl }: { isRtl: boolean }) {
  return (
    <div className="w-full max-w-sm mx-auto bg-white dark:bg-zinc-900 border-2 border-slate-100 dark:border-zinc-800 rounded-2xl p-3 sm:p-3.5 shadow-sm text-start">
      {/* Streak Header */}
      <div className="flex items-center justify-between p-2 rounded-xl bg-orange-50 dark:bg-orange-950/30 border border-orange-100 dark:border-orange-900/40 mb-2">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-orange-100 dark:bg-orange-900/50 text-orange-600 dark:text-orange-400 flex items-center justify-center shrink-0">
            <Flame className="w-4 h-4" strokeWidth={2.5} />
          </div>
          <div>
            <div className="text-xs sm:text-sm font-black text-orange-950 dark:text-orange-200 leading-snug">
              {isRtl ? 'ستريك دراسي 7 أيام متواصلة' : '7-Day Daily Study Streak'}
            </div>
            <div className="text-[11px] font-bold text-orange-700/80 dark:text-orange-400">
              {isRtl ? '+150 XP مكتسبة هذا الأسبوع' : '+150 XP earned this week'}
            </div>
          </div>
        </div>
        <span className="text-[11px] font-black text-orange-600 dark:text-orange-400 bg-white dark:bg-zinc-900 px-2 py-0.5 rounded-lg border border-orange-200 dark:border-orange-900/60 shadow-xs">
          🔥 {isRtl ? 'نشط' : 'Active'}
        </span>
      </div>

      {/* Mini Leaderboard Podium */}
      <div className="space-y-1">
        <div className="flex items-center justify-between px-2.5 py-1.5 rounded-xl bg-amber-50/70 dark:bg-amber-950/20 border border-amber-200/70 dark:border-amber-900/40 text-xs sm:text-sm font-bold">
          <div className="flex items-center gap-2">
            <span className="text-xs sm:text-sm">🥇</span>
            <span className="text-slate-900 dark:text-white font-black">
              {isRtl ? 'دانيال أحمد' : 'Daniel Ahmed'}
            </span>
            <span className="text-[10px] text-amber-700 dark:text-amber-400 font-extrabold">
              {isRtl ? 'المركز الأول' : '#1 Ranked'}
            </span>
          </div>
          <span className="text-slate-600 dark:text-slate-400 text-xs font-mono">1,450 XP</span>
        </div>
        <div className="flex items-center justify-between px-2.5 py-1.5 rounded-xl bg-slate-50 dark:bg-zinc-800/40 border border-slate-100 dark:border-zinc-800 text-xs sm:text-sm font-medium">
          <div className="flex items-center gap-2">
            <span className="text-xs sm:text-sm">🥈</span>
            <span className="text-slate-800 dark:text-slate-200 font-bold">
              {isRtl ? 'علي حسين' : 'Ali Hussein'}
            </span>
          </div>
          <span className="text-slate-500 text-xs font-mono">1,280 XP</span>
        </div>
        <div className="flex items-center justify-between px-2.5 py-1.5 rounded-xl bg-sky-50/60 dark:bg-sky-950/20 border border-sky-100 dark:border-sky-900/40 text-xs sm:text-sm font-bold text-sky-800 dark:text-sky-300">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono font-black px-1.5 py-0.5 rounded bg-sky-200/60 dark:bg-sky-900/60">
              #5
            </span>
            <span>{isRtl ? 'أنت (قريب من منصة التتويج!)' : 'You (Closing in on top 3!)'}</span>
          </div>
          <span className="text-sky-700 dark:text-sky-400 text-xs font-mono font-black">940 XP</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function OnboardingSlides({ onComplete, lang = 'ar' }: OnboardingSlidesProps) {
  const [currentSlide, setCurrentSlide] = useState(0);
  const isRtl = lang === 'ar';

  const slides = [
    {
      id: 'welcome',
      isPro: false,
      badge: isRtl ? 'المنصة الأكاديمية لدفعتك' : 'Stage Academic Platform',
      icon: <BookOpen className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" strokeWidth={2.5} />,
      title: isRtl ? 'كل ما تحتاجه لدراستك في مكان واحد' : 'Everything for Your Studies in One Place',
      body: isRtl
        ? 'ملازم وسلايدات دفعتك وتدريبات الـ MCQ الرسمية مجمّعة في منصة أكاديمية واحدة.'
        : 'Official university lectures, slides, and MCQ practice questions together in a structured study workspace.',
      preview: <LecturesPreview isRtl={isRtl} />,
      perks: [
        isRtl ? 'ملازم وسلايدات محدثة رسمياً حسب مرحلتك وكليتك' : 'Live updated lectures & slides for your specific stage',
        isRtl ? 'تسجيلات صوتية مرتبطة بكل محاضرة لتسهيل المتابعة' : 'Dedicated audio recordings linked to each lecture'
      ]
    },
    {
      id: 'simosan',
      isPro: true,
      badge: isRtl ? 'ميزة حصرية' : 'Exclusive Feature',
      icon: <Bot className="w-3.5 h-3.5 text-violet-600 dark:text-violet-400" strokeWidth={2.5} />,
      title: isRtl ? 'سيموسان: معلمك الذكي داخل السلايد' : 'Simosan: Your Private AI Tutor in the Slide',
      body: isRtl
        ? 'يشرح لك الفقرات المعقدة فورياً داخل الـ PDF ويولّد كويزات تفاعلية لتثبيت المعلومة.'
        : 'Breaks down complex slide concepts in real time and generates smart quick quizzes to verify your recall.',
      preview: <SimosanPreview isRtl={isRtl} />,
      perks: [
        isRtl ? 'شرح فوري وتفكيك للجداول والمعادلات الصعبة داخل الـ PDF' : 'Instant in-reader explanation of complex tables & concepts',
        isRtl ? 'اختبارات سريعة لتثبيت المعلومة والتأكد من فهمك' : 'Smart quick quizzes to verify your understanding on the spot'
      ]
    },
    {
      id: 'translation',
      isPro: true,
      badge: isRtl ? 'ميزة حصرية' : 'Exclusive Feature',
      icon: <Languages className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" strokeWidth={2.5} />,
      title: isRtl ? 'ترجمة طبية فورية وأدوات تظليل ذكية' : '1-Tap Medical Translation & Smart Highlighting',
      body: isRtl
        ? 'ترجم المصطلحات الطبية المتخصصة بنقرة واحدة داخل السلايد ودوّن ملاحظاتك بلا تشتت.'
        : 'Translate complex medical terms with one tap inside the lecture PDF and keep persistent study notes.',
      preview: <TranslationPreview isRtl={isRtl} />,
      perks: [
        isRtl ? 'ترجمة دقيقة للمصطلحات الطبية والعلمية المتخصصة' : 'Accurate medical terminology translation with clear context',
        isRtl ? 'تظليل ذكي وحفظ ملاحظاتك الدراسية على نفس الصفحة' : 'Persistent highlighting and margin notes saved automatically'
      ]
    },
    {
      id: 'mcq_bank',
      isPro: true,
      badge: isRtl ? 'ميزة حصرية' : 'Exclusive Feature',
      icon: <HelpCircle className="w-3.5 h-3.5 text-rose-600 dark:text-rose-400" strokeWidth={2.5} />,
      title: isRtl ? 'بنك أسئلة الـ MCQ ومحاكي الامتحانات' : 'MCQ Question Bank & Realistic Exam Simulator',
      body: isRtl
        ? 'مئات الأسئلة الوزارية والسنوات السابقة مصنفة بدقة لكل محاضرة مع شرح علمي للإجابات.'
        : 'hundreds of past-paper MCQs organized per lecture, complete with reasoned scientific explanations.',
      preview: <MCQPreview isRtl={isRtl} />,
      perks: [
        isRtl ? 'أسئلة وزارية شاملة مدعومة بتفسير أسباب صحة الإجابة' : 'Comprehensive question bank with detailed answer reasoning',
        isRtl ? 'محاكاة لظروف الامتحان ومؤقت دقيق لقياس سرعتك' : 'Realistic exam mode with timers and performance analytics'
      ]
    },
    {
      id: 'cloud_space',
      isPro: false,
      badge: isRtl ? 'المساحة الأكاديمية والمشغل' : 'Cloud Workspace & Audio',
      icon: <HardDrive className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" strokeWidth={2.5} />,
      title: isRtl ? 'مساحتك السحابية ومشغل الصوت الذكي' : 'Your Personal Cloud & Background Audio Player',
      body: isRtl
        ? 'احفظ ملخصاتك في سحابتك الآمنة واستمع لتسجيلات المحاضرات في الخلفية أثناء التنقل.'
        : 'Store your personal summaries securely in the cloud and stream audio lectures in the background.',
      preview: <CloudAudioPreview isRtl={isRtl} />,
      perks: [
        isRtl ? 'سحابة شخصية آمنة لحفظ ملخصاتك ومستنداتك الدراسية' : 'Secure private cloud storage for personal study notes & PDFs',
        isRtl ? 'مشغل صوتيات يعمل في الخلفية حتى مع قفل الشاشة' : 'Background audio playback that runs seamlessly on mobile'
      ]
    },
    {
      id: 'streak_podium',
      isPro: false,
      badge: isRtl ? 'عادات التفوق والصدارة' : 'Streak & Leaderboards',
      icon: <Flame className="w-3.5 h-3.5 text-orange-600 dark:text-orange-400" strokeWidth={2.5} />,
      title: isRtl ? 'اصنع عادة التفوق وتصدر دفعتك' : 'Build Consistent Study Habits & Top the Stage',
      body: isRtl
        ? 'حافظ على شعلة الستريك اليومي، واكسب الـ XP، ونافس زملاءك على منصة التتويج.'
        : 'Keep your daily streak burning, earn XP with every session, and claim your place on the stage podium.',
      preview: <StreakPodiumPreview isRtl={isRtl} />,
      perks: [
        isRtl ? 'نظام ستريك يومي يحفزك على الاستمرارية وعدم الانقطاع' : 'Daily streak counter to foster consistent study habits',
        isRtl ? 'لوحة صدارة وتنافس محتدم بين طلبة كليتك ومرحلتك' : 'Stage-wide leaderboard recognition for top achievers'
      ]
    }
  ];

  const nextSlide = () => {
    if (currentSlide < slides.length - 1) {
      setCurrentSlide(s => s + 1);
    } else {
      onComplete();
    }
  };

  const prevSlide = () => {
    if (currentSlide > 0) {
      setCurrentSlide(s => s - 1);
    }
  };

  // Keyboard navigation (Arrow keys + Escape)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        if (isRtl) prevSlide();
        else nextSlide();
      } else if (e.key === 'ArrowLeft') {
        if (isRtl) nextSlide();
        else prevSlide();
      } else if (e.key === 'Escape') {
        onComplete();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentSlide, isRtl]);

  const active = slides[currentSlide];
  const isLast = currentSlide === slides.length - 1;

  const ForwardIcon = isRtl ? ChevronLeft : ChevronRight;
  const BackwardIcon = isRtl ? ChevronRight : ChevronLeft;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[100] bg-slate-50 dark:bg-zinc-950 flex flex-col justify-between overflow-hidden select-none"
      dir={isRtl ? 'rtl' : 'ltr'}
      style={{ paddingTop: 'max(env(safe-area-inset-top), 0.5rem)' }}
    >
      {/* Top Thin Progress Bar */}
      <div className="w-full bg-slate-200 dark:bg-zinc-800 h-1 overflow-hidden shrink-0">
        <div
          className="bg-sky-600 dark:bg-sky-500 h-full transition-all duration-300 ease-out"
          style={{ width: `${((currentSlide + 1) / slides.length) * 100}%` }}
        />
      </div>

      {/* Top Header: Back Button, Step Counter, and Skip */}
      <div className="w-full max-w-lg mx-auto px-4 sm:px-6 pt-2 pb-1 flex items-center justify-between z-10 shrink-0">
        <div className="flex items-center gap-1.5">
          {currentSlide > 0 ? (
            <button
              onClick={prevSlide}
              className="px-2 py-1 -ms-1 rounded-lg text-xs font-bold text-slate-500 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-100 hover:bg-slate-200/60 dark:hover:bg-zinc-800/60 transition-all flex items-center gap-1 cursor-pointer"
              aria-label={isRtl ? 'السابق' : 'Previous'}
            >
              <BackwardIcon className="w-4 h-4" strokeWidth={2.5} />
              <span>{isRtl ? 'السابق' : 'Back'}</span>
            </button>
          ) : (
            <div className="w-12" />
          )}
        </div>

        <div className="text-xs font-bold text-slate-500 dark:text-zinc-400">
          <span>{isRtl ? `الخطوة ${currentSlide + 1} من ${slides.length}` : `Step ${currentSlide + 1} of ${slides.length}`}</span>
        </div>

        <button
          onClick={onComplete}
          className="px-2.5 py-1 -me-1 rounded-lg text-xs font-bold text-slate-500 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-100 hover:bg-slate-200/60 dark:hover:bg-zinc-800/60 transition-all flex items-center gap-1 cursor-pointer"
        >
          <span>{isRtl ? 'تخطي' : 'Skip'}</span>
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Main Slide Content Area with Swipe Support */}
      <div className="flex-1 flex flex-col items-center px-4 sm:px-6 text-center relative w-full max-w-lg mx-auto overflow-y-auto overflow-x-hidden min-h-0">
        <AnimatePresence mode="wait">
          <motion.div
            key={active.id}
            drag="x"
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={0.2}
            onDragEnd={(_e, { offset, velocity }) => {
              const isSwipe = Math.abs(offset.x) > 40 || Math.abs(velocity.x) > 400;
              if (isSwipe) {
                if (offset.x < 0) {
                  // Swiped left
                  nextSlide();
                } else {
                  // Swiped right
                  prevSlide();
                }
              }
            }}
            initial={{ opacity: 0, x: isRtl ? -24 : 24, scale: 0.98 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: isRtl ? 24 : -24, scale: 0.98 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="flex flex-col items-center w-full m-auto py-1 sm:py-2"
          >
            {/* Minimalist Apple Typographic Kicker (Option B) */}
            <div className="flex items-center justify-center gap-1.5 mb-1.5 sm:mb-2 text-xs select-none">
              {active.isPro ? (
                <>
                  <Crown className="w-3.5 h-3.5 text-amber-500 fill-amber-500 shrink-0" />
                  <span className="font-black text-amber-500 tracking-wider uppercase text-[11px] sm:text-xs">
                    PRO
                  </span>
                  <span className="text-slate-300 dark:text-zinc-600 font-bold">•</span>
                  <span className="font-bold text-slate-500 dark:text-zinc-400">
                    {active.badge}
                  </span>
                </>
              ) : (
                <>
                  <span className="shrink-0">{active.icon}</span>
                  <span className="font-bold text-slate-500 dark:text-zinc-400">
                    {active.badge}
                  </span>
                </>
              )}
            </div>

            {/* Commanding Hero Headline */}
            <h1 className="text-xl sm:text-2xl md:text-[26px] font-black text-slate-900 dark:text-white mb-1.5 tracking-tight leading-tight max-w-lg">
              {active.title}
            </h1>

            {/* Streamlined Subtitle Body */}
            <p className="text-xs sm:text-sm text-slate-500 dark:text-zinc-400 font-medium leading-relaxed max-w-sm sm:max-w-md mb-2.5 sm:mb-3">
              {active.body}
            </p>

            {/* Tangible Micro-UI Preview (Authentic App Surface) */}
            <div className="w-full mb-2 sm:mb-2.5">
              {active.preview}
            </div>

            {/* Micro-Perks (2 clear bullets) */}
            <div className="w-full max-w-sm bg-white dark:bg-zinc-900 border-2 border-slate-100 dark:border-zinc-800 rounded-2xl p-2 sm:p-2.5 shadow-sm space-y-1 text-start">
              {active.perks.map((perk, i) => (
                <div key={i} className="flex items-start gap-2 text-xs font-semibold text-slate-700 dark:text-slate-300">
                  <div className="w-4 h-4 rounded-md bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0 mt-0.5">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                  </div>
                  <span className="leading-snug">{perk}</span>
                </div>
              ))}
            </div>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Bottom Area: Step Dots & Single Solid CTA Button */}
      <div
        className="w-full max-w-lg mx-auto px-5 sm:px-6 pt-1.5 pb-4 sm:pb-5 flex flex-col gap-2.5 shrink-0"
        style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 1rem)' }}
      >
        {/* Step Indicator Dots */}
        <div className="flex justify-center items-center gap-1.5">
          {slides.map((slide, i) => (
            <button
              key={slide.id}
              onClick={() => setCurrentSlide(i)}
              aria-label={`Slide ${i + 1}`}
              className={`h-1.5 rounded-full transition-all duration-300 cursor-pointer ${i === currentSlide
                ? 'w-6 bg-sky-600 dark:bg-sky-500'
                : 'w-1.5 bg-slate-200 dark:bg-zinc-800 hover:bg-slate-300 dark:hover:bg-zinc-700'
                }`}
            />
          ))}
        </div>

        {/* Full-width Solid Ergonomic CTA Button */}
        <button
          onClick={nextSlide}
          className={`w-full h-11 sm:h-12 rounded-2xl font-bold text-sm sm:text-base transition-all active:scale-[0.98] flex items-center justify-center gap-2 shadow-sm cursor-pointer ${isLast
            ? 'bg-sky-600 hover:bg-sky-700 text-white'
            : 'bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-slate-100'
            }`}
        >
          <span>{isLast ? (isRtl ? 'ابدأ رحلة التفوق الآن 🚀' : 'Start Your Journey Now 🚀') : (isRtl ? 'التالي' : 'Next')}</span>
          {!isLast && <ForwardIcon className="w-4 h-4" strokeWidth={2.5} />}
        </button>
      </div>
    </motion.div>
  );
}
