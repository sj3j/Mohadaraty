import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Search, Loader2, X, Check, Mail, User } from 'lucide-react';
import {
  searchSubscriptionStudents,
  type SubscriptionStudentSearchResult,
} from '../../services/subscriptionManagementService';
import { PLAN_CONFIG, type SubscriptionPlan } from '../../types';

interface Props {
  value: string; // The email
  selectedStudent: SubscriptionStudentSearchResult | null;
  onSelect: (student: SubscriptionStudentSearchResult | null, rawEmail?: string) => void;
  rtl?: boolean;
  placeholder?: string;
  disabled?: boolean;
}

function formatStageBadge(stageId: string | null | undefined, rtl: boolean): string | null {
  if (!stageId) return null;
  const match = stageId.match(/^stage_(\d+)$/i);
  if (match) {
    return rtl ? `المرحلة ${match[1]}` : `Stage ${match[1]}`;
  }
  return stageId;
}

export default function StudentSearchDropdown({
  value,
  selectedStudent,
  onSelect,
  rtl = true,
  placeholder,
  disabled = false,
}: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SubscriptionStudentSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceTimerRef = useRef<number | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const defaultPlaceholder = rtl
    ? 'ابحث باسم الطالب أو البريد...'
    : 'Search by student name or email...';

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Debounced search query
  useEffect(() => {
    if (debounceTimerRef.current) {
      window.clearTimeout(debounceTimerRef.current);
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const trimmed = query.trim();
    if (!trimmed || trimmed.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const controller = new AbortController();
    abortControllerRef.current = controller;

    debounceTimerRef.current = window.setTimeout(async () => {
      try {
        const response = await searchSubscriptionStudents(trimmed, controller.signal);
        setResults(response.students || []);
        setHighlightedIndex(-1);
      } catch (err: any) {
        if (err?.name !== 'AbortError') {
          console.error('Subscription student search failed:', err);
          setResults([]);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }, 280);

    return () => {
      if (debounceTimerRef.current) window.clearTimeout(debounceTimerRef.current);
      controller.abort();
    };
  }, [query]);

  const looksLikeEmail = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q.includes('@') && q.length > 5;
  }, [query]);

  const handleSelectStudent = (student: SubscriptionStudentSearchResult) => {
    onSelect(student, student.email);
    setQuery('');
    setIsOpen(false);
    setResults([]);
  };

  const handleUseTypedEmail = () => {
    const email = query.trim().toLowerCase();
    if (!email) return;
    onSelect(null, email);
    setQuery('');
    setIsOpen(false);
    setResults([]);
  };

  const handleClear = () => {
    onSelect(null, '');
    setQuery('');
    setResults([]);
    setTimeout(() => {
      inputRef.current?.focus();
    }, 50);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        setIsOpen(true);
      }
      return;
    }

    const totalOptions = results.length + (looksLikeEmail ? 1 : 0);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex(prev => (prev + 1 < totalOptions ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex(prev => (prev - 1 >= 0 ? prev - 1 : totalOptions - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightedIndex >= 0 && highlightedIndex < results.length) {
        handleSelectStudent(results[highlightedIndex]);
      } else if (looksLikeEmail && (highlightedIndex === results.length || highlightedIndex === -1)) {
        handleUseTypedEmail();
      }
    } else if (e.key === 'Escape') {
      setIsOpen(false);
    }
  };

  // If a student is selected or a valid value is already set
  if (selectedStudent || (value && !isOpen && query === '')) {
    const displayName = selectedStudent?.name || value;
    const displayEmail = selectedStudent?.email || value;
    const isSubscribed = selectedStudent?.isSubscribed;
    const planConfig = (selectedStudent?.currentPlan && selectedStudent.currentPlan in PLAN_CONFIG)
      ? PLAN_CONFIG[selectedStudent.currentPlan as SubscriptionPlan]
      : null;
    const planLabel = planConfig
      ? (rtl ? planConfig.labelAr : planConfig.labelEn)
      : selectedStudent?.currentPlan;

    return (
      <div className="w-full rounded-2xl border border-sky-200 bg-sky-50/70 p-3 transition-all dark:border-sky-900/60 dark:bg-sky-950/30">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sky-600/10 text-sky-600 dark:bg-sky-400/10 dark:text-sky-400">
              <User className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate text-sm font-bold text-slate-900 dark:text-white">
                  {displayName}
                </p>
                {formatStageBadge(selectedStudent?.stageId, rtl) && (
                  <span className="inline-flex shrink-0 items-center rounded-md bg-sky-100/90 px-1.5 py-0.5 text-[10px] font-semibold text-sky-800 dark:bg-sky-900/60 dark:text-sky-300">
                    {formatStageBadge(selectedStudent?.stageId, rtl)}
                  </span>
                )}
                {isSubscribed ? (
                  <span className="inline-flex shrink-0 items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300">
                    <Check className="me-1 h-2.5 w-2.5" />
                    {planLabel || (rtl ? 'مشترك' : 'Active')}
                  </span>
                ) : (
                  <span className="inline-flex shrink-0 items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600 dark:bg-zinc-800 dark:text-zinc-400">
                    {rtl ? 'غير مشترك' : 'Inactive'}
                  </span>
                )}
              </div>
              <p className="truncate font-mono text-xs text-slate-500 dark:text-slate-400">
                {displayEmail}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleClear}
            disabled={disabled}
            className="flex shrink-0 items-center gap-1 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600 shadow-sm transition hover:bg-slate-50 hover:text-rose-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-slate-300 dark:hover:bg-zinc-700 dark:hover:text-rose-400"
            title={rtl ? 'تغيير الطالب' : 'Change student'}
          >
            <X className="h-3.5 w-3.5" />
            <span>{rtl ? 'تغيير' : 'Change'}</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative w-full">
      <div className="relative">
        <div className="pointer-events-none absolute inset-y-0 start-0 flex items-center ps-3.5 text-slate-400">
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin text-sky-600 dark:text-sky-400" />
          ) : (
            <Search className="h-4 w-4 text-slate-400 dark:text-zinc-500" />
          )}
        </div>
        <input
          ref={inputRef}
          type="text"
          value={query}
          disabled={disabled}
          onChange={e => {
            setQuery(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => {
            if (query.trim().length >= 2 || results.length > 0) {
              setIsOpen(true);
            }
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder || defaultPlaceholder}
          className="w-full rounded-2xl border border-slate-200 bg-white py-3 pe-4 ps-10 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20 dark:border-zinc-700 dark:bg-zinc-800/90 dark:text-white dark:placeholder:text-zinc-500 dark:focus:border-sky-400"
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setResults([]);
            }}
            className="absolute inset-y-0 end-0 flex items-center pe-3 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {isOpen && (query.trim().length >= 2 || results.length > 0) && (
        <div className="absolute z-50 mt-1.5 max-h-64 w-full overflow-y-auto rounded-2xl border border-slate-200 bg-white/95 p-1.5 shadow-xl backdrop-blur-md dark:border-zinc-700 dark:bg-zinc-900/95">
          {results.length === 0 && !loading && (
            <div className="p-3 text-center text-xs text-slate-400 dark:text-zinc-500">
              {rtl ? 'لا توجد نتائج مطابقة' : 'No matching students found'}
            </div>
          )}

          {results.map((student, idx) => {
            const isHighlighted = highlightedIndex === idx;
            const planConfig = (student.currentPlan && student.currentPlan in PLAN_CONFIG)
              ? PLAN_CONFIG[student.currentPlan as SubscriptionPlan]
              : null;
            const planLabel = planConfig
              ? (rtl ? planConfig.labelAr : planConfig.labelEn)
              : student.currentPlan;

            return (
              <button
                key={student.id || student.email}
                type="button"
                onClick={() => handleSelectStudent(student)}
                onMouseEnter={() => setHighlightedIndex(idx)}
                className={`flex w-full items-center justify-between gap-3 rounded-xl p-2.5 text-start transition-colors ${
                  isHighlighted
                    ? 'bg-sky-50 text-sky-900 dark:bg-sky-950/50 dark:text-white'
                    : 'text-slate-700 hover:bg-slate-50 dark:text-zinc-200 dark:hover:bg-zinc-800/60'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-bold text-slate-900 dark:text-white">
                      {student.name}
                    </p>
                    {formatStageBadge(student.stageId, rtl) && (
                      <span className="inline-flex shrink-0 items-center rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 dark:bg-zinc-800 dark:text-zinc-300">
                        {formatStageBadge(student.stageId, rtl)}
                      </span>
                    )}
                  </div>
                  <p className="truncate font-mono text-xs text-slate-500 dark:text-zinc-400">
                    {student.email}
                  </p>
                </div>
                <div className="shrink-0 text-end">
                  {student.isSubscribed ? (
                    <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300">
                      {planLabel || (rtl ? 'مشترك' : 'Active')}
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-zinc-800 dark:text-zinc-400">
                      {rtl ? 'غير مشترك' : 'Inactive'}
                    </span>
                  )}
                </div>
              </button>
            );
          })}

          {looksLikeEmail && (
            <button
              type="button"
              onClick={handleUseTypedEmail}
              onMouseEnter={() => setHighlightedIndex(results.length)}
              className={`flex w-full items-center gap-2 border-t border-slate-100 p-2.5 text-start text-xs font-semibold dark:border-zinc-800 ${
                highlightedIndex === results.length
                  ? 'bg-sky-50 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300'
                  : 'text-sky-600 hover:bg-slate-50 dark:text-sky-400 dark:hover:bg-zinc-800/60'
              }`}
            >
              <Mail className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">
                {rtl ? 'استخدام البريد المكتوب:' : 'Use typed email:'} <b>{query.trim().toLowerCase()}</b>
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
