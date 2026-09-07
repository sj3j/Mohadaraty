import React, { useState, useEffect } from 'react';
import { X, UserPlus, Trash2, Users, Loader2, AlertCircle, CheckCircle2, XCircle, Upload, Download, GitMerge, User, Mail, Calendar, Flame, BookOpen, Settings, KeyRound, Copy, Layers, Search } from 'lucide-react';
import { auth, db } from '../lib/firebase';
import { collection, query, where, getDocs, deleteDoc, doc, updateDoc, setDoc, getDoc, serverTimestamp, writeBatch, limit } from 'firebase/firestore';
import { Language, TRANSLATIONS, Student, UserProfile } from '../types';
import { motion, AnimatePresence } from 'motion/react';
import { hashPassword } from '../lib/hash';
import { logAdminAction } from '../services/adminLogService';
import { useStageContext } from '../contexts/StageContext';
import StageSettingsModal from './StageSettingsModal';
import SignupRequestsQueue from './SignupRequestsQueue';
import DeletionRequestsQueue from './DeletionRequestsQueue';
import { canManageGroups } from '../lib/permissions';
import { apiUrl } from '../lib/apiBase';
import RosterImport from './RosterImport';
import { nameKeyFor, normalizeName } from '../../shared/rosterIdentity';
import { completedProgressionFields } from '../../shared/progression';
import { useAcademicPhase } from '../hooks/useAcademicPhase';

interface StudentManagementProps {
  isOpen: boolean;
  onClose: () => void;
  lang: Language;
  user: UserProfile | null;
}

interface ExamCodeMatch {
  rowId: string;
  csvName: string;
  csvExamCode: string;
  matchedStudentId: string | null;
  matchedStudentName: string | null;
  matchScore: number;
}

export default function StudentManagement({ isOpen, onClose, lang, user }: StudentManagementProps) {
  const t = TRANSLATIONS[lang];
  const isRtl = lang === 'ar';
  const isMasterAdmin = ['almdrydyl335@gmail.com', 'jempe.kn@gmail.com'].includes(user?.email?.toLowerCase() || '') || user?.isMasterAdmin;
  const { effectiveStageId, groupConfig, stages } = useStageContext();
  const { yearLabel } = useAcademicPhase();
  const [showGroupSettings, setShowGroupSettings] = useState(false);

  // Group/subgroup options come from the stage config, not a hardcoded A-D list.
  const groupIds = groupConfig.groups.map(g => g.id);
  const subgroupOptions = groupConfig.groups.flatMap(g =>
    Array.from({ length: g.subgroupCount }, (_, i) => `${g.id}${i + 1}`)
  );
  const subgroupsForGroup = (groupId: string) => {
    const group = groupConfig.groups.find(g => g.id === groupId);
    if (!group) return [];
    return Array.from({ length: group.subgroupCount }, (_, i) => `${groupId}${i + 1}`);
  };
  
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [examCode, setExamCode] = useState('');
  const [subgroup, setSubgroup] = useState('');
  
  const [students, setStudents] = useState<Student[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [isDeletingAll, setIsDeletingAll] = useState(false);
  const [editingStudent, setEditingStudent] = useState<Student | null>(null);
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [editExamCode, setEditExamCode] = useState('');
  const [editSubgroup, setEditSubgroup] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedGroupFilter, setSelectedGroupFilter] = useState('All');
  const [selectedSubgroupFilter, setSelectedSubgroupFilter] = useState('All');
        const [matchedExamCodes, setMatchedExamCodes] = useState<ExamCodeMatch[]>([]);
  const [examCodesCsvName, setExamCodesCsvName] = useState<string>('');
  const [sortUnmatchedFirst, setSortUnmatchedFirst] = useState(false);
  const [mergingBaseId, setMergingBaseId] = useState<string | null>(null);
  // A re-issued password, held until dismissed. It exists nowhere else: the
  // stored copy is a bcrypt hash, so closing this without reading it means
  // generating another one.
  const [resetResult, setResetResult] = useState<{ name: string; loginCode: string; password: string } | null>(null);
  const [resettingId, setResettingId] = useState<string | null>(null);
  /**
   * Which panel is on screen.
   *
   * Everything used to be stacked in one 20rem column beside the roster: the
   * add form, the signup queue, the roster importer and the exam-code
   * importer, all at once. On a phone that column comes FIRST, so reaching the
   * student list meant scrolling past four tools, and the importer - the one
   * that needs room for a preview table - had the least of it.
   */
  const [panel, setPanel] = useState<'roster' | 'add' | 'import' | 'requests' | 'codes' | 'orphans'>('roster');
  const [viewingProfile, setViewingProfile] = useState<UserProfile | null>(null);
  const [isFetchingProfile, setIsFetchingProfile] = useState(false);
  






















































































































































  const handleViewProfile = async (userUid: string) => {
    setIsFetchingProfile(true);
    try {
      const userSnap = await getDoc(doc(db, 'users', userUid));
      if (userSnap.exists()) {
        setViewingProfile(userSnap.data() as UserProfile);
      } else {
        setError(isRtl ? 'لم يتم العثور على ملف تعريف الطالب' : 'Student profile not found');
      }
    } catch (err: any) {
      console.error('Error fetching profile:', err);
      setError('Error fetching profile');
    } finally {
      setIsFetchingProfile(false);
    }
  };

  /**
   * Students the stage-scoped roster can never show.
   *
   * fetchStudents filters both collections on `stageId == effectiveStageId`, so
   * a row whose stageId is missing - or points at a stage document that no
   * longer exists - belongs to no stage and appears under none of them. That is
   * how a student ends up with a blank المرحلة that nobody can fix: they are
   * invisible to the very screen that would fix it.
   *
   * Firestore cannot query for an absent field, so this is an unfiltered read
   * of the whole collection, capped and behind an explicit button rather than
   * running with the roster. Master admin only, and not merely as a UI
   * preference: canManageStudentsOn() in firestore.rules short-circuits for the
   * master admin regardless of a document's stageId, while for a representative
   * a row with no stageId evaluates canManageStudentsOn('') and fails - there
   * is no rules-legal way for them to read these at all.
   */
  const ORPHAN_SCAN_LIMIT = 500;
  const [orphans, setOrphans] = useState<Student[] | null>(null);
  const [isScanningOrphans, setIsScanningOrphans] = useState(false);
  const [orphanAssignments, setOrphanAssignments] = useState<Record<string, string>>({});
  const [assigningOrphan, setAssigningOrphan] = useState<string | null>(null);

  const scanForOrphans = async () => {
    setIsScanningOrphans(true);
    setError(null);
    try {
      const knownStageIds = new Set(stages.map(st => st.id));
      const snapshot = await getDocs(query(collection(db, 'students'), limit(ORPHAN_SCAN_LIMIT)));
      const rows = snapshot.docs
        .map(d => ({ ...(d.data() as any), id: d.id } as Student))
        .filter(row => !row.stageId || !knownStageIds.has(row.stageId));
      setOrphans(rows);
    } catch (err: any) {
      console.error('Error scanning for students without a stage:', err);
      setOrphans(null);
      setError(isRtl ? 'تعذّر البحث عن الطلاب بدون مرحلة' : 'Could not scan for students without a stage');
    } finally {
      setIsScanningOrphans(false);
    }
  };

  const assignStage = async (student: Student, stageId: string) => {
    if (!stageId) return;
    setAssigningOrphan(student.id);
    setError(null);
    setSuccess(null);
    try {
      // completedProgressionFields stamps them as already handled for this
      // year. Without it, giving a student a stageId mid-progression-season
      // drops them straight onto the blocking ProgressionScreen with a question
      // about a year they have no result to report for. RosterImport and the
      // CLI promotion stamp it for the same reason.
      const patch = { stageId, ...completedProgressionFields(yearLabel) };

      const batch = writeBatch(db);
      batch.set(doc(db, 'students', student.id), patch, { merge: true });

      // Both copies, always: syncUserStage copies the students value onto the
      // user document at every login, so a users-only write is reverted, and a
      // students-only write leaves the live session showing the old value.
      const emailLower = (student.email || student.id).toLowerCase().trim();
      const userDocs = await getDocs(query(collection(db, 'users'), where('email', '==', emailLower)));
      userDocs.docs.forEach(d => batch.set(d.ref, patch, { merge: true }));

      await batch.commit();
      await logAdminAction('ASSIGN_STAGE', `Assigned ${student.id} to ${stageId}`);
      setSuccess(isRtl ? 'تم تعيين المرحلة' : 'Stage assigned');
      setOrphans(prev => (prev || []).filter(row => row.id !== student.id));
      if (stageId === effectiveStageId) fetchStudents();
    } catch (err: any) {
      console.error('Error assigning a stage:', err);
      setError(stageAwareMessage(err, isRtl ? 'فشل تعيين المرحلة' : 'Failed to assign the stage'));
    } finally {
      setAssigningOrphan(null);
    }
  };

  const fetchStudents = async () => {
    setIsLoading(true);
    try {
      // NOTE: students collection doesn't have stageId by default yet in Phase 2, but users does. 
      // We will filter users by stageId, and students by stageId if possible.
      // But if we just filter users, students who haven't logged in won't be filtered by stage. 
      // Let's assume students collection has stageId or we only filter users for now.
      // Wait, let's filter both.
      const snapshot = await getDocs(query(collection(db, 'students'), where('stageId', '==', effectiveStageId)));
      const usersSnapshot = await getDocs(query(collection(db, 'users'), where('stageId', '==', effectiveStageId)));
      
      const userMap = new Map<string, any[]>();
      usersSnapshot.docs.forEach((doc: any) => {
        const userData = doc.data();
        const userEmail = userData.email || doc.id;
        if (userEmail) {
          const emailLower = userEmail.toLowerCase().trim();
          if (!userMap.has(emailLower)) {
            userMap.set(emailLower, []);
          }
          userMap.get(emailLower)!.push({
            name: userData.name,
            streakCount: userData.streakCount || 0,
            longestStreak: userData.longestStreak || 0,
            freezeTokens: userData.freezeTokens || 0,
            userUid: doc.id,
            createdAt: userData.createdAt || null,
            role: userData.role || 'student'
          });
        }
      });
      
      const studentsData: any[] = [];
      const processedEmails = new Set<string>();
      
      snapshot.docs.forEach((doc: any) => {
        const data = doc.data();
        const emailLower = (data.email || doc.id).toLowerCase().trim();
        processedEmails.add(emailLower);
        const userProfiles = userMap.get(emailLower) || [];
        
        if (userProfiles.length === 0) {
          studentsData.push({
            id: doc.id,
            name: data.name,
            email: data.email,
            examCode: data.examCode || '',
            subgroup: data.subgroup || '',
            loginCode: data.loginCode || '',
            placeholderEmail: data.placeholderEmail === true,
            googleEmail: data.googleEmail || '',
            isActive: data.isActive ?? true,
            createdAt: data.createdAt,
            userUid: undefined,
            currentName: data.name,
            streakCount: 0,
            longestStreak: 0,
            freezeTokens: 0,
            isAuthAccountOnly: false
          });
        } else {
          userProfiles.forEach((profile: any, index: number) => {
            studentsData.push({
              id: index === 0 ? doc.id : `${doc.id}_dup_${index}_${profile.userUid}`,
              baseStudentId: doc.id,
              name: data.name,
              email: data.email,
              examCode: data.examCode || '',
              subgroup: data.subgroup || '',
              loginCode: data.loginCode || '',
              placeholderEmail: data.placeholderEmail === true,
              googleEmail: data.googleEmail || '',
              isActive: data.isActive ?? true,
              createdAt: profile.createdAt || data.createdAt,
              userUid: profile.userUid,
              currentName: profile.name || data.name,
              streakCount: profile.streakCount || 0,
              longestStreak: profile.longestStreak || 0,
              freezeTokens: profile.freezeTokens || 0,
              isAuthAccountOnly: index > 0,
              hasMultiple: userProfiles.length > 1,
              role: profile.role
            });
          });
        }
      });
      
      // Add all other users (e.g. admins or master admins) not in students collection
      userMap.forEach((profiles, email) => {
        if (!processedEmails.has(email)) {
          profiles.forEach((profile: any, index: number) => {
             studentsData.push({
                id: `auth_only_${profile.userUid}`,
                baseStudentId: `auth_only_${profile.userUid}`,
                name: profile.name || email,
                email: email,
                examCode: profile.examCode || '',
                isActive: true, // Auth-only users don't have a status in students collection
                createdAt: profile.createdAt || null,
                userUid: profile.userUid,
                currentName: profile.name || email,
                streakCount: profile.streakCount || 0,
                longestStreak: profile.longestStreak || 0,
                freezeTokens: profile.freezeTokens || 0,
                isAuthAccountOnly: true,
                hasMultiple: profiles.length > 1,
                role: profile.role
             });
          });
        }
      });
      
      const uniqueStudentsMap = new Map();
      studentsData.forEach(s => {
        if (!uniqueStudentsMap.has(s.id)) {
          uniqueStudentsMap.set(s.id, s);
        } else {
          // If a duplicate ID is somehow generated, append a timestamp to make it unique so we don't lose the record
          const newId = `${s.id}_fallback_${Date.now()}_${Math.random()}`;
          uniqueStudentsMap.set(newId, { ...s, id: newId });
        }
      });
      setStudents(Array.from(uniqueStudentsMap.values()) as unknown as Student[]);
    } catch (err) {
      console.error('Error fetching students:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchStudents();
    }
  }, [isOpen, effectiveStageId]);

  useEffect(() => {
    if (selectedGroupFilter !== 'All') {
      if (selectedSubgroupFilter !== 'All') {
         setSubgroup(selectedSubgroupFilter);
      } else if (!subgroup.startsWith(selectedGroupFilter)) {
         setSubgroup(`${selectedGroupFilter}1`);
      }
    }
  }, [selectedGroupFilter, selectedSubgroupFilter]);

  /**
   * Turns a rules rejection into something actionable.
   *
   * `students` is scoped to the stage a representative manages, so the usual
   * cause of permission-denied here is not a bug but an address that belongs
   * to another cohort - which the raw Firebase message does not say.
   */
  const stageAwareMessage = (err: any, fallback: string) => {
    if (err?.code === 'permission-denied' || /permission/i.test(err?.message || '')) {
      return isRtl
        ? 'هذا البريد يخص طالباً في مرحلة أخرى، أو ليس لديك صلاحية على هذه المرحلة.'
        : 'That address belongs to a student on another stage, or you have no authority over this stage.';
    }
    return err?.message || fallback;
  };

  const handleAddStudent = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    setSuccess(null);

    try {
      const emailLower = email.toLowerCase();

      // Checked against the loaded roster rather than with a getDoc. The
      // students rules are stage-scoped now, and a get on a document that does
      // not exist has no stageId to match, so the probe would come back
      // permission-denied for every genuinely new address.
      if (students.some(s => (s.baseStudentId || s.id).toLowerCase() === emailLower)) {
        throw new Error(isRtl ? 'الطالب موجود بالفعل' : 'Student already exists');
      }

      const hashedPassword = await hashPassword(password);

      await setDoc(doc(db, 'students', emailLower), {
        name,
        // Every path that writes `name` must write nameKey too - /api/login
        // queries it, so a student without one can only sign in by email.
        nameKey: nameKeyFor(name),
        email: emailLower,
        password: hashedPassword,
        examCode,
        subgroup,
        isActive: true,
        stageId: effectiveStageId,
        createdAt: serverTimestamp()
      });

      setSuccess(isRtl ? 'تمت إضافة الطالب بنجاح' : 'Student added successfully');
      await logAdminAction('ADD_STUDENT', `Added new student: ${emailLower}`);
      setName('');
      setEmail('');
      setPassword('');
      setExamCode('');
      setSubgroup('');
      fetchStudents();
    } catch (err: any) {
      console.error('Error adding student:', err);
      setError(stageAwareMessage(err, isRtl ? 'فشل إضافة الطالب' : 'Failed to add student'));
    } finally {
      setIsSubmitting(false);
    }
  };

  /**
   * The per-row actions, shared by the desktop table and the mobile cards.
   *
   * Extracted rather than duplicated: it carries the inline delete
   * confirmation, so two copies would drift on the one interaction where that
   * matters most.
   */
  const renderStudentActions = (student: Student) => (
                  deletingId === student.id ? (
                    <div className="flex items-center justify-center gap-2">
                      <button
                        onClick={() => handleDeleteStudent(student.id)}
                        className="px-2 py-1 text-xs font-bold bg-red-100 text-red-600 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 rounded-lg transition-colors"
                      >
                        {isRtl ? 'تأكيد' : 'Confirm'}
                      </button>
                      <button
                        onClick={() => setDeletingId(null)}
                        className="px-2 py-1 text-xs font-bold bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-zinc-700 dark:text-slate-300 rounded-lg transition-colors"
                      >
                        {isRtl ? 'إلغاء' : 'Cancel'}
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-center gap-1">
                      {student.userUid && (
                        <button
                          onClick={() => handleViewProfile(student.userUid!)}
                          className="p-2 text-indigo-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 rounded-lg transition-colors"
                          title={isRtl ? 'عرض الملف الشخصي' : 'View Profile'}
                        >
                          <User className="w-4 h-4" />
                        </button>
                      )}
                      {student.hasMultiple && (
                        <button
                          onClick={() => setMergingBaseId(student.baseStudentId || student.id)}
                          className="p-2 text-amber-500 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/30 rounded-lg transition-colors"
                          title={isRtl ? 'دمج الحسابات' : 'Merge Accounts'}
                        >
                          <GitMerge className="w-4 h-4" />
                        </button>
                      )}
                      {!student.isAuthAccountOnly && (
                        <button
                          onClick={() => handleResetPassword(student)}
                          disabled={resettingId === student.id}
                          className="p-2 text-slate-400 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/30 rounded-lg transition-colors disabled:opacity-50"
                          title={isRtl ? 'إصدار كلمة مرور جديدة' : 'Issue a new password'}
                        >
                          {resettingId === student.id
                            ? <Loader2 className="w-4 h-4 animate-spin" />
                            : <KeyRound className="w-4 h-4" />}
                        </button>
                      )}
                      <button
                        onClick={() => {
                          setPanel('add');
                          setEditingStudent(student);
                          setEditName(student.name);
                          setEditEmail(student.email);
                          setEditPassword('');
                          setEditExamCode(student.examCode || '');
                          setEditSubgroup(student.subgroup || '');
                        }}
                        className="p-2 text-slate-400 hover:text-sky-600 hover:bg-sky-50 dark:hover:bg-sky-900/30 rounded-lg transition-colors"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => setDeletingId(student.id)}
                        className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  )
  );

  /**
   * Issues a replacement password for one student.
   *
   * Routed through the API rather than the SDK on purpose: the server picks the
   * password, bcrypts it, and refuses a target outside the caller's own stage -
   * none of which a client-side write could enforce.
   */
  const handleResetPassword = async (student: Student) => {
    const targetId = student.baseStudentId || student.id;
    const ok = window.confirm(isRtl
      ? `إصدار كلمة مرور جديدة لـ "${student.name}"؟ كلمته الحالية لن تعمل بعدها.`
      : `Issue a new password for "${student.name}"? Their current one will stop working.`);
    if (!ok) return;

    setResettingId(student.id);
    setError(null);
    try {
      const token = await auth.currentUser?.getIdToken();
      const res = await fetch(apiUrl(`/api/admin/students/${encodeURIComponent(targetId)}/reset-password`), {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to reset password');

      setResetResult({
        name: data.name || student.name,
        loginCode: data.loginCode || student.loginCode || '',
        password: data.password,
      });
      await logAdminAction('RESET_STUDENT_PASSWORD',
        `stage=${effectiveStageId} student=${targetId}`);
      fetchStudents();
    } catch (err: any) {
      console.error('Error resetting password:', err);
      setError(err.message || (isRtl ? 'فشل إصدار كلمة المرور' : 'Failed to reset password'));
    } finally {
      setResettingId(null);
    }
  };

  const handleToggleActive = async (student: Student) => {
    try {
      const targetId = student.baseStudentId || student.id;
      await updateDoc(doc(db, 'students', targetId), {
        isActive: !student.isActive
      });
      await logAdminAction('TOGGLE_STUDENT_STATUS', `${student.isActive ? 'Deactivated' : 'Activated'} student: ${student.email}`);
      setStudents(students.map(s => (s.baseStudentId || s.id) === targetId ? { ...s, isActive: !s.isActive } : s));
    } catch (err) {
      console.error('Error toggling student status:', err);
    }
  };

  const handleDeleteStudent = async (id: string) => {
    try {
      const student = students.find(s => s.id === id);
      if (!student) return;

      if (student.isAuthAccountOnly && student.userUid) {
        // Delete only the duplicated Auth account via backend
        const token = await auth.currentUser?.getIdToken();
        const res = await fetch(apiUrl(`/api/admin/users/${student.userUid}`), {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });
        
        if (!res.ok) {
          const text = await res.text();
          let errorMsg = 'Failed to delete Auth account';
          if (text.startsWith('<!DOCTYPE') || text.startsWith('<html')) {
            errorMsg = `Server returned an HTML error page (Status ${res.status}). Server may be restarting.`;
          } else {
            try {
              const data = JSON.parse(text);
              errorMsg = data.error || errorMsg;
            } catch (e) {
              errorMsg = `Server error (${res.status}): ${text.substring(0, 100)}`;
            }
          }
          throw new Error(errorMsg);
        }
        await logAdminAction('DELETE_AUTH_ACCOUNT', `Deleted duplicate Auth account for: ${student.email} (${student.userUid})`);
      } else {
        // Delete original student list record
        await deleteDoc(doc(db, 'students', student.baseStudentId || id));
        if (student.userUid) {
          // Also try to delete auth account if exists, but we can't reliably do it from client
          const token = await auth.currentUser?.getIdToken();
          await fetch(apiUrl(`/api/admin/users/${student.userUid}`), {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
          }).catch(console.error); // Ignore error if it fails
        }
        await logAdminAction('DELETE_STUDENT', `Deleted student record: ${student.baseStudentId || id}`);
      }
      
      fetchStudents();
      setDeletingId(null);
    } catch (err: any) {
      console.error('Error deleting student:', err);
      setError(err.message || (isRtl ? 'فشل حذل الطالب' : 'Failed to delete student'));
    }
  };































  const handleDeleteAllStudents = async () => {
    try {
      const snapshot = await getDocs(query(collection(db, 'students'), where('stageId', '==', effectiveStageId)));
      const batch = writeBatch(db);
      snapshot.docs.forEach((doc) => {
        batch.delete(doc.ref);
      });
      await batch.commit();
      await logAdminAction('DELETE_ALL_STUDENTS', `Batch deleted all students`);
      setStudents([]);
      setIsDeletingAll(false);
      setSuccess(isRtl ? 'تم حذف جميع الطلاب بنجاح' : 'All students deleted successfully');
    } catch (err) {
      console.error('Error deleting all students:', err);
      setError(isRtl ? 'فشل حذف جميع الطلاب' : 'Failed to delete all students');
    }
  };

  const handleEditStudent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingStudent) return;
    
    setIsSubmitting(true);
    setError(null);
    setSuccess(null);

    try {
      const oldEmail = editingStudent.baseStudentId || editingStudent.id;
      const newEmailLower = editEmail.toLowerCase();
      
      const updateData: any = {
        name: editName,
        // Kept in step with `name`, or name login stops finding them.
        nameKey: nameKeyFor(editName),
        examCode: editExamCode,
        subgroup: editSubgroup,
      };

      if (editPassword) {
        updateData.password = await hashPassword(editPassword);
      }

      if (newEmailLower !== oldEmail) {
        // Same reason as handleAddStudent: the existence check reads the loaded
        // roster, because a scoped get on a missing document is refused.
        if (students.some(s => (s.baseStudentId || s.id).toLowerCase() === newEmailLower)) {
          throw new Error(isRtl ? 'البريد الإلكتروني الجديد موجود بالفعل' : 'New email already exists');
        }
        // Changing the address rewrites the document id, and for a roster
        // student that id is also their auth uid, their users doc key and the
        // email claim in their token - so a rename would strand the account
        // they are already signed in to. They attach a real address by linking
        // Google from settings, which adds a field instead of moving the doc.
        if (editingStudent.placeholderEmail) {
          throw new Error(isRtl
            ? 'لا يمكن تغيير بريد طالب مستورد بدون بريد. اطلب منه ربط حساب Google من الإعدادات.'
            : 'Cannot change the address of an imported student. Ask them to link Google from settings.');
        }
        const oldDoc = await getDoc(doc(db, 'students', oldEmail));
        const oldData = oldDoc.data() || { createdAt: serverTimestamp() };

        await setDoc(doc(db, 'students', newEmailLower), {
          ...oldData,
          ...updateData,
          email: newEmailLower
        });
        await deleteDoc(doc(db, 'students', oldEmail));
      } else {
        await updateDoc(doc(db, 'students', oldEmail), updateData);
      }

      setSuccess(isRtl ? 'تم تحديث الطالب بنجاح' : 'Student updated successfully');
      await logAdminAction('UPDATE_STUDENT', `Updated student details: ${newEmailLower}`);
      setEditingStudent(null);
      fetchStudents();
    } catch (err: any) {
      console.error('Error editing student:', err);
      setError(stageAwareMessage(err, isRtl ? 'فشل تحديث بيانات الطالب' : 'Failed to update student'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleExamCodeCsvUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

        setIsLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const text = await file.text();
      const rows = text.split('\n').filter(row => row.trim() !== '');
      
      if (rows.length === 0) {
        throw new Error(isRtl ? 'ملف CSV فارغ' : 'CSV file is empty');
      }

      // Skip header row if it exists
      const startIndex = rows[0].toLowerCase().includes('name') ? 1 : 0;
      
      if (rows.length <= startIndex) {
        throw new Error(isRtl ? 'ملف CSV فارغ' : 'CSV file is empty');
      }

      const Fuse = (await import('fuse.js')).default;
      const fuse = new Fuse(students, {
        keys: ['name', 'currentName'],
        includeScore: true,
        threshold: 0.2 // Stricter threshold
      });

      const matches: ExamCodeMatch[] = [];
      const assignedIds = new Set<string>();

      for (let i = startIndex; i < rows.length; i++) {
        let cols = rows[i].split(',');
        if (cols.length === 1 && rows[i].includes('\t')) {
          cols = rows[i].split('\t');
        }
        
        cols = cols.map(s => s?.trim() || '');
        
        let csvName = cols[0];
        let csvExamCode = cols.slice(1).join(',').trim();

        // Auto-detect swapped columns: if first col is numbers/short code, and second is a longer string
        if (/^\d+$/.test(csvName) && !/^\d+$/.test(csvExamCode) && csvExamCode.length > csvName.length) {
           const temp = csvName;
           csvName = csvExamCode;
           csvExamCode = temp;
        }

        if (csvName && csvExamCode) {
          // Shared with /api/login, which queries students.nameKey with the
          // same folding. Two copies would drift and lock out exactly the
          // students whose names are spelled inconsistently.
          const normalize = normalizeName;
          const normalizedCsvName = normalize(csvName);
          
          let matchedStudentId = null;
          let matchedStudentName = null;
          let matchScore = 0;

          // 1. Try Exact match first
          const exactMatch = students.find(s => 
             normalize(s.name) === normalizedCsvName || 
             (s.currentName && normalize(s.currentName) === normalizedCsvName)
          );

          if (exactMatch && !assignedIds.has(exactMatch.id)) {
            matchedStudentId = exactMatch.id;
            matchedStudentName = exactMatch.name;
            matchScore = 1;
            assignedIds.add(exactMatch.id);
          } else {
            // 2. Try Fuzzy Match
            const results = fuse.search(csvName);
            for (const bestMatch of results) {
              const rawScore = bestMatch.score !== undefined ? bestMatch.score : 1;
              const currentScore = Math.max(0, 1 - rawScore);
              const matchedStudent = bestMatch.item as Student;
              
              // Demand a very high match score to avoid distributing to the wrong person
              if (currentScore > 0.85 && !assignedIds.has(matchedStudent.id)) {
                matchedStudentId = matchedStudent.id;
                matchedStudentName = matchedStudent.name;
                matchScore = currentScore;
                assignedIds.add(matchedStudent.id);
                break; // Stop looking if we found a valid available match
              }
            }
          }

          matches.push({
            rowId: `row_${i}_${Date.now()}`,
            csvName,
            csvExamCode,
            matchedStudentId,
            matchedStudentName,
            matchScore
          });
        }
      }

      setMatchedExamCodes(matches);
      setExamCodesCsvName(file.name);
    } catch (err: any) {
      console.error('Error uploading exam codes CSV:', err);
      setError(err.message || (isRtl ? 'فشل استيراد أكواد الامتحانات' : 'Failed to import exam codes'));
    } finally {
      setIsLoading(false);
      if (e.target) e.target.value = '';
    }
  };

  const handleConfirmExamCodes = async () => {
    if (!matchedExamCodes.length) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const batch = writeBatch(db);
      let count = 0;
      for (const match of matchedExamCodes) {
        if (match.matchedStudentId) {
          const studentRef = doc(db, 'students', match.matchedStudentId);
          batch.update(studentRef, { examCode: match.csvExamCode });
          count++;
        }
      }
      if (count > 0) {
        await batch.commit();
        await logAdminAction('IMPORT_EXAM_CODES', `Imported ${count} exam codes via CSV mapping`);
        setSuccess(isRtl ? `تم الحفظ: استيراد ${count} كود بنجاح` : `Saved: Successfully imported ${count} codes`);
        fetchStudents();
      } else {
        setError(isRtl ? 'لم يتم العثور على أية مطابقات للحفظ' : 'No matches found to save');
      }
      setMatchedExamCodes([]);
    } catch (err: any) {
      console.error('Error saving exam codes:', err);
      setError(err.message || (isRtl ? 'فشل حفظ الأكواد' : 'Failed to save exam codes'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDownloadNeverSignedIn = () => {
    const neverSignedIn = students.filter(s => !s.userUid);
    if (neverSignedIn.length === 0) {
      alert(isRtl ? 'لا يوجد طلاب لم يسجلوا الدخول' : 'No students who never signed in');
      return;
    }

    const csvContent = "data:text/csv;charset=utf-8,\uFEFF" 
      + (isRtl ? "الاسم,البريد الإلكتروني,رمز الدخول,الكود,الحالة\n" : "Name,Email,Login code,Exam code,Status\n")
      + neverSignedIn.map(s => `"${s.name}","${s.placeholderEmail ? '' : s.email}","${s.loginCode || ''}","${s.examCode || ''}","${s.isActive ? (isRtl ? 'مفعل' : 'Active') : (isRtl ? 'معطل' : 'Inactive')}"`).join('\n');
    
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `never_signed_in_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const filteredStudents = students.filter(student => {
    const matchesSearch = student.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
      student.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (student.loginCode || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      (student.googleEmail || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      (student.examCode || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      (student.subgroup || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      (student.currentName && student.currentName.toLowerCase().includes(searchQuery.toLowerCase()));
      
    if (selectedGroupFilter !== 'All') {
      // subgroup looks like "A1", "B2". We check if it starts with the selected group.
      const studentGroup = (student.subgroup || '').charAt(0).toUpperCase();
      if (studentGroup !== selectedGroupFilter) return false;
    }
    
    return matchesSearch;
  });

  const sortedExamCodes = [...matchedExamCodes].sort((a, b) => {
    if (sortUnmatchedFirst) {
      const aMatched = !!a.matchedStudentId;
      const bMatched = !!b.matchedStudentId;
      if (aMatched === bMatched) return 0;
      return aMatched ? 1 : -1;
    }
    return 0;
  });

  const selectedStudentIds = new Set(matchedExamCodes.map(r => r.matchedStudentId).filter(Boolean));

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[110] flex bg-slate-50 dark:bg-zinc-950" dir={isRtl ? 'rtl' : 'ltr'}>
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="relative w-full h-full bg-white dark:bg-zinc-900 overflow-hidden flex flex-col shadow-2xl"
          >
            <div className="px-6 pt-[max(env(safe-area-inset-top),1rem)] pb-4 border-b border-slate-100 dark:border-zinc-800 flex justify-between items-center bg-sky-600 dark:bg-sky-600 text-white">
              <h2 className="text-xl font-bold flex items-center gap-2">
                <Users className="w-5 h-5" />
                {isRtl ? 'إدارة الطلاب' : 'Manage Students'}
              </h2>
              <button onClick={onClose} className="p-2 hover:bg-white/20 rounded-full transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            
            

            <div className="flex-1 overflow-hidden flex flex-col">




































              {matchedExamCodes.length > 0 ? (
                <div className="p-6 overflow-y-auto flex-1 flex flex-col gap-6">

                <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between border-b border-slate-200 dark:border-zinc-800 pb-4">
                  <div>
                    <h2 className="text-lg font-bold text-slate-900 dark:text-white">
                      {isRtl ? `مراجعة كشف أكواد الامتحانات: ${examCodesCsvName}` : `Review Exam Codes CSV: ${examCodesCsvName}`}
                    </h2>
                    <div className="flex items-center gap-4 mt-1">
                      <p className="text-sm text-slate-500 dark:text-zinc-400">
                        {isRtl ? `تم العثور على ${matchedExamCodes.length} صف. المطابق: ${matchedExamCodes.filter(r => r.matchedStudentId).length}` : `Found ${matchedExamCodes.length} rows. Matched: ${matchedExamCodes.filter(r => r.matchedStudentId).length}`}
                      </p>
                      <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                        <input 
                          type="checkbox" 
                          checked={sortUnmatchedFirst} 
                          onChange={(e) => setSortUnmatchedFirst(e.target.checked)}
                          className="rounded text-sky-500 focus:ring-sky-500 cursor-pointer"
                        />
                        <span className="text-slate-600 dark:text-slate-300 font-bold">{isRtl ? 'فرز "غير مطابق" أولاً' : 'Sort Unmatched First'}</span>
                      </label>
                    </div>
                  </div>
                  <div className="flex gap-2 w-full sm:w-auto">
                    <button 
                      onClick={() => setMatchedExamCodes([])}
                      disabled={isSubmitting}
                      className="flex-1 sm:flex-none px-4 py-2 border border-slate-300 dark:border-zinc-700 text-slate-700 dark:text-slate-300 rounded-xl hover:bg-slate-50 dark:hover:bg-zinc-800 font-bold transition-colors"
                    >
                      {isRtl ? 'إلغاء' : 'Cancel'}
                    </button>
                    <button 
                      onClick={handleConfirmExamCodes}
                      disabled={isSubmitting}
                      className="flex-1 sm:flex-none px-6 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                    >
                      {isSubmitting ? <Loader2 className="w-5 h-5 animate-spin" /> : <CheckCircle2 className="w-5 h-5" />}
                      {isRtl ? 'اعتماد وحفظ' : 'Confirm and Save'}
                    </button>
                  </div>
                </div>

                <div className="overflow-x-auto bg-slate-50 dark:bg-zinc-800/50 rounded-2xl border border-slate-200 dark:border-zinc-700">
                  <table className="w-full text-left border-collapse">
                    <thead className="bg-slate-100 dark:bg-zinc-800 sticky top-0 z-10">
                      <tr>
                        <th className="p-3 text-sm font-bold text-slate-600 dark:text-slate-300 w-1/4">{isRtl ? 'الاسم في الكشف' : 'Name in CSV'}</th>
                        <th className="p-3 text-sm font-bold text-slate-600 dark:text-slate-300 w-1/4">{isRtl ? 'كود الامتحان الجديد' : 'New Exam Code'}</th>
                        <th className="p-3 text-sm font-bold text-slate-600 dark:text-slate-300 w-1/2">{isRtl ? 'المطابقة مع النظام' : 'System Match'}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedExamCodes.map((result, idx) => (
                        <tr key={`${result.rowId}-${idx}`} className="border-b border-slate-200 dark:border-zinc-700/50 hover:bg-white dark:hover:bg-zinc-800 transition-colors">
                          <td className="p-3">
                            <div className="font-bold text-slate-900 dark:text-white">📄 {result.csvName}</div>
                          </td>
                          <td className="p-3 font-mono font-bold text-sky-600 dark:text-sky-400">
                            {result.csvExamCode}
                          </td>
                          <td className="p-3">
                            <select
                               value={result.matchedStudentId || ''}
                               onChange={(e) => {
                                 const selectedId = e.target.value || null;
                                 setMatchedExamCodes(prev => prev.map(r => r.rowId === result.rowId ? { 
                                   ...r, 
                                   matchedStudentId: selectedId, 
                                   matchScore: selectedId ? 1.0 : 0 
                                 } : r));
                               }}
                               className={`w-full p-2 border-slate-300 dark:border-zinc-700 rounded-lg text-sm bg-white dark:bg-zinc-900 dark:text-white focus:ring-sky-500 focus:border-sky-500
                                 ${result.matchedStudentId && result.matchScore > 0.8 ? 'border-emerald-500 ring-1 ring-emerald-500' : 
                                   result.matchedStudentId ? 'border-yellow-400 ring-1 ring-yellow-400' : 'border-red-400 ring-1 ring-red-400'}
                               `}
                            >
                              <option value="">{isRtl ? 'غير متطابق (لن يتم الحفظ)' : 'No Match (will not save)'}</option>
                              {students.filter(s => !selectedStudentIds.has(s.id) || s.id === result.matchedStudentId).map((s, idx) => {
                                const showAlias = s.currentName && s.currentName !== s.name;
                                return (
                                  <option key={`${s.id}-${idx}`} value={s.id}>
                                    {s.name} {showAlias ? `(الاسم بحسابه: ${s.currentName})` : ''} - {s.email}
                                  </option>
                                );
                              })}
                            </select>
                            {result.matchedStudentId && result.matchScore < 1 && (
                              <div className="mt-1 text-[10px] text-yellow-600 dark:text-yellow-500">{isRtl ? 'تمت مطابقة تقريبية' : 'Fuzzy Match'}</div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
            <div className="flex-1 overflow-hidden flex flex-col">
              {/* Tabs. Horizontally scrollable so five of them still fit on a
                  narrow phone without wrapping into two rows. */}
              <div className="px-4 sm:px-6 pt-3 shrink-0 border-b border-slate-100 dark:border-zinc-800">
                <div className="flex gap-1.5 overflow-x-auto pb-2.5 -mx-1 px-1 scrollbar-thin">
                  {([
                    ['roster',   Users,     isRtl ? 'الطلاب' : 'Students', students.length],
                    ['add',      UserPlus,  isRtl ? 'إضافة' : 'Add', null],
                    ['import',   Upload,    isRtl ? 'استيراد' : 'Import', null],
                    ['requests', Mail,      isRtl ? 'الطلبات' : 'Requests', null],
                    ['codes',    BookOpen,  isRtl ? 'الأكواد' : 'Codes', null],
                    // Master admin only - see scanForOrphans; the rules give a
                    // representative no way to read a stageless row at all.
                    ...(isMasterAdmin
                      ? [['orphans', Layers, isRtl ? 'بدون مرحلة' : 'No stage', null] as const]
                      : []),
                  ] as const).map(([id, Icon, label, count]) => (
                    <button
                      key={id}
                      onClick={() => { setPanel(id); if (id !== 'add') setEditingStudent(null); }}
                      className={`shrink-0 flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-bold transition-colors ${
                        panel === id
                          ? 'bg-sky-600 text-white'
                          : 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-zinc-700'
                      }`}
                    >
                      <Icon className="w-4 h-4 shrink-0" />
                      {label}
                      {count != null && (
                        <span className={`text-[11px] font-black tabular-nums ${panel === id ? 'opacity-80' : 'text-slate-400'}`} dir="ltr">
                          {count}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {panel !== 'roster' && (
              <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-5">
              <div className="w-full max-w-2xl mx-auto space-y-6">
                {panel === 'add' && (editingStudent ? (
                  <form onSubmit={handleEditStudent} className="space-y-4 bg-sky-50 dark:bg-sky-900/10 p-4 rounded-2xl border border-sky-100 dark:border-sky-900/30">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-sm font-bold text-sky-600 dark:text-sky-400 uppercase tracking-wider">
                        {isRtl ? 'تعديل بيانات الطالب' : 'Edit Student'}
                      </h3>
                      <button 
                        type="button"
                        onClick={() => setEditingStudent(null)}
                        className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    
                    {error && (
                      <div className="p-3 bg-red-50 dark:bg-red-900/30 border border-red-100 dark:border-red-900/50 text-red-600 dark:text-red-400 rounded-xl flex items-center gap-2 text-sm">
                        <AlertCircle className="w-4 h-4" />
                        {error}
                      </div>
                    )}
                    {success && (
                      <div className="p-3 bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-100 dark:border-emerald-900/50 text-emerald-600 dark:text-emerald-400 rounded-xl flex items-center gap-2 text-sm">
                        <CheckCircle2 className="w-4 h-4" />
                        {success}
                      </div>
                    )}

                    <div className="space-y-3">
                      <input
                        required
                        type="text"
                        placeholder={isRtl ? 'الاسم الكامل' : 'Full Name'}
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="w-full px-4 py-2.5 bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-900 dark:text-stone-100 rounded-xl focus:ring-2 focus:ring-sky-500 outline-none transition-all"
                      />
                      <input
                        required
                        type="email"
                        placeholder={isRtl ? 'البريد الإلكتروني' : 'Email'}
                        value={editEmail}
                        onChange={(e) => setEditEmail(e.target.value)}
                        className="w-full px-4 py-2.5 bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-900 dark:text-stone-100 rounded-xl focus:ring-2 focus:ring-sky-500 outline-none transition-all"
                      />
                      <input
                        type="password"
                        placeholder={isRtl ? 'كلمة المرور (اختياري)' : 'Password (Optional)'}
                        value={editPassword}
                        onChange={(e) => setEditPassword(e.target.value)}
                        className="w-full px-4 py-2.5 bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-900 dark:text-stone-100 rounded-xl focus:ring-2 focus:ring-sky-500 outline-none transition-all"
                      />
                      <input
                        type="text"
                        placeholder={isRtl ? 'كود الامتحان (اختياري)' : 'Exam Code (Optional)'}
                        value={editExamCode}
                        onChange={(e) => setEditExamCode(e.target.value)}
                        className="w-full px-4 py-2.5 bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-900 dark:text-stone-100 rounded-xl focus:ring-2 focus:ring-sky-500 outline-none transition-all"
                      />
                      <select
                        value={editSubgroup}
                        onChange={(e) => setEditSubgroup(e.target.value)}
                        className="w-full px-4 py-2.5 bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-900 dark:text-stone-100 rounded-xl focus:ring-2 focus:ring-sky-500 outline-none transition-all"
                      >
                        <option value="">{isRtl ? 'بدون مجموعة (اختياري)' : 'No Group (Optional)'}</option>
                        {subgroupOptions.map(sub => (
                          <option key={sub} value={sub}>
                            {isRtl ? `المجموعة ${sub}` : `Group ${sub}`}
                          </option>
                        ))}
                      </select>
                      
                      <button
                        disabled={isSubmitting}
                        type="submit"
                        className="w-full py-2.5 bg-sky-600 text-white rounded-xl font-bold hover:bg-sky-700 transition-all flex items-center justify-center gap-2 shadow-lg shadow-sky-100 dark:shadow-none"
                      >
                        {isSubmitting ? <Loader2 className="w-5 h-5 animate-spin" /> : <CheckCircle2 className="w-5 h-5" />}
                        {isRtl ? 'حفظ التعديلات' : 'Save Changes'}
                      </button>
                    </div>
                  </form>
                ) : (
                  <form onSubmit={handleAddStudent} className="space-y-4">
                    <h3 className="text-sm font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
                      {isRtl ? 'إضافة طالب جديد' : 'Add New Student'}
                    </h3>
                    
                    {error && (
                      <div className="p-3 bg-red-50 dark:bg-red-900/30 border border-red-100 dark:border-red-900/50 text-red-600 dark:text-red-400 rounded-xl flex items-center gap-2 text-sm">
                        <AlertCircle className="w-4 h-4" />
                        {error}
                      </div>
                    )}
                    {success && (
                      <div className="p-3 bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-100 dark:border-emerald-900/50 text-emerald-600 dark:text-emerald-400 rounded-xl flex items-center gap-2 text-sm">
                        <CheckCircle2 className="w-4 h-4" />
                        {success}
                      </div>
                    )}

                    <div className="space-y-3">
                      <input
                        required
                        type="text"
                        placeholder={isRtl ? 'الاسم الكامل' : 'Full Name'}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="w-full px-4 py-2.5 bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-900 dark:text-stone-100 rounded-xl focus:ring-2 focus:ring-sky-500 outline-none transition-all"
                      />
                      <input
                        required
                        type="email"
                        placeholder={isRtl ? 'البريد الإلكتروني' : 'Email'}
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="w-full px-4 py-2.5 bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-900 dark:text-stone-100 rounded-xl focus:ring-2 focus:ring-sky-500 outline-none transition-all"
                      />
                      <input
                        required
                        type="password"
                        placeholder={isRtl ? 'كلمة المرور' : 'Password'}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="w-full px-4 py-2.5 bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-900 dark:text-stone-100 rounded-xl focus:ring-2 focus:ring-sky-500 outline-none transition-all"
                      />
                    <input
                      type="text"
                      placeholder={isRtl ? 'كود الامتحان (اختياري)' : 'Exam Code (Optional)'}
                      value={examCode}
                      onChange={(e) => setExamCode(e.target.value)}
                      className="w-full px-4 py-2.5 bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-900 dark:text-stone-100 rounded-xl focus:ring-2 focus:ring-sky-500 outline-none transition-all"
                    />
                    <select
                      value={subgroup}
                      onChange={(e) => setSubgroup(e.target.value)}
                      className="w-full px-4 py-2.5 bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-900 dark:text-stone-100 rounded-xl focus:ring-2 focus:ring-sky-500 outline-none transition-all"
                    >
                      <option value="">{isRtl ? 'بدون مجموعة (اختياري)' : 'No Group (Optional)'}</option>
                      {subgroupOptions.map(sub => (
                        <option key={sub} value={sub}>
                          {isRtl ? `المجموعة ${sub}` : `Group ${sub}`}
                        </option>
                      ))}
                    </select>
                    <button
                      disabled={isSubmitting}
                      type="submit"
                      className="w-full py-2.5 bg-sky-600 text-white rounded-xl font-bold hover:bg-sky-700 transition-all flex items-center justify-center gap-2 shadow-lg shadow-sky-100 dark:shadow-none"
                    >
                      {isSubmitting ? <Loader2 className="w-5 h-5 animate-spin" /> : <UserPlus className="w-5 h-5" />}
                      {isRtl ? 'إضافة طالب' : 'Add Student'}
                    </button>
                  </div>
                </form>
                ))}

                {panel === 'requests' && (
                  <div className="space-y-6">
                    <SignupRequestsQueue user={user} lang={lang} />
                    {/* Both queues live on the same tab: they are the two ways
                        a roster changes without the representative typing. */}
                    <div className="pt-6 border-t border-slate-200 dark:border-zinc-800">
                      <DeletionRequestsQueue lang={lang} />
                    </div>
                  </div>
                )}

                {panel === 'import' && (
                  <RosterImport
                    lang={lang}
                    students={students}
                    effectiveStageId={effectiveStageId}
                    groupConfig={groupConfig}
                    onImported={fetchStudents}
                  />
                )}

                {panel === 'orphans' && isMasterAdmin && (
                  <div className="space-y-4">
                    <div>
                      <h3 className="text-sm font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2">
                        {isRtl ? 'طلاب بدون مرحلة' : 'Students without a stage'}
                      </h3>
                      <p className="text-xs font-bold text-slate-400 dark:text-slate-500 leading-relaxed">
                        {isRtl
                          ? 'هؤلاء لا يظهرون في أي مرحلة، فالقائمة تُفلتر حسب المرحلة. عيّن لكل واحد مرحلته ليظهر بشكل طبيعي.'
                          : 'These students appear under no stage, because the roster is filtered by stage. Assign each one so they show up normally.'}
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={scanForOrphans}
                      disabled={isScanningOrphans}
                      className="w-full py-2.5 bg-sky-50 dark:bg-sky-900/20 text-sky-600 dark:text-sky-400 rounded-xl font-bold hover:bg-sky-100 dark:hover:bg-sky-900/40 transition-all flex items-center justify-center gap-2 border border-sky-200 dark:border-sky-800/50 disabled:opacity-50"
                    >
                      {isScanningOrphans ? <Loader2 className="w-5 h-5 animate-spin" /> : <Search className="w-5 h-5" />}
                      {isRtl ? 'ابحث عن طلاب بدون مرحلة' : 'Scan for students without a stage'}
                    </button>

                    {orphans !== null && orphans.length === 0 && (
                      <div className="flex items-center gap-2 p-4 rounded-2xl bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 text-sm font-bold">
                        <CheckCircle2 className="w-5 h-5 shrink-0" />
                        {isRtl ? 'كل الطلاب لديهم مرحلة.' : 'Every student has a stage.'}
                      </div>
                    )}

                    {orphans !== null && orphans.length > 0 && (
                      <div className="space-y-2">
                        {orphans.map(student => (
                          <div
                            key={student.id}
                            className="p-3.5 rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 space-y-3"
                          >
                            <div className="min-w-0">
                              <div className="font-bold text-sm text-slate-800 dark:text-slate-100 truncate">
                                {student.name || student.id}
                              </div>
                              <div className="text-xs font-bold text-slate-400 truncate" dir="ltr">
                                {student.email || student.id}
                              </div>
                              {student.stageId && (
                                <div className="mt-1 text-xs font-bold text-amber-600 dark:text-amber-400 truncate" dir="ltr">
                                  {isRtl ? 'مرحلة غير معروفة: ' : 'Unknown stage: '}{student.stageId}
                                </div>
                              )}
                            </div>

                            <div className="flex items-center gap-2">
                              <select
                                value={orphanAssignments[student.id] || ''}
                                onChange={e => setOrphanAssignments(prev => ({ ...prev, [student.id]: e.target.value }))}
                                className="flex-1 min-w-0 bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded-xl px-3 py-2 text-sm font-bold outline-none focus:border-sky-500 dark:text-stone-100"
                              >
                                <option value="">{isRtl ? 'اختر المرحلة' : 'Select a stage'}</option>
                                {stages.map(st => (
                                  <option key={st.id} value={st.id}>
                                    {isRtl ? st.nameAr : st.nameEn}
                                  </option>
                                ))}
                              </select>
                              <button
                                type="button"
                                onClick={() => assignStage(student, orphanAssignments[student.id] || '')}
                                disabled={!orphanAssignments[student.id] || assigningOrphan === student.id}
                                className="shrink-0 px-4 py-2 bg-sky-600 text-white rounded-xl text-sm font-bold hover:bg-sky-700 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                              >
                                {assigningOrphan === student.id && <Loader2 className="w-4 h-4 animate-spin" />}
                                {isRtl ? 'تعيين' : 'Assign'}
                              </button>
                            </div>
                          </div>
                        ))}
                        <p className="pt-1 px-1 text-xs font-bold text-slate-400 dark:text-slate-500">
                          {isRtl
                            ? `يفحص أول ${ORPHAN_SCAN_LIMIT} سجل. أعد البحث بعد التعيين إن كان العدد أكبر.`
                            : `Scans the first ${ORPHAN_SCAN_LIMIT} records. Re-run after assigning if there are more.`}
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {panel === 'codes' && (
                  <div>
                    <h3 className="text-sm font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2">
                      {isRtl ? 'استيراد أكواد الامتحانات (بواسطة الاسم)' : 'Import Exam Codes (By Name)'}
                    </h3>
                    <label className="w-full py-2.5 bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 rounded-xl font-bold hover:bg-indigo-100 dark:hover:bg-indigo-900/40 transition-all flex items-center justify-center gap-2 cursor-pointer border border-indigo-200 dark:border-indigo-800/50">
                      <Upload className="w-5 h-5" />
                      {isRtl ? 'اختر ملف CSV للأكواد' : 'Choose Exam Codes CSV'}
                      <input
                        type="file"
                        accept=".csv"
                        className="hidden"
                        onChange={handleExamCodeCsvUpload}
                      />
                    </label>
                    <p className="text-xs text-slate-500 mt-2 text-center">
                      {isRtl ? 'الأعمدة: name, examCode' : 'Columns: name, examCode'}
                    </p>
                  </div>
                )}
              </div>
              </div>
              )}

              {panel === 'roster' && (
              <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden px-4 sm:px-6 pt-4 pb-4">
                <div className="flex items-center justify-between mb-3 flex-wrap gap-3">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <h3 className="hidden sm:block text-sm font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider whitespace-nowrap">
                      {isRtl ? 'قائمة الطلاب' : 'Student List'} ({students.length})
                    </h3>
                    <div className="relative flex-1 sm:max-w-sm flex items-center gap-2 min-w-0">
                      <input
                        type="text"
                        placeholder={isRtl ? 'البحث بالاسم، الإيميل، أو الكود...' : 'Search by name, email, or code...'}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full px-4 py-2 bg-slate-50 dark:bg-zinc-800/50 border border-slate-200 dark:border-zinc-700/50 text-slate-900 dark:text-zinc-100 rounded-xl focus:ring-2 focus:ring-sky-500 focus:border-sky-500 outline-none transition-all text-sm"
                      />
                      <button
                        onClick={handleDownloadNeverSignedIn}
                        title={isRtl ? 'تحميل قائمة الطلاب الذين لم يسجلوا الدخول' : 'Download students who never signed in'}
                        className="p-2 bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-slate-300 hover:bg-sky-50 hover:text-sky-600 dark:hover:bg-sky-900/30 rounded-xl transition-colors border border-slate-200 dark:border-zinc-700/50"
                      >
                        <Download className="w-5 h-5" />
                      </button>
                    </div>
                  </div>
                  {isMasterAdmin && (
                    <div className="flex flex-wrap items-center gap-2 mb-2 md:mb-0">
                      
                      
                      {students.length > 0 && (
                        <div className="relative">
                          {isDeletingAll ? (
                            <div className="flex items-center gap-2 bg-white dark:bg-zinc-800 p-1 rounded-lg shadow-sm border border-slate-200 dark:border-zinc-700">
                              <button
                                onClick={handleDeleteAllStudents}
                                className="px-2 py-1 text-xs font-bold bg-red-100 text-red-600 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 rounded-md transition-colors"
                              >
                                {isRtl ? 'تأكيد الحذف' : 'Confirm Delete'}
                              </button>
                              <button
                                onClick={() => setIsDeletingAll(false)}
                                className="px-2 py-1 text-xs font-bold bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-zinc-700 dark:text-slate-300 rounded-md transition-colors"
                              >
                                {isRtl ? 'إلغاء' : 'Cancel'}
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setIsDeletingAll(true)}
                              className="px-3 py-1.5 text-xs font-bold bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-900/20 dark:text-red-400 rounded-lg transition-colors flex items-center gap-1"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              {isRtl ? 'حذف جميع الطلاب' : 'Delete All Students'}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                  
                <div className="flex flex-col gap-2 mb-4 mt-4">
                  <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-thin px-1 items-center">
                    {canManageGroups(user) && (
                      <button
                        onClick={() => setShowGroupSettings(true)}
                        title={isRtl ? 'إعدادات المجموعات' : 'Group settings'}
                        className="shrink-0 w-9 h-9 rounded-xl bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-500 dark:text-slate-400 flex items-center justify-center hover:bg-sky-50 hover:text-sky-600 dark:hover:bg-sky-900/20 transition-colors"
                      >
                        <Settings className="w-4 h-4" />
                      </button>
                    )}
                    {['All', ...groupIds].map(group => (
                      <button
                        key={group}
                        onClick={() => {
                          setSelectedGroupFilter(group);
                          setSelectedSubgroupFilter('All');
                        }}
                        className={`px-5 py-2 rounded-xl text-sm font-bold whitespace-nowrap transition-all ${
                          selectedGroupFilter === group 
                            ? 'bg-sky-600 text-white shadow-lg shadow-sky-200 dark:shadow-none scale-105' 
                            : 'bg-white dark:bg-zinc-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-zinc-700 hover:bg-sky-50 dark:hover:bg-sky-900/20'
                        }`}
                      >
                        {group === 'All' ? (isRtl ? 'الكل' : 'All') : (isRtl ? `المجموعة ${group}` : `Group ${group}`)}
                      </button>
                    ))}
                  </div>
                  
                  {selectedGroupFilter !== 'All' && (
                    <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-thin px-1">
                      <button
                        onClick={() => setSelectedSubgroupFilter('All')}
                        className={`px-4 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition-all ${
                          selectedSubgroupFilter === 'All'
                            ? 'bg-sky-500 text-white shadow-md'
                            : 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-zinc-700'
                        }`}
                      >
                        {isRtl ? 'الكل' : 'All'}
                      </button>
                      {subgroupsForGroup(selectedGroupFilter).map(sub => {
                        return (
                          <button
                            key={sub}
                            onClick={() => setSelectedSubgroupFilter(sub)}
                            className={`px-4 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition-all ${
                              selectedSubgroupFilter === sub
                                ? 'bg-sky-500 text-white shadow-md'
                                : 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-zinc-700'
                            }`}
                          >
                            {sub}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="flex-1 overflow-auto bg-slate-50 dark:bg-zinc-800/50 rounded-2xl border border-slate-200 dark:border-zinc-700">
                  {isLoading ? (
                    <div className="flex justify-center items-center h-full py-12">
                      <Loader2 className="w-8 h-8 animate-spin text-sky-600 dark:text-sky-400" />
                    </div>
                  ) : filteredStudents.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full py-12 text-slate-400">
                      <Users className="w-12 h-12 mb-4 opacity-50" />
                      <p>{isRtl ? 'لا توجد نتائج' : 'No results found'}</p>
                    </div>
                  ) : (
                    <>
                    {/* Phones get cards. The table has eight columns and only
                        sideways scrolling to fit them, which on a phone hides
                        the login code - the one value a representative is most
                        often reading out to a student. */}
                    <div className="md:hidden divide-y divide-slate-200 dark:divide-zinc-700">
                      {filteredStudents.map((student, idx) => (
                        <div
                          key={`card-${student.id}-${idx}`}
                          className={`p-3 ${student.isAuthAccountOnly ? 'bg-amber-50/50 dark:bg-amber-900/10' : ''}`}
                        >
                          <div className="flex items-start gap-2">
                            <div className="flex-1 min-w-0">
                              <div className="font-bold text-sm text-slate-900 dark:text-stone-100 flex items-center gap-1.5 flex-wrap">
                                <span className="truncate">{student.name}</span>
                                {student.isAuthAccountOnly && (
                                  <span className="text-[9px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">
                                    {isRtl ? 'حساب إضافي' : 'Duplicate'}
                                  </span>
                                )}
                                {student.role && student.role !== 'student' && (
                                  <span className="text-[9px] bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 px-1.5 py-0.5 rounded-full capitalize">
                                    {student.role.replace('_', ' ')}
                                  </span>
                                )}
                              </div>
                              <div className="mt-1 flex items-center gap-2 flex-wrap text-[11px] font-bold">
                                <span className="px-1.5 py-0.5 rounded-md bg-sky-50 dark:bg-sky-900/20 text-sky-700 dark:text-sky-400">
                                  {student.subgroup || '—'}
                                </span>
                                <span className="font-mono text-slate-500 dark:text-slate-400" dir="ltr">
                                  {student.placeholderEmail
                                    ? (student.loginCode || '—')
                                    : student.email}
                                </span>
                                {student.examCode && (
                                  <span className="font-mono text-slate-400" dir="ltr">#{student.examCode}</span>
                                )}
                              </div>
                              <div className="mt-1.5 flex items-center gap-2 text-[11px] font-bold">
                                <span className={student.userUid
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : 'text-slate-400'}>
                                  {student.userUid
                                    ? (isRtl ? 'سجّل الدخول' : 'Signed in')
                                    : (isRtl ? 'لم يسجّل بعد' : 'Never signed in')}
                                </span>
                                <span className={student.isActive
                                  ? 'text-slate-400'
                                  : 'text-rose-600 dark:text-rose-400'}>
                                  {student.isActive ? (isRtl ? 'مفعل' : 'Active') : (isRtl ? 'معطل' : 'Disabled')}
                                </span>
                              </div>
                            </div>
                          </div>
                          <div className="mt-2 flex justify-end">
                            {renderStudentActions(student)}
                          </div>
                        </div>
                      ))}
                    </div>

                    <table className="hidden md:table w-full text-left border-collapse">
                      <thead className="bg-slate-100 dark:bg-zinc-800 sticky top-0 z-10">
                        <tr>
                          <th className="p-3 text-sm font-bold text-slate-600 dark:text-slate-300">{isRtl ? 'الاسم' : 'Name'}</th>
                          <th className="p-3 text-sm font-bold text-slate-600 dark:text-slate-300">{isRtl ? 'البريد' : 'Email'}</th>
                          <th className="p-3 text-sm font-bold text-slate-600 dark:text-slate-300">{isRtl ? 'المجموعة' : 'Group'}</th>
                          <th className="p-3 text-sm font-bold text-slate-600 dark:text-slate-300">{isRtl ? 'الكود' : 'Code'}</th>
                          <th className="p-3 text-sm font-bold text-slate-600 dark:text-slate-300 text-center">{isRtl ? 'تسجيل الدخول' : 'Signed In'}</th>
                          {user?.isMasterAdmin && (
                            <th className="p-3 text-sm font-bold text-slate-600 dark:text-slate-300 text-center">{isRtl ? 'الستريك' : 'Streak'}</th>
                          )}
                          <th className="p-3 text-sm font-bold text-slate-600 dark:text-slate-300 text-center">{isRtl ? 'الحالة' : 'Status'}</th>
                          <th className="p-3 text-sm font-bold text-slate-600 dark:text-slate-300 text-center">{isRtl ? 'إجراء' : 'Action'}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredStudents.map((student, idx) => (
                          <tr key={`${student.id}-${idx}`} className={`border-b border-slate-200 dark:border-zinc-700/50 hover:bg-white dark:hover:bg-zinc-800 transition-colors ${student.isAuthAccountOnly ? 'bg-amber-50/50 dark:bg-amber-900/10' : ''}`}>
                            <td className="p-3">
                              <div className="text-sm font-medium text-slate-900 dark:text-stone-100 flex items-center gap-2">
                                {student.name}
                                {student.isAuthAccountOnly && (
                                  <span className="text-[9px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full whitespace-nowrap">
                                    {isRtl ? 'حساب إضافي' : 'Duplicate'}
                                  </span>
                                )}
                                {student.role && student.role !== 'student' && (
                                  <span className="text-[9px] bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 px-1.5 py-0.5 rounded-full whitespace-nowrap capitalize">
                                    {student.role.replace('_', ' ')}
                                  </span>
                                )}
                              </div>
                              {student.currentName && student.currentName !== student.name && (
                                <div className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">
                                  {isRtl ? 'الاسم الحالي: ' : 'Current: '}{student.currentName}
                                </div>
                              )}
                            </td>
                            <td className="p-3 text-sm text-slate-500 dark:text-slate-400">
                              {/* A roster student's id is synthetic - showing it
                                  would read as an address that does not exist.
                                  Their login code is what they actually type. */}
                              {student.placeholderEmail ? (
                                <span className="font-mono text-xs" dir="ltr">
                                  {student.loginCode || '—'}
                                </span>
                              ) : (
                                <span dir="ltr">{student.email}</span>
                              )}
                              {student.googleEmail && (
                                <div className="text-[10px] text-emerald-600 dark:text-emerald-500 mt-0.5 break-all" dir="ltr">
                                  Google: {student.googleEmail}
                                </div>
                              )}
                              {student.userUid && (
                                <div className="text-[9px] text-slate-400 mt-0.5 break-all">ID: {student.userUid}</div>
                              )}
                            </td>
                            <td className="p-3 text-sm font-bold text-sky-600 dark:text-sky-400">{student.subgroup || '-'}</td>
                            <td className="p-3 text-sm font-mono text-slate-500 dark:text-slate-400">{student.examCode}</td>
                            <td className="p-3 text-center">
                              {student.userUid ? (
                                <span className="inline-flex py-1 px-2 text-[10px] font-bold rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400">
                                  {isRtl ? 'نعم' : 'Yes'}
                                </span>
                              ) : (
                                <span className="inline-flex py-1 px-2 text-[10px] font-bold rounded-full bg-rose-50 text-rose-600 dark:bg-rose-900/30 dark:text-rose-400">
                                  {isRtl ? 'لا' : 'No'}
                                </span>
                              )}
                            </td>
                            {user?.isMasterAdmin && (
                              <td className="p-3 text-center text-sm font-bold text-orange-600">{student.streakCount !== undefined ? student.streakCount : '-'}</td>
                            )}
                            <td className="p-3 text-center">
                              <button
                                onClick={() => student.isAuthAccountOnly ? null : handleToggleActive(student)}
                                disabled={student.isAuthAccountOnly}
                                className={`inline-flex items-center justify-center w-8 h-8 rounded-full transition-colors ${
                                  student.isAuthAccountOnly 
                                    ? 'bg-slate-100 text-slate-400 dark:bg-zinc-800 cursor-not-allowed'
                                    : student.isActive 
                                      ? 'bg-emerald-100 text-emerald-600 hover:bg-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400' 
                                      : 'bg-red-100 text-red-600 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400'
                                }`}
                                title={student.isAuthAccountOnly ? (isRtl ? 'غير متوفر لحساب إضافي' : 'Not available for duplicate accounts') : student.isActive ? (isRtl ? 'تعطيل' : 'Deactivate') : (isRtl ? 'تفعيل' : 'Activate')}
                              >
                                {student.isActive ? <CheckCircle2 className="w-5 h-5" /> : <XCircle className="w-5 h-5" />}
                              </button>
                            </td>
                            <td className="p-3 text-center">
                              {renderStudentActions(student)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    </>
                  )}
                </div>
              </div>
              )}
            </div>
            )}
            </div>
          </motion.div>
        </div>
      )}

      {/* The re-issued password. Same contract as the import panel: shown
          once, never recoverable, and it does not close itself. */}
      {resetResult && (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-4"
          dir={isRtl ? 'rtl' : 'ltr'}
        >
          <div className="w-full max-w-sm bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-2xl">
            <div className="w-14 h-14 bg-amber-100 dark:bg-amber-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
              <KeyRound className="w-7 h-7 text-amber-600 dark:text-amber-400" />
            </div>
            <h3 className="text-base font-black text-center text-slate-900 dark:text-stone-100">
              {resetResult.name}
            </h3>
            {resetResult.loginCode && (
              <p className="text-center text-xs font-mono font-bold text-slate-400 mt-1" dir="ltr">
                {resetResult.loginCode}
              </p>
            )}

            <div className="my-5 py-4 bg-slate-50 dark:bg-zinc-950 rounded-2xl text-center">
              <div className="font-mono font-black text-2xl text-slate-900 dark:text-stone-100 tracking-wider" dir="ltr">
                {resetResult.password}
              </div>
            </div>

            <p className="text-center text-[11px] font-bold text-amber-700 dark:text-amber-500 mb-4 leading-relaxed">
              {isRtl
                ? 'تظهر مرة واحدة فقط. سيُطلب من الطالب تغييرها عند أول دخول.'
                : 'Shown once only. The student will be asked to change it at first sign-in.'}
            </p>

            <button
              onClick={() => navigator.clipboard.writeText(resetResult.password).catch(console.error)}
              className="w-full py-2.5 mb-2 bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-slate-200 rounded-xl font-bold text-sm hover:bg-slate-200 dark:hover:bg-zinc-700 flex items-center justify-center gap-2"
            >
              <Copy className="w-4 h-4" />
              {isRtl ? 'نسخ' : 'Copy'}
            </button>
            <button
              onClick={() => setResetResult(null)}
              className="w-full py-3 bg-sky-600 text-white rounded-xl font-black text-sm hover:bg-sky-700"
            >
              {isRtl ? 'حفظتها — إغلاق' : 'I have saved it — close'}
            </button>
          </div>
        </div>
      )}

      {mergingBaseId && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" dir={isRtl ? 'rtl' : 'ltr'}>
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="w-full max-w-4xl bg-white dark:bg-zinc-900 rounded-[24px] shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
          >
            <div className="flex items-center justify-between p-6 border-b border-slate-200 dark:border-zinc-800">
              <h2 className="text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <GitMerge className="w-6 h-6 text-amber-500" />
                {isRtl ? 'دمج الحسابات المكررة' : 'Merge Duplicate Accounts'}
              </h2>
              <button
                onClick={() => setMergingBaseId(null)}
                className="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 rounded-full hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-6 overflow-y-auto">
              <p className="text-sm text-slate-600 dark:text-zinc-400 mb-6">
                {isRtl 
                  ? 'تم العثور على حسابات متعددة لنفس البريد الإلكتروني. اختر الحساب الأساسي الذي تريد الاحتفاظ به. سيتم حذف الحساب الآخر ودمج تقدمه (النقاط، المحاضرات، إلخ) في الحساب الأساسي الذي تم الاحتفاظ به.' 
                  : 'Multiple accounts found for the same email. Choose the primary account to KEEP. The other will be DELETED, and its progress (scores, lectures, etc) will be merged into the kept account.'}
              </p>

              {error && (
                <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded-xl text-sm flex items-start gap-3 border border-red-200 dark:border-red-900/50">
                  <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                  <p>{error}</p>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {students.filter(s => (s.baseStudentId || s.id) === mergingBaseId).map((acc, idx) => (
                  <div key={`${acc.id}-${idx}`} className="border-2 border-slate-200 dark:border-zinc-700 rounded-xl p-5 flex flex-col gap-4 relative">
                    {acc.isAuthAccountOnly ? (
                      <span className={`absolute top-4 ${isRtl ? 'left-4' : 'right-4'} px-2 py-1 bg-amber-100 text-amber-700 text-[10px] font-bold rounded-full uppercase tracking-wider`}>
                        {isRtl ? 'حساب مصادقة إضافي' : 'Duplicate Auth Account'}
                      </span>
                    ) : (
                      <span className={`absolute top-4 ${isRtl ? 'left-4' : 'right-4'} px-2 py-1 bg-emerald-100 text-emerald-700 text-[10px] font-bold rounded-full uppercase tracking-wider`}>
                        {isRtl ? 'ملف الطالب الأصلي' : 'Original Student List'}
                      </span>
                    )}
                    
                    <div>
                      <div className="text-sm text-slate-500 mb-1">{isRtl ? 'البريد الإلكتروني' : 'Email'}</div>
                      <div className="font-bold text-slate-900 dark:text-white break-all">{acc.email}</div>
                    </div>

                    <div>
                      <div className="text-sm text-slate-500 mb-1">{isRtl ? 'معرف المستخدم (UID)' : 'User ID (UID)'}</div>
                      <div className="font-mono text-xs text-slate-700 dark:text-zinc-300 bg-slate-100 dark:bg-zinc-800 p-2 rounded-lg break-all">
                        {acc.userUid || (isRtl ? 'غير متوفر (لم يسجل الدخول)' : 'N/A (Never logged in)')}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <div className="text-sm text-slate-500 mb-1">{isRtl ? 'الاسم الظاهر' : 'Display Name'}</div>
                        <div className="font-medium text-slate-900 dark:text-white">{acc.currentName}</div>
                      </div>
                      <div>
                        <div className="text-sm text-slate-500 mb-1">{isRtl ? 'النقاط / التسلسل' : 'Streaks'}</div>
                        <div className="font-medium text-slate-900 dark:text-white flex items-center gap-2">
                          <span className="text-orange-500 font-bold">{acc.streakCount || 0}</span>
                          <span className="text-slate-300">|</span>
                          <span className="text-slate-500 text-xs">Max: {acc.longestStreak || 0}</span>
                        </div>
                      </div>
                    </div>

                    <div className="mt-auto pt-4 border-t border-slate-100 dark:border-zinc-800 flex gap-2">
                      <button
                        onClick={async () => {
                          const duplicates = students.filter(s => (s.baseStudentId || s.id) === mergingBaseId);
                          const deleteAcc = duplicates.find(d => d.id !== acc.id);
                          if (!deleteAcc) return;
                          
                          if (!acc.userUid) {
                            setError(isRtl ? 'لا يمكنك الاحتفاظ بحساب لا يحتوي على معرف مستخدم (UID).' : 'Cannot keep an account without a User ID (UID).');
                            return;
                          }
                          if (!deleteAcc.userUid) {
                            setError(isRtl ? 'الحساب المكرر لا يحتوي على معرف مستخدم (UID)، لا فائدة من الدمج هنا.' : 'Duplicate account has no UID, nothing to merge from Auth side.');
                            return;
                          }

                          setIsSubmitting(true);
                          setError(null);
                          try {
                            const token = await auth.currentUser?.getIdToken();
                            const res = await fetch(apiUrl(`/api/admin/users/merge`), {
                              method: 'POST',
                              headers: {
                                'Authorization': `Bearer ${token}`,
                                'Content-Type': 'application/json'
                              },
                              body: JSON.stringify({ keepUid: acc.userUid, deleteUid: deleteAcc.userUid })
                            });
                            
                            if (!res.ok) {
                              const text = await res.text();
                              let errorMsg = 'Failed to merge';
                              if (text.startsWith('<!DOCTYPE') || text.startsWith('<html')) {
                                errorMsg = `Server returned an HTML error page (Status ${res.status}). The server might be restarting or unavailable. Please reload the app and try again.`;
                              } else {
                                try {
                                  const data = JSON.parse(text);
                                  errorMsg = data.error || errorMsg;
                                } catch (e) {
                                  errorMsg = `Server error (${res.status}): ${text.substring(0, 100)}`;
                                }
                              }
                              throw new Error(errorMsg);
                            }
                            
                            await logAdminAction('MERGE_DUPLICATES', `Merged accounts for ${acc.email} (Kept: ${acc.userUid})`);
                            setSuccess(isRtl ? 'تم دمج الحسابات بنجاح!' : 'Accounts merged successfully!');
                            fetchStudents();
                            setMergingBaseId(null);
                          } catch (err: any) {
                            console.error(err);
                            setError(err.message || 'Error merging accounts');
                          } finally {
                            setIsSubmitting(false);
                          }
                        }}
                        disabled={isSubmitting}
                        className="flex-1 px-4 py-2 bg-slate-900 hover:bg-slate-800 dark:bg-white dark:hover:bg-zinc-200 text-white dark:text-zinc-900 font-bold rounded-xl transition-colors disabled:opacity-50 flex items-center justify-center"
                      >
                        {isSubmitting ? <Loader2 className="w-5 h-5 animate-spin" /> : (isRtl ? 'الاحتفاظ بهذا ودمج الآخر' : 'Keep this & Merge')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        </div>
      )}
      {viewingProfile && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" dir={isRtl ? 'rtl' : 'ltr'}>
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="w-full max-w-lg bg-white dark:bg-zinc-900 rounded-[24px] shadow-2xl overflow-hidden flex flex-col"
          >
            <div className="flex items-center justify-between p-6 border-b border-slate-200 dark:border-zinc-800 bg-indigo-50 dark:bg-indigo-900/10">
              <h2 className="text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <User className="w-6 h-6 text-indigo-500" />
                {isRtl ? 'الملف الشخصي' : 'Student Profile'}
              </h2>
              <button
                onClick={() => setViewingProfile(null)}
                className="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 rounded-full hover:bg-white/50 dark:hover:bg-zinc-800 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-6 overflow-y-auto">
              <div className="flex items-center gap-4 mb-6">
                <div className="w-20 h-20 rounded-2xl bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center overflow-hidden border border-indigo-200 dark:border-indigo-800/50 flex-shrink-0">
                  {viewingProfile.photoUrl ? (
                    <img src={viewingProfile.photoUrl} alt={viewingProfile.name} className="w-full h-full object-cover" />
                  ) : (
                    <User className="w-10 h-10 text-indigo-400" />
                  )}
                </div>
                <div>
                  <h3 className="text-2xl font-bold text-slate-900 dark:text-white">{viewingProfile.name}</h3>
                  {viewingProfile.originalName && viewingProfile.name !== viewingProfile.originalName && (
                    <div className="text-sm text-slate-500 dark:text-slate-400">
                      {isRtl ? 'الاسم الأصلي:' : 'Original Name:'} {viewingProfile.originalName}
                    </div>
                  )}
                  <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400 mt-1">
                    <Mail className="w-4 h-4" />
                    <span className="text-sm">{viewingProfile.email}</span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="bg-slate-50 dark:bg-zinc-800/50 p-4 rounded-2xl border border-slate-100 dark:border-zinc-800">
                  <div className="flex items-center gap-2 text-rose-500 mb-2">
                    <Flame className="w-5 h-5" />
                    <span className="font-bold">{isRtl ? 'الالتزام الحالي' : 'Current Streak'}</span>
                  </div>
                  <div className="text-3xl font-black text-slate-900 dark:text-white">{viewingProfile.streakCount || 0}</div>
                  <div className="text-xs text-slate-500 mt-1">
                    {isRtl ? 'أطول سلسلة:' : 'Longest:'} {viewingProfile.longestStreak || 0}
                  </div>
                </div>

                <div className="bg-slate-50 dark:bg-zinc-800/50 p-4 rounded-2xl border border-slate-100 dark:border-zinc-800">
                  <div className="flex items-center gap-2 text-sky-500 mb-2">
                    <BookOpen className="w-5 h-5" />
                    <span className="font-bold">{isRtl ? 'الدروس المكتملة' : 'Studied'}</span>
                  </div>
                  <div className="text-3xl font-black text-slate-900 dark:text-white">
                    {(viewingProfile.studied?.length || 0)}
                  </div>
                  <div className="text-xs text-slate-500 mt-1">
                    {isRtl ? 'المهام الأسبوعية:' : 'Weekly Tasks:'} {(viewingProfile.completedWeeklyTasks?.length || 0)}
                  </div>
                </div>

                <div className="bg-slate-50 dark:bg-zinc-800/50 p-4 rounded-2xl border border-slate-100 dark:border-zinc-800 col-span-2">
                  <div className="flex flex-col gap-3">
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-slate-500 dark:text-slate-400">{isRtl ? 'الفرقة/المجموعة' : 'Group/Year'}</span>
                      <span className="font-bold text-slate-900 dark:text-white">{viewingProfile.group || '-'}</span>
                    </div>
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-slate-500 dark:text-slate-400">{isRtl ? 'كود الامتحانات' : 'Exam Code'}</span>
                      <span className="font-mono font-bold text-slate-900 dark:text-white bg-slate-200 dark:bg-zinc-700 px-2 py-0.5 rounded">{viewingProfile.examCode || '-'}</span>
                    </div>
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-slate-500 dark:text-slate-400">{isRtl ? 'تاريخ التسجيل' : 'Joined'}</span>
                      <span className="font-bold text-slate-900 dark:text-white">
                        {(viewingProfile as any).createdAt?.toDate ? new Date((viewingProfile as any).createdAt.toDate()).toLocaleDateString(isRtl ? 'ar-EG' : 'en-US') : '-'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      )}

      <StageSettingsModal
        isOpen={showGroupSettings}
        onClose={() => setShowGroupSettings(false)}
        lang={lang}
        students={students}
      />
    </AnimatePresence>
  );
}
















