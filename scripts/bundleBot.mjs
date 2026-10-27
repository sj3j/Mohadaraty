/**
 * Packages the Telegram mirror bot for a panel host (Wispbyte / Pterodactyl).
 *
 * Run with:  npm run bot:bundle
 * Produces:  build-output/mylecture-telegram-bot.zip
 *
 * The bot imports the announcement schema, the entity codec and safeUrl from
 * src/ so those have exactly one definition in the repo - which means the bot
 * directory alone is NOT deployable. esbuild resolves those cross-tree imports
 * at build time, leaving one self-contained CommonJS file that needs nothing
 * from the repo at runtime.
 *
 * firebase-admin and dotenv stay external: firebase-admin is ~50MB and the
 * panel runs `npm install` from the emitted package.json anyway.
 */
import { build } from 'esbuild';
import { mkdirSync, rmSync, writeFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stage = resolve(root, 'build-output/wispbyte');
const zip = resolve(root, 'build-output/mylecture-telegram-bot.zip');
const checksumFile = `${zip}.sha256`;
const releaseFile = resolve(root, 'build-output/mylecture-telegram-bot.release.txt');
const commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const botDirty = execFileSync('git', [
  'status', '--porcelain', '--', 'bot', 'scripts/bundleBot.mjs',
  'shared/telegramMirror.ts', 'src/types/announcement.types.ts', 'src/lib/richText.ts',
], { cwd: root, encoding: 'utf8' }).trim().length > 0;
const buildVersion = `${commit}${botDirty ? '+working-tree' : ''}`;

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// index.js, not index.cjs: panel eggs default their startup to `node index.js`,
// and package.json omits "type" so this stays CommonJS.
await build({
  entryPoints: [resolve(root, 'bot/src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  packages: 'external',
  define: { 'process.env.BOT_BUILD_VERSION': JSON.stringify(buildVersion) },
  outfile: resolve(stage, 'index.js'),
});

await build({
  entryPoints: [resolve(root, 'bot/src/recovery.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  packages: 'external',
  outfile: resolve(stage, 'recovery.js'),
});

const botPkg = JSON.parse(
  await import('node:fs/promises').then(fs => fs.readFile(resolve(root, 'bot/package.json'), 'utf8')),
);

writeFileSync(resolve(stage, 'package.json'), JSON.stringify({
  name: 'mylecture-telegram-mirror',
  version: botPkg.version,
  private: true,
  description: botPkg.description,
  main: 'index.js',
  scripts: { start: 'node index.js', recovery: 'node recovery.js' },
  // Copied from bot/package.json so the two cannot drift.
  dependencies: botPkg.dependencies,
  engines: botPkg.engines,
}, null, 2) + '\n');

const readme = resolve(root, 'bot/DEPLOY.txt');
if (existsSync(readme)) copyFileSync(readme, resolve(stage, 'README.txt'));

rmSync(zip, { force: true });
rmSync(checksumFile, { force: true });
rmSync(releaseFile, { force: true });
// Compress-Archive on Windows, zip elsewhere. Entries must sit at the archive
// root: the startup command looks for index.js in the server root, and a
// nested folder is the most common reason a first upload does not boot.
if (process.platform === 'win32') {
  // Get-ChildItem piped in, NOT `-Path <dir>\*`: the wildcard form re-creates
  // the staging folder inside the archive, which puts index.js one level down
  // and is precisely why a first upload fails to boot.
  execFileSync('powershell', [
    '-NoProfile', '-Command',
    `Get-ChildItem -LiteralPath '${stage}' | Compress-Archive -DestinationPath '${zip}' -CompressionLevel Optimal`,
  ], { stdio: 'inherit' });
} else {
  execFileSync('zip', ['-r', '-9', zip, '.'], { cwd: stage, stdio: 'inherit' });
}

const checksum = createHash('sha256').update(readFileSync(zip)).digest('hex');
writeFileSync(checksumFile, `${checksum}  mylecture-telegram-bot.zip\n`);
writeFileSync(releaseFile, [
  `Commit: ${commit}`,
  `Build-Version: ${buildVersion}`,
  `SHA256: ${checksum}`,
  '',
].join('\n'));

console.log(`\nPackaged: ${zip}`);
console.log(`Build version: ${buildVersion}`);
console.log(`SHA256: ${checksum}`);
console.log(`Release record: ${releaseFile}`);
console.log('Upload its FOUR files to the server root, set the startup command');
console.log('to `node index.js`, and make sure the panel runs `npm install`.');
console.log(`Set GIT_SHA=${buildVersion} in the panel so the boot log identifies this release.`);
