/**
 * Verifies the manual (Super Qi / Qi Card) payment rules.
 *
 * Run with:  npm run test:payments
 *
 * Pure functions only - no Firestore, no Storage. Two invariants are the point
 * of this file, and both were bugs:
 *
 *   1. ONE CONTACT CHANNEL IS ENOUGH. A seller who only uses Telegram must not
 *      have to invent a WhatsApp number, and a number that cannot be dialled
 *      must not render as a button. wa.me rejects a local 07xx number with its
 *      own "invalid number" page, so normalisation is what makes the button
 *      work at all.
 *   2. ONE PROOF IS ENOUGH. The form demanded a transaction number, which Super
 *      Qi shows once on a screen most students have already dismissed. A
 *      receipt screenshot is the other half, and either settles it.
 */
import {
  EMPTY_PAYMENT_CONTACT,
  RECEIPT_MAX_BYTES,
  checkReceiptFile,
  hasPaymentChannel,
  hasPaymentContact,
  isProofSufficient,
  normalizePaymentContact,
  normalizeTelegram,
  normalizeWalletNumber,
  normalizeWhatsapp,
  receiptStoragePath,
  telegramUrl,
  whatsappUrl,
} from '../src/lib/paymentContact';

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); failed++; }
};

console.log('WhatsApp numbers:');
check('a local Iraqi number gets the country code',
  normalizeWhatsapp('07801234567') === '9647801234567', normalizeWhatsapp('07801234567'));
check('spaces and dashes are dropped',
  normalizeWhatsapp('0780-123 4567') === '9647801234567', normalizeWhatsapp('0780-123 4567'));
check('a +964 number is kept',
  normalizeWhatsapp('+964 780 123 4567') === '9647801234567', normalizeWhatsapp('+964 780 123 4567'));
check('a 00964 prefix is unwrapped',
  normalizeWhatsapp('00964 780 123 4567') === '9647801234567', normalizeWhatsapp('00964 780 123 4567'));
check('a bare mobile with no trunk zero is completed',
  normalizeWhatsapp('7801234567') === '9647801234567', normalizeWhatsapp('7801234567'));
check('too short is refused rather than half-built',
  normalizeWhatsapp('0780') === '', normalizeWhatsapp('0780'));
check('an empty field is refused', normalizeWhatsapp('') === '');
check('a non-string is refused', normalizeWhatsapp(undefined) === '');

console.log('\nTelegram usernames:');
check('a bare username is kept', normalizeTelegram('mohadaraty') === 'mohadaraty');
check('a leading @ is stripped', normalizeTelegram('@mohadaraty') === 'mohadaraty');
check('a pasted link is reduced to the username',
  normalizeTelegram('https://t.me/mohadaraty') === 'mohadaraty', normalizeTelegram('https://t.me/mohadaraty'));
check('a telegram.me link works too',
  normalizeTelegram('telegram.me/mohadaraty') === 'mohadaraty', normalizeTelegram('telegram.me/mohadaraty'));
check('a query string is dropped',
  normalizeTelegram('t.me/mohadaraty?start=1') === 'mohadaraty', normalizeTelegram('t.me/mohadaraty?start=1'));
check('an invite link is NOT a person to message',
  normalizeTelegram('https://t.me/+AbCdEf123') === '', normalizeTelegram('https://t.me/+AbCdEf123'));
check('a joinchat link is refused - "joinchat" is not a person',
  normalizeTelegram('t.me/joinchat/AbCdEf') === '', normalizeTelegram('t.me/joinchat/AbCdEf'));
check('a channel-post link is refused',
  normalizeTelegram('t.me/c/1234567/89') === '', normalizeTelegram('t.me/c/1234567/89'));
check('a trailing slash is not a path segment',
  normalizeTelegram('https://t.me/mohadaraty/') === 'mohadaraty', normalizeTelegram('https://t.me/mohadaraty/'));
check('too short for Telegram is refused', normalizeTelegram('abcd') === '');
check('a name with a space is refused', normalizeTelegram('moha daraty') === '');

console.log('\nWallet number:');
check('grouping the seller typed is preserved',
  normalizeWalletNumber('0770 000 0000') === '0770 000 0000', normalizeWalletNumber('0770 000 0000'));
check('a 16-digit card number survives',
  normalizeWalletNumber('1234-5678-9012-3456') === '1234-5678-9012-3456');
check('letters are stripped', normalizeWalletNumber('qi 0770') === '0770');

console.log('\nOne channel is enough:');
{
  const whatsappOnly = normalizePaymentContact({ whatsapp: '07801234567' });
  const telegramOnly = normalizePaymentContact({ telegram: '@mohadaraty' });
  const numberOnly = normalizePaymentContact({ walletNumber: '0770 000 0000' });

  check('WhatsApp alone is a channel', hasPaymentChannel(whatsappOnly));
  check('Telegram alone is a channel', hasPaymentChannel(telegramOnly));
  check('nothing configured is not a channel', !hasPaymentChannel(EMPTY_PAYMENT_CONTACT));
  check('a wallet number is NOT a channel - it answers nobody',
    !hasPaymentChannel(numberOnly) && hasPaymentContact(numberOnly));
  check('a mistyped WhatsApp does not count as a channel',
    !hasPaymentChannel(normalizePaymentContact({ whatsapp: '077' })));
  check('an invite-link Telegram does not count as a channel',
    !hasPaymentChannel(normalizePaymentContact({ telegram: 't.me/+AbCdEf123' })));

  check('the wa.me link carries the order details',
    whatsappUrl(whatsappOnly, 'Plan: Seasonal') === 'https://wa.me/9647801234567?text=Plan%3A%20Seasonal',
    whatsappUrl(whatsappOnly, 'Plan: Seasonal'));
  check('no link without a number', whatsappUrl(telegramOnly, 'x') === '');
  check('the t.me link points at the person',
    telegramUrl(telegramOnly) === 'https://t.me/mohadaraty', telegramUrl(telegramOnly));
  check('a garbage document reads as empty, never throws',
    hasPaymentContact(normalizePaymentContact('nonsense')) === false);
}

console.log('\nOne proof is enough:');
check('a transaction number alone submits', isProofSufficient('TX9931', false));
check('a receipt alone submits', isProofSufficient('', true));
check('both is fine', isProofSufficient('TX9931', true));
check('neither does not submit', !isProofSufficient('', false));
check('whitespace is not a transaction number', !isProofSufficient('   ', false));

console.log('\nReceipt files:');
check('a jpeg is accepted', checkReceiptFile({ type: 'image/jpeg', size: 900_000 }) === null);
check('a png is accepted', checkReceiptFile({ type: 'image/png', size: 10 }) === null);
check('an iPhone HEIC is accepted', checkReceiptFile({ type: 'image/heic', size: 10 }) === null);
check('a PDF is not a screenshot', checkReceiptFile({ type: 'application/pdf', size: 10 }) === 'type');
check('a video is refused', checkReceiptFile({ type: 'video/mp4', size: 10 }) === 'type');
check('oversize is refused',
  checkReceiptFile({ type: 'image/jpeg', size: RECEIPT_MAX_BYTES + 1 }) === 'size');
check('a missing content type is trusted to the picker',
  checkReceiptFile({ size: 10 }) === null);

console.log('\nStorage path (the rule in storage.rules is a uid PREFIX match):');
{
  const opaque = receiptStoragePath('AbC123xyz', 'IMG_0421.PNG');
  check('lands under payment_receipts/', opaque.startsWith('payment_receipts/'), opaque);
  check('the object name starts with the uid',
    opaque.slice('payment_receipts/'.length).startsWith('AbC123xyz'), opaque);
  check('the extension is carried and lower-cased', opaque.endsWith('.png'), opaque);

  // Roster students authenticate with a custom token whose uid IS their college
  // email, so the prefix contract has to hold for that shape too.
  const email = receiptStoragePath('ph2023099@student.alsafwa.edu.iq', 'shot.jpeg');
  check('a uid that is an email still prefixes the name',
    email.slice('payment_receipts/'.length).startsWith('ph2023099@student.alsafwa.edu.iq'), email);

  check('an extensionless file still gets one',
    receiptStoragePath('u1', 'screenshot').endsWith('.jpg'), receiptStoragePath('u1', 'screenshot'));
  check('a path-traversal extension cannot escape the prefix',
    !receiptStoragePath('u1', 'a.../../x').includes('..'), receiptStoragePath('u1', 'a.../../x'));
  check('two uploads in the same millisecond do not collide',
    receiptStoragePath('u1', 'a.png') !== receiptStoragePath('u1', 'a.png'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
