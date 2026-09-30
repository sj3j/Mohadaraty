/**
 * Copies pdf.js's standard font data into public/ so it ships in the bundle
 * (and therefore inside the APK).
 *
 * Without this, any PDF that does not embed the base-14 fonts renders its text
 * as blank boxes. Runs before the Vite build so the files are picked up as
 * static assets.
 *
 * .map files are filtered out deliberately: scripts/pruneNativeWebDir.mjs fails
 * the native build on stray source maps.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcFonts = path.join(root, 'node_modules', 'pdfjs-dist', 'standard_fonts');
const destFonts = path.join(root, 'public', 'pdfjs', 'standard_fonts');

const srcCmaps = path.join(root, 'node_modules', 'pdfjs-dist', 'cmaps');
const destCmaps = path.join(root, 'public', 'pdfjs', 'cmaps');

if (!existsSync(srcFonts)) {
  console.error('pdfjs-dist standard_fonts not found - is pdfjs-dist installed?');
  process.exit(1);
}

rmSync(destFonts, { recursive: true, force: true });
mkdirSync(destFonts, { recursive: true });
cpSync(srcFonts, destFonts, {
  recursive: true,
  filter: (s) => !s.endsWith('.map'),
});
console.log(`copyPdfjsAssets: standard_fonts -> public/pdfjs/standard_fonts`);

if (existsSync(srcCmaps)) {
  rmSync(destCmaps, { recursive: true, force: true });
  mkdirSync(destCmaps, { recursive: true });
  cpSync(srcCmaps, destCmaps, {
    recursive: true,
    filter: (s) => !s.endsWith('.map'),
  });
  console.log(`copyPdfjsAssets: cmaps -> public/pdfjs/cmaps`);
}
