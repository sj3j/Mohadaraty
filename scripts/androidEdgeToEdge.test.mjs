import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const capacitorConfig = readFileSync(new URL('../capacitor.config.ts', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const mainActivity = readFileSync(
  new URL('../android/app/src/main/java/com/mohadaraty/app/MainActivity.java', import.meta.url),
  'utf8',
);

assert.match(mainActivity, /EdgeToEdge\.enable\(this\)/, 'Android must enable edge-to-edge on pre-API 35 devices');
assert.match(app, /paddingTop:\s*'env\(safe-area-inset-top\)'/, 'The web shell must own the top safe-area inset');
assert.doesNotMatch(
  capacitorConfig,
  /adjustMarginsForEdgeToEdge:\s*['"](?:force|auto)['"]/,
  'Native WebView margins must stay disabled when the web shell already applies safe-area insets',
);

console.log('PASS  Android uses one edge-to-edge inset owner');
