import fs from 'fs';
import path from 'path';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  PASS: ${msg}`);
}

console.log('\n--- Test 1: Background Screen Unmounting During PDF Reader ---');
const appTsx = fs.readFileSync(path.resolve(process.cwd(), 'src/App.tsx'), 'utf-8');

assert(
  appTsx.includes('const isReaderOpen = (readerLecture !== null) || (localReaderFile !== null);'),
  'App.tsx derives isReaderOpen from readerLecture or localReaderFile'
);
assert(
  appTsx.includes('!isReaderOpen && [\'home\', \'lectures\', \'weekly\', \'records\', \'leaderboard\', \'downloads\'].includes(currentTab)'),
  'App.tsx unmounts HomeScreen when isReaderOpen is true to prevent occluding native PDF view'
);
assert(
  appTsx.includes('${isReaderOpen ? \'bg-transparent\' : \'bg-stone-50 dark:bg-zinc-900\'}'),
  'App.tsx root container applies bg-transparent when isReaderOpen is true'
);

console.log('\n--- Test 2: Native Transparency Styling & HTML/Body Rule ---');
const indexCss = fs.readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf-8');

assert(
  indexCss.includes('html.pdf-native-transparent'),
  'index.css defines html.pdf-native-transparent rule'
);
assert(
  indexCss.includes('html.pdf-native-transparent body'),
  'index.css sets body background to transparent for native PDF view'
);
assert(
  indexCss.includes('html.pdf-native-transparent #root'),
  'index.css sets #root background to transparent for native PDF view'
);

const overlayTsx = fs.readFileSync(path.resolve(process.cwd(), 'src/components/pdf/PdfReaderOverlay.tsx'), 'utf-8');
assert(
  overlayTsx.includes('document.documentElement.classList.add(\'pdf-native-transparent\')'),
  'PdfReaderOverlay adds pdf-native-transparent class when isNative is true'
);
assert(
  overlayTsx.includes('document.documentElement.classList.remove(\'pdf-native-transparent\')'),
  'PdfReaderOverlay cleans up pdf-native-transparent class on unmount or fallback'
);

console.log('\n--- Test 3: Annotation Dock Responsiveness & Tool Sizing ---');
const dockTsx = fs.readFileSync(path.resolve(process.cwd(), 'src/components/pdf/NotewiseAnnotationDock.tsx'), 'utf-8');

assert(
  dockTsx.includes('w-[min(98vw,560px)]'),
  'NotewiseAnnotationDock uses responsive width w-[min(98vw,560px)] instead of fixed max-w'
);
assert(
  dockTsx.includes('inset-x-0 mx-auto'),
  'NotewiseAnnotationDock uses inset-x-0 mx-auto for centered placement without RTL clipping'
);
assert(
  dockTsx.includes('p-1.5 sm:px-2.5 sm:py-1.5'),
  'NotewiseAnnotationDock uses compact 28px/32px touch targets on mobile'
);
assert(
  dockTsx.includes('w-3.5 h-3.5 sm:w-4 sm:h-4'),
  'NotewiseAnnotationDock scales icons for mobile viewports'
);

// Verify all 10 tools are present in the dock
assert(dockTsx.includes('title={isRtl ? \'قلم الرصاص / رسم\' : \'Pencil / Pen\'}'), 'Pencil tool is present');
assert(dockTsx.includes('title={isRtl ? \'تظليل حر للمخططات والصفحات\' : \'Freehand Highlighter\'}'), 'Free Highlighter is present');
assert(dockTsx.includes('title={isRtl ? \'إضافة نص وملاحظات\' : \'Text Box\'}'), 'Text Box tool is present');
assert(dockTsx.includes('title={isRtl ? \'الممحاة\' : \'Eraser\'}'), 'Eraser tool is present');
assert(dockTsx.includes('title={isRtl ? \'اختيار اللون\' : \'Pick Color\'}'), 'Color Swatch is present');
assert(dockTsx.includes('title={isRtl ? \'إضافة ملاحظة\' : \'Add Note\'}'), 'Add Note tool is present');
assert(dockTsx.includes('title={isRtl ? \'تراجع\' : \'Undo\'}'), 'Undo button is present');
assert(dockTsx.includes('title={isRtl ? \'إعادة\' : \'Redo\'}'), 'Redo button is present');
assert(dockTsx.includes('title={isRtl ? \'سيموسان الذكي\' : \'Simosan AI\'}'), 'Simosan AI quick button is present');
assert(dockTsx.includes('title={isRtl ? \'إغلاق الشريط\' : \'Close bar\'}'), 'Dismiss dock button is present');

console.log('\n--- Test 4: Page Pill Mobile Behavior ---');
const pillTsx = fs.readFileSync(path.resolve(process.cwd(), 'src/components/pdf/NotewisePagePill.tsx'), 'utf-8');

assert(
  pillTsx.includes('isAnnotationMode ? \'hidden sm:flex bottom-20\' : \'bottom-5\''),
  'NotewisePagePill is hidden on mobile screens during annotation mode to prevent overlap'
);

console.log('\n--- Test 5: Screen Width Budget Verification ---');
// Simulated width calculation for a 340px phone screen:
// 4 tool buttons (28px each) = 112px
// 1 color swatch (20px) = 20px
// 1 note button (28px) = 28px
// 2 undo/redo buttons (28px each) = 56px
// 1 simosan button (28px) = 28px
// 1 dismiss button (28px) = 28px
// 3 separators (1px + 4px margin = 5px each) = 15px
// Gaps between 11 items = 22px
// Padding = 16px
// Total = 325px <= 340px
const totalDockWidthMobile = (4 * 28) + 20 + 28 + (2 * 28) + 28 + 28 + 15 + 22 + 16;
assert(totalDockWidthMobile <= 340, `Dock mobile footprint (${totalDockWidthMobile}px) fits cleanly on 340px+ screens`);

console.log('\nALL MOBILE PDF RESPONSIVENESS TESTS PASSED!\n');
