/**
 * Verifies compatibility polyfills for PDF.js (Map.prototype.getOrInsertComputed and Promise.withResolvers).
 *
 * Run with:  npx tsx scripts/pdfCompat.test.ts
 */

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
    failed++;
  }
};

console.log('Testing PDF.js Compatibility Polyfills:');

// Test 1: Verify native environment does not have getOrInsertComputed by default,
// or verify polyfill installation.
import '../src/lib/pdfPolyfills';

// Check Map.prototype.getOrInsertComputed presence
check('Map.prototype.getOrInsertComputed is a function', typeof (Map.prototype as any).getOrInsertComputed === 'function');

const mapDesc = Object.getOwnPropertyDescriptor(Map.prototype, 'getOrInsertComputed');
check('Map.prototype.getOrInsertComputed is non-enumerable', mapDesc?.enumerable === false);

// Test functionality: retrieval, insertion, and callback execution
{
  const map = new Map<string, number>();
  let callCount = 0;
  const factory = (k: string) => {
    callCount++;
    return k.length;
  };

  const v1 = (map as any).getOrInsertComputed('hello', factory);
  check('inserts and returns computed value for new key', v1 === 5 && map.get('hello') === 5);
  check('calls factory exactly once for new key', callCount === 1);

  const v2 = (map as any).getOrInsertComputed('hello', factory);
  check('returns existing value without calling factory again', v2 === 5);
  check('does not call factory when key exists', callCount === 1);

  // Test with undefined as valid value
  const map2 = new Map<string, any>();
  let called2 = 0;
  map2.set('empty', undefined);
  const vEmpty = (map2 as any).getOrInsertComputed('empty', () => { called2++; return 'fallback'; });
  check('handles keys with undefined value without recomputing', vEmpty === undefined && called2 === 0);
}

// Test Promise.withResolvers presence & functionality
check('Promise.withResolvers is a function', typeof (Promise as any).withResolvers === 'function');

const promiseDesc = Object.getOwnPropertyDescriptor(Promise, 'withResolvers');
check('Promise.withResolvers is non-enumerable', promiseDesc?.enumerable === false);

(async () => {
  // Promise resolution test
  const { promise: p1, resolve: r1 } = (Promise as any).withResolvers();
  setTimeout(() => r1('success'), 10);
  const res1 = await p1;
  check('Promise.withResolvers resolves correctly', res1 === 'success');

  // Promise rejection test
  const { promise: p2, reject: r2 } = (Promise as any).withResolvers();
  setTimeout(() => r2(new Error('fail-test')), 10);
  try {
    await p2;
    check('Promise.withResolvers rejects correctly', false, 'Should have thrown');
  } catch (err: any) {
    check('Promise.withResolvers rejects correctly', err?.message === 'fail-test');
  }

  // Test WorkerTransport cache pattern from PDF.js
  const methodPromises = new Map<string, Promise<string>>();
  let sendCount = 0;
  const sendWithPromise = (name: string) => {
    sendCount++;
    return Promise.resolve(`response-for-${name}`);
  };

  const cacheSimpleMethod = (name: string) =>
    (methodPromises as any).getOrInsertComputed(name, () => sendWithPromise(name));

  const pCall1 = cacheSimpleMethod('GetOptionalContentConfig');
  const pCall2 = cacheSimpleMethod('GetOptionalContentConfig');
  const [out1, out2] = await Promise.all([pCall1, pCall2]);

  check('PDF.js cache pattern: returns cached promise', pCall1 === pCall2);
  check('PDF.js cache pattern: sends message only once', sendCount === 1);
  check('PDF.js cache pattern: resolves to expected data', out1 === 'response-for-GetOptionalContentConfig' && out2 === out1);

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
