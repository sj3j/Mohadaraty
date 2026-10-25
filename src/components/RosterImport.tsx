import React, { useState } from 'react';
import { db } from '../lib/firebase';
import { doc, getDoc, serverTimestamp, writeBatch } from 'firebase/firestore';
import {
  Upload, Loader2, AlertTriangle, CheckCircle2, Download, X, Copy, Check,
} from 'lucide-react';
import { Language, Student } from '../types';
import { hashPassword } from '../lib/hash';
import { logAdminAction } from '../services/adminLogService';
import { readRosterFile } from '../lib/spreadsheet';
import { resolveRosterColumns, cell } from '../../shared/csv';
import {
  nameKeyFor, normalizeName, newRosterDocId, makeLoginCode, loginCodeKeyFor,
  generatePassword, isPlaceholderEmail,
} from '../../shared/rosterIdentity';
import { GroupConfigLike, isValidSubgroup, normalizeSubgroup, subgroupOptions } from '../../shared/groups';
import { DEFAULT_CALENDAR } from '../../shared/academicCalendar';
import { completedProgressionFields } from '../../shared/progression';

/**
 * Bulk student import from a spreadsheet or CSV.
 *
 * Only `name` is required. The old importer demanded name + email + password
 * and silently dropped every row missing any of them, which meant the roster
 * the department actually hands out - names and a group - imported nothing at
 * all and said it had succeeded.
 *
 * Anything absent is generated here rather than demanded:
 *
 *   password   8 unambiguous characters, and mustChangePassword is set so the
 *              student cannot keep using the one printed on a shared sheet
 *   email      a synthetic id (see shared/rosterIdentity). It is not a mailbox;
 *              it exists because the document id IS the auth uid and the
 *              token's email claim, so it has to be email-shaped and stable
 *   loginCode  "D4-01234", the typeable alternative to a long Arabic name
 *
 * Parsing and committing are separate steps on purpose. The old one-shot
 * version reported a count and nothing else, so a shifted column or a group
 * that does not exist on this stage was only discovered later, in the roster.
 */

type RowStatus = 'new' | 'update' | 'suspect' | 'error';

interface ImportRow {
  key: string;
  name: string;
  subgroup: string;
  examCode: string;
  /** A password the file supplied. Always honoured, never regenerated. */
  csvPassword: string;
  /** Generated up front so the preview can show it; used only if this row creates. */
  generatedPassword: string;
  newDocId: string;
  newLoginCode: string;
  /** The existing student this row resolves to, when it updates one. */
  existingId: string;
  existingName: string;
  existingLoginCode: string;
  status: RowStatus;
  /** For 'suspect' rows: what the representative decided. */
  action: 'create' | 'update';
  note: string;
}

/** One line of the one-time passwords list. */
interface IssuedRow {
  name: string;
  subgroup: string;
  loginCode: string;
  email: string;
  password: string;
}

interface RosterImportProps {
  lang: Language;
  /** The current stage's roster, for dedupe against people already imported. */
  students: Student[];
  effectiveStageId: string | null;
  creationStageIsValid: boolean;
  groupConfig: GroupConfigLike;
  onImported: () => void;
}

/**
 * Firestore commits at most 500 operations per batch. The previous importer
 * used a single batch for the whole file, so a full-year roster failed as one
 * unit - and the failure surfaced as a generic error, not "too many rows".
 */
const BATCH_LIMIT = 450;

/**
 * How sure a fuzzy name match has to be before the row is even questioned.
 * Same figure the exam-code matcher in StudentManagement uses, for the same
 * reason: below it, the suggestions are noise and get dismissed unread.
 */
const SUSPECT_SCORE = 0.85;

/** What a row resolves to once the representative's choices are applied. */
function resolveRow(row: ImportRow) {
  const updating = row.status === 'update' || (row.status === 'suspect' && row.action === 'update');
  const docId = updating ? row.existingId : row.newDocId;
  // A student who already has a code keeps it - it may be printed on a sheet
  // they are carrying.
  const loginCode = updating ? (row.existingLoginCode || row.newLoginCode) : row.newLoginCode;
  // Updating never regenerates a password: they may already have changed it,
  // and a silent reset would lock them out of an account that was working.
  const password = row.csvPassword || (updating ? '' : row.generatedPassword);
  return { updating, docId, loginCode, password, forced: !row.csvPassword && !!password };
}

function toCsv(header: string[], rows: string[][]): string {
  const escape = (v: string) => '"' + (v || '').replace(/"/g, '""') + '"';
  // The BOM is what makes Excel read the Arabic as UTF-8 rather than mojibake.
  return '﻿' + [header, ...rows].map(r => r.map(escape).join(',')).join('\r\n');
}

/** A Blob rather than a data: URI - a few hundred rows exceeds the URL limit. */
function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export default function RosterImport({
  lang, students, effectiveStageId, creationStageIsValid, groupConfig, onImported,
}: RosterImportProps) {
  const isRtl = lang === 'ar';
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [fileName, setFileName] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /**
   * This roster is a brand-new intake with no prior year's result to report -
   * so newly-created rows are stamped as already answered for the current
   * calendar year (see completedProgressionFields), or nextProgressionStep
   * would ask them a question that has nothing to ask them about. Only new
   * rows get stamped: a row that updates an existing student may already be
   * mid-cycle (e.g. awaiting a resit), and this checkbox must not overwrite
   * that.
   */
  const [freshIntake, setFreshIntake] = useState(false);

  /**
   * The passwords from the last import, held until the representative confirms
   * they have them.
   *
   * This is the whole reason the panel exists. The batch commits BEFORE the
   * file is offered, the passwords are stored only as bcrypt hashes, and in the
   * Capacitor WebView a blob download is a silent no-op - so clearing this on
   * our own initiative would destroy the only plaintext copy that will ever
   * exist, having already told the representative it was saved.
   */
  const [issued, setIssued] = useState<IssuedRow[] | null>(null);

  const valid = rows.filter(r => r.status !== 'error');
  const errored = rows.filter(r => r.status === 'error');
  const suspects = rows.filter(r => r.status === 'suspect');
  const willIssue = valid.filter(r => resolveRow(r).password).length;

  const setAction = (key: string, action: 'create' | 'update') =>
    setRows(prev => prev.map(r => (r.key === key ? { ...r, action } : r)));

  const passwordsFileName = () =>
    `passwords_${effectiveStageId}_${new Date().toISOString().split('T')[0]}.csv`;

  const issuedCsv = (list: IssuedRow[]) => toCsv(
    isRtl
      ? ['الاسم', 'المجموعة', 'رمز الدخول', 'البريد', 'كلمة المرور']
      : ['Name', 'Group', 'Login code', 'Email', 'Password'],
    list.map(r => [r.name, r.subgroup, r.loginCode, r.email, r.password]),
  );

  const copyIssued = async (list: IssuedRow[]) => {
    const text = list
      .map(r => [r.name, r.subgroup, r.loginCode, r.password].filter(Boolean).join('\t'))
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch (err) {
      console.error('Clipboard write failed:', err);
      setError(isRtl
        ? 'تعذّر النسخ. نزّل الملف أو صوّر القائمة.'
        : 'Copy failed. Download the file or screenshot the list.');
    }
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setResult(null);
    setIsBusy(true);

    try {
      if (!effectiveStageId) {
        throw new Error(isRtl ? 'لم يتم تحديد المرحلة.' : 'No stage selected.');
      }

      const parsed = await readRosterFile(file);
      if (parsed.rows.length === 0) {
        throw new Error(isRtl ? 'الملف فارغ' : 'The file is empty');
      }
      const cols = resolveRosterColumns(parsed);
      if (cols.name < 0) {
        throw new Error(isRtl
          ? 'لم يتم العثور على عمود الاسم. أضف رأس عمود باسم name أو "الاسم".'
          : 'No name column found. Add a header called name.');
      }

      // Existing roster, keyed the way login keys it. nameKey is recomputed
      // from `name` rather than read, so rows imported before the field existed
      // still dedupe correctly.
      const roster = students.filter(s => !s.isAuthAccountOnly)
        .map(s => ({ ...s, id: s.baseStudentId || s.id }));
      const byNameKey = new Map<string, Student>();
      const byEmail = new Map<string, Student>();
      const usedCodes = new Set<string>();
      for (const s of roster) {
        const key = nameKeyFor(s.currentName || s.name);
        if (key && !byNameKey.has(key)) byNameKey.set(key, s);
        if (s.email) byEmail.set(s.email.toLowerCase(), s);
        if (s.loginCode) usedCodes.add(loginCodeKeyFor(s.loginCode));
      }

      // Both representatives manage the stage that already holds every live
      // account, so an upload lands beside them. Arabic names vary in how many
      // parts get written down - "علي فاضل كاظم سلمان" against "علي فاضل كاظم"
      // is not an exact match - and without this a row like that silently
      // becomes a SECOND account for someone who already has one.
      const Fuse = (await import('fuse.js')).default;
      const fuse = new Fuse(roster, {
        keys: ['name', 'currentName'],
        includeScore: true,
        threshold: 0.2,
      });
      const claimed = new Set<string>();

      const allowedGroups = subgroupOptions(groupConfig).join('، ');
      const seenNames = new Set<string>();
      const seenEmails = new Set<string>();
      const built: ImportRow[] = [];

      const blank = {
        subgroup: '', examCode: '', csvPassword: '', generatedPassword: '',
        newDocId: '', newLoginCode: '', existingId: '', existingName: '',
        existingLoginCode: '', action: 'update' as const,
      };

      parsed.rows.forEach((raw, i) => {
        const name = cell(raw, cols.name);
        const key = `row-${i}`;

        if (!name) {
          built.push({
            ...blank, key, name: '', status: 'error',
            note: isRtl ? 'الاسم مفقود' : 'Missing name',
          });
          return;
        }

        const nameKey = nameKeyFor(name);
        const rawEmail = cell(raw, cols.email).toLowerCase();
        const rawGroup = cell(raw, cols.group);
        const subgroup = normalizeSubgroup(rawGroup) || '';
        const csvPassword = cell(raw, cols.password);
        const examCode = cell(raw, cols.examCode);

        const fail = (note: string) => built.push({
          ...blank, key, name, subgroup: rawGroup, examCode, status: 'error', note,
        });

        if (seenNames.has(nameKey)) {
          return fail(isRtl ? 'اسم مكرر داخل الملف' : 'Duplicate name in this file');
        }
        if (rawEmail && seenEmails.has(rawEmail)) {
          return fail(isRtl ? 'بريد مكرر داخل الملف' : 'Duplicate email in this file');
        }
        // A group that does not exist on this stage would import a student the
        // group filters can never show, so it is refused rather than silently
        // blanked.
        if (rawGroup && !isValidSubgroup(groupConfig, rawGroup)) {
          return fail(isRtl
            ? `المجموعة "${rawGroup}" غير معرّفة لهذه المرحلة (${allowedGroups})`
            : `Group "${rawGroup}" is not defined for this stage (${allowedGroups})`);
        }

        seenNames.add(nameKey);
        if (rawEmail) seenEmails.add(rawEmail);

        const exact = (rawEmail && byEmail.get(rawEmail)) || byNameKey.get(nameKey);

        let near: Student | null = null;
        if (!exact) {
          for (const hit of fuse.search(name)) {
            const score = 1 - (hit.score ?? 1);
            const candidate = hit.item as Student;
            if (score > SUSPECT_SCORE && !claimed.has(candidate.id)
                && normalizeName(candidate.name) !== nameKey) {
              near = candidate;
              claimed.add(candidate.id);
              break;
            }
          }
        }

        const target = exact || near;
        let newLoginCode = '';
        if (!target?.loginCode) {
          do { newLoginCode = makeLoginCode(subgroup); }
          while (usedCodes.has(loginCodeKeyFor(newLoginCode)));
          usedCodes.add(loginCodeKeyFor(newLoginCode));
        }

        built.push({
          key,
          name,
          subgroup,
          examCode,
          csvPassword,
          generatedPassword: csvPassword ? '' : generatePassword(),
          newDocId: rawEmail || newRosterDocId(),
          newLoginCode,
          existingId: target?.id || '',
          existingName: target?.currentName || target?.name || '',
          existingLoginCode: target?.loginCode || '',
          status: exact ? 'update' : near ? 'suspect' : 'new',
          // Default a suspect to updating: creating a duplicate account is the
          // damaging mistake, and it is the one that is hard to undo.
          action: 'update',
          note: exact
            ? (isRtl ? 'تحديث لطالب موجود' : 'Updates an existing student')
            : '',
        });
      });

      setRows(built);
      setFileName(file.name);
      if (built.every(r => r.status === 'error')) {
        setError(isRtl ? 'لا يوجد أي صف صالح في هذا الملف.' : 'No valid rows in this file.');
      }
    } catch (err: any) {
      console.error('Roster import parse failed:', err);
      setError(err.message || (isRtl ? 'فشل قراءة الملف' : 'Failed to read the file'));
    } finally {
      setIsBusy(false);
      if (e.target) e.target.value = '';
    }
  };

  const handleCommit = async () => {
    if (valid.length === 0) return;
    if (!creationStageIsValid || !effectiveStageId) {
      setError(isRtl
        ? 'تعذّر تحديد مرحلة دراسية صحيحة. أعد تحميل المراحل قبل الاستيراد.'
        : 'A valid stage is required. Reload the stages before importing.');
      return;
    }
    setIsBusy(true);
    setError(null);

    try {
      let freshIntakeYearLabel: string | null = null;
      if (freshIntake) {
        const calSnap = await getDoc(doc(db, 'app_settings', 'academicCalendar'));
        freshIntakeYearLabel = (calSnap.exists() && calSnap.data().yearLabel) || DEFAULT_CALENDAR.yearLabel;
      }

      const list: IssuedRow[] = [];
      let created = 0;
      let updated = 0;

      for (let start = 0; start < valid.length; start += BATCH_LIMIT) {
        const batch = writeBatch(db);
        for (const row of valid.slice(start, start + BATCH_LIMIT)) {
          const { updating, docId, loginCode, password, forced } = resolveRow(row);

          const payload: Record<string, any> = {
            name: row.name,
            nameKey: nameKeyFor(row.name),
            email: docId,
            loginCode,
            loginCodeKey: loginCodeKeyFor(loginCode),
            isActive: true,
            stageId: effectiveStageId,
          };
          if (row.subgroup) payload.subgroup = row.subgroup;
          if (row.examCode) payload.examCode = row.examCode;
          if (isPlaceholderEmail(docId)) payload.placeholderEmail = true;
          if (password) {
            payload.password = await hashPassword(password);
            // Only a password WE generated is forced; one the file supplied is
            // presumed deliberate.
            payload.mustChangePassword = forced;
          }
          if (!updating) {
            payload.createdAt = serverTimestamp();
            if (!row.examCode) payload.examCode = '';
            if (freshIntakeYearLabel) Object.assign(payload, completedProgressionFields(freshIntakeYearLabel));
          }

          // merge so an update never clears fields this file has no column for.
          batch.set(doc(db, 'students', docId), payload, { merge: true });
          updating ? updated++ : created++;

          if (password) {
            list.push({
              name: row.name,
              subgroup: row.subgroup,
              loginCode,
              email: isPlaceholderEmail(docId) ? '' : docId,
              password,
            });
          }
        }
        await batch.commit();
      }

      await logAdminAction('IMPORT_STUDENTS_CSV',
        `stage=${effectiveStageId} file="${fileName}" created=${created} updated=${updated} passwords=${list.length}`);

      // Offer the file immediately, but never claim it arrived - see `issued`.
      if (list.length > 0) downloadCsv(passwordsFileName(), issuedCsv(list));

      setIssued(list.length > 0 ? list : null);
      setResult(isRtl
        ? `تم استيراد ${created + updated} طالب (${created} جديد، ${updated} تحديث).`
        : `Imported ${created + updated} students (${created} new, ${updated} updated).`);
      setRows([]);
      setFileName('');
      onImported();
    } catch (err: any) {
      console.error('Roster import commit failed:', err);
      setError(err.message || (isRtl ? 'فشل حفظ الطلاب' : 'Failed to save students'));
    } finally {
      setIsBusy(false);
    }
  };

  // ---------------------------------------------------------------------------

  if (issued) {
    return (
      <div className="border-2 border-amber-300 dark:border-amber-800 rounded-2xl overflow-hidden">
        <div className="px-3 py-2.5 bg-amber-50 dark:bg-amber-900/20">
          <h3 className="text-sm font-black text-amber-800 dark:text-amber-300 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            {isRtl ? `كلمات مرور ${issued.length} طالب` : `${issued.length} student passwords`}
          </h3>
          <p className="text-[11px] font-bold text-amber-700 dark:text-amber-500 mt-1 leading-relaxed">
            {isRtl
              ? 'تظهر مرة واحدة فقط ولا يمكن استرجاعها. نزّل الملف أو انسخ القائمة قبل الإغلاق.'
              : 'Shown once and not recoverable. Download the file or copy the list before closing.'}
          </p>
        </div>

        <div className="max-h-64 overflow-y-auto divide-y divide-slate-100 dark:divide-zinc-800">
          {issued.map((r, i) => (
            <div key={i} className="px-3 py-2 flex items-center gap-2 text-xs">
              <div className="flex-1 min-w-0">
                <div className="font-bold text-slate-700 dark:text-slate-200 truncate">{r.name}</div>
                <div className="text-slate-400 font-mono text-[11px]" dir="ltr">
                  {r.subgroup || '—'} · {r.loginCode}
                </div>
              </div>
              <span className="font-mono font-black text-sm text-slate-800 dark:text-slate-100 shrink-0" dir="ltr">
                {r.password}
              </span>
            </div>
          ))}
        </div>

        <div className="p-3 bg-slate-50 dark:bg-zinc-900 border-t border-slate-200 dark:border-zinc-800 space-y-2">
          <div className="flex gap-2">
            <button
              onClick={() => downloadCsv(passwordsFileName(), issuedCsv(issued))}
              className="flex-1 py-2.5 bg-sky-600 text-white rounded-xl font-bold text-sm hover:bg-sky-700 transition-colors flex items-center justify-center gap-2"
            >
              <Download className="w-4 h-4" />
              {isRtl ? 'تنزيل الملف' : 'Download file'}
            </button>
            <button
              onClick={() => copyIssued(issued)}
              className="flex-1 py-2.5 bg-slate-200 dark:bg-zinc-800 text-slate-700 dark:text-slate-200 rounded-xl font-bold text-sm hover:bg-slate-300 dark:hover:bg-zinc-700 transition-colors flex items-center justify-center gap-2"
            >
              {copied ? <Check className="w-4 h-4" strokeWidth={3} /> : <Copy className="w-4 h-4" />}
              {copied ? (isRtl ? 'تم النسخ' : 'Copied') : (isRtl ? 'نسخ الكل' : 'Copy all')}
            </button>
          </div>
          <button
            onClick={() => { setIssued(null); setCopied(false); }}
            className="w-full py-2 rounded-xl font-bold text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-zinc-800"
          >
            {isRtl ? 'حفظتها — إغلاق' : 'I have saved them — close'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-sm font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2">
        {isRtl ? 'استيراد قائمة الطلاب' : 'Import student list'}
      </h3>

      <label className="mb-3 flex items-start gap-2 p-2.5 bg-slate-50 dark:bg-zinc-900 rounded-xl border border-slate-200 dark:border-zinc-800 cursor-pointer">
        <input
          type="checkbox"
          checked={freshIntake}
          onChange={e => setFreshIntake(e.target.checked)}
          className="mt-0.5 shrink-0"
        />
        <span className="text-xs">
          <span className="font-bold text-slate-700 dark:text-slate-200 block">
            {isRtl ? 'دفعة جديدة كلياً' : 'Brand-new cohort'}
          </span>
          <span className="text-slate-500 dark:text-slate-400">
            {isRtl
              ? 'لا نتيجة عام سابق لديهم ليُبلَّغوا عنها — لن يُسألوا سؤال النتيجة هذا العام.'
              : "They have no prior year's result to report — they won't be asked this year's result question."}
          </span>
        </span>
      </label>

      <label className="w-full py-2.5 bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-slate-300 rounded-xl font-bold hover:bg-slate-200 dark:hover:bg-zinc-700 transition-all flex items-center justify-center gap-2 cursor-pointer border border-slate-200 dark:border-zinc-700">
        {isBusy ? <Loader2 className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />}
        {isRtl ? 'اختر ملف Excel أو CSV' : 'Choose an Excel or CSV file'}
        <input
          type="file"
          accept=".csv,.txt,.xlsx,.xlsm,.xlsb,.xls,.ods"
          className="hidden"
          onChange={handleFile}
          disabled={isBusy}
        />
      </label>

      <p className="text-xs text-slate-500 mt-2 text-center leading-relaxed">
        {isRtl
          ? 'الأعمدة: name (مطلوب)، group، password، email، examCode'
          : 'Columns: name (required), group, password, email, examCode'}
        <br />
        <span className="text-slate-400">
          {isRtl
            ? 'ما لا تضعه يُنشأ تلقائياً: كلمة مرور ورمز دخول لكل طالب'
            : 'Anything you omit is generated: a password and a login code per student'}
        </span>
      </p>

      {error && (
        <div className="mt-3 p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-xl text-xs font-bold flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {result && (
        <div className="mt-3 p-3 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 rounded-xl text-xs font-bold flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{result}</span>
        </div>
      )}

      {rows.length > 0 && (
        <div className="mt-4 border border-slate-200 dark:border-zinc-800 rounded-2xl overflow-hidden">
          <div className="px-3 py-2.5 bg-slate-50 dark:bg-zinc-900 flex items-center justify-between gap-2 border-b border-slate-200 dark:border-zinc-800">
            <div className="text-xs font-bold text-slate-600 dark:text-slate-300 min-w-0">
              <div className="truncate">{fileName}</div>
              <div className="text-slate-400 font-medium mt-0.5">
                {isRtl
                  ? `${valid.length} صالح · ${suspects.length} للمراجعة · ${errored.length} خطأ`
                  : `${valid.length} valid · ${suspects.length} to review · ${errored.length} with errors`}
              </div>
            </div>
            <button
              onClick={() => { setRows([]); setFileName(''); setError(null); }}
              className="p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-zinc-800 shrink-0"
              title={isRtl ? 'إلغاء' : 'Cancel'}
            >
              <X className="w-4 h-4 text-slate-400" />
            </button>
          </div>

          <div className="max-h-72 overflow-y-auto divide-y divide-slate-100 dark:divide-zinc-800">
            {rows.map(row => (
              <div key={row.key} className="px-3 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      row.status === 'error' ? 'bg-red-500'
                        : row.status === 'suspect' ? 'bg-orange-500'
                        : row.status === 'update' ? 'bg-amber-500' : 'bg-emerald-500'
                    }`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-slate-700 dark:text-slate-200 truncate">
                      {row.name || (isRtl ? '(بدون اسم)' : '(no name)')}
                    </div>
                    {row.note && (
                      <div className={`mt-0.5 ${row.status === 'error' ? 'text-red-500' : 'text-amber-600 dark:text-amber-500'}`}>
                        {row.note}
                      </div>
                    )}
                  </div>
                  {row.status !== 'error' && (
                    <div className="text-slate-400 font-mono shrink-0 text-[11px]" dir="ltr">
                      {row.subgroup || '—'} · {resolveRow(row).loginCode}
                    </div>
                  )}
                </div>

                {row.status === 'suspect' && (
                  <div className="mt-1.5 ms-3.5 p-2 bg-orange-50 dark:bg-orange-900/20 rounded-lg">
                    <p className="text-[11px] font-bold text-orange-700 dark:text-orange-400 leading-snug">
                      {isRtl
                        ? `اسم قريب من طالب موجود: "${row.existingName}"`
                        : `Close to an existing student: "${row.existingName}"`}
                    </p>
                    <div className="flex gap-1.5 mt-1.5">
                      <button
                        onClick={() => setAction(row.key, 'update')}
                        className={`px-2.5 py-1 rounded-lg text-[11px] font-black transition-colors ${
                          row.action === 'update'
                            ? 'bg-orange-600 text-white'
                            : 'bg-white dark:bg-zinc-800 text-slate-500'
                        }`}
                      >
                        {isRtl ? 'نفس الطالب' : 'Same student'}
                      </button>
                      <button
                        onClick={() => setAction(row.key, 'create')}
                        className={`px-2.5 py-1 rounded-lg text-[11px] font-black transition-colors ${
                          row.action === 'create'
                            ? 'bg-orange-600 text-white'
                            : 'bg-white dark:bg-zinc-800 text-slate-500'
                        }`}
                      >
                        {isRtl ? 'شخص آخر' : 'Different person'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          {valid.length > 0 && (
            <div className="p-3 bg-slate-50 dark:bg-zinc-900 border-t border-slate-200 dark:border-zinc-800">
              {willIssue > 0 && (
                <p className="text-[11px] text-amber-700 dark:text-amber-500 font-bold mb-2.5 flex items-start gap-1.5">
                  <Download className="w-3.5 h-3.5 shrink-0 mt-px" />
                  <span>
                    {isRtl
                      ? `سيتم إصدار كلمة مرور لـ ${willIssue} طالب، وتظهر مرة واحدة فقط.`
                      : `${willIssue} passwords will be issued, shown once only.`}
                  </span>
                </p>
              )}
              <button
                onClick={handleCommit}
                disabled={isBusy}
                className="w-full py-2.5 bg-sky-600 text-white rounded-xl font-bold hover:bg-sky-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isBusy && <Loader2 className="w-4 h-4 animate-spin" />}
                {isRtl ? `استيراد ${valid.length} طالب` : `Import ${valid.length} students`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
