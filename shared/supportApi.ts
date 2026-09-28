import type { Request, Response } from 'express';

export interface SupportTicketInput {
  name: string;
  email: string;
  category: string;
  message: string;
}

export const SUPPORT_CATEGORIES = [
  'subscription',
  'account',
  'sync',
  'errata',
  'general',
] as const;

export const CATEGORY_LABELS_AR: Record<string, string> = {
  subscription: 'الاشتراكات واستعادة المشتريات',
  account: 'الحساب وتسجيل الدخول',
  sync: 'المزامنة والوصول دون إنترنت',
  errata: 'تصحيح علمي وملاحظات الأسئلة',
  general: 'استفسار عام',
};

export const CATEGORY_LABELS_EN: Record<string, string> = {
  subscription: 'Subscriptions & In-App Purchases',
  account: 'Account & Sign In',
  sync: 'Offline Access & Sync',
  errata: 'Scientific Correction',
  general: 'General Inquiry',
};

export function createSupportHandlers({ admin }: { admin: any }) {
  const submitTicket = async (req: Request, res: Response) => {
    try {
      const { name, email, category, message } = req.body || {};

      const trimmedName = (typeof name === 'string' ? name : '').trim();
      if (!trimmedName || trimmedName.length < 2) {
        return res.status(400).json({ error: 'الاسم الكامل مطلوب (حرفين على الأقل)' });
      }

      const trimmedEmail = (typeof email === 'string' ? email : '').trim().toLowerCase();
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!trimmedEmail || !emailRegex.test(trimmedEmail)) {
        return res.status(400).json({ error: 'البريد الإلكتروني غير صحيح' });
      }

      const validCategory = (SUPPORT_CATEGORIES as readonly string[]).includes(category)
        ? category
        : 'general';

      const trimmedMessage = (typeof message === 'string' ? message : '').trim();
      if (!trimmedMessage || trimmedMessage.length < 10) {
        return res.status(400).json({ error: 'تفاصيل الرسالة مطلوبة (10 أحرف على الأقل)' });
      }
      if (trimmedMessage.length > 2000) {
        return res.status(400).json({ error: 'الرسالة طويلة جداً (الحد الأقصى 2000 حرف)' });
      }

      const ticketNumber = Math.floor(100000 + Math.random() * 900000);
      const ticketId = `MHD-${ticketNumber}`;
      const db = admin.firestore();
      const serverTimestamp = admin.firestore.FieldValue.serverTimestamp();

      // 1. Store ticket in support_tickets collection
      await db.collection('support_tickets').doc(ticketId).set({
        ticketId,
        name: trimmedName,
        email: trimmedEmail,
        category: validCategory,
        categoryLabel: CATEGORY_LABELS_AR[validCategory] || validCategory,
        categoryLabelEn: CATEGORY_LABELS_EN[validCategory] || validCategory,
        message: trimmedMessage,
        status: 'open',
        createdAt: serverTimestamp,
        source: 'support_page',
        ip: req.ip || req.headers['x-forwarded-for'] || null,
      });

      // 2. Dispatch alert to adminAlerts for staff inbox
      const categoryLabel = CATEGORY_LABELS_AR[validCategory] || validCategory;
      await db.collection('adminAlerts').add({
        type: 'support_ticket',
        ticketId,
        reportedByName: trimmedName,
        reportedBy: trimmedEmail,
        email: trimmedEmail,
        category: validCategory,
        categoryLabel,
        reason: `[دعم: ${categoryLabel}] ${trimmedMessage.slice(0, 120)}`,
        fullMessage: trimmedMessage,
        replied: false,
        createdAt: serverTimestamp,
      });

      return res.json({
        success: true,
        ticketId,
        message: 'تم استلام استفسارك بنجاح',
      });
    } catch (err: any) {
      console.error('submitTicket error:', err);
      return res.status(500).json({ error: 'حدث خطأ أثناء معالجة الطلب' });
    }
  };

  return { submitTicket };
}
