import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

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

const generatedProfileDir = join(
  root,
  'android', 'app', 'src', 'release', 'generated', 'baselineProfiles',
);
for (const name of ['baseline-prof.txt', 'startup-prof.txt']) {
  const path = join(generatedProfileDir, name);
  if (!existsSync(path) || statSync(path).size === 0) {
    throw new Error(
      `App profile verification failed: missing or empty ${path}. ` +
      'Run :app:generateReleaseBaselineProfile on the Pixel 6 API 35 managed device first.',
    );
  }
}

const manifest = join(
  root,
  'android', 'app', 'build', 'intermediates', 'merged_manifests', 'release',
  'processReleaseManifest', 'AndroidManifest.xml',
);
if (!existsSync(manifest) || !readFileSync(manifest, 'utf8').includes('android:versionCode="15"')) {
  throw new Error('Release manifest is missing or does not contain versionCode 15.');
}

const binaryProfile = join(
  root,
  'android', 'app', 'build', 'intermediates', 'binary_art_profile', 'release',
  'compileReleaseArtProfile', 'baseline.prof',
);
if (!existsSync(binaryProfile) || statSync(binaryProfile).size === 0) {
  throw new Error(`Baseline Profile verification failed: missing or empty ${binaryProfile}`);
}

console.log('verify-android-optimization: R8 outputs, code 15 manifest, and compiled Baseline Profile are present.');
