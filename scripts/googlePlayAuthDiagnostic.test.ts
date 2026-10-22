/**
 * Google Play OAuth Artifact Verification Suite
 *
 * Replaces the misleading diagnostic assertions with true artifact verification:
 * 1. Derives the expected OAuth Web Client ID dynamically from the matching
 *    Firebase Android configuration in android/app/google-services.json.
 * 2. Verifies Android source strings: default_web_client_id has translatable="false"
 *    and matches the derived Web Client ID.
 * 3. Inspects APK and AAB resource configurations using aapt2 to reject placeholders
 *    (e.g. WILL_BE_OVERRIDDEN) and mismatched values.
 * 4. Verifies the artifact checker fails against captured Arabic and English Play APKs.
 * 5. Verifies the rebuilt AAB and generated language splits either inherit the default
 *    or match the expected client ID with zero localized overrides.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync, spawnSync } from 'child_process';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.error(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// 1. Derive Expected Web Client ID from Firebase Android Configuration
// ---------------------------------------------------------------------------
console.log('=== Step 1: Firebase Android Configuration ===\n');

const repoRoot = path.resolve('.');
const googleServicesPath = path.join(repoRoot, 'android/app/google-services.json');

if (!fs.existsSync(googleServicesPath)) {
  console.error(`Missing google-services.json at ${googleServicesPath}`);
  process.exit(1);
}

const googleServices = JSON.parse(fs.readFileSync(googleServicesPath, 'utf8'));
const androidClient = googleServices.client?.find(
  (c: any) => c.client_info?.android_client_info?.package_name === 'com.mohadaraty.app'
);

check('Found com.mohadaraty.app client in google-services.json', !!androidClient);

const webOAuthClient = androidClient?.oauth_client?.find((oc: any) => oc.client_type === 3);
const expectedWebClientId: string = webOAuthClient?.client_id || '';

check(
  `Derived expected Web Client ID (client_type: 3): ${expectedWebClientId.substring(0, 30)}...`,
  Boolean(expectedWebClientId && expectedWebClientId.endsWith('.apps.googleusercontent.com') && expectedWebClientId !== 'WILL_BE_OVERRIDDEN'),
  `Derived value: ${expectedWebClientId}`
);

// ---------------------------------------------------------------------------
// 2. Verify Android Source Resources
// ---------------------------------------------------------------------------
console.log('\n=== Step 2: Source Resource Definitions ===\n');

const stringsXmlPath = path.join(repoRoot, 'android/app/src/main/res/values/strings.xml');
const stringsXml = fs.existsSync(stringsXmlPath) ? fs.readFileSync(stringsXmlPath, 'utf8') : '';

check('android/app/src/main/res/values/strings.xml exists', fs.existsSync(stringsXmlPath));

const translatableMatch = stringsXml.match(/<string\s+[^>]*name="default_web_client_id"[^>]*>([\s\S]*?)<\/string>/);
const hasTranslatableFalse = /<string\s+[^>]*name="default_web_client_id"[^>]*translatable="false"/.test(stringsXml) ||
  /<string\s+[^>]*translatable="false"[^>]*name="default_web_client_id"/.test(stringsXml);

check('default_web_client_id is marked translatable="false"', hasTranslatableFalse);

const sourceClientId = translatableMatch ? translatableMatch[1].trim() : '';
check(
  'Source strings.xml default_web_client_id matches expected Web Client ID',
  sourceClientId === expectedWebClientId,
  `Source has: "${sourceClientId}", expected: "${expectedWebClientId}"`
);

// Verify no localized values-XX directory overrides default_web_client_id
const resDir = path.join(repoRoot, 'android/app/src/main/res');
const localizedDirs = fs.existsSync(resDir)
  ? fs.readdirSync(resDir).filter((d) => d.startsWith('values-') && fs.statSync(path.join(resDir, d)).isDirectory())
  : [];

let localizedOverridesFound = 0;
for (const dir of localizedDirs) {
  const locStrings = path.join(resDir, dir, 'strings.xml');
  if (fs.existsSync(locStrings)) {
    const content = fs.readFileSync(locStrings, 'utf8');
    if (content.includes('default_web_client_id')) {
      localizedOverridesFound++;
      console.error(`  FAIL  Found unexpected localized override in ${locStrings}`);
    }
  }
}
check('No localized values-*/strings.xml override default_web_client_id in source', localizedOverridesFound === 0);

// ---------------------------------------------------------------------------
// 3. Locate AAPT2 and Bundletool
// ---------------------------------------------------------------------------
function resolveAapt2(): string {
  const sdk =
    process.env.ANDROID_HOME ||
    process.env.ANDROID_SDK_ROOT ||
    path.join(process.env.LOCALAPPDATA || '', 'Android/Sdk');

  const buildToolsDir = path.join(sdk, 'build-tools');
  if (fs.existsSync(buildToolsDir)) {
    const versions = fs.readdirSync(buildToolsDir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) {
      const candidate = path.join(buildToolsDir, v, process.platform === 'win32' ? 'aapt2.exe' : 'aapt2');
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  // Fallback to PATH
  return process.platform === 'win32' ? 'aapt2.exe' : 'aapt2';
}

function resolveBundletool(): string | null {
  const candidates = [
    path.join(repoRoot, 'scripts/lib/bundletool.jar'),
    path.join(os.tmpdir(), 'bundletool.jar'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const aapt2 = resolveAapt2();
const bundletool = resolveBundletool();

// ---------------------------------------------------------------------------
// 4. Resource Inspector for APKs
// ---------------------------------------------------------------------------
export interface ConfigEntry {
  config: string;
  value: string;
}

export interface ApkResourceReport {
  present: boolean;
  entries: ConfigEntry[];
  hasPlaceholder: boolean;
  mismatchedValues: string[];
  ok: boolean;
}

export function inspectApkOAuthResources(apkPath: string, expectedId: string): ApkResourceReport {
  if (!fs.existsSync(apkPath)) {
    throw new Error(`APK does not exist: ${apkPath}`);
  }

  let dump = '';
  try {
    dump = execFileSync(aapt2, ['dump', 'resources', apkPath], {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    const stderr = String(err.stderr || err.message || '');
    if (stderr.includes('Failed to retrieve resource table') || stderr.includes('could not identify format')) {
      // APK has no resource table (e.g. pure ABI native library split)
      return {
        present: false,
        entries: [],
        hasPlaceholder: false,
        mismatchedValues: [],
        ok: true,
      };
    }
    throw err;
  }

  const lines = dump.split(/\r?\n/);
  let capturing = false;
  const entries: ConfigEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('string/default_web_client_id')) {
      capturing = true;
      continue;
    }
    if (capturing) {
      if (/^\s*resource\s+0x/i.test(line)) {
        break; // Moved to next resource
      }
      const match = line.match(/^\s*\(([^)]*)\)\s+"([^"]*)"/);
      if (match) {
        entries.push({ config: match[1].trim(), value: match[2].trim() });
      }
    }
  }

  const hasPlaceholder = entries.some((e) => e.value.includes('WILL_BE_OVERRIDDEN'));
  const mismatchedValues = entries
    .filter((e) => e.value !== expectedId)
    .map((e) => `(${e.config || 'default'}): "${e.value}"`);

  // An APK resource is valid if either:
  // 1. It is absent (meaning a split APK inherits default from base)
  // 2. All configurations present exactly match expectedId and none is a placeholder
  const ok = entries.length === 0 || (!hasPlaceholder && mismatchedValues.length === 0);

  return {
    present: entries.length > 0,
    entries,
    hasPlaceholder,
    mismatchedValues,
    ok,
  };
}

// ---------------------------------------------------------------------------
// 5. Verification Against Captured Play APKs (Negative / Red Test)
// ---------------------------------------------------------------------------
console.log('\n=== Step 3: Verification Against Captured Play APKs ===\n');

const capturedDir = [
  path.join(repoRoot, 'scratch/captured_play_apks'),
  path.join(os.tmpdir(), 'mohadaraty-play-auth-954eb12d372a493e90701012a16ecef6'),
].find((d) => fs.existsSync(d) && fs.existsSync(path.join(d, 'split_config.ar.apk')));

if (capturedDir) {
  const baseApk = path.join(capturedDir, 'play-base.apk');
  const arApk = path.join(capturedDir, 'split_config.ar.apk');
  const enApk = path.join(capturedDir, 'split_config.en.apk');

  if (fs.existsSync(baseApk)) {
    const baseReport = inspectApkOAuthResources(baseApk, expectedWebClientId);
    check(
      'Captured base APK contains valid default Web Client ID',
      baseReport.ok && baseReport.present,
      JSON.stringify(baseReport.entries)
    );
  }

  if (fs.existsSync(arApk)) {
    const arReport = inspectApkOAuthResources(arApk, expectedWebClientId);
    check(
      'Artifact checker REJECTS captured Arabic language APK (placeholder detected)',
      !arReport.ok && arReport.hasPlaceholder,
      arReport.hasPlaceholder ? 'Detected WILL_BE_OVERRIDDEN' : 'Failed to detect placeholder'
    );
  }

  if (fs.existsSync(enApk)) {
    const enReport = inspectApkOAuthResources(enApk, expectedWebClientId);
    check(
      'Artifact checker REJECTS captured English language APK (placeholder detected)',
      !enReport.ok && enReport.hasPlaceholder,
      enReport.hasPlaceholder ? 'Detected WILL_BE_OVERRIDDEN' : 'Failed to detect placeholder'
    );
  }
} else {
  console.log('  INFO  No captured Play APK directory found in scratch/ or tmp, skipping negative APK fixtures.');
}

// ---------------------------------------------------------------------------
// 6. Verification Against Rebuilt AAB & Generated Split APKs
// ---------------------------------------------------------------------------
console.log('\n=== Step 4: Verification Against Rebuilt AAB & Split APKs ===\n');

const releaseAabPath = path.join(repoRoot, 'android/app/build/outputs/bundle/release/app-release.aab');

if (fs.existsSync(releaseAabPath) && bundletool) {
  const tempApksPath = path.join(os.tmpdir(), `check-apks-${Date.now()}.apks`);
  const extractDir = path.join(os.tmpdir(), `check-extracted-${Date.now()}`);

  try {
    fs.mkdirSync(extractDir, { recursive: true });

    // Build splits from the AAB using bundletool
    execFileSync('java', [
      '-jar',
      bundletool,
      'build-apks',
      `--bundle=${releaseAabPath}`,
      `--output=${tempApksPath}`,
      '--mode=default',
    ], { stdio: 'pipe' });

    // Unzip the apks archive
    spawnSync('tar', ['-xf', tempApksPath, '-C', extractDir], { stdio: 'pipe' });

    const splitsDir = path.join(extractDir, 'splits');
    if (fs.existsSync(splitsDir)) {
      const splitFiles = fs.readdirSync(splitsDir).filter((f) => f.endsWith('.apk'));

      const masterApk = path.join(splitsDir, 'base-master.apk');
      if (fs.existsSync(masterApk)) {
        const masterReport = inspectApkOAuthResources(masterApk, expectedWebClientId);
        check(
          'Rebuilt base-master.apk contains correct default OAuth Client ID',
          masterReport.ok && masterReport.present,
          JSON.stringify(masterReport.entries)
        );
      }

      // Check Arabic and English language splits
      const arSplit = path.join(splitsDir, 'base-ar.apk');
      if (fs.existsSync(arSplit)) {
        const arReport = inspectApkOAuthResources(arSplit, expectedWebClientId);
        check(
          'Rebuilt base-ar.apk has no placeholder and either inherits default or matches client ID',
          arReport.ok && !arReport.hasPlaceholder,
          JSON.stringify(arReport.entries)
        );
      }

      const enSplit = path.join(splitsDir, 'base-en.apk');
      if (fs.existsSync(enSplit)) {
        const enReport = inspectApkOAuthResources(enSplit, expectedWebClientId);
        check(
          'Rebuilt base-en.apk has no placeholder and either inherits default or matches client ID',
          enReport.ok && !enReport.hasPlaceholder,
          JSON.stringify(enReport.entries)
        );
      }

      // Check ALL generated split APKs for any placeholder
      let anyPlaceholderFound = false;
      for (const split of splitFiles) {
        const report = inspectApkOAuthResources(path.join(splitsDir, split), expectedWebClientId);
        if (report.hasPlaceholder || !report.ok) {
          anyPlaceholderFound = true;
          console.error(`  FAIL  Split ${split} failed verification:`, report);
        }
      }
      check('All generated split APKs contain no placeholders or client ID mismatches', !anyPlaceholderFound);
    }
  } catch (err: any) {
    check('Generated split APK verification from rebuilt AAB', false, err.message);
  } finally {
    try {
      if (fs.existsSync(tempApksPath)) fs.unlinkSync(tempApksPath);
      if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
} else if (!fs.existsSync(releaseAabPath)) {
  console.log(`  INFO  Release AAB not yet built at ${releaseAabPath}. Run build:aab first to verify rebuilt artifact.`);
} else {
  console.log('  INFO  bundletool not available for splitting AAB.');
}

console.log(`\n==============================================`);
console.log(`Diagnostic & Artifact Verification Summary: ${passed} passed, ${failed} failed.`);
console.log(`==============================================\n`);

if (failed > 0) {
  process.exit(1);
}
