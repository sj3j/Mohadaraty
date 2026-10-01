/**
 * Polyfills for modern PDF.js (v5/v6) in environments like iOS Safari / WKWebView
 * where newer ECMAScript methods are not yet natively implemented.
 *
 * 1. Map.prototype.getOrInsertComputed:
 *    Introduced in ECMAScript 2026 / TC39 stage 3, used heavily in PDF.js transport and worker
 *    for caching promises, glyphs, and annotations. Missing in WebKit / Safari < 26.2.
 *
 * 2. Promise.withResolvers:
 *    Introduced in ECMAScript 2024. Supported in Safari 17.4+, but missing in older iOS versions.
 *
 * Both are defined with `enumerable: false` to ensure prototype iteration (`for...in`)
 * is not polluted, which PDF.js explicitly asserts against.
 */

declare global {
  interface Map<K, V> {
    getOrInsertComputed(key: K, callbackFn: (key: K) => V): V;
  }

  interface PromiseConstructor {
    withResolvers<T>(): {
      promise: Promise<T>;
      resolve: (value: T | PromiseLike<T>) => void;
      reject: (reason?: any) => void;
    };
  }
}

if (typeof Map.prototype.getOrInsertComputed !== 'function') {
  Object.defineProperty(Map.prototype, 'getOrInsertComputed', {
    value: function <K, V>(
      this: Map<K, V>,
      key: K,
      callbackFn: (key: K) => V,
    ): V {
      if (this.has(key)) {
        return this.get(key)!;
      }
      const value = callbackFn(key);
      this.set(key, value);
      return value;
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

if (typeof (Promise as any).withResolvers !== 'function') {
  Object.defineProperty(Promise, 'withResolvers', {
    value: function <T>() {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: any) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

export {};
