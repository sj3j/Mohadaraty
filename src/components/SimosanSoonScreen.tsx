import React, { useState, useEffect, useRef } from 'react';
import { Sparkles, CheckCircle2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Language } from '../types';

export type SimosanServiceId = 'courses' | 'attendance' | 'transport_housing' | 'simosan';

export interface SimosanSoonScreenProps {
  lang: Language;
  onSelectService?: (serviceId: SimosanServiceId) => void;
}

interface ServiceCardConfig {
  id: SimosanServiceId;
  title: string;
  subtitle: string;
  tag: string;
  tileBg: string;
  tagColor: string;
  renderIcon: () => React.ReactNode;
}

/**
 * Simosan Services Hub.
 *
 * Provides a clean, aesthetic dashboard for university services:
 * - كورسات (Courses & Curriculum)
 * - الحضور (Student & Staff Attendance)
 * - الخط والسكن (Campus Transit & Dormitories)
 * - سيموسان (Simosan AI Smart Tutor)
 *
 * Modeled on the profile screen's StatCard aesthetic:
 * border-2 border-slate-100 dark:border-zinc-700 rounded-2xl, centered content,
 * soft tinted icon tiles, and clean typography.
 */
export default function SimosanSoonScreen({ lang, onSelectService }: SimosanSoonScreenProps) {
  const isRtl = lang === 'ar';
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current) {
        clearTimeout(toastTimeoutRef.current);
      }
    };
  }, []);

  const handleCardClick = (service: ServiceCardConfig) => {
    if (onSelectService) {
      onSelectService(service.id);
      return;
    }

    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
    }

    const message = isRtl
      ? `خدمة «${service.title}» قيد التطوير وستتوفر قريباً`
      : `"${service.title}" is under development and coming soon`;

    setToastMessage(message);
    toastTimeoutRef.current = setTimeout(() => {
      setToastMessage(null);
    }, 2600);
  };

  const services: ServiceCardConfig[] = [
    {
      id: 'courses',
      title: isRtl ? 'كورسات' : 'Courses',
      subtitle: isRtl
        ? 'تصفح وإدارة المقررات الدراسية والمناهج'
        : 'Browse & organize academic curriculum',
      tag: isRtl ? 'قريباً' : 'Soon',
      tileBg: 'bg-indigo-100 dark:bg-indigo-900/30',
      tagColor: 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 border border-indigo-100 dark:border-indigo-900/40',
      renderIcon: () => (
        <svg
          className="w-5 h-5 sm:w-6 sm:h-6 stroke-[2] text-indigo-600 dark:text-indigo-400"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {/* Academic Book with ribbon bookmark */}
          <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z" />
          <path d="M8 7h8" />
          <path d="M8 11h5" />
          <path d="m14 2 3 5-3 5" />
        </svg>
      ),
    },
    {
      id: 'attendance',
      title: isRtl ? 'الحضور' : 'Attendance',
      subtitle: isRtl
        ? 'سجل الحضور والغياب والإحصاءات'
        : 'Attendance logs & check-in analytics',
      tag: isRtl ? 'قريباً' : 'Soon',
      tileBg: 'bg-emerald-100 dark:bg-emerald-900/30',
      tagColor: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-100 dark:border-emerald-900/40',
      renderIcon: () => (
        <svg
          className="w-5 h-5 sm:w-6 sm:h-6 stroke-[2] text-emerald-600 dark:text-emerald-400"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {/* Calendar sheet with verified checkmark */}
          <rect width="18" height="18" x="3" y="4" rx="3" />
          <line x1="16" x2="16" y1="2" y2="6" />
          <line x1="8" x2="8" y1="2" y2="6" />
          <line x1="3" x2="21" y1="10" y2="10" />
          <path d="m9 16 2 2 4-4" />
        </svg>
      ),
    },
    {
      id: 'transport_housing',
      title: isRtl ? 'الخط والسكن' : 'Transit & Housing',
      subtitle: isRtl
        ? 'مسارات النقل وخدمات السكن الجامعي'
        : 'Campus transit routes & student housing',
      tag: isRtl ? 'قريباً' : 'Soon',
      tileBg: 'bg-amber-100 dark:bg-amber-900/30',
      tagColor: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-100 dark:border-amber-900/40',
      renderIcon: () => (
        <svg
          className="w-5 h-5 sm:w-6 sm:h-6 stroke-[2] text-amber-600 dark:text-amber-400"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {/* Residence building background */}
          <path d="M15 21V5a2 2 0 0 1 2-2h4a1 1 0 0 1 1 1v17" />
          <path d="M18 7h.01" />
          <path d="M18 11h.01" />
          {/* Campus transit bus front */}
          <rect width="11" height="12" x="2" y="8" rx="2" />
          <path d="M2 13h11" />
          <circle cx="5" cy="17" r="1" fill="currentColor" />
          <circle cx="10" cy="17" r="1" fill="currentColor" />
          <path d="M4 20v1" />
          <path d="M11 20v1" />
        </svg>
      ),
    },
    {
      id: 'simosan',
      title: isRtl ? 'سيموسان' : 'Simosan AI',
      subtitle: isRtl
        ? 'المعلم الذكي ومساعد الدراسة التفاعلي'
        : 'Smart AI tutor & interactive learning',
      tag: isRtl ? 'قريباً' : 'Soon',
      tileBg: 'bg-sky-100 dark:bg-sky-900/30',
      tagColor: 'bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 border border-sky-100 dark:border-sky-800/40',
      renderIcon: () => (
        <img
          src="/icons/logo-mark.png"
          alt=""
          className="w-5 h-5 sm:w-6 sm:h-6 object-contain"
        />
      ),
    },
  ];

  return (
    <div
      className="max-w-xl w-full mx-auto px-4 pt-4 pb-8 flex flex-col items-center justify-start text-center relative"
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      {/* Gentle Floating In-App Toast */}
      <AnimatePresence>
        {toastMessage && (
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -15, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            className="fixed top-5 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2.5 px-4 py-2.5 rounded-2xl bg-slate-900/95 dark:bg-stone-100/95 text-white dark:text-slate-900 text-xs sm:text-sm font-bold shadow-xl backdrop-blur-md border border-white/10 dark:border-black/10 max-w-[90vw]"
          >
            <CheckCircle2 className="w-4 h-4 text-emerald-400 dark:text-emerald-600 shrink-0" />
            <span className="truncate">{toastMessage}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Top Brand & Header Section */}
      <div className="flex flex-col items-center mb-6">
        <div className="relative mb-3.5">
          <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl sm:rounded-3xl bg-sky-50 dark:bg-sky-900/30 border border-sky-100 dark:border-sky-800/40 flex items-center justify-center shadow-sm">
            <img
              src="/icons/logo-mark.png"
              alt="Simosan"
              className="w-10 h-10 sm:w-12 sm:h-12 object-contain"
            />
          </div>
        </div>

        <div className="inline-flex items-center gap-1.5 px-3 py-1 mb-2.5 rounded-full bg-sky-50 dark:bg-sky-900/30 border border-sky-100/80 dark:border-sky-800/40 text-sky-700 dark:text-sky-300 text-xs font-bold">
          <Sparkles className="w-3.5 h-3.5" />
          <span>{isRtl ? 'بوابة الخدمات الجامعية' : 'Campus Services Hub'}</span>
        </div>

        <h1 className="text-xl sm:text-2xl font-black text-slate-900 dark:text-stone-100 mb-1.5 tracking-tight">
          {isRtl ? 'خدمات سيموسان' : 'Simosan Services'}
        </h1>

        <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 max-w-sm leading-relaxed">
          {isRtl
            ? 'منظومة الخدمات الأكاديمية واللوجستية. الخدمات قيد التحضير وستنطلق تباعاً.'
            : 'Academic and campus management portal. Services are being prepared.'}
        </p>
      </div>

      {/* 2x2 Responsive Services Grid - Matching Profile StatCard Theme & Centered Alignment */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 w-full">
        {services.map((service) => (
          <button
            key={service.id}
            type="button"
            onClick={() => handleCardClick(service)}
            className="group relative flex flex-col items-center justify-center p-4 sm:p-5 rounded-2xl bg-white dark:bg-zinc-800 border-2 border-slate-100 dark:border-zinc-700 shadow-sm hover:bg-slate-50 dark:hover:bg-zinc-700/60 active:translate-y-px active:scale-[0.98] transition-all text-center cursor-pointer select-none min-h-[160px] sm:min-h-[175px]"
          >
            {/* Centered Icon tile */}
            <div
              className={`w-11 h-11 sm:w-12 sm:h-12 rounded-xl flex items-center justify-center shrink-0 mb-2.5 transition-transform group-hover:scale-105 ${service.tileBg}`}
            >
              {service.renderIcon()}
            </div>

            {/* Title */}
            <h2 className="text-base sm:text-lg font-black text-slate-800 dark:text-stone-100 mb-1 leading-tight group-hover:text-sky-600 dark:group-hover:text-sky-400 transition-colors">
              {service.title}
            </h2>

            {/* Subtitle */}
            <p className="text-xs font-bold text-slate-400 dark:text-slate-500 leading-normal line-clamp-2 max-w-[170px] mb-2.5">
              {service.subtitle}
            </p>

            {/* Micro subtle tag */}
            <span
              className={`text-[10px] font-bold px-2.5 py-0.5 rounded-full ${service.tagColor}`}
            >
              {service.tag}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
