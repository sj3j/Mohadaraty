# Question Bank Excel Import & Upload Enhancement Design

## Intent & The Why
Staff and faculty representatives frequently manage exam questions in Excel spreadsheets (`.xlsx`). Currently, `AdminQuestionBankScreen` only supports manual 1-by-1 addition (`AddBankQuestionModal`) or AI extraction from scanned PDFs (`UploadPDFModal`). The "استيراد من Excel" button was a stub.

This feature adds a production-grade, resilient, bilingual Excel importer with a downloadable preformatted template, interactive validation table, and high-performance batched saving.

## Goals
1. **Excel Support**: Accept `.xlsx`, `.xls`, `.csv` files containing MCQs (2 to 5 options) and True/False questions.
2. **Template Download**: 1-click download of a standard `.xlsx` template pre-filled with column headers, data formats, and examples in Arabic and English.
3. **Flexible Column Parser**: Automatically detect Arabic (`السؤال`, `الخيار A`, `الإجابة الصحيحة`, ...) and English (`Question`, `Choice A`, `Correct Answer`, ...) column headers.
4. **Intelligent Answer Mapping**: Resolve correct answers specified by letter (A-E, أ-هـ), index (1-5), True/False keywords, or exact text.
5. **Interactive Review Table**: Review parsed questions, flag validation errors (e.g. missing question stem, choices < 2, answer not matching any choice), enable inline quick edits and one-click removal of invalid rows.
6. **Batched Persistence**: Migrate question bank saving from slow sequential `addDoc` to batched writes (`writeBatch`), providing real-time progress indicators for both Excel import and PDF AI import.

## Non-Goals
- Generating questions using AI during Excel import (the Excel file already contains the exact questions).
- Multi-subject cross-import in a single file (the batch is scoped by the UI selector to ensure stage/subject integrity).

## Approaches Considered
- **Approach 1 (Selected): Dedicated Service + Interactive Validation Table + Shared Batch Engine**:
  Decoupled parser in `questionBankExcelService.ts`, rich preview grid in `UploadExcelModal.tsx`, shared `batchAddBankQuestions` in `questionBankService.ts`. Highest performance and reliability.
- **Approach 2: Simple Accordion Clone**:
  Reusing the vertical accordion of `UploadPDFModal` without tabular view or `writeBatch`. Rejected due to poor ergonomics on large sheets (>50 questions) and slow network roundtrips.

## Architecture & Data Flow

```
[User Spreadsheet (.xlsx)] 
         │
         ▼
[questionBankExcelService: parseQuestionBankExcel]
         │ (Maps columns, resolves answers, flags invalid rows)
         ▼
[UploadExcelModal: Review Stage] 
  - Filter: All / Valid / Errors
  - Quick inline edit
  - Delete invalid rows
         │
         ▼ (User clicks "حفظ الأسئلة")
[questionBankService: batchAddBankQuestions]
         │ (Batches of 400 docs via Firestore writeBatch)
         ▼
[Firestore collection: questionBank]
```

## Schema & Column Aliases
| Target Field | Arabic Aliases | English Aliases | Required |
|---|---|---|---|
| `stem` | السؤال, نص السؤال, السؤال أو الفقرة | Question, Stem, Question Text | Yes |
| `choiceA` | الخيار A, الخيار أ, أ, A, الاختيار 1 | Choice A, Option A, Choice 1 | Yes (MCQ) |
| `choiceB` | الخيار B, الخيار ب, ب, B, الاختيار 2 | Choice B, Option B, Choice 2 | Yes (MCQ) |
| `choiceC` | الخيار C, الخيار ج, ج, C, الاختيار 3 | Choice C, Option C, Choice 3 | No |
| `choiceD` | الخيار D, الخيار د, د, D, الاختيار 4 | Choice D, Option D, Choice 4 | No |
| `choiceE` | الخيار E, الخيار هـ, هـ, E, الاختيار 5 | Choice E, Option E, Choice 5 | No |
| `correctAnswer` | الإجابة الصحيحة, الإجابة, الحل, الجواب | Correct Answer, Answer, Key | Yes |
| `explanation` | التفسير, الشرح, التوضيح | Explanation, Rationale, Note | No |
| `difficulty` | الصعوبة, مستوى الصعوبة | Difficulty, Level | No (default: medium) |
| `tags` | الوسوم, التصنيف, التاجات | Tags, Categories | No |
| `type` | نوع السؤال | Type, Question Type | No (default: auto) |
