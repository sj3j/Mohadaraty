/**
 * The manual payment channel: Super Qi / Qi Card.
 *
 * Two facts about this flow drove every decision in this file.
 *
 * **Nothing about it is automatic.** ZainCash settles itself - the gateway
 * calls back, `shared/subscriptions.ts` inquires and activates. A Super Qi
 * transfer lands in a wallet nobody here can query, so the only thing the app
 * can do is (a) tell the student where to send the money and how to reach a
 * human, and (b) collect enough evidence for that human to recognise the
 * transfer in their own wallet history. The screen used to do neither: it
 * printed the literal placeholder `07XXXXXXXXX` and demanded a transaction id
 * with no way to ask anyone what that meant.
 *
 * **Both halves are "one of these, not all of them".**
 *   - Contact: WhatsApp OR Telegram. One reachable channel is enough; a seller
 *     who only uses Telegram should not have to invent a WhatsApp number, and a
 *     row of dead buttons is worse than one live one.
 *   - Proof: a receipt SCREENSHOT or the transaction number. Super Qi shows a
 *     reference on the success screen, but a student who has already dismissed
 *     it can still screenshot the transfer in their history - and a screenshot
 *     is what most of them send anyway. Requiring the number outright is what
 *     made the form unfinishable. `isProofSufficient()` is the rule, and
 *     `npm run test:payments` pins it.
 *
 * Pure by design - no firebase imports - so both are testable without an
 * emulator, and so the module can be read as the contract the UI implements.
 *
 * NOT IN THE NATIVE BUNDLE. Its only importers are SubscriptionScreen,
 * SubscriptionManagement and subscriptionService, all of which vite.config.ts
 * replaces or orphans for `mode === 'native'`. It carries no gateway name and
 * no currency code, so `npm run check:payment-surface` would not catch it if
 * that ever changed - keep it imported only from the purchase surface.
 */

/**
 * Where the seller's own details live, edited in-app from Subscription
 * Management. Deliberately Firestore rather than a `VITE_` build variable: the
 * number that receives the money is the single most likely thing to change, and
 * a rebuild + redeploy is not an acceptable cost for changing a phone number.
 * `settings/*` is already `read: if isAuthenticated()` / `write: if isAdmin()`
 * in firestore.rules, which is exactly the audience this needs.
 */
export const PAYMENT_CONTACT_COLLECTION = 'settings';
export const PAYMENT_CONTACT_DOC = 'payment_contact';

/** Iraq. The app is single-country: ar-IQ dates, IQD prices, Baghdad resets. */
const DEFAULT_COUNTRY_CODE = '964';

export interface PaymentContact {
  /** Super Qi / Qi Card account the transfer goes to. Display only. */
  walletNumber: string;
  /** Digits only, international, no `+` or `00`: `9647801234567`. */
  whatsapp: string;
  /** Telegram username WITHOUT the leading `@`. */
  telegram: string;
  /** Optional free line under the number ("اسم الحساب: ..."). */
  note: string;
}

export const EMPTY_PAYMENT_CONTACT: PaymentContact = {
  walletNumber: '',
  whatsapp: '',
  telegram: '',
  note: '',
};

const collapse = (raw: unknown, max: number): string =>
  typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/**
 * A wallet number as the student should read it.
 *
 * Kept as text rather than parsed: a Super Qi account may be quoted as a phone
 * number (07xx xxx xxxx) or as a 16-digit Qi card number, and the seller's own
 * grouping is the version the student will compare against their app.
 */
export const normalizeWalletNumber = (raw: unknown): string =>
  collapse(raw, 32).replace(/[^\d+\-\s]/g, '').replace(/\s+/g, ' ').trim();

/**
 * A WhatsApp number in the form wa.me needs: digits only, country code first.
 *
 * wa.me silently opens a "phone number is invalid" page for a local number, so
 * `07801234567` typed by the seller has to become `9647801234567` here rather
 * than being handed to WhatsApp as-is. Returns '' for anything too short to be
 * a number, which is what makes an unset or mistyped field fall back to the
 * other channel instead of rendering a dead button.
 */
export function normalizeWhatsapp(raw: unknown): string {
  let digits = (typeof raw === 'string' ? raw : '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  // Local Iraqi form: 07XX XXX XXXX -> 9647XX XXX XXXX.
  if (digits.startsWith('0')) digits = DEFAULT_COUNTRY_CODE + digits.slice(1);
  // Bare mobile with neither trunk 0 nor country code: 7801234567.
  else if (digits.startsWith('7') && digits.length === 10) digits = DEFAULT_COUNTRY_CODE + digits;
  return digits.length >= 8 && digits.length <= 15 ? digits : '';
}

/**
 * Telegram's own reserved first path segments.
 *
 * `t.me/joinchat/AbCd` reduces to the valid-looking username "joinchat", and
 * linking a student to https://t.me/joinchat is a dead end. These are the
 * deep-link prefixes long enough to survive the username check below.
 */
const TELEGRAM_RESERVED = new Set([
  'joinchat', 'addstickers', 'addlist', 'addtheme', 'proxy', 'socks',
  'share', 'setlanguage', 'confirmphone', 'login',
]);

/**
 * A Telegram username, however the seller pasted it.
 *
 * Accepts `@name`, `name`, `t.me/name` and a full https link, and refuses
 * anything Telegram itself would refuse (5-32 of [A-Za-z0-9_]). Refusing is
 * the point: a `t.me/+invite`, a `t.me/joinchat/...` or a `t.me/c/123/45`
 * link is not a person a student can message, and shipping one as a "contact
 * us" button sends them to a dead end. A remaining `/` is the tell - a
 * username is the WHOLE path.
 */
export function normalizeTelegram(raw: unknown): string {
  const handle = collapse(raw, 128)
    .replace(/^https?:\/\//i, '')
    .replace(/^(?:www\.)?(?:t|telegram)\.me\//i, '')
    .replace(/^@/, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
  if (handle.includes('/')) return '';
  return /^[A-Za-z0-9_]{5,32}$/.test(handle) && !TELEGRAM_RESERVED.has(handle.toLowerCase())
    ? handle
    : '';
}

/** Read a Firestore `settings/payment_contact` document. Never throws. */
export function normalizePaymentContact(raw: unknown): PaymentContact {
  const data = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    walletNumber: normalizeWalletNumber(data.walletNumber),
    whatsapp: normalizeWhatsapp(data.whatsapp),
    telegram: normalizeTelegram(data.telegram),
    note: collapse(data.note, 200),
  };
}

/**
 * True when the student has at least one way to reach a human.
 *
 * The wallet number is NOT a channel: it takes money and answers nothing, so a
 * contact-less form leaves a student who has already paid with nowhere to go.
 */
export const hasPaymentChannel = (c: PaymentContact): boolean =>
  !!(c.whatsapp || c.telegram);

/** Anything at all configured - used to decide whether to offer this method. */
export const hasPaymentContact = (c: PaymentContact): boolean =>
  hasPaymentChannel(c) || !!c.walletNumber;

/**
 * wa.me link, with the order details prefilled.
 *
 * The prefill is the whole value of the WhatsApp route: the seller needs the
 * student's name, the plan and the amount to match a transfer against an
 * account, and a student typing that from memory gets it wrong.
 */
export function whatsappUrl(c: PaymentContact, message?: string): string {
  if (!c.whatsapp) return '';
  const query = message ? `?text=${encodeURIComponent(message)}` : '';
  return `https://wa.me/${c.whatsapp}${query}`;
}

/**
 * t.me link to a person.
 *
 * No `?text=` - Telegram only honours prefilled text on share links, not on a
 * direct chat, so it would be dropped silently. The UI offers copy instead.
 */
export const telegramUrl = (c: PaymentContact): string =>
  c.telegram ? `https://t.me/${c.telegram}` : '';

// ─── Proof of payment ───────────────────────────────────────────────────────

/** Images only, and small enough that a phone upload finishes on 3G. */
export const RECEIPT_MAX_BYTES = 5 * 1024 * 1024;
export const RECEIPT_ACCEPT = 'image/png,image/jpeg,image/webp,image/heic,image/heif';

const RECEIPT_TYPES = /^image\/(png|jpe?g|webp|heic|heif)$/i;

export type ReceiptProblem = 'type' | 'size';

/** Why this file cannot be a receipt, or null. */
export function checkReceiptFile(file: { type?: string; size?: number }): ReceiptProblem | null {
  // A HEIC picked from an iPhone gallery sometimes arrives with an empty type;
  // the extension check in the picker has already filtered it, so trust size.
  if (file.type && !RECEIPT_TYPES.test(file.type)) return 'type';
  if ((file.size ?? 0) > RECEIPT_MAX_BYTES) return 'size';
  return null;
}

/**
 * The submit rule: a screenshot OR a transaction number, not both.
 *
 * Pinned by npm run test:payments. Requiring the number was the bug - Super Qi
 * shows it once, on a screen the student has usually already dismissed by the
 * time they reach this form.
 */
export const isProofSufficient = (transactionId: string, hasReceipt: boolean): boolean =>
  hasReceipt || (transactionId || '').trim().length > 0;

/**
 * Storage object name for a receipt.
 *
 * MUST begin with the uid: storage.rules admits the write with
 * `fileName.matches(request.auth.uid + ".*")`, the same prefix contract as
 * `profiles/` and `chat_attachments/`. Roster students authenticate with a uid
 * that IS their college email, so the name carries an `@` and dots - fine for
 * an object name, and matched literally by that rule.
 */
export function receiptStoragePath(uid: string, fileName: string): string {
  // lastIndexOf, not split('.').pop(): a name with no dot at all makes pop()
  // return the whole name, so "screenshot" became the extension ".scree".
  const name = fileName || '';
  const dot = name.lastIndexOf('.');
  const ext = (dot > 0 ? name.slice(dot + 1) : '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 5) || 'jpg';
  const salt = Math.random().toString(36).slice(2, 10);
  return `payment_receipts/${uid}_${Date.now()}_${salt}.${ext}`;
}
