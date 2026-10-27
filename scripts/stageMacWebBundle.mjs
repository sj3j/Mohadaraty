import fs from 'fs';
import path from 'path';

const root = process.cwd();
const source = path.resolve(root, 'dist');
const resourcesRoot = path.resolve(root, 'macos', 'MohadaratyMac', 'Resources');
const destination = path.join(resourcesRoot, 'WebApp');
const iconSource = path.resolve(root, 'assets', 'icon.png');
const iconDestination = path.resolve(root, 'macos', 'MohadaratyMac', 'Assets.xcassets', 'AppIcon.appiconset', 'icon_1024.png');

if (!fs.existsSync(path.join(source, 'index.html'))) {
  throw new Error('Mac staging refused: dist/index.html is missing.');
}
if (!destination.startsWith(resourcesRoot + path.sep)) {
  throw new Error('Mac staging refused: destination escaped Resources.');
}

fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(resourcesRoot, { recursive: true });
fs.cpSync(source, destination, { recursive: true });
fs.mkdirSync(path.dirname(iconDestination), { recursive: true });
fs.copyFileSync(iconSource, iconDestination);

const required = [
  'index.html',
  'icons/icon-192.png',
  'pdfjs/standard_fonts/LiberationSans-Regular.ttf',
  'pdfjs/cmaps/78-EUC-H.bcmap',
];
for (const relative of required) {
  const file = path.join(destination, relative);
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    throw new Error(`Mac staging failed: required asset is missing: ${relative}`);
  }
}

const assetFiles = fs.readdirSync(path.join(destination, 'assets'));
if (!assetFiles.some(name => /^pdfWorkerEntry-.*\.js$/.test(name))) {
  throw new Error('Mac staging failed: bundled PDF worker was not found.');
}
const forbidden = ['server.cjs', 'server.cjs.map'];
for (const name of forbidden) {
  if (fs.existsSync(path.join(destination, name))) throw new Error(`Mac bundle contains forbidden server artifact: ${name}`);
}
const maps = [];
for (const entry of fs.readdirSync(destination, { recursive: true })) {
  if (String(entry).endsWith('.map')) maps.push(String(entry));
}
if (maps.length) throw new Error(`Mac bundle contains source maps: ${maps.join(', ')}`);

console.log(`Staged macOS web bundle at ${destination}`);

