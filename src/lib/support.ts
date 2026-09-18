// The help content students see when they cannot get in, and the accounts that
// answer when it does not help.
//
// Plain data, no JSX, because it is read from three places that render it
// differently: the Settings sub-page, the login screen and the signup screen.
// Two of those render BEFORE the auth gate, so nothing here may touch
// Firestore, contexts or TRANSLATIONS - the same self-contained rule the legal
// pages follow.
import type { LucideIcon } from 'lucide-react';
import { KeyRound, LogIn, MessageCircle, Send } from 'lucide-react';

/** A string in both app languages. Mirrors how the settings tree writes copy. */
export interface Bilingual {
  ar: string;
  en: string;
}

export interface FaqItem {
  id: string;
  icon: LucideIcon;
  /** Glyph colour and the tint of the plate behind it, written out in full so
   *  Tailwind sees literals. Same convention as `settingsIcons`. */
  className: string;
  tile: string;
  question: Bilingual;
  answer: Bilingual;
}

export const FAQ_ITEMS: FaqItem[] = [
  {
    id: 'credentials',
    icon: KeyRound,
    className: 'text-sky-500',
    tile: 'bg-sky-100 dark:bg-sky-900/30',
    question: {
      ar: 'منين أجيب حسابي وكلمة السر؟',
      en: 'Where do I get my account and password?',
    },
    answer: {
      ar: 'حسابك هو نفسه حسابك القديم في محاضراتي. إذا ما عندك حساب أو نسيت كلمة السر، راسل ممثل مرحلتك.',
      en: 'It is the same account you already had on MyLecture. If you do not have one, or you forgot the password, message your stage representative.',
    },
  },
  {
    id: 'cannot-sign-in',
    icon: LogIn,
    className: 'text-amber-500',
    tile: 'bg-amber-100 dark:bg-amber-900/30',
    question: {
      ar: 'الرمز أو الإيميل ما يسجّل دخول',
      en: 'My code or email will not sign in',
    },
    answer: {
      ar: 'تأكد أن الإيميل هو الإيميل الجامعي، وأن كلمة المرور هي كلمة مرور محاضراتي وليست كلمة مرور تطبيق Hepiq.',
      en: 'Check that the email is your university email, and that the password is your MyLecture password — not your Hepiq app password.',
    },
  },
];

export interface SupportChannel {
  id: string;
  icon: LucideIcon;
  className: string;
  tile: string;
  label: Bilingual;
  sublabel: Bilingual;
  url: string;
}

/** Where "anything else" goes. Both open in the platform browser, which is what
 *  hands the link off to the installed app when there is one. */
export const SUPPORT_CHANNELS: SupportChannel[] = [
  {
    id: 'telegram',
    icon: Send,
    className: 'text-cyan-500',
    tile: 'bg-cyan-100 dark:bg-cyan-900/30',
    label: { ar: 'تيليجرام', en: 'Telegram' },
    sublabel: { ar: '@Varmacybot', en: '@Varmacybot' },
    url: 'https://t.me/Varmacybot',
  },
  {
    id: 'whatsapp',
    icon: MessageCircle,
    className: 'text-emerald-500',
    tile: 'bg-emerald-100 dark:bg-emerald-900/30',
    label: { ar: 'واتساب', en: 'WhatsApp' },
    sublabel: { ar: 'راسلنا على واتساب', en: 'Message us on WhatsApp' },
    url: 'https://wa.me/message/SD5YU5TP3QXXD1',
  },
];

export const SUPPORT_PROMPT: Bilingual = {
  ar: 'لأي مشاكل أخرى راسلوا حسابات الدعم',
  en: 'For anything else, message the support accounts',
};

export const FAQ_TITLE: Bilingual = {
  ar: 'الأسئلة الشائعة',
  en: 'FAQ',
};

export const FAQ_SUBTITLE: Bilingual = {
  ar: 'الحساب وتسجيل الدخول والدعم',
  en: 'Account, sign-in and support',
};
