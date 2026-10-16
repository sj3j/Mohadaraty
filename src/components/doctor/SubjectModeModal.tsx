import React from 'react';
import { X, Check, BookOpen, Layers, Sparkles } from 'lucide-react';
import { DoctorSubject, LectureMode } from './types';

interface SubjectModeModalProps {
  isOpen: boolean;
  onClose: () => void;
  subjects: DoctorSubject[];
  selectedSubject: DoctorSubject;
  onSelectSubject: (sub: DoctorSubject) => void;
  selectedMode: 'theoretical' | 'practical' | 'both';
  onSelectMode: (mode: 'theoretical' | 'practical' | 'both') => void;
  isRtl: boolean;
}

export default function SubjectModeModal({
  isOpen,
  onClose,
  subjects,
  selectedSubject,
  onSelectSubject,
  selectedMode,
  onSelectMode,
  isRtl,
}: SubjectModeModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
      <div 
        className="w-full max-w-lg overflow-hidden rounded-3xl bg-white shadow-2xl border border-slate-200 dark:bg-zinc-900 dark:border-zinc-800"
        dir={isRtl ? 'rtl' : 'ltr'}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-zinc-800">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-teal-100 text-teal-600 dark:bg-teal-950/50 dark:text-teal-400">
              <BookOpen className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-black text-slate-800 dark:text-zinc-100">
                {isRtl ? 'تحديد المادة ونمط الحضور' : 'Select Subject & Mode'}
              </h2>
              <p className="text-xs text-slate-500 dark:text-zinc-400">
                {isRtl ? 'اختر المادة الدراسية لتسجيل الحضور وجدول المحاضرات' : 'Choose which subject you want to record attendance for'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-6">
          {/* Subject selection */}
          <div className="space-y-3">
            <label className="text-xs font-black uppercase tracking-wider text-slate-400 dark:text-zinc-500">
              {isRtl ? 'المواد المعيّنة للتدريسي' : 'Assigned Subjects'}
            </label>
            <div className="grid gap-2.5">
              {subjects.map((subj) => {
                const isSelected = subj.id === selectedSubject.id;
                return (
                  <button
                    key={subj.id}
                    onClick={() => onSelectSubject(subj)}
                    className={`flex items-center justify-between p-4 rounded-2xl border transition-all text-start ${
                      isSelected
                        ? 'border-teal-500 bg-teal-50/60 shadow-sm dark:bg-teal-950/30 dark:border-teal-500/70'
                        : 'border-slate-200 bg-white hover:border-slate-300 dark:bg-zinc-800/60 dark:border-zinc-700/60 dark:hover:border-zinc-600'
                    }`}
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-black text-sm text-slate-900 dark:text-zinc-100">
                          {isRtl ? subj.nameAr : subj.nameEn}
                        </span>
                        {subj.code && (
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 dark:bg-zinc-700 dark:text-zinc-300">
                            {subj.code}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-zinc-400">
                        <Layers className="h-3.5 w-3.5 text-slate-400" />
                        <span>{subj.stageNameAr}</span>
                        <span>•</span>
                        <span>
                          {subj.type === 'both'
                            ? (isRtl ? 'نظري + عملي' : 'Theoretical + Practical')
                            : subj.type === 'practical'
                            ? (isRtl ? 'عملي فقط' : 'Practical only')
                            : (isRtl ? 'نظري فقط' : 'Theoretical only')}
                        </span>
                      </div>
                    </div>
                    {isSelected && (
                      <div className="flex h-6 w-6 items-center justify-center rounded-full bg-teal-600 text-white shadow-sm">
                        <Check className="h-4 w-4" />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Mode selection (Theoretical vs Practical vs Both) */}
          <div className="space-y-3">
            <label className="text-xs font-black uppercase tracking-wider text-slate-400 dark:text-zinc-500">
              {isRtl ? 'نمط المحاضرات المعروضة الآن' : 'Active Attendance Mode'}
            </label>
            <div className="grid grid-cols-3 gap-2">
              {[
                { id: 'both', labelAr: 'الكل (نظري + عملي)', labelEn: 'All Lectures' },
                { id: 'theoretical', labelAr: 'النظري فقط', labelEn: 'Theoretical' },
                { id: 'practical', labelAr: 'العملي فقط', labelEn: 'Practical' },
              ].map((modeOption) => {
                const isSelected = selectedMode === modeOption.id;
                return (
                  <button
                    key={modeOption.id}
                    onClick={() => onSelectMode(modeOption.id as any)}
                    className={`py-3 px-2 rounded-xl text-xs font-black border transition-all text-center ${
                      isSelected
                        ? 'border-teal-500 bg-teal-600 text-white shadow-md shadow-teal-600/20'
                        : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100 dark:bg-zinc-800 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-700'
                    }`}
                  >
                    {isRtl ? modeOption.labelAr : modeOption.labelEn}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 dark:bg-zinc-900/80 dark:border-zinc-800 flex justify-end">
          <button
            onClick={onClose}
            className="w-full sm:w-auto px-6 py-2.5 rounded-xl bg-teal-600 hover:bg-teal-700 text-white font-black text-xs shadow-md transition-all"
          >
            {isRtl ? 'حفظ والمتابعة' : 'Done & Continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
