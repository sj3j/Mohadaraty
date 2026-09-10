/**
 * Verifies the Telegram <-> announcement entity codec.
 *
 * Run with:  npm --prefix bot run test
 *
 * The property that matters most is the FIXED POINT: a Telegram message that
 * becomes an announcement, is sent back out to Telegram, and comes back in
 * again, must be identical. Every mirrored post makes that round trip at least
 * once, so an asymmetry here does not show up as one wrong post - it compounds
 * on every edit until the text is unrecognisable.
 *
 * UTF-16 offsets are the other half. Arabic is 1 code unit per letter and
 * emoji are 2, and this feed is almost entirely Arabic with emoji in it, so a
 * codec that is only tested on ASCII is untested.
 */
import {
  tgEntitiesToRich,
  richEntitiesToTg,
  tgMessageToBlocks,
  blocksToTgText,
  splitTgText,
} from '../src/sync/entities.ts';
import { blocksToPlainText } from '../../src/lib/richText.ts';
import type { RichBlock } from '../../src/types/announcement.types.ts';
import type { TgMessageEntity } from '../src/telegram/types.ts';

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); failed++; }
};
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

console.log('\nInbound: Telegram -> RichEntity');

check('bold survives',
  eq(tgEntitiesToRich([{ type: 'bold', offset: 0, length: 3 }], 10),
     [{ type: 'bold', offset: 0, length: 3 }]));

check('strikethrough is renamed to strike',
  eq(tgEntitiesToRich([{ type: 'strikethrough', offset: 1, length: 2 }], 10),
     [{ type: 'strike', offset: 1, length: 2 }]));

check('pre is downgraded to code',
  eq(tgEntitiesToRich([{ type: 'pre', offset: 0, length: 4, language: 'js' }], 10),
     [{ type: 'code', offset: 0, length: 4 }]));

check('text_link keeps its url',
  eq(tgEntitiesToRich([{ type: 'text_link', offset: 0, length: 2, url: 'https://a.com' }], 5),
     [{ type: 'link', offset: 0, length: 2, url: 'https://a.com/' }]));

check('a javascript: text_link is dropped entirely',
  eq(tgEntitiesToRich([{ type: 'text_link', offset: 0, length: 2, url: 'javascript:alert(1)' }], 5), []));

for (const dropped of ['spoiler', 'blockquote', 'expandable_blockquote', 'url', 'mention',
                       'hashtag', 'cashtag', 'bot_command', 'email', 'phone_number',
                       'text_mention', 'custom_emoji'] as TgMessageEntity['type'][]) {
  check(`${dropped} is dropped, text kept`,
    eq(tgEntitiesToRich([{ type: dropped, offset: 0, length: 3 }], 10), []));
}

check('an entity running past the text is clamped',
  eq(tgEntitiesToRich([{ type: 'bold', offset: 2, length: 99 }], 5),
     [{ type: 'bold', offset: 2, length: 3 }]));

check('an entity starting past the text is dropped',
  eq(tgEntitiesToRich([{ type: 'bold', offset: 9, length: 3 }], 5), []));

console.log('\nOutbound: RichEntity -> Telegram');

check('strike is renamed back to strikethrough',
  eq(richEntitiesToTg([{ type: 'strike', offset: 0, length: 2 }]),
     [{ type: 'strikethrough', offset: 0, length: 2 }]));

check('link becomes text_link',
  eq(richEntitiesToTg([{ type: 'link', offset: 0, length: 2, url: 'https://a.com/' }]),
     [{ type: 'text_link', offset: 0, length: 2, url: 'https://a.com/' }]));

check('an unsafe stored url is refused on the way out too',
  eq(richEntitiesToTg([{ type: 'link', offset: 0, length: 2, url: 'javascript:x' }]), []));

console.log('\nUTF-16 offsets');

check('emoji counts as 2 inbound',
  eq(tgMessageToBlocks('😀ب', [{ type: 'bold', offset: 2, length: 1 }]),
     [{ type: 'p', text: '😀ب', entities: [{ type: 'bold', offset: 2, length: 1 }] }]));

check('Arabic letters count as 1 each',
  eq(tgMessageToBlocks('مرحبا X', [{ type: 'bold', offset: 6, length: 1 }]),
     [{ type: 'p', text: 'مرحبا X', entities: [{ type: 'bold', offset: 6, length: 1 }] }]));

console.log('\nblocksToPlainText stays an identity on inbound text');

for (const sample of [
  'سطر واحد',
  'سطر أول\nسطر ثانٍ',
  'نص فيه 😀 إيموجي\n\nوفقرة ثانية',
  'Mixed عربي and Latin',
]) {
  check(`round-trips: ${JSON.stringify(sample.slice(0, 24))}`,
    blocksToPlainText(tgMessageToBlocks(sample)) === sample.trim(),
    JSON.stringify(blocksToPlainText(tgMessageToBlocks(sample))));
}

console.log('\nFixed point: TG -> blocks -> TG -> blocks');

const fixedPoint = (label: string, text: string, entities: TgMessageEntity[] = []) => {
  const first = tgMessageToBlocks(text, entities);
  const sent = blocksToTgText(first);
  const second = tgMessageToBlocks(sent.text, sent.entities);
  check(label, eq(first, second), JSON.stringify({ first, second }));
};

fixedPoint('plain Arabic', 'إعلان مهم للطلاب');
fixedPoint('bold run', 'امتحان الفارما غداً', [{ type: 'bold', offset: 0, length: 6 }]);
fixedPoint('emoji then bold', '📌 طلاب المرحلة', [{ type: 'bold', offset: 3, length: 5 }]);
fixedPoint('link', 'اضغط هنا للتسجيل', [{ type: 'text_link', offset: 5, length: 3, url: 'https://a.com/x' }]);
fixedPoint('multiline', 'العنوان\nالتفاصيل هنا', [{ type: 'bold', offset: 0, length: 7 }]);
fixedPoint('every mark at once', 'abcdef', [
  { type: 'bold', offset: 0, length: 6 },
  { type: 'italic', offset: 0, length: 6 },
  { type: 'underline', offset: 0, length: 6 },
  { type: 'strikethrough', offset: 0, length: 6 },
  { type: 'code', offset: 0, length: 6 },
]);

console.log('\nHeadings become bold on the way out');

const heading: RichBlock[] = [{ type: 'h', text: 'عنوان' }, { type: 'p', text: 'نص' }];
const headingOut = blocksToTgText(heading);
check('heading text is joined with a newline', headingOut.text === 'عنوان\nنص', headingOut.text);
check('heading emits a bold entity over itself',
  eq(headingOut.entities, [{ type: 'bold', offset: 0, length: 5 }]),
  JSON.stringify(headingOut.entities));
check('outbound text equals blocksToPlainText',
  headingOut.text === blocksToPlainText(heading));

console.log('\nSplitting past 4096');

const long = { text: 'x'.repeat(50) + '\n' + 'y'.repeat(60), entities: [{ type: 'bold' as const, offset: 45, length: 20 }] };
const parts = splitTgText(long, 60);
check('splits into more than one part', parts.length > 1, String(parts.length));
check('no part exceeds the limit', parts.every(p => p.text.length <= 60));
check('a straddling entity is clipped into both parts, not dropped',
  parts.filter(p => p.entities.length > 0).length === 2,
  JSON.stringify(parts.map(p => p.entities)));
check('short text is returned untouched',
  eq(splitTgText({ text: 'short', entities: [] }, 60), [{ text: 'short', entities: [] }]));

const runaway = splitTgText({ text: 'z'.repeat(5000), entities: [] }, 100, 3);
check('a runaway body is capped at maxParts', runaway.length === 3, String(runaway.length));
check('the final capped part is ellipsised', runaway[2].text.endsWith('…'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
