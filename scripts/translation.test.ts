import { detectLanguage, isArabicText, buildExternalTranslateUrl } from '../src/services/translationService';
import { createTranslateHandlers } from '../shared/translateApi';
import assert from 'node:assert/strict';

console.log('Testing Translation Services:');

// 1. Language detection
assert.equal(isArabicText('Hello world'), false);
assert.equal(isArabicText('Pharmacokinetics in clinical medicine'), false);
assert.equal(isArabicText('مرحبا بكم في التطبيق'), true);
assert.equal(isArabicText('علم الأدوية 101'), true);
assert.equal(detectLanguage('Hello world'), 'en');
assert.equal(detectLanguage('مرحبا'), 'ar');
console.log('  PASS  Language detection (Arabic vs English)');

// 2. External URL construction
const urlEn = buildExternalTranslateUrl('Hypertension', 'ar');
assert.ok(urlEn.includes('tl=ar'));
assert.ok(urlEn.includes('Hypertension'));

const urlAr = buildExternalTranslateUrl('ضغط الدم', 'en');
assert.ok(urlAr.includes('tl=en'));
assert.ok(urlAr.includes(encodeURIComponent('ضغط الدم')));
console.log('  PASS  External Google Translate URL builder');

// 3. Server API handler validation
const handlers = createTranslateHandlers();
let statusSent = 0;
let jsonSent: any = null;

const fakeReqEmpty: any = { body: { text: '' } };
const fakeRes: any = {
  status(code: number) {
    statusSent = code;
    return this;
  },
  json(data: any) {
    jsonSent = data;
    return this;
  },
};

void handlers.translate(fakeReqEmpty, fakeRes).then(async () => {
  assert.equal(statusSent, 400);
  assert.equal(jsonSent?.error, 'empty_text');
  console.log('  PASS  Translate API rejects empty input with 400');

  // 4. translateService validation
  const { translateText } = await import('../src/services/translateService');
  await assert.rejects(
    () => translateText('   '),
    /النص المحدّد فارغ/,
  );
  console.log('  PASS  translateService rejects whitespace input with Arabic error');

  console.log('\nAll translation tests passed successfully.');
});
