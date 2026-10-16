import { DoctorSubject, LectureColumn, StudentAttendanceRow } from './types';

export const MOCK_DOCTOR_SUBJECTS: DoctorSubject[] = [
  {
    id: 'subj_pharma',
    nameAr: 'علم الأدوية والسموم (Pharmacology)',
    nameEn: 'Pharmacology & Toxicology',
    stageId: 'stage_3',
    stageNameAr: 'المرحلة الثالثة',
    type: 'both',
    code: 'PHAR-301',
  },
  {
    id: 'subj_clinchem',
    nameAr: 'الكيمياء السريرية (Clinical Chemistry)',
    nameEn: 'Clinical Chemistry',
    stageId: 'stage_3',
    stageNameAr: 'المرحلة الثالثة',
    type: 'theoretical',
    code: 'CHEM-302',
  },
];

export const MOCK_LECTURES: LectureColumn[] = [
  { id: 'lec_1', number: 1, date: '2026-09-20', title: 'مقدمة في حركية الدواء (Pharmacokinetics)', mode: 'theoretical', time: '08:30 ص', location: 'القاعة الكبرى 1' },
  { id: 'lec_2', number: 2, date: '2026-09-27', title: 'امتصاص وتوزيع الدواء (Absorption & Distribution)', mode: 'theoretical', time: '08:30 ص', location: 'القاعة الكبرى 1' },
  { id: 'lec_3', number: 3, date: '2026-10-04', title: 'أيض وإخراج الأدوية (Metabolism & Excretion)', mode: 'theoretical', time: '08:30 ص', location: 'القاعة الكبرى 1' },
  { id: 'lec_4', number: 4, date: '2026-10-11', title: 'ديناميكية الدواء والمستقبلات (Pharmacodynamics)', mode: 'theoretical', time: '08:30 ص', location: 'القاعة الكبرى 1' },
  { id: 'lec_5', number: 5, date: '2026-10-18', title: 'أدوية الجهاز العصبي الودي (Sympathetic NS)', mode: 'theoretical', time: '08:30 ص', location: 'القاعة الكبرى 1' },
  { id: 'lec_6', number: 6, date: '2026-10-25', title: 'مختبر 1: طرق إعطاء الدواء في النماذج الحية', mode: 'practical', time: '10:30 ص', location: 'مختبر الفارما 2' },
  { id: 'lec_7', number: 7, date: '2026-11-01', title: 'أدوية الجهاز اللاودي (Parasympathetic)', mode: 'theoretical', time: '08:30 ص', location: 'القاعة الكبرى 1' },
  { id: 'lec_8', number: 8, date: '2026-11-08', title: 'مختبر 2: قياس تراكيز الدواء بالبلازما', mode: 'practical', time: '10:30 ص', location: 'مختبر الفارما 2' },
  { id: 'lec_9', number: 9, date: '2026-11-15', title: 'حاصرات بيتا ومضادات الضغط (Beta Blockers)', mode: 'theoretical', time: '08:30 ص', location: 'القاعة الكبرى 1' },
  { id: 'lec_10', number: 10, date: '2026-11-22', title: 'أدوية الجهاز البولي والمدرات (Diuretics)', mode: 'theoretical', time: '08:30 ص', location: 'القاعة الكبرى 1' },
];

export const MOCK_STUDENTS: StudentAttendanceRow[] = [
  {
    studentId: 'std_01',
    name: 'حسين علي جاسم حسن',
    group: 'A',
    examCode: 'PH26-101',
    attendance: {
      lec_1: 'present', lec_2: 'present', lec_3: 'present', lec_4: 'present', lec_5: 'present',
      lec_6: 'present', lec_7: 'present', lec_8: 'present', lec_9: 'present', lec_10: 'present',
    },
  },
  {
    studentId: 'std_02',
    name: 'زينب كريم محمد كاظم',
    group: 'A',
    examCode: 'PH26-102',
    attendance: {
      lec_1: 'present', lec_2: 'present', lec_3: 'absent', lec_4: 'present', lec_5: 'present',
      lec_6: 'present', lec_7: 'present', lec_8: 'present', lec_9: 'present', lec_10: 'present',
    },
  },
  {
    studentId: 'std_03',
    name: 'سجاد عبد الزهرة عبد الحسين',
    group: 'A',
    examCode: 'PH26-103',
    attendance: {
      lec_1: 'present', lec_2: 'absent', lec_3: 'absent', lec_4: 'absent', lec_5: 'present',
      lec_6: 'absent', lec_7: 'absent', lec_8: 'absent', lec_9: 'absent', lec_10: 'unrecorded',
    },
  },
  {
    studentId: 'std_04',
    name: 'مريم حيدر فاضل مهدي',
    group: 'A',
    examCode: 'PH26-104',
    attendance: {
      lec_1: 'present', lec_2: 'present', lec_3: 'present', lec_4: 'excused', lec_5: 'present',
      lec_6: 'present', lec_7: 'present', lec_8: 'present', lec_9: 'present', lec_10: 'present',
    },
  },
  {
    studentId: 'std_05',
    name: 'مصطفى أحمد كاظم عبد الله',
    group: 'B',
    examCode: 'PH26-105',
    attendance: {
      lec_1: 'present', lec_2: 'present', lec_3: 'present', lec_4: 'present', lec_5: 'absent',
      lec_6: 'present', lec_7: 'present', lec_8: 'present', lec_9: 'excused', lec_10: 'present',
    },
  },
  {
    studentId: 'std_06',
    name: 'فاطمة عباس نوري رشيد',
    group: 'B',
    examCode: 'PH26-106',
    attendance: {
      lec_1: 'present', lec_2: 'present', lec_3: 'present', lec_4: 'present', lec_5: 'present',
      lec_6: 'present', lec_7: 'present', lec_8: 'present', lec_9: 'present', lec_10: 'present',
    },
  },
  {
    studentId: 'std_07',
    name: 'كرار حيدر علي شريف',
    group: 'B',
    examCode: 'PH26-107',
    attendance: {
      lec_1: 'absent', lec_2: 'absent', lec_3: 'absent', lec_4: 'present', lec_5: 'absent',
      lec_6: 'absent', lec_7: 'unrecorded', lec_8: 'unrecorded', lec_9: 'unrecorded', lec_10: 'unrecorded',
    },
  },
  {
    studentId: 'std_08',
    name: 'آمنة رعد شاكر محمود',
    group: 'B',
    examCode: 'PH26-108',
    attendance: {
      lec_1: 'present', lec_2: 'present', lec_3: 'present', lec_4: 'present', lec_5: 'present',
      lec_6: 'present', lec_7: 'present', lec_8: 'present', lec_9: 'present', lec_10: 'present',
    },
  },
  {
    studentId: 'std_09',
    name: 'علي جواد كاظم عناد',
    group: 'C',
    examCode: 'PH26-109',
    attendance: {
      lec_1: 'present', lec_2: 'present', lec_3: 'present', lec_4: 'present', lec_5: 'present',
      lec_6: 'absent', lec_7: 'present', lec_8: 'present', lec_9: 'present', lec_10: 'present',
    },
  },
  {
    studentId: 'std_10',
    name: 'نور الهدى عمار طارق صبيح',
    group: 'C',
    examCode: 'PH26-110',
    attendance: {
      lec_1: 'present', lec_2: 'present', lec_3: 'present', lec_4: 'present', lec_5: 'present',
      lec_6: 'present', lec_7: 'present', lec_8: 'present', lec_9: 'present', lec_10: 'present',
    },
  },
  {
    studentId: 'std_11',
    name: 'محمد صادق باقر إبراهيم',
    group: 'C',
    examCode: 'PH26-111',
    attendance: {
      lec_1: 'absent', lec_2: 'present', lec_3: 'absent', lec_4: 'present', lec_5: 'present',
      lec_6: 'present', lec_7: 'absent', lec_8: 'present', lec_9: 'present', lec_10: 'present',
    },
  },
  {
    studentId: 'std_12',
    name: 'تبارك عبد الأمير حميد',
    group: 'C',
    examCode: 'PH26-112',
    attendance: {
      lec_1: 'present', lec_2: 'present', lec_3: 'present', lec_4: 'present', lec_5: 'present',
      lec_6: 'present', lec_7: 'present', lec_8: 'present', lec_9: 'present', lec_10: 'present',
    },
  },
  {
    studentId: 'std_13',
    name: 'حيدر ستار جبار لفتة',
    group: 'A',
    examCode: 'PH26-113',
    attendance: {
      lec_1: 'present', lec_2: 'present', lec_3: 'absent', lec_4: 'present', lec_5: 'present',
      lec_6: 'absent', lec_7: 'present', lec_8: 'present', lec_9: 'present', lec_10: 'present',
    },
  },
  {
    studentId: 'std_14',
    name: 'زهراء قاسم محمد رضا',
    group: 'A',
    examCode: 'PH26-114',
    attendance: {
      lec_1: 'present', lec_2: 'present', lec_3: 'present', lec_4: 'present', lec_5: 'present',
      lec_6: 'present', lec_7: 'present', lec_8: 'present', lec_9: 'present', lec_10: 'present',
    },
  },
  {
    studentId: 'std_15',
    name: 'يوسف مهدي صالح عجيل',
    group: 'B',
    examCode: 'PH26-115',
    attendance: {
      lec_1: 'absent', lec_2: 'absent', lec_3: 'absent', lec_4: 'absent', lec_5: 'absent',
      lec_6: 'absent', lec_7: 'absent', lec_8: 'absent', lec_9: 'unrecorded', lec_10: 'unrecorded',
    },
  },
  {
    studentId: 'std_16',
    name: 'هدى فراس عبد المنعم',
    group: 'B',
    examCode: 'PH26-116',
    attendance: {
      lec_1: 'present', lec_2: 'present', lec_3: 'present', lec_4: 'present', lec_5: 'present',
      lec_6: 'present', lec_7: 'present', lec_8: 'present', lec_9: 'present', lec_10: 'present',
    },
  },
  {
    studentId: 'std_17',
    name: 'ضرغام خليل إسماعيل شاتي',
    group: 'C',
    examCode: 'PH26-117',
    attendance: {
      lec_1: 'present', lec_2: 'present', lec_3: 'absent', lec_4: 'present', lec_5: 'present',
      lec_6: 'present', lec_7: 'present', lec_8: 'present', lec_9: 'present', lec_10: 'present',
    },
  },
  {
    studentId: 'std_18',
    name: 'سارة ثامر كاظم ناجي',
    group: 'C',
    examCode: 'PH26-118',
    attendance: {
      lec_1: 'present', lec_2: 'present', lec_3: 'present', lec_4: 'present', lec_5: 'present',
      lec_6: 'present', lec_7: 'present', lec_8: 'present', lec_9: 'present', lec_10: 'present',
    },
  },
  {
    studentId: 'std_19',
    name: 'أمير سلمان داود سلمان',
    group: 'A',
    examCode: 'PH26-119',
    attendance: {
      lec_1: 'present', lec_2: 'absent', lec_3: 'present', lec_4: 'present', lec_5: 'absent',
      lec_6: 'present', lec_7: 'present', lec_8: 'absent', lec_9: 'present', lec_10: 'present',
    },
  },
  {
    studentId: 'std_20',
    name: 'آية ناصر حسين مصلح',
    group: 'B',
    examCode: 'PH26-120',
    attendance: {
      lec_1: 'present', lec_2: 'present', lec_3: 'present', lec_4: 'present', lec_5: 'present',
      lec_6: 'present', lec_7: 'present', lec_8: 'present', lec_9: 'present', lec_10: 'present',
    },
  },
];

/**
 * Calculates attendance metrics for a student.
 */
export function calculateStudentStats(row: StudentAttendanceRow, lectures: LectureColumn[]) {
  let present = 0;
  let absent = 0;
  let excused = 0;
  let totalHeld = 0;

  for (const lec of lectures) {
    const status = row.attendance[lec.id];
    if (status && status !== 'unrecorded') {
      totalHeld++;
      if (status === 'present') present++;
      else if (status === 'absent') absent++;
      else if (status === 'excused') excused++;
    }
  }

  const attendanceRate = totalHeld > 0 ? Math.round((present / totalHeld) * 100) : 100;
  const absenceRate = totalHeld > 0 ? Math.round((absent / totalHeld) * 100) : 0;

  // Iraqi Higher Education typical attendance deprivation rule:
  // > 15% absence = Deprivation (محروم)
  // > 10% absence = First warning (إنذار أول)
  // > 5% absence = Alert (تنبيه)
  let status: 'safe' | 'alert' | 'warning' | 'deprived' = 'safe';
  if (absenceRate >= 15) {
    status = 'deprived';
  } else if (absenceRate >= 10) {
    status = 'warning';
  } else if (absenceRate >= 5) {
    status = 'alert';
  }

  return { present, absent, excused, totalHeld, attendanceRate, absenceRate, status };
}
