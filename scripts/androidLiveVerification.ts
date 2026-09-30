/**
 * Live Android WebView CDP Verification via USB Debugging
 *
 * Connects directly to the physical Android device's WebView over Chrome DevTools Protocol
 * (port 9222 forwarded from @webview_devtools_remote_<PID>).
 *
 * Run with: npx tsx scripts/androidLiveVerification.ts
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

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
  console.log('--- Android Physical Device Live CDP Test ---');

  // Step 1: Detect app PID and forward port
  const pid = runAdb('shell pidof com.mohadaraty.app');
  check('App Process Found on Device', !!pid && !isNaN(Number(pid)), `PID: ${pid}`);

  const forwardResult = runAdb(`forward tcp:9222 localabstract:webview_devtools_remote_${pid}`);
  console.log(`Forwarded tcp:9222 -> localabstract:webview_devtools_remote_${pid} ${forwardResult ? '(' + forwardResult + ')' : ''}`);

  // Step 2: Query endpoints
  const res = await fetch('http://127.0.0.1:9222/json');
  const targets = (await res.json()) as Array<{ id: string; url: string; webSocketDebuggerUrl: string; title: string }>;

  check('DevTools Target Available', targets.length > 0, `Found ${targets.length} targets`);
  const target = targets.find(t => t.url.includes('localhost') || t.url.includes('http')) || targets[0];
  if (!target || !target.webSocketDebuggerUrl) {
    console.error('No inspectable target with webSocketDebuggerUrl found.');
    process.exit(1);
  }

  console.log(`Target: ${target.title} (${target.url})`);

  // Step 3: Open WebSocket to WebView
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let msgId = 1;
  const pending = new Map<number, (res: any) => void>();

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data as string);
    if (data.id && pending.has(data.id)) {
      pending.get(data.id)!(data.result);
      pending.delete(data.id);
    }
  };

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(e);
  });

  check('CDP WebSocket Connected to Android WebView', true);

  function sendCdp(method: string, params: any = {}): Promise<any> {
    const id = msgId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  await sendCdp('Runtime.enable');

  // Step 4: Evaluate Runtime environment
  const evalUA = await sendCdp('Runtime.evaluate', {
    expression: 'navigator.userAgent',
    returnByValue: true,
  });
  const ua = evalUA?.result?.value || '';
  check('User Agent Detected', ua.includes('Android') && ua.includes('Chrome'), ua.slice(0, 60) + '...');

  const evalCap = await sendCdp('Runtime.evaluate', {
    expression: 'typeof window.Capacitor !== "undefined"',
    returnByValue: true,
  });
  check('Capacitor Bridge Initialized in WebView', evalCap?.result?.value === true);

  // Step 5: Check DOM and touch event support
  const evalTouch = await sendCdp('Runtime.evaluate', {
    expression: '("ontouchstart" in window) && (navigator.maxTouchPoints > 0)',
    returnByValue: true,
  });
  check('Native Multi-Touch Points Supported by WebView', evalTouch?.result?.value === true);

  // Step 6: Check CSS touch-action and -webkit-overflow-scrolling support
  const evalCss = await sendCdp('Runtime.evaluate', {
    expression: 'CSS.supports("touch-action", "pan-x pan-y") && CSS.supports("overscroll-behavior", "contain")',
    returnByValue: true,
  });
  check('Modern CSS Touch-Action & Overscroll Supported', evalCss?.result?.value === true);

  // Step 7: Check for any window errors
  const evalErrors = await sendCdp('Runtime.evaluate', {
    expression: 'window.__lastError || null',
    returnByValue: true,
  });
  check('No Unhandled Window Script Errors', evalErrors?.result?.value === null);

  ws.close();

  console.log(`\nLive Device Verification Summary: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Error during live verification:', err);
  process.exit(1);
});
