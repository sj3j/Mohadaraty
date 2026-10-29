import { formatLectureCaption, type LectureDoc } from '../src/sync/lectures.ts';
import {
  resolveLectureChannelForStage,
  type TelegramConfig,
} from '../../shared/telegramMirror.ts';

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); failed++; }
};

console.log('\nLecture Caption & Deep Link Formatting');
{
  const lecture: LectureDoc = {
    id: 'lec_pharm_101',
    title: 'Pharmacokinetics Intro',
    subjectName: 'علم الأدوية 1',
    type: 'theoretical',
    number: 1,
    pdfUrl: 'https://example.com/lec1.pdf',
  };

  const { caption, directUrl, replyMarkup } = formatLectureCaption(lecture);

  check('directUrl is valid deep link with lecture id', directUrl === 'https://mohadaraty.vercel.app/?lecture=lec_pharm_101');
  check('caption contains lecture title with book emoji', caption.includes('📚 Pharmacokinetics Intro'));
  check('caption contains subject name', caption.includes('📖 المادة: علم الأدوية 1'));
  check('caption contains theoretical type and number', caption.includes('🔖 النوع: نظري · المحاضرة 1'));
  check('caption contains direct URL', caption.includes(directUrl));
  check('replyMarkup includes inline keyboard button with app open link',
    replyMarkup.inline_keyboard[0][0].text === '📱 فتح في التطبيق' &&
    replyMarkup.inline_keyboard[0][0].url === directUrl
  );
}

console.log('\nLecture Channel Resolution');
{
  const configWithDedicatedChannel: TelegramConfig = {
    enabled: true,
    defaultMirrorOut: true,
    channels: {
      stage_3: {
        chatId: -1001111111111,
        lectureChatId: -1002222222222,
        enabled: true,
        mirrorIn: true,
        mirrorOut: true,
        mirrorLectures: true,
      },
    },
  };

  check('resolves dedicated lectureChatId when mirrorLectures is true',
    resolveLectureChannelForStage(configWithDedicatedChannel, 'stage_3') === -1002222222222
  );

  const configWithFallback: TelegramConfig = {
    enabled: true,
    defaultMirrorOut: true,
    channels: {
      stage_3: {
        chatId: -1001111111111,
        enabled: true,
        mirrorIn: true,
        mirrorOut: true,
        mirrorLectures: true,
      },
    },
  };

  check('falls back to chatId when lectureChatId is unset but mirrorLectures is true',
    resolveLectureChannelForStage(configWithFallback, 'stage_3') === -1001111111111
  );

  const configDisabled: TelegramConfig = {
    enabled: true,
    defaultMirrorOut: true,
    channels: {
      stage_3: {
        chatId: -1001111111111,
        lectureChatId: -1002222222222,
        enabled: true,
        mirrorIn: true,
        mirrorOut: true,
        mirrorLectures: false,
      },
    },
  };

  check('returns null when mirrorLectures is false',
    resolveLectureChannelForStage(configDisabled, 'stage_3') === null
  );

  const configGlobalOff: TelegramConfig = {
    enabled: false,
    defaultMirrorOut: true,
    channels: {
      stage_3: {
        chatId: -1001111111111,
        lectureChatId: -1002222222222,
        enabled: true,
        mirrorIn: true,
        mirrorOut: true,
        mirrorLectures: true,
      },
    },
  };

  check('returns null when global mirror is disabled',
    resolveLectureChannelForStage(configGlobalOff, 'stage_3') === null
  );
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

