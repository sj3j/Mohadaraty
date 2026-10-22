import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { verifyAllNativeLibraries } from './verify16KbPageAlignment.mjs';

const root = process.cwd();
const requiredOutputs = [
  'mapping.txt',
  'usage.txt',
  'seeds.txt',
  'configuration.txt',
];
const mappingDir = join(root, 'android', 'app', 'build', 'outputs', 'mapping', 'release');

for (const name of requiredOutputs) {
  const path = join(mappingDir, name);
  if (!existsSync(path) || statSync(path).size === 0) {
    throw new Error(`R8 verification failed: missing or empty ${path}`);
  }
}

const buildGradle = readFileSync(join(root, 'android', 'app', 'build.gradle'), 'utf8');
const codeMatch = buildGradle.match(/versionCode\s+(\d+)/);
const expectedCode = codeMatch ? codeMatch[1] : '17';

const manifest = join(
  root,
  'android', 'app', 'build', 'intermediates', 'merged_manifests', 'release',
  'processReleaseManifest', 'AndroidManifest.xml',
);
if (!existsSync(manifest) || !readFileSync(manifest, 'utf8').includes(`android:versionCode="${expectedCode}"`)) {
  throw new Error(`Release manifest is missing or does not contain versionCode ${expectedCode}.`);
}

const binaryProfile = join(
  root,
  'android', 'app', 'build', 'intermediates', 'binary_art_profile', 'release',
  'compileReleaseArtProfile', 'baseline.prof',
);
if (!existsSync(binaryProfile) || statSync(binaryProfile).size === 0) {
  throw new Error(`Baseline Profile verification failed: missing or empty ${binaryProfile}`);
}

verifyAllNativeLibraries([
  'android/app/build/intermediates/merged_native_libs/release/mergeReleaseNativeLibs/out/lib',
  'android/app/build/intermediates/stripped_native_libs/release/stripReleaseDebugSymbols/out/lib',
]);

console.log(`verify-android-optimization: R8 outputs, code ${expectedCode} manifest, compiled Baseline Profile, and 16 KB page-aligned native libs are verified.`);
