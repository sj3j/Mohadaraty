/**
 * Simosan's Gemini layer: the Files API cache, the prompt contract, and the
 * streaming call.
 *
 * Split from shared/simosan.ts so the budget arithmetic stays free of any
 * network dependency and can be unit-tested against the emulator alone.
 *
 * The model is never named to the student. Every user-facing string in this
 * file and its callers says "Simosan" / "سيموسان" — see the docblock on
 * SIMOSAN_SYSTEM_PROMPT for why that matters beyond branding.
 */
import { GoogleGenAI } from '@google/genai';
import {
  FILE_REFRESH_MS,
  MAX_PDF_BYTES,
  MAX_PDF_PAGES,
  TOKENS_PER_PDF_PAGE,
  type GeminiUsage,
} from './simosan.js';

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
}

export interface LectureFile {
  fileUri: string;
  pageCount: number;
}

export class SimosanError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/* ------------------------------------------------------------------ *
 * Page counting
 * ------------------------------------------------------------------ */

/**
 * Approximate a PDF's page count from its bytes.
 *
 * Used only to size the energy reservation, which is reconciled against real
 * usage afterwards — so the requirement is "never materially under-count",
 * not "exact". Both strategies below miss on PDFs that hide their page tree in
 * a compressed object stream, hence the deliberately generous byte-size
 * fallback: over-reserving is refunded, under-reserving overruns the budget.
 */
export function estimatePageCount(buf: Buffer): number {
  const text = buf.toString('latin1');

  // The page tree root carries the authoritative total.
  let best = 0;
  for (const m of text.matchAll(/\/Count\s+(\d+)/g)) {
    const n = Number(m[1]);
    if (n > best && n <= MAX_PDF_PAGES) best = n;
  }

  // Individual page objects. `[^s]` so /Pages (the tree node) is not counted.
  const objects = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
  best = Math.max(best, objects);

  if (best > 0) return best;
  // ~40KB/page is dense for a slide deck, so this rounds up rather than down.
  return Math.max(1, Math.ceil(buf.length / 40_000));
}

/* ------------------------------------------------------------------ *
 * Files API cache
 * ------------------------------------------------------------------ */

/**
 * Resolve a lecture to a Gemini file URI, uploading it once if needed.
 *
 * Uploads and storage are free and entries live 48h, so one upload is shared by
 * every student reading that lecture. The alternative — inlining the PDF as
 * base64 on every turn — would re-transfer several MB per question and, on
 * Vercel Hobby, spend most of the function's time budget before the model
 * produced a single token.
 *
 * Refreshed at 44h rather than 48 so a long-running request cannot race the
 * expiry it was validated against.
 */
export async function ensureLectureFile(
  ai: GoogleGenAI,
  db: FirebaseFirestore.Firestore,
  FieldValue: { serverTimestamp(): any },
  lectureId: string,
  pdfUrl: string,
): Promise<LectureFile> {
  const ref = db.collection('aiFiles').doc(lectureId);
  const snap = await ref.get();
  const cached = snap.exists ? snap.data() : null;

  if (cached?.fileUri && cached?.uploadedAtMs) {
    const age = Date.now() - Number(cached.uploadedAtMs);
    if (age < FILE_REFRESH_MS) {
      return { fileUri: cached.fileUri, pageCount: Number(cached.pageCount) || 1 };
    }
  }

  const res = await fetch(pdfUrl);
  if (!res.ok) {
    throw new SimosanError('pdf_unreachable', `PDF fetch failed: ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());

  if (buf.length > MAX_PDF_BYTES) {
    throw new SimosanError('pdf_too_large', `PDF is ${buf.length} bytes`);
  }
  const pageCount = estimatePageCount(buf);
  if (pageCount > MAX_PDF_PAGES) {
    throw new SimosanError('pdf_too_many_pages', `PDF has ~${pageCount} pages`);
  }

  const uploaded = await ai.files.upload({
    file: new Blob([buf], { type: 'application/pdf' }),
    config: { mimeType: 'application/pdf', displayName: `lecture-${lectureId}` },
  });

  // A freshly uploaded file is PROCESSING until Gemini has parsed it; a
  // generateContent referencing it before then fails outright.
  let file = uploaded;
  const deadline = Date.now() + 30_000;
  while (file.state === 'PROCESSING' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 700));
    file = await ai.files.get({ name: file.name as string });
  }
  if (file.state !== 'ACTIVE') {
    throw new SimosanError('pdf_processing_failed', `File state: ${file.state}`);
  }
  // The SDK types `uri` as optional. Firestore rejects undefined outright and
  // this project does not set ignoreUndefinedProperties, so an absent uri would
  // surface as a raw "Unsupported field value: undefined" - the exact failure
  // mode that took MCQ generation down. Fail with a code the route can map.
  if (!file.uri) {
    throw new SimosanError('pdf_processing_failed', 'Gemini returned no file URI');
  }

  await ref.set(
    {
      lectureId,
      fileUri: file.uri,
      pageCount,
      bytes: buf.length,
      uploadedAtMs: Date.now(),
      uploadedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return { fileUri: file.uri, pageCount };
}

/* ------------------------------------------------------------------ *
 * Prompt
 * ------------------------------------------------------------------ */

/** Emitted by the model as the first token when it declines a question. The
 *  route strips it and refunds the student rather than charging for a refusal. */
export const OFF_TOPIC_MARKER = '[[OFF_TOPIC]]';

/** Marks a walkthrough request, so chunking is deterministic rather than
 *  inferred. Sent by the drawer's "اشرح المحاضرة بأجزاء" button. */
export const WALKTHROUGH_MARKER = '[[WALKTHROUGH]]';

/**
 * Simosan's instructions.
 *
 * A senior-professor persona layered OVER two mechanisms the system depends on.
 * Neither may be dropped while refactoring the tone:
 *
 * 1. `[[OFF_TOPIC]]` gates the energy refund and the free-refusal cap. Remove
 *    it and every refusal bills as a full answer.
 * 2. `[[p:N]]` is parsed by extractCitedPages into tappable chips that jump the
 *    reader. It matters more, not less, under a persona this authoritative:
 *    it is the only way a student can check a drug claim against the slide.
 *
 * Arabic is unconditional. Mirroring the student's language would switch the
 * feature off the moment someone types in English, and Arabic-explanation-with-
 * English-terms IS the product.
 *
 * DELIBERATELY IMPERSONAL. The student's name and the subject are NOT here -
 * they arrive in the final user turn instead. Gemini's implicit cache keys on a
 * byte-identical prefix, and the system instruction sits in that prefix, so a
 * name here would give every student a different prefix and destroy the sharing
 * that makes a follow-up cost half of a first question.
 */
export const SIMOSAN_SYSTEM_PROMPT = `أنت "سيموسان" (Simosan)، أستاذ جامعي رفيع المستوى وخبير سريري، تشرح لطلبة الصيدلة داخل تطبيق محاضراتي.

هويتك:
- اسمك سيموسان فقط. لا تذكر أبداً أنك Gemini أو Google أو أي نموذج ذكاء اصطناعي، ولا تذكر اسم أي شركة مطوّرة.
- إذا سُئلت "من أنت؟" أجب: أنا سيموسان، مساعدك الدراسي داخل التطبيق.

الأسلوب والمخاطبة:
- خاطب الطالب كطبيب/صيدلي المستقبل، واستخدم اسمه عند توفره في سياق الرسالة (مثال: "أهلاً بك يا دكتور أحمد").
- كن مشجّعاً بعقلانية ومهنية، احترافياً ودقيقاً. لا تتجاوز أي تفصيل علمي مهم مهما كان صغيراً — مستقبل الطالب السريري يعتمد على فهمه الدقيق.
- لا تكرر السؤال. ادخل في الإجابة مباشرة.
- إذا كان السؤال غامضاً، أجب عن التفسير الأرجح ثم اسأل سؤال توضيح واحداً في النهاية.

اللغة (قاعدة إلزامية):
- اشرح دائماً بالعربية الفصحى المبسّطة، مهما كانت لغة السؤال. حتى لو سأل الطالب بالإنجليزية، اشرح بالعربية.
- أبقِ المصطلح الإنجليزي، اسم المرض، اسم الدواء، أو الجملة المفتاحية كما هي تماماً من المحاضرة: receptor, half-life, bioavailability, first-pass metabolism, enzyme inhibition.
- ضع التوضيح العربي بجانب المصطلح مباشرة، شرحاً للمعنى الطبي والسريري لا ترجمة حرفية.
- لا تكتب المصطلح الإنجليزي بحروف عربية. اكتبه بالإنجليزية داخل الجملة العربية.

التوجيه الامتحاني:
- الطالب يستعد لامتحان فيه أسئلة اختيار متعدد (MCQ) وأسئلة مقالية قصيرة (SA).
- اربط التفاصيل الدقيقة (الأرقام، الـ receptors، الآليات، الـ side effects) بأسئلة MCQ، وضع بعدها: (نقطة هامة لأسئلة MCQ).
- اربط المقارنات (دواء مقابل دواء، مرض مقابل مرض، الجداول والتصنيفات) والخطوات المتسلسلة بأسئلة SA، وضع بعدها: (سؤال SA مضمون).
- أضف لمسة سريرية موجزة (Clinical Pearl) عندما تساعد على ربط المعلومة وتذكّرها في المستشفى أو الصيدلية.

التقطيع (يُطبَّق فقط عند طلب شرح المحاضرة كاملة):
- إذا بدأت رسالة الطالب بالعلامة ${WALKTHROUGH_MARKER}، أو طلب صراحةً شرح المحاضرة كلها: قسّمها إلى أجزاء منطقية (٣ أو ٤)، اشرح الجزء الأول فقط بتفاصيله، ثم اختم بسؤال: (هل أنت مستعد للانتقال إلى الجزء التالي المتعلق بـ ...؟) ولا تكمل حتى يأذن الطالب.
- أما السؤال المحدد (مثل "ما هو الـ half-life؟") فأجب عنه مباشرة في رسالة واحدة. لا تقسّمه ولا تطلب إذناً.

التنسيق (Markdown):
- استخدم العناوين (##) لتنظيم الأفكار، والنقاط للقوائم.
- استخدم **الخط العريض** للمصطلحات الإنجليزية المفتاحية التي تبحث عنها عين المصحح.
- استخدم جداول Markdown للمقارنات بين دواءين أو أكثر، أو بين تصنيفات.

النطاق:
- أجب فقط عن أسئلة تخص محتوى المحاضرة المرفقة، أو مفاهيم علمية لازمة لفهمها.
- إذا كان السؤال خارج نطاق المحاضرة تماماً (سياسة، رياضة، برمجة، دردشة عامة، أو طلب واجب غير متعلق)، ابدأ ردك فوراً بالعلامة ${OFF_TOPIC_MARKER} ثم اعتذر بلطف في سطر واحد ووجّه الطالب لسؤال يخص المحاضرة.
- لا تقدّم نصيحة طبية أو دوائية شخصية لحالة مريض. اشرح المفهوم الأكاديمي فقط.

الاستشهاد بالصفحات (إلزامي):
- عند الاعتماد على محتوى من المحاضرة، أضف مرجع الصفحة بهذه الصيغة تماماً: [[p:رقم_الصفحة]]
- مثال: يرتبط الدواء بالـ receptor بشكل عكسي [[p:12]].
- ضع رقم صفحة واحداً فقط داخل كل علامة. إذا كانت المعلومة في أكثر من صفحة، كرّر العلامة: [[p:7]] [[p:8]] ولا تكتب [[p:7, 8]].
- استخدم أرقام الصفحات الحقيقية من الملف المرفق. لا تخترع أرقاماً.
- إذا لم تجد المعلومة في المحاضرة، قل ذلك صراحةً واشرح المفهوم عامةً دون مرجع صفحة.`;

const LECTURE_PREAMBLE =
  'هذه هي المحاضرة التي يقرأها الطالب الآن. اعتمد عليها في إجاباتك.';
const READY_ACK = 'تمام، اطّلعت على المحاضرة. اسأل ما تشاء عنها.';

/** Quoted selection wrapper. Kept as a function so the triple-quote fence
 *  stays out of the surrounding template literals. */
const SELECTION_TEMPLATE = (sel: string, question: string) =>
  `النص المحدَّد من المحاضرة:
"""
${sel.slice(0, 4000)}
"""

سؤال الطالب: ${question}`;

/**
 * Assemble the request.
 *
 * Ordering is not cosmetic. Gemini's implicit cache keys on a byte-identical
 * prefix, so the file reference and preamble must be the first content and must
 * not vary between turns of the same chat — that is what makes a follow-up
 * question cost a fraction of the first one. Anything that changes per turn
 * (history, the new question) goes strictly after.
 */
export interface TurnContext {
  /** First name only. See the note below on why it is not in the prefix. */
  studentName?: string;
  subjectName?: string;
  /** True when the student pressed the walkthrough button. */
  walkthrough?: boolean;
}

export function buildContents(
  fileUri: string,
  history: ChatMessage[],
  question: string,
  selection?: string,
  ctx: TurnContext = {},
): any[] {
  const contents: any[] = [
    {
      role: 'user',
      parts: [
        { fileData: { fileUri, mimeType: 'application/pdf' } },
        { text: LECTURE_PREAMBLE },
      ],
    },
    { role: 'model', parts: [{ text: READY_ACK }] },
  ];

  for (const m of history) {
    contents.push({ role: m.role, parts: [{ text: m.text }] });
  }

  /*
   * Per-student context rides on the FINAL turn, never the prefix.
   *
   * The student's name and the subject would otherwise sit inside the cached
   * span, giving every student a different prefix for the same lecture and
   * throwing away the cross-student sharing on a ~20,000-token PDF. Down here
   * they cost a handful of tokens and change nothing that is cached.
   */
  const header: string[] = [];
  if (ctx.subjectName) header.push(`المادة: ${ctx.subjectName}`);
  if (ctx.studentName) header.push(`اسم الطالب: ${ctx.studentName}`);

  const trimmed = selection?.trim();
  const body = trimmed ? SELECTION_TEMPLATE(trimmed, question) : question;

  const questionBlock = [
    ctx.walkthrough ? WALKTHROUGH_MARKER : '',
    header.length ? `(${header.join(' — ')})` : '',
    body,
  ].filter(Boolean).join('\n');

  contents.push({ role: 'user', parts: [{ text: questionBlock }] });
  return contents;
}

/* ------------------------------------------------------------------ *
 * Streaming
 * ------------------------------------------------------------------ */

export interface StreamResult {
  usage: GeminiUsage | null;
  offTopic: boolean;
}

/**
 * Stream an answer, invoking `onDelta` for each text chunk.
 *
 * The off-topic marker is detected and stripped from the first chunks so the
 * student never sees it, while the caller still learns the request was declined
 * and can refund accordingly.
 */
export async function streamAnswer(
  ai: GoogleGenAI,
  model: string,
  contents: any[],
  onDelta: (text: string) => void,
): Promise<StreamResult> {
  const stream = await ai.models.generateContentStream({
    model,
    contents,
    config: { systemInstruction: SIMOSAN_SYSTEM_PROMPT },
  });

  let usage: GeminiUsage | null = null;
  let offTopic = false;
  // The marker can be split across chunks, so hold back until we have enough
  // characters to decide rather than leaking a partial "[[OFF_" to the client.
  let head = '';
  let headSettled = false;

  for await (const chunk of stream as any) {
    if (chunk?.usageMetadata) usage = chunk.usageMetadata;
    const text: string = chunk?.text ?? '';
    if (!text) continue;

    if (!headSettled) {
      head += text;
      if (head.length < OFF_TOPIC_MARKER.length) continue;
      headSettled = true;
      if (head.startsWith(OFF_TOPIC_MARKER)) {
        offTopic = true;
        head = head.slice(OFF_TOPIC_MARKER.length);
      }
      if (head) onDelta(head);
      continue;
    }
    onDelta(text);
  }

  // A reply shorter than the marker never settled the head above.
  if (!headSettled && head) {
    if (head.startsWith(OFF_TOPIC_MARKER)) {
      offTopic = true;
      head = head.slice(OFF_TOPIC_MARKER.length);
    }
    if (head) onDelta(head);
  }

  return { usage, offTopic };
}

/**
 * Matches a citation marker, tolerating a LIST of pages.
 *
 * The prompt asks for one page per marker, but a live answer came back with
 * `[[p:7, 8]]` when a comparison row cited two slides at once. A single-number
 * regex silently fails to match that, so the marker survives into the rendered
 * text and the student reads raw `[[p:7, 8]]`. Accepting the list is cheaper
 * than trusting the model to never do it again.
 */
export const CITATION_RE = /\[\[p:\s*(\d+(?:\s*,\s*\d+)*)\s*\]\]/g;

/** Page numbers cited anywhere in an answer, de-duplicated and ordered. */
export function extractCitedPages(text: string): number[] {
  const pages = new Set<number>();
  for (const m of text.matchAll(CITATION_RE)) {
    for (const part of m[1].split(',')) {
      const n = Number(part.trim());
      if (n > 0) pages.add(n);
    }
  }
  return [...pages].sort((a, b) => a - b);
}

/** Rough token cost of a PDF, for the reservation estimate. */
export function pdfTokens(pageCount: number): number {
  return Math.max(0, pageCount) * TOKENS_PER_PDF_PAGE;
}
