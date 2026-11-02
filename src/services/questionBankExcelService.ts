import * as XLSX from 'xlsx';
import { Difficulty, QuestionType, StemFormat } from '../types/questionBank.types';

export interface ParsedExcelQuestion {
  id: string; // temporary local unique key
  rowNumber: number;
  stem: string;
  choices: { label: string; text: string }[];
  correctAnswer: string;
  explanation: string;
  difficulty: Difficulty;
  tags: string[];
  type: QuestionType;
  stemFormat: StemFormat;
  isValid: boolean;
  errors: string[];
}

export interface ParseExcelResult {
  questions: ParsedExcelQuestion[];
  totalCount: number;
  validCount: number;
  invalidCount: number;
}

// Column alias normalization
const STEM_ALIASES = [
  'السؤال', 'نص السؤال', 'السؤال أو الفقرة', 'سؤال', 'نص', 
  'question', 'stem', 'question text', 'question_text', 'text'
];

const CHOICE_A_ALIASES = [
  'الخيار a', 'الخيار أ', 'أ', 'a', 'choice a', 'choice_a', 
  'option a', 'option_a', 'choice 1', 'option 1', 'خيار 1', 'خيار a'
];

const CHOICE_B_ALIASES = [
  'الخيار b', 'الخيار ب', 'ب', 'b', 'choice b', 'choice_b', 
  'option b', 'option_b', 'choice 2', 'option 2', 'خيار 2', 'خيار b'
];

const CHOICE_C_ALIASES = [
  'الخيار c', 'الخيار ج', 'ج', 'c', 'choice c', 'choice_c', 
  'option c', 'option_c', 'choice 3', 'option 3', 'خيار 3', 'خيار c'
];

const CHOICE_D_ALIASES = [
  'الخيار d', 'الخيار د', 'د', 'd', 'choice d', 'choice_d', 
  'option d', 'option_d', 'choice 4', 'option 4', 'خيار 4', 'خيار d'
];

const CHOICE_E_ALIASES = [
  'الخيار e', 'الخيار هـ', 'الخيار ه', 'هـ', 'ه', 'e', 'choice e', 
  'choice_e', 'option e', 'option_e', 'choice 5', 'option 5', 'خيار 5', 'خيار e'
];

const ANSWER_ALIASES = [
  'الإجابة الصحيحة', 'الاجابة الصحيحة', 'الإجابة', 'الاجابة', 'الحل', 'الجواب', 
  'correct answer', 'correct_answer', 'answer', 'correct', 'key', 'ans'
];

const EXPLANATION_ALIASES = [
  'التفسير', 'تفسير', 'الشرح', 'شرح', 'التوضيح', 'توضيح', 'ملاحظات', 
  'explanation', 'rationale', 'notes'
];

const DIFFICULTY_ALIASES = [
  'الصعوبة', 'مستوى الصعوبة', 'صعوبة', 'difficulty', 'level'
];

const TAGS_ALIASES = [
  'الوسوم', 'وسوم', 'التاغات', 'تاغات', 'التصنيف', 'تصنيف', 'tags', 'tag', 'categories'
];

const TYPE_ALIASES = [
  'نوع السؤال', 'نوع', 'type', 'question type', 'question_type'
];

function cleanKey(header: any): string {
  if (header == null) return '';
  return String(header).trim().toLowerCase().replace(/\s+/g, ' ');
}

function matchAlias(cleanHeader: string, aliases: string[]): boolean {
  if (!cleanHeader) return false;
  return aliases.some(alias => cleanHeader === alias || cleanHeader.startsWith(alias + ' ') || cleanHeader.endsWith(' ' + alias));
}

function normalizeDifficulty(val: any, fallback: Difficulty = 'medium'): Difficulty {
  if (!val) return fallback;
  const s = String(val).trim().toLowerCase();
  if (s === 'easy' || s === 'سهل' || s === 'بسيط') return 'easy';
  if (s === 'hard' || s === 'صعب' || s === 'متقدم') return 'hard';
  if (s === 'medium' || s === 'متوسط' || s === 'عادي') return 'medium';
  return fallback;
}

function normalizeQuestionType(val: any): QuestionType {
  if (!val) return 'mcq';
  const s = String(val).trim().toLowerCase();
  if (s.includes('tf') || s.includes('true') || s.includes('صح') || s.includes('خطأ') || s.includes('false')) {
    return 'true_false';
  }
  return 'mcq';
}

function parseTags(val: any): string[] {
  if (!val) return [];
  const s = String(val).trim();
  if (!s) return [];
  return s
    .split(/[,،;\n]+/)
    .map(t => t.trim().replace(/^#+/, ''))
    .filter(t => t.length > 0);
}

/**
 * Builds the standard Question Bank Excel template workbook
 */
export function buildQuestionBankTemplateWorkbook(): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();

  // 1. Questions Sheet with Example Rows
  const sampleData = [
    {
      'السؤال (Question)': 'What is the primary mechanism of action of Paracetamol (Acetaminophen)?',
      'الخيار A (Option A)': 'Inhibition of central prostaglandin synthesis (COX-3 / central COX)',
      'الخيار B (Option B)': 'Direct inhibition of peripheral COX-1 and COX-2 with anti-inflammatory effect',
      'الخيار C (Option C)': 'Irreversible acetylation of platelet COX-1',
      'الخيار D (Option D)': 'Selective inhibition of peripheral COX-2 enzyme only',
      'الخيار E (Option E)': 'Agonist at opioid mu-receptors',
      'الإجابة الصحيحة (Answer)': 'A',
      'التفسير (Explanation)': 'Paracetamol acts primarily in the CNS to inhibit prostaglandin synthesis, explaining its analgesic and antipyretic efficacy without significant peripheral anti-inflammatory action.',
      'الصعوبة (Difficulty)': 'medium',
      'الوسوم (Tags)': 'وزاري, مهم, سنين_سابقة',
      'نوع السؤال (Type)': 'mcq'
    },
    {
      'السؤال (Question)': 'Aspirin is contraindicated in children with viral illness due to the risk of Reye syndrome.',
      'الخيار A (Option A)': 'صح / True',
      'الخيار B (Option B)': 'خطأ / False',
      'الخيار C (Option C)': '',
      'الخيار D (Option D)': '',
      'الخيار E (Option E)': '',
      'الإجابة الصحيحة (Answer)': 'صح',
      'التفسير (Explanation)': 'Aspirin use in children recovering from viral infections (like influenza or chickenpox) is linked to potentially fatal Reye syndrome.',
      'الصعوبة (Difficulty)': 'easy',
      'الوسوم (Tags)': 'وزاري, سؤال_الدكتور',
      'نوع السؤال (Type)': 'true_false'
    },
    {
      'السؤال (Question)': 'أي من الآتي يعتبر مضاد حيوي مثبط لتصنيع جدار الخلية البكتيرية؟',
      'الخيار A (Option A)': 'Amoxicillin',
      'الخيار B (Option B)': 'Gentamicin',
      'الخيار C (Option C)': 'Doxycycline',
      'الخيار D (Option D)': 'Ciprofloxacin',
      'الخيار E (Option E)': '',
      'الإجابة الصحيحة (Answer)': 'A',
      'التفسير (Explanation)': 'الأموكسيسيلين ينتمي إلى البنسلينات ويثبط إنزيم transpeptidase في جدار الخلية.',
      'الصعوبة (Difficulty)': 'easy',
      'الوسوم (Tags)': 'مهم, متوقع',
      'نوع السؤال (Type)': 'mcq'
    }
  ];

  const questionsSheet = XLSX.utils.json_to_sheet(sampleData);

  // Set column widths for better readability
  questionsSheet['!cols'] = [
    { wch: 45 }, // Question
    { wch: 30 }, // Option A
    { wch: 30 }, // Option B
    { wch: 30 }, // Option C
    { wch: 30 }, // Option D
    { wch: 25 }, // Option E
    { wch: 20 }, // Answer
    { wch: 40 }, // Explanation
    { wch: 15 }, // Difficulty
    { wch: 25 }, // Tags
    { wch: 15 }, // Type
  ];

  XLSX.utils.book_append_sheet(wb, questionsSheet, 'الأسئلة (Questions)');

  // 2. Instructions Sheet
  const instructionsData = [
    { 'الحقل (Field)': 'السؤال (Question)', 'الشرط (Requirement)': 'إجباري (Required)', 'الوصف والتعليمات (Description)': 'نص السؤال الرئيسي. يدعم اللغتين العربية والإنجليزية.' },
    { 'الحقل (Field)': 'الخيار A والخيار B', 'الشرط (Requirement)': 'إجباري لأسئلة MCQ', 'الوصف والتعليمات (Description)': 'يجب توفر خيارين على الأقل لكل سؤال اختيار من متعدد.' },
    { 'الحقل (Field)': 'الخيارات C و D و E', 'الشرط (Requirement)': 'اختياري (Optional)', 'الوصف والتعليمات (Description)': 'يمكنك إضافة خيارات إضافية حتى 5 خيارات (A إلى E).' },
    { 'الحقل (Field)': 'الإجابة الصحيحة (Answer)', 'الشرط (Requirement)': 'إجباري (Required)', 'الوصف والتعليمات (Description)': 'يمكن كتابة حرف الخيار (A, B, C, D, E) أو باللغة العربية (أ، ب، ج، د، هـ) أو كتابة نص الخيار تماماً، أو (صح / خطأ / True / False).' },
    { 'الحقل (Field)': 'التفسير (Explanation)', 'الشرط (Requirement)': 'اختياري (Optional)', 'الوصف والتعليمات (Description)': 'تفسير أو تعليل الإجابة يظهر للطالب بعد إنهاء الاختبار للمراجعة.' },
    { 'الحقل (Field)': 'الصعوبة (Difficulty)', 'الشرط (Requirement)': 'اختياري (الافتراضي medium)', 'الوصف والتعليمات (Description)': 'اكتب: easy / medium / hard (أو: سهل / متوسط / صعب).' },
    { 'الحقل (Field)': 'الوسوم (Tags)', 'الشرط (Requirement)': 'اختياري (Optional)', 'الوصف والتعليمات (Description)': 'افصل بين الوسوم بفاصلة (مثال: وزاري, سنين_سابقة, سؤال_الدكتور, مهم, متوقع).' },
    { 'الحقل (Field)': 'نوع السؤال (Type)', 'الشرط (Requirement)': 'اختياري (الافتراضي mcq)', 'الوصف والتعليمات (Description)': 'اكتب mcq للاختيار من متعدد، أو true_false لأسئلة الصح والخطأ.' }
  ];

  const instructionsSheet = XLSX.utils.json_to_sheet(instructionsData);
  instructionsSheet['!cols'] = [
    { wch: 25 },
    { wch: 22 },
    { wch: 65 }
  ];
  XLSX.utils.book_append_sheet(wb, instructionsSheet, 'التعليمات (Instructions)');

  return wb;
}

/**
 * Initiates download of the question bank template in the browser
 */
export function downloadQuestionBankTemplate(filename: string = 'نموذج_بنك_الأسئلة_MyLecture.xlsx') {
  const wb = buildQuestionBankTemplateWorkbook();
  XLSX.writeFile(wb, filename);
}

/**
 * Parses raw ArrayBuffer / Uint8Array representing a spreadsheet into validated BankQuestion candidates
 */
export function parseQuestionBankBuffer(buffer: ArrayBuffer | Uint8Array, defaultDifficulty: Difficulty = 'medium'): ParseExcelResult {
  const wb = XLSX.read(buffer, { type: 'array' });
  const firstSheetName = wb.SheetNames[0];
  if (!firstSheetName) {
    return { questions: [], totalCount: 0, validCount: 0, invalidCount: 0 };
  }

  const sheet = wb.Sheets[firstSheetName];
  // Read as positional matrix with header: 1 to preserve empty cells accurately
  const matrix: any[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false
  });

  if (!matrix || matrix.length === 0) {
    return { questions: [], totalCount: 0, validCount: 0, invalidCount: 0 };
  }

  // Find header row (first non-empty row)
  let headerRowIndex = -1;
  for (let i = 0; i < matrix.length; i++) {
    const row = matrix[i];
    if (row && row.some((cell: any) => cell != null && String(cell).trim() !== '')) {
      headerRowIndex = i;
      break;
    }
  }

  if (headerRowIndex === -1) {
    return { questions: [], totalCount: 0, validCount: 0, invalidCount: 0 };
  }

  const headers = matrix[headerRowIndex].map(cleanKey);

  // Identify column indices
  let stemCol = -1;
  let choiceACol = -1;
  let choiceBCol = -1;
  let choiceCCol = -1;
  let choiceDCol = -1;
  let choiceECol = -1;
  let answerCol = -1;
  let explanationCol = -1;
  let difficultyCol = -1;
  let tagsCol = -1;
  let typeCol = -1;

  headers.forEach((h, idx) => {
    if (stemCol === -1 && matchAlias(h, STEM_ALIASES)) stemCol = idx;
    else if (choiceACol === -1 && matchAlias(h, CHOICE_A_ALIASES)) choiceACol = idx;
    else if (choiceBCol === -1 && matchAlias(h, CHOICE_B_ALIASES)) choiceBCol = idx;
    else if (choiceCCol === -1 && matchAlias(h, CHOICE_C_ALIASES)) choiceCCol = idx;
    else if (choiceDCol === -1 && matchAlias(h, CHOICE_D_ALIASES)) choiceDCol = idx;
    else if (choiceECol === -1 && matchAlias(h, CHOICE_E_ALIASES)) choiceECol = idx;
    else if (answerCol === -1 && matchAlias(h, ANSWER_ALIASES)) answerCol = idx;
    else if (explanationCol === -1 && matchAlias(h, EXPLANATION_ALIASES)) explanationCol = idx;
    else if (difficultyCol === -1 && matchAlias(h, DIFFICULTY_ALIASES)) difficultyCol = idx;
    else if (tagsCol === -1 && matchAlias(h, TAGS_ALIASES)) tagsCol = idx;
    else if (typeCol === -1 && matchAlias(h, TYPE_ALIASES)) typeCol = idx;
  });

  // Fallback: If no recognized stem header found, default to column 0 if row has > 2 columns
  if (stemCol === -1 && headers.length >= 3) {
    stemCol = 0;
    if (choiceACol === -1) choiceACol = 1;
    if (choiceBCol === -1) choiceBCol = 2;
    if (choiceCCol === -1 && headers.length > 3) choiceCCol = 3;
    if (choiceDCol === -1 && headers.length > 4) choiceDCol = 4;
    if (choiceECol === -1 && headers.length > 5) choiceECol = 5;
    if (answerCol === -1 && headers.length > 6) answerCol = 6;
  }

  const parsedQuestions: ParsedExcelQuestion[] = [];
  const rows = matrix.slice(headerRowIndex + 1);

  rows.forEach((row, rIdx) => {
    // Ignore completely empty rows
    const isRowEmpty = !row || row.every((c: any) => c == null || String(c).trim() === '');
    if (isRowEmpty) return;

    const rowNumber = headerRowIndex + 2 + rIdx;
    const errors: string[] = [];

    const rawStem = stemCol >= 0 && row[stemCol] != null ? String(row[stemCol]).trim() : '';
    const rawChoiceA = choiceACol >= 0 && row[choiceACol] != null ? String(row[choiceACol]).trim() : '';
    const rawChoiceB = choiceBCol >= 0 && row[choiceBCol] != null ? String(row[choiceBCol]).trim() : '';
    const rawChoiceC = choiceCCol >= 0 && row[choiceCCol] != null ? String(row[choiceCCol]).trim() : '';
    const rawChoiceD = choiceDCol >= 0 && row[choiceDCol] != null ? String(row[choiceDCol]).trim() : '';
    const rawChoiceE = choiceECol >= 0 && row[choiceECol] != null ? String(row[choiceECol]).trim() : '';
    const rawAnswer = answerCol >= 0 && row[answerCol] != null ? String(row[answerCol]).trim() : '';
    const rawExplanation = explanationCol >= 0 && row[explanationCol] != null ? String(row[explanationCol]).trim() : '';
    const rawDifficulty = difficultyCol >= 0 && row[difficultyCol] != null ? row[difficultyCol] : null;
    const rawTags = tagsCol >= 0 && row[tagsCol] != null ? row[tagsCol] : null;
    const rawType = typeCol >= 0 && row[typeCol] != null ? row[typeCol] : null;

    if (!rawStem) {
      errors.push('نص السؤال فارغ');
    }

    let detectedType = normalizeQuestionType(rawType);
    const difficulty = normalizeDifficulty(rawDifficulty, defaultDifficulty);
    const tags = parseTags(rawTags);

    // Build raw choices list
    const candidateChoices = [
      { label: 'A', text: rawChoiceA },
      { label: 'B', text: rawChoiceB },
      { label: 'C', text: rawChoiceC },
      { label: 'D', text: rawChoiceD },
      { label: 'E', text: rawChoiceE }
    ];

    let choices = candidateChoices
      .filter(c => c.text !== '')
      .map((c, i) => ({ label: String.fromCharCode(65 + i), text: c.text }));

    // Detect if this is a True / False question
    const isAnswerTrueFalse = /^(true|false|صح|خطأ|صواب)$/i.test(rawAnswer);
    if ((detectedType === 'true_false' || isAnswerTrueFalse) && choices.length === 0) {
      detectedType = 'true_false';
      choices = [
        { label: 'A', text: 'صح / True' },
        { label: 'B', text: 'خطأ / False' }
      ];
    }

    if (choices.length < 2) {
      errors.push('يجب توفر خيارين على الأقل (A و B)');
    }

    // Resolve Correct Answer
    let resolvedAnswer = '';
    const ansLower = rawAnswer.toLowerCase();
    const ansUpper = rawAnswer.toUpperCase();

    if (!rawAnswer) {
      errors.push('لم يتم تحديد الإجابة الصحيحة');
      resolvedAnswer = choices.length > 0 ? choices[0].text : '';
    } else {
      // 1. Try matching by letter (A, B, C, D, E)
      const letterMatchIndex = ['A', 'B', 'C', 'D', 'E'].indexOf(ansUpper);
      // Arabic letter matching (أ، ب، ج، د، هـ)
      const arLetterMatchIndex = ['أ', 'ب', 'ج', 'د', 'هـ', 'ه'].indexOf(rawAnswer);
      // Numeric matching ("1", "2", "3", "4", "5")
      const numMatch = parseInt(rawAnswer, 10);

      if (letterMatchIndex >= 0 && letterMatchIndex < choices.length) {
        resolvedAnswer = choices[letterMatchIndex].text;
      } else if (arLetterMatchIndex >= 0 && arLetterMatchIndex < choices.length) {
        resolvedAnswer = choices[arLetterMatchIndex].text;
      } else if (!isNaN(numMatch) && numMatch >= 1 && numMatch <= choices.length) {
        resolvedAnswer = choices[numMatch - 1].text;
      } else if (detectedType === 'true_false' || isAnswerTrueFalse) {
        if (/^(true|صح|صواب)$/i.test(rawAnswer)) {
          const trueChoice = choices.find(c => /^(صح|true)/i.test(c.text)) || choices[0];
          resolvedAnswer = trueChoice ? trueChoice.text : choices[0]?.text || '';
        } else if (/^(false|خطأ)$/i.test(rawAnswer)) {
          const falseChoice = choices.find(c => /^(خطأ|false)/i.test(c.text)) || choices[1];
          resolvedAnswer = falseChoice ? falseChoice.text : choices[1]?.text || '';
        }
      } else {
        // Match by exact text or prefix (e.g. "A. Aspirin" or "A) Aspirin")
        const exactMatch = choices.find(c => c.text.toLowerCase() === ansLower);
        if (exactMatch) {
          resolvedAnswer = exactMatch.text;
        } else {
          // Check prefix
          const prefixed = choices.find(c =>
            ansUpper.startsWith(`${c.label.toUpperCase()}.`) ||
            ansUpper.startsWith(`${c.label.toUpperCase()})`) ||
            ansUpper.startsWith(`${c.label.toUpperCase()}:`)
          );
          if (prefixed) {
            resolvedAnswer = prefixed.text;
          } else {
            // Check if choice starts with answer text or vice versa
            const partial = choices.find(c => c.text.toLowerCase().includes(ansLower) || ansLower.includes(c.text.toLowerCase()));
            if (partial) {
              resolvedAnswer = partial.text;
            } else {
              errors.push(`الإجابة "${rawAnswer}" لا تطابق أي خيار من الخيارات المتوفرة`);
              resolvedAnswer = choices.length > 0 ? choices[0].text : '';
            }
          }
        }
      }
    }

    const isValid = errors.length === 0;

    parsedQuestions.push({
      id: `excel_row_${rowNumber}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      rowNumber,
      stem: rawStem,
      choices,
      correctAnswer: resolvedAnswer,
      explanation: rawExplanation,
      difficulty,
      tags,
      type: detectedType,
      stemFormat: detectedType === 'true_false' ? 'true_false' : 'standard',
      isValid,
      errors
    });
  });

  const validCount = parsedQuestions.filter(q => q.isValid).length;
  const invalidCount = parsedQuestions.length - validCount;

  return {
    questions: parsedQuestions,
    totalCount: parsedQuestions.length,
    validCount,
    invalidCount
  };
}

/**
 * Convenience method for File instances
 */
export async function parseQuestionBankExcel(file: File, defaultDifficulty: Difficulty = 'medium'): Promise<ParseExcelResult> {
  const arrayBuffer = await file.arrayBuffer();
  return parseQuestionBankBuffer(arrayBuffer, defaultDifficulty);
}

