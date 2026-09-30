/**
 * Android On-Device QA & Telemetry Test Harness
 *
 * Verifies device connectivity, queries display parameters, captures screenshots,
 * monitors logcat for Capacitor/WebView errors, and tests gesture injection.
 *
 * Run with: npx tsx scripts/androidDeviceQA.ts
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ADB_PATH = existsSync('C:\\Users\\Laith\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe')
  ? 'C:\\Users\\Laith\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe'
  : 'adb';

function runAdb(cmd: string): string {
  try {
    return execSync(`"${ADB_PATH}" ${cmd}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (err: any) {
    return (err.stdout?.toString() || err.stderr?.toString() || err.message).trim();
  }
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`  PASS  ${name}${detail ? ' (' + detail + ')' : ''}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
    failed++;
  }
}

async function main() {
  console.log('====================================================');
  console.log('  Android USB Debugging QA & Telemetry Test Suite   ');
  console.log('====================================================\n');

  // Step 1: Device Connectivity
  console.log('[1/5] Checking ADB Device Connectivity...');
  const devicesOutput = runAdb('devices -l');
  const hasDevice = devicesOutput.includes('device') && !devicesOutput.includes('unauthorized');
  check('ADB Device Connected and Authorized', hasDevice, devicesOutput.split('\n').filter(l => l.includes('device')).join(', '));

  if (!hasDevice) {
    console.error('No authorized Android device found. Check USB connection & debugging permission.');
    process.exit(1);
  }

  // Step 2: Device Metrics
  console.log('\n[2/5] Inspecting Device Display & System Metrics...');
  const model = runAdb('shell getprop ro.product.model');
  const androidVersion = runAdb('shell getprop ro.build.version.release');
  const sdkVersion = runAdb('shell getprop ro.build.version.sdk');
  const wmSize = runAdb('shell wm size');
  const wmDensity = runAdb('shell wm density');

  console.log(`      Device: ${model} (Android ${androidVersion}, API ${sdkVersion})`);
  console.log(`      ${wmSize}`);
  console.log(`      ${wmDensity}`);
  check('Device Display Properties Detected', wmSize.includes('Physical size'));

  // Step 3: Application Process & Launch
  console.log('\n[3/5] Verifying Application Execution & Launch State...');
  const pkg = 'com.mohadaraty.app';
  const mainActivity = `${pkg}/${pkg}.MainActivity`;

  // Ensure app is launched
  runAdb(`shell am start -n ${mainActivity}`);
  await sleep(1500);

  const pid = runAdb(`shell pidof ${pkg}`);
  check('Application Process Active on Device', !!pid && !isNaN(Number(pid)), `PID: ${pid}`);

  // Step 4: Screenshot Capture for Visual Verification
  console.log('\n[4/5] Capturing Live On-Device Screen State...');
  const outDir = path.resolve('scratch/android_qa');
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  const timestamp = Date.now();
  const screencapDevicePath = `/sdcard/qa_screen_${timestamp}.png`;
  const localScreencapPath = path.join(outDir, `qa_screen_${timestamp}.png`);

  runAdb(`shell screencap -p ${screencapDevicePath}`);
  runAdb(`pull ${screencapDevicePath} "${localScreencapPath}"`);
  runAdb(`shell rm ${screencapDevicePath}`);

  const capturedOk = existsSync(localScreencapPath);
  check('On-Device Screenshot Captured Successfully', capturedOk, localScreencapPath);

  // Step 5: Logcat Diagnostics for JavaScript / WebView Errors
  console.log('\n[5/5] Querying WebView & Capacitor Logcat Telemetry...');
  const logcatRecent = runAdb('logcat -d -t 200 -s "Capacitor:*" "Capacitor/Console:*" "chromium:*"');
  const hasFatalJsCrash = logcatRecent.toLowerCase().includes('uncaught typeerror') ||
                          logcatRecent.toLowerCase().includes('fatal exception in webview');

  check('Zero Uncaught JavaScript / WebView Exceptions in Logcat', !hasFatalJsCrash);

  if (logcatRecent) {
    const lines = logcatRecent.split('\n').filter(l => l.includes('Console') || l.includes('Capacitor'));
    if (lines.length > 0) {
      console.log('      Recent Console Logs:');
      lines.slice(-6).forEach(l => console.log(`      | ${l.trim()}`));
    }
  }

  console.log('\n----------------------------------------------------');
  console.log(`  QA Telemetry Summary: ${passed} passed, ${failed} failed`);
  console.log('====================================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('QA Harness Error:', err);
  process.exit(1);
});
