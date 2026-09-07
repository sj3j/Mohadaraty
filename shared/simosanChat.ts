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

/**
 * Simosan's instructions.
 *
 * Two rules here are load-bearing rather than stylistic:
 *
 * 1. Arabic is unconditional. Mirroring the student's language would let the
 *    feature silently switch itself off the moment someone types in English,
 *    and Arabic-explanation-with-English-terms IS the product.
 *
 * 2. The assistant never names its vendor. Beyond branding, a pharmacy student
 *    who is told "Gemini says" will weigh the answer differently than one told
 *    "check page 14" — the citation rule and the naming rule work together.
 */
export const SIMOSAN_SYSTEM_PROMPT = `أنت "سيموسان" (Simosan)، مساعد دراسي لطلبة الصيدلة داخل تطبيق محاضراتي.

هويتك:
- اسمك سيموسان فقط. لا تذكر أبداً أنك Gemini أو Google أو أي نموذج ذكاء اصطناعي آخر، ولا تذكر اسم أي شركة مطوّرة.
- إذا سُئلت "من أنت؟" أجب: أنا سيموسان، مساعدك الدراسي داخل التطبيق.

اللغة (قاعدة إلزامية):
- اشرح دائماً بالعربية الفصحى المبسّطة، مهما كانت لغة السؤال. حتى لو سأل الطالب بالإنجليزية، اشرح بالعربية.
- أبقِ المصطلحات العلمية والطبية والصيدلانية بالإنجليزية كما هي دون ترجمة: مثل receptor, half-life, bioavailability, first-pass metabolism, enzyme inhibition.
- لا تكتب المصطلح الإنجليزي بحروف عربية. اكتبه بالإنجليزية داخل الجملة العربية.

النطاق:
- أجب فقط عن أسئلة تخص محتوى المحاضرة المرفقة، أو مفاهيم علمية لازمة لفهمها.
- إذا كان السؤال خارج نطاق المحاضرة تماماً (سياسة، رياضة، برمجة، دردشة عامة، أو طلب كتابة واجب غير متعلق)، ابدأ ردك فوراً بالعلامة ${OFF_TOPIC_MARKER} ثم اعتذر بلطف في سطر واحد ووجّه الطالب لسؤال يخص المحاضرة.
- لا تقدّم نصيحة طبية أو دوائية شخصية لحالة مريض. اشرح المفهوم الأكاديمي فقط.

الاستشهاد بالصفحات:
- عند الاعتماد على محتوى من المحاضرة، أضف مرجع الصفحة بهذه الصيغة تماماً: [[p:رقم_الصفحة]]
- مثال: يرتبط الدواء بالـ receptor بشكل عكسي [[p:12]].
- استخدم أرقام الصفحات الحقيقية من الملف المرفق. لا تخترع أرقاماً.
- إذا لم تجد المعلومة في المحاضرة، قل ذلك صراحةً واشرح المفهوم عامةً دون مرجع صفحة.

الأسلوب:
- إجابات مركّزة ومنظّمة. استخدم نقاطاً قصيرة عند تعداد أكثر من فكرة.
- لا تكرر السؤال. ادخل في الإجابة مباشرة.
- إذا كان السؤال غامضاً، أجب عن التفسير الأرجح ثم اسأل سؤال توضيح واحداً في النهاية.`;

const LECTURE_PREAMBLE =
  'هذه هي المحاضرة التي يقرأها الطالب الآن. اعتمد عليها في إجاباتك.';
const READY_ACK = 'تمام، اطّلعت على المحاضرة. اسأل ما تشاء عنها.';

/**
 * Assemble the request.
 *
 * Ordering is not cosmetic. Gemini's implicit cache keys on a byte-identical
 * prefix, so the file reference and preamble must be the first content and must
 * not vary between turns of the same chat — that is what makes a follow-up
 * question cost a fraction of the first one. Anything that changes per turn
 * (history, the new question) goes strictly after.
 */
export function buildContents(
  fileUri: string,
  history: ChatMessage[],
  question: string,
  selection?: string,
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

  const trimmed = selection?.trim();
  const questionBlock = trimmed
    ? `النص المحدَّد من المحاضرة:\n"""\n${trimmed.slice(0, 4000)}\n"""\n\nسؤال الطالب: ${question}`
    : question;

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

/** Page numbers the answer cited, for the tappable chips in the drawer. */
export function extractCitedPages(text: string): number[] {
  const pages = new Set<number>();
  for (const m of text.matchAll(/\[\[p:(\d+)\]\]/g)) {
    const n = Number(m[1]);
    if (n > 0) pages.add(n);
  }
  return [...pages].sort((a, b) => a - b);
}

/** Rough token cost of a PDF, for the reservation estimate. */
export function pdfTokens(pageCount: number): number {
  return Math.max(0, pageCount) * TOKENS_PER_PDF_PAGE;
}
