import { db, FieldValue } from '../firebase.ts';
import { log, errFields } from '../log.ts';
import { telegram, TG_LIMITS } from '../telegram/api.ts';
import type { TgMessage } from '../telegram/types.ts';

export interface LectureDoc {
  id: string;
  title: string;
  subjectName?: string;
  subjectId?: string;
  stageId?: string;
  type?: 'theoretical' | 'practical';
  number?: number | null;
  pdfUrl?: string;
  youtubeUrl?: string | null;
  telegramPost?: {
    chatId: number;
    messageId: number;
    sentAt?: unknown;
  };
}

export function formatLectureCaption(lecture: LectureDoc): {
  caption: string;
  directUrl: string;
  replyMarkup: { inline_keyboard: Array<Array<{ text: string; url: string }>> };
} {
  const directUrl = `https://mohadaraty.vercel.app/?lecture=${lecture.id}`;
  const lines: string[] = [];

  // Lecture title
  lines.push(`📚 ${lecture.title || 'محاضرة جديدة'}`);

  // Subject
  if (lecture.subjectName) {
    lines.push(`📖 المادة: ${lecture.subjectName}`);
  }

  // Type and number
  const typeText = lecture.type === 'practical' ? 'عملي' : 'نظري';
  if (lecture.number) {
    lines.push(`🔖 النوع: ${typeText} · المحاضرة ${lecture.number}`);
  } else {
    lines.push(`🔖 النوع: ${typeText}`);
  }

  // Direct app link
  lines.push('');
  lines.push(`🔗 رابط المحاضرة في التطبيق:`);
  lines.push(directUrl);

  const caption = lines.join('\n');
  const replyMarkup = {
    inline_keyboard: [
      [
        { text: '📱 فتح في التطبيق', url: directUrl }
      ]
    ]
  };

  return { caption, directUrl, replyMarkup };
}

/**
 * Sends a lecture to a Telegram channel/group and records the post stamp on the lecture doc.
 */
export async function sendLectureToTelegram(lecture: LectureDoc, chatId: number): Promise<number> {
  const { caption, directUrl, replyMarkup } = formatLectureCaption(lecture);
  let messageId: number;

  if (lecture.pdfUrl) {
    try {
      const sent = await telegram.sendByUrl('sendDocument', {
        chat_id: chatId,
        document: lecture.pdfUrl,
        caption,
        reply_markup: JSON.stringify(replyMarkup),
      });
      messageId = sent.message_id;
    } catch (urlErr) {
      log.warn('tg.lecture.url_send_failed_fallback_multipart', {
        lectureId: lecture.id,
        chatId,
        ...errFields(urlErr),
      });

      // Fallback to downloading bytes and streaming as multipart
      const res = await fetch(lecture.pdfUrl);
      if (!res.ok) throw new Error(`Failed to download lecture PDF: ${res.statusText}`);
      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      if (buffer.length > TG_LIMITS.uploadBytes) {
        log.warn('tg.lecture.oversize', { lectureId: lecture.id, size: buffer.length });
        const textMsg = `${caption}\n\n⚠️ حجم الملف (${(buffer.length / (1024 * 1024)).toFixed(1)} MB) يتجاوز حد تيليجرام (50MB). يمكنك عرضه مباشرة من التطبيق.`;
        const sent = await telegram.sendMessage({
          chat_id: chatId,
          text: textMsg,
          link_preview_options: { url: directUrl },
        });
        messageId = sent.message_id;
      } else {
        const form = new FormData();
        form.append('chat_id', String(chatId));
        form.append('caption', caption);
        form.append('reply_markup', JSON.stringify(replyMarkup));
        const blob = new Blob([buffer], { type: 'application/pdf' });
        const safeTitle = (lecture.title || 'lecture').replace(/[^a-zA-Z0-9\u0600-\u06FF.\-_]/g, '_');
        form.append('document', blob, `${safeTitle}.pdf`);

        const sent = await telegram.sendMultipart('sendDocument', form) as TgMessage;
        messageId = sent.message_id;
      }
    }
  } else {
    // No PDF (e.g. YouTube video only)
    const text = lecture.youtubeUrl ? `${caption}\n\n🎥 رابط يوتيوب: ${lecture.youtubeUrl}` : caption;
    const sent = await telegram.sendMessage({
      chat_id: chatId,
      text,
      link_preview_options: { url: lecture.youtubeUrl || directUrl },
    });
    messageId = sent.message_id;
  }

  // Stamp lecture in Firestore to guarantee idempotency
  await db.collection('lectures').doc(lecture.id).update({
    'telegramPost.chatId': chatId,
    'telegramPost.messageId': messageId,
    'telegramPost.sentAt': FieldValue.serverTimestamp(),
  });

  log.info('tg.lecture.sent', { lectureId: lecture.id, chatId, messageId });
  return messageId;
}

