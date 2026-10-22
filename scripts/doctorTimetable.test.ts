import {
  normalizeTeacherName,
  matchesDoctorTeacher,
  STAGE_NAME_MAP,
} from '../src/components/doctor/useDoctorCrossStageTimetable';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, details = '') {
  if (condition) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name}${details ? ` -> ${details}` : ''}`);
    failed++;
  }
}

console.log('\n--- Testing Teacher Normalization & Matching ---');

// 1. Normalization tests
check('Normalizes prefix د.', normalizeTeacherName('د. غزوان') === 'غزوان');
check('Normalizes prefix دكتور', normalizeTeacherName('دكتور غزوان مهدي') === 'غزوان مهدي');
check('Normalizes prefix أ.د.', normalizeTeacherName('أ.د. حيدر') === 'حيدر');
check('Normalizes alefs (أ -> ا, إ -> ا)', normalizeTeacherName('د. أحمد') === 'احمد');
check('Normalizes taa marbuta (ة -> ه)', normalizeTeacherName('دكتورة فاطمة') === 'فاطمه');
check('Normalizes yaa (ى -> ي)', normalizeTeacherName('د. منى') === 'مني');

// 2. Doctor matching tests
check(
  'Matches exact doctor name with title "د. غزوان" vs "غزوان"',
  matchesDoctorTeacher('د. غزوان', 'غزوان') === true
);

check(
  'Matches doctor name with title "د. غزوان" vs "د. غزوان"',
  matchesDoctorTeacher('د. غزوان', 'د. غزوان') === true
);

check(
  'Matches shorthand timetable "د. غزوان" with full account "د. غزوان مهدي"',
  matchesDoctorTeacher('د. غزوان', 'د. غزوان مهدي') === true
);

check(
  'Matches full timetable "د. غزوان مهدي" with short account "غزوان"',
  matchesDoctorTeacher('د. غزوان مهدي', 'غزوان') === true
);

check(
  'Matches Alef normalized names: "د. احمد" vs "أحمد علي"',
  matchesDoctorTeacher('د. احمد', 'أحمد علي') === true
);

check(
  'Rejects different doctors with same common first name: "د. محمد رضا" vs "محمد علي"',
  matchesDoctorTeacher('د. محمد رضا', 'محمد علي') === false
);

check(
  'Rejects completely different doctors: "د. سارة" vs "غزوان"',
  matchesDoctorTeacher('د. سارة', 'غزوان') === false
);

// 3. Stage mapping tests
check('Maps stage_1 to المرحلة الأولى', STAGE_NAME_MAP.stage_1.ar === 'المرحلة الأولى');
check('Maps stage_3 to المرحلة الثالثة', STAGE_NAME_MAP.stage_3.ar === 'المرحلة الثالثة');
check('Maps stage_4 to المرحلة الرابعة', STAGE_NAME_MAP.stage_4.ar === 'المرحلة الرابعة');
check('Maps stage_5 to المرحلة الخامسة', STAGE_NAME_MAP.stage_5.ar === 'المرحلة الخامسة');

console.log(`\nResults: ${passed} passed, ${failed} failed.\n`);
if (failed > 0) {
  process.exit(1);
}
