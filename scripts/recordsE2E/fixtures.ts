/**
 * Mohadaraty E2E Test Suite - Fixtures and Test Data
 * Realistic mock data covering Tiers 1-4.
 */

import type { TestLecture, TestRecordItem, TestUserProfile } from './types';

export const R2_PUBLIC_BASE = 'https://media.mohadaraty.com';

// ----------------------------------------------------
// Mock Lectures
// ----------------------------------------------------
export const FIXTURE_LECTURES: TestLecture[] = [
  {
    id: 'lec_pharma_1',
    stageId: 'stage_3',
    subjectId: 'pharmacology',
    type: 'theoretical',
    number: 1,
    title: 'Pharmacology - Introduction to Pharmacokinetics',
    description: 'Basic principles of ADME in clinical medicine',
    pdfUrl: 'https://storage.googleapis.com/test-bucket/lectures/pharma_1.pdf',
  },
  {
    id: 'lec_pharma_2',
    stageId: 'stage_3',
    subjectId: 'pharmacology',
    type: 'theoretical',
    number: 2,
    title: 'Pharmacology - Pharmacodynamics & Receptor Theory',
    description: 'Agonists, antagonists, and dose-response curves',
    pdfUrl: 'https://storage.googleapis.com/test-bucket/lectures/pharma_2.pdf',
  },
  {
    id: 'lec_pharma_3_no_records',
    stageId: 'stage_3',
    subjectId: 'pharmacology',
    type: 'theoretical',
    number: 3,
    title: 'Pharmacology - Autonomic Nervous System I',
    description: 'Sympathetic neurotransmission and adrenergic agonists',
    pdfUrl: 'https://storage.googleapis.com/test-bucket/lectures/pharma_3.pdf',
  },
  {
    id: 'lec_anatomy_1',
    stageId: 'stage_1',
    subjectId: 'anatomy',
    type: 'practical',
    number: 1,
    title: 'Anatomy - Upper Limb Osteology Lab',
    description: 'Clavicle, scapula, and humerus surface markings',
    pdfUrl: 'https://storage.googleapis.com/test-bucket/lectures/anatomy_1.pdf',
  },
];

// ----------------------------------------------------
// Mock Records
// ----------------------------------------------------
export const FIXTURE_RECORDS: TestRecordItem[] = [
  // Explicit lectureId link (1 record for lec_pharma_1)
  {
    id: 'rec_pharma_1_main',
    lectureId: 'lec_pharma_1',
    title: 'تسجيل محاضرة الحركية الدوائية كاملة',
    category: 'pharmacology',
    subjectId: 'pharmacology',
    type: 'theoretical',
    number: 1,
    stageId: 'stage_3',
    audioUrl: `${R2_PUBLIC_BASE}/records/stage_3/1715000000000_pharma_1.mp3`,
    duration: 3600, // 1 hour
    size: 45 * 1024 * 1024,
    createdAt: { toMillis: () => 1715000000000 },
    uploadedBy: 'staff_dr_ahmed',
    uploaderName: 'د. أحمد حيدر',
    subjectName: 'Pharmacology',
    subjectNameAr: 'علم الأدوية',
  },

  // Multiple records for lec_pharma_2 (Part 1 and Part 2)
  {
    id: 'rec_pharma_2_part1',
    lectureId: 'lec_pharma_2',
    title: 'ديناميكية الدواء - الجزء الأول: نظريات المستقبلات',
    category: 'pharmacology',
    subjectId: 'pharmacology',
    type: 'theoretical',
    number: 2,
    stageId: 'stage_3',
    audioUrl: `${R2_PUBLIC_BASE}/records/stage_3/1715001000000_pharma_2_pt1.mp3`,
    duration: 2100, // 35 min
    size: 28 * 1024 * 1024,
    createdAt: { toMillis: () => 1715001000000 },
    uploadedBy: 'staff_dr_ahmed',
    uploaderName: 'د. أحمد حيدر',
    subjectName: 'Pharmacology',
    subjectNameAr: 'علم الأدوية',
  },
  {
    id: 'rec_pharma_2_part2',
    lectureId: 'lec_pharma_2',
    title: 'ديناميكية الدواء - الجزء الثاني: منحنيات الجرعة والاستجابة',
    category: 'pharmacology',
    subjectId: 'pharmacology',
    type: 'theoretical',
    number: 2,
    stageId: 'stage_3',
    audioUrl: `${R2_PUBLIC_BASE}/records/stage_3/1715002000000_pharma_2_pt2.mp3`,
    duration: 2700, // 45 min
    size: 34 * 1024 * 1024,
    createdAt: { toMillis: () => 1715002000000 },
    uploadedBy: 'staff_dr_ahmed',
    uploaderName: 'د. أحمد حيدر',
    subjectName: 'Pharmacology',
    subjectNameAr: 'علم الأدوية',
  },

  // Legacy record without lectureId (matches lec_anatomy_1 by tuple stageId+subjectId+type+number)
  {
    id: 'rec_anatomy_1_legacy',
    title: 'تشريح عملي 1 - عظام الطرف العلوي',
    category: 'anatomy',
    subjectId: 'anatomy',
    type: 'practical',
    number: 1,
    stageId: 'stage_1',
    audioUrl: `${R2_PUBLIC_BASE}/records/stage_1/1714000000000_anatomy_lab1.m4a`,
    duration: 1800,
    size: 20 * 1024 * 1024,
    createdAt: 1714000000000,
    uploadedBy: 'staff_dr_omar',
    uploaderName: 'د. عمر طارق',
    subjectName: 'Anatomy',
    subjectNameAr: 'التشريح البشري',
  },

  // Adversarial Boundary record: extreme length title
  {
    id: 'rec_extreme_title',
    lectureId: 'lec_pharma_1',
    title:
      'محاضرة الحركية الدوائية المتقدمة جداً مع مراجعة شاملة لجميع مسائل الحسابات الدوائية ومعادلات التصفية الكلوية والحجم التوزيعي والتوافر الحيوي الدقيق للعام الدراسي الكامل 2026 بالتفصيل الممل جداً جداً جداً جداً جداً جداً مع حلول جميع الأسئلة الامتحانية السابقة 1234567890',
    category: 'pharmacology',
    subjectId: 'pharmacology',
    type: 'theoretical',
    number: 1,
    stageId: 'stage_3',
    audioUrl: `${R2_PUBLIC_BASE}/records/stage_3/1715003000000_extreme.mp3`,
    duration: 5400,
    size: 60 * 1024 * 1024,
    createdAt: { toMillis: () => 1715003000000 },
    uploadedBy: 'staff_dr_ahmed',
  },

  // Adversarial Boundary record: Arabic diacritics, emojis, quotes, special characters
  {
    id: 'rec_special_chars',
    lectureId: 'lec_pharma_1',
    title: '🎙️ شَرْحُ "الفَارْمَاكُولُوجِي" (مُهِمّ جِدّاً!) & أسئلة الـ MCQs <2026> #1',
    category: 'pharmacology',
    subjectId: 'pharmacology',
    type: 'theoretical',
    number: 1,
    stageId: 'stage_3',
    audioUrl: `${R2_PUBLIC_BASE}/records/stage_3/1715004000000_special_%231.mp3`,
    duration: 1500,
    size: 15 * 1024 * 1024,
    createdAt: { toMillis: () => 1715004000000 },
  },

  // Adversarial Boundary record: missing optional fields
  {
    id: 'rec_missing_fields',
    lectureId: 'lec_pharma_1',
    title: 'تسجيل سريع بدون تفاصيل',
    category: 'pharmacology',
    subjectId: 'pharmacology',
    type: 'theoretical',
    number: 1,
    stageId: 'stage_3',
    audioUrl: `${R2_PUBLIC_BASE}/records/stage_3/1715005000000_bare.mp3`,
    // duration, size, uploaderName, createdAt are omitted
  },
];

// ----------------------------------------------------
// Mock User Profiles
// ----------------------------------------------------
export const FIXTURE_USERS: Record<string, TestUserProfile> = {
  studentStage3: {
    uid: 'student_301',
    role: 'student',
    stageId: 'stage_3',
    name: 'Zaid Mustafa',
    email: 'zaid@student.uob.edu',
  },
  studentStage1: {
    uid: 'student_101',
    role: 'student',
    stageId: 'stage_1',
    name: 'Sarah Ali',
    email: 'sarah@student.uob.edu',
  },
  staffAdmin: {
    uid: 'staff_dr_ahmed',
    role: 'staff',
    stageId: 'stage_3',
    name: 'Dr. Ahmed Haydar',
    email: 'ahmed@staff.mohadaraty.com',
    permissions: {
      manageRecords: true,
      manageLectures: true,
    },
  },
  masterAdmin: {
    uid: 'admin_root',
    role: 'master_admin',
    name: 'System Root Admin',
    email: 'admin@mohadaraty.com',
    permissions: {
      manageRecords: true,
      manageLectures: true,
    },
  },
};
