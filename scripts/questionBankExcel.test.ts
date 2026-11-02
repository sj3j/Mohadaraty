import { strict as assert } from 'node:assert';
import * as XLSX from 'xlsx';
import { 
  buildQuestionBankTemplateWorkbook, 
  parseQuestionBankBuffer 
} from '../src/services/questionBankExcelService';

async function runTests() {
  console.log('--- Testing Question Bank Excel Parser & Template Service ---');

  // Test 1: Template Generation
  console.log('Test 1: Template workbook structure');
  const templateWb = buildQuestionBankTemplateWorkbook();
  assert.equal(templateWb.SheetNames.length, 2, 'Workbook should have 2 sheets');
  assert.equal(templateWb.SheetNames[0], 'الأسئلة (Questions)');
  assert.equal(templateWb.SheetNames[1], 'التعليمات (Instructions)');

  // Test 2: Parsing the generated template
  console.log('Test 2: Parsing template workbook');
  const templateBuffer = XLSX.write(templateWb, { type: 'buffer', bookType: 'xlsx' });
  const parsedFromTemplate = parseQuestionBankBuffer(templateBuffer);
  
  assert.equal(parsedFromTemplate.totalCount, 3, 'Should have 3 sample questions');
  assert.equal(parsedFromTemplate.validCount, 3, 'All 3 sample questions should be valid');
  assert.equal(parsedFromTemplate.invalidCount, 0, 'No invalid questions');

  // Verify first sample (MCQ with letter answer 'A')
  const q1 = parsedFromTemplate.questions[0];
  assert.equal(q1.type, 'mcq');
  assert.equal(q1.choices.length, 5);
  assert.equal(q1.correctAnswer, q1.choices[0].text);
  assert.deepEqual(q1.tags, ['وزاري', 'مهم', 'سنين_سابقة']);

  // Verify second sample (True/False)
  const q2 = parsedFromTemplate.questions[1];
  assert.equal(q2.type, 'true_false');
  assert.equal(q2.choices.length, 2);
  assert.ok(q2.correctAnswer.includes('صح') || q2.correctAnswer.includes('True'));

  // Test 3: Arabic Headers & Arabic Letter Answers (أ، ب، ج، د)
  console.log('Test 3: Arabic headers with Arabic letter answers');
  const arabicData = [
    {
      'السؤال': 'ما هو الترياق المستخدم لتسمم الباراسيتامول؟',
      'الخيار أ': 'N-acetylcysteine',
      'الخيار ب': 'Naloxone',
      'الخيار ج': 'Flumazenil',
      'الخيار د': 'Atropine',
      'الإجابة الصحيحة': 'أ',
      'التفسير': 'يعمل N-acetylcysteine على تجديد مخزون الجلوتاثيون في الكبد.',
      'الصعوبة': 'سهل',
      'الوسوم': 'وزاري، مهم'
    },
    {
      'السؤال': 'أي من الأدوية التالية يسبب سعال جاف كعرض جانبي شائع؟',
      'الخيار أ': 'Captopril',
      'الخيار ب': 'Amlodipine',
      'الخيار ج': 'Losartan',
      'الإجابة الصحيحة': 'Captopril',
      'الصعوبة': 'متوسط'
    }
  ];

  const arabicWb = XLSX.utils.book_new();
  const arabicWs = XLSX.utils.json_to_sheet(arabicData);
  XLSX.utils.book_append_sheet(arabicWb, arabicWs, 'Sheet1');
  const arabicBuffer = XLSX.write(arabicWb, { type: 'buffer', bookType: 'xlsx' });

  const arabicResult = parseQuestionBankBuffer(arabicBuffer);
  assert.equal(arabicResult.totalCount, 2);
  assert.equal(arabicResult.validCount, 2);
  assert.equal(arabicResult.questions[0].correctAnswer, 'N-acetylcysteine');
  assert.equal(arabicResult.questions[0].difficulty, 'easy');
  assert.deepEqual(arabicResult.questions[0].tags, ['وزاري', 'مهم']);
  assert.equal(arabicResult.questions[1].correctAnswer, 'Captopril');
  assert.equal(arabicResult.questions[1].difficulty, 'medium');

  // Test 4: English Headers with numeric and letter answers
  console.log('Test 4: English headers with numeric and letter answers');
  const englishData = [
    {
      'Question': 'Which vitamin is synthesized by intestinal flora?',
      'Choice A': 'Vitamin A',
      'Choice B': 'Vitamin K',
      'Choice C': 'Vitamin C',
      'Answer': 'B',
      'Difficulty': 'easy'
    },
    {
      'Question': 'Which organ is primarily responsible for drug metabolism?',
      'Choice A': 'Kidney',
      'Choice B': 'Liver',
      'Choice C': 'Lungs',
      'Choice D': 'Heart',
      'Answer': '2', // Numeric answer -> Choice 2 (Liver)
      'Difficulty': 'medium'
    }
  ];

  const englishWb = XLSX.utils.book_new();
  const englishWs = XLSX.utils.json_to_sheet(englishData);
  XLSX.utils.book_append_sheet(englishWb, englishWs, 'Sheet1');
  const englishBuffer = XLSX.write(englishWb, { type: 'buffer', bookType: 'xlsx' });

  const englishResult = parseQuestionBankBuffer(englishBuffer);
  assert.equal(englishResult.totalCount, 2);
  assert.equal(englishResult.validCount, 2);
  assert.equal(englishResult.questions[0].correctAnswer, 'Vitamin K');
  assert.equal(englishResult.questions[1].correctAnswer, 'Liver');

  // Test 5: Validation and Error Flagging
  console.log('Test 5: Validation errors on malformed rows');
  const malformedData = [
    {
      'Question': '', // Missing question stem
      'Choice A': 'Option 1',
      'Choice B': 'Option 2',
      'Answer': 'A'
    },
    {
      'Question': 'Only one choice provided question',
      'Choice A': 'Option 1',
      'Choice B': '', // Missing Choice B
      'Answer': 'A'
    },
    {
      'Question': 'Mismatch answer question',
      'Choice A': 'Option 1',
      'Choice B': 'Option 2',
      'Answer': 'Z' // Non-existent choice
    }
  ];

  const malformedWb = XLSX.utils.book_new();
  const malformedWs = XLSX.utils.json_to_sheet(malformedData);
  XLSX.utils.book_append_sheet(malformedWb, malformedWs, 'Sheet1');
  const malformedBuffer = XLSX.write(malformedWb, { type: 'buffer', bookType: 'xlsx' });

  const malformedResult = parseQuestionBankBuffer(malformedBuffer);
  assert.equal(malformedResult.totalCount, 3);
  assert.equal(malformedResult.validCount, 0);
  assert.equal(malformedResult.invalidCount, 3);
  assert.ok(malformedResult.questions[0].errors.some(e => e.includes('فارغ')));
  assert.ok(malformedResult.questions[1].errors.some(e => e.includes('خيارين')));
  assert.ok(malformedResult.questions[2].errors.some(e => e.includes('لا تطابق')));

  console.log(' All 5 Question Bank Excel tests passed successfully!');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});

