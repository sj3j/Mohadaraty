import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  PASS  ${msg}`);
}

console.log('\n--- Test 1: Search Panel Layering & Z-Index ---');
const searchPanelSource = fs.readFileSync(path.resolve(__dirname, '../src/components/pdf/PdfSearchPanel.tsx'), 'utf8');
const headerPillSource = fs.readFileSync(path.resolve(__dirname, '../src/components/pdf/NotewiseHeaderPill.tsx'), 'utf8');
const readerOverlaySource = fs.readFileSync(path.resolve(__dirname, '../src/components/pdf/PdfReaderOverlay.tsx'), 'utf8');

// Header pill is z-40
assert(headerPillSource.includes('z-40'), 'NotewiseHeaderPill is at z-40');

// Search panel MUST be at z-50 or higher so it renders ON TOP of the header buttons, never behind
const searchHasHigherZIndex = searchPanelSource.includes('z-50') || searchPanelSource.includes('z-[50]') || searchPanelSource.includes('z-[60]');
assert(searchHasHigherZIndex, 'PdfSearchPanel has z-50+ to render strictly above header buttons (not behind z-40)');

// PdfReaderOverlay must register searchOpen in interactive touch zones so touches are not forwarded to underlying native view
assert(readerOverlaySource.includes('searchOpen') && readerOverlaySource.includes('isAnyDrawerOpen'), 'PdfReaderOverlay includes searchOpen in isAnyDrawerOpen check');

console.log('\n--- Test 2: Initial Dark Mode & Canvas Inversion in Web Mode ---');
// PdfReaderOverlay must initialize isNightMode based on the app theme / document.documentElement.classList.contains('dark')
const initializesFromAppTheme = readerOverlaySource.includes("classList.contains('dark')");
assert(initializesFromAppTheme, "isNightMode initializes from document.documentElement.classList.contains('dark')");

// In web mode, night mode must apply dark inversion filter to the canvas so PDF pages are eye-comfort dark
const appliesDarkFilter = readerOverlaySource.includes('invert(') || fs.readFileSync(path.resolve(__dirname, '../src/components/pdf/PdfPage.tsx'), 'utf8').includes('invert(');
assert(appliesDarkFilter, 'Web PDF view applies invert filter to canvas in night mode');

console.log('\n--- Test 3: Responsive Bottom Navigation (No Collisions) ---');
// When annotation mode is on, NotewisePagePill must not collide with NotewiseAnnotationDock at bottom-5
const pagePillAvoidsOverlap = readerOverlaySource.includes('isAnnotationMode') && (readerOverlaySource.includes('bottom-20') || readerOverlaySource.includes('bottom-24'));
assert(pagePillAvoidsOverlap, 'NotewisePagePill repositions above dock (e.g. bottom-20) when annotation mode is active to prevent collision');

console.log('\n--- Test 4: Design System & Theme Consistency (Zinc/Slate over Stone) ---');
// NotewiseHeaderPill and NotewiseAnnotationDock must use app standard zinc/slate tokens instead of stone
const headerUsesZinc = !headerPillSource.includes('dark:bg-stone-900') && (headerPillSource.includes('dark:bg-zinc-900') || headerPillSource.includes('dark:bg-zinc-950'));
assert(headerUsesZinc, 'NotewiseHeaderPill uses dark:bg-zinc-900/95 matching the app design system');

const dockSource = fs.readFileSync(path.resolve(__dirname, '../src/components/pdf/NotewiseAnnotationDock.tsx'), 'utf8');
const dockUsesZinc = !dockSource.includes('dark:bg-stone-900') && dockSource.includes('dark:bg-zinc-900');
assert(dockUsesZinc, 'NotewiseAnnotationDock uses dark:bg-zinc-900 matching the app design system');

console.log('\n--- Test 5: iOS Native Touch Pass-Through & Inversion ---');
const iosPluginSource = fs.readFileSync(path.resolve(__dirname, '../ios/App/App/pdf/PdfViewerPlugin.swift'), 'utf8');
assert(iosPluginSource.includes('CIColorInvert'), 'iOS PDF plugin implements CIColorInvert filter in setNightMode');

console.log('\nALL FEEDBACK LOOP TESTS PASSED!');
