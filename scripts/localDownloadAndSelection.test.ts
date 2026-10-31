import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { exportPdfToDevice } from '../src/lib/deviceExport';
import { safeFileName } from '../src/lib/shareFileName';
import { downloadNativeFile, openNativePdf } from '../src/lib/nativeFileTransfer';
import { shareFile } from '../src/lib/shareFile';

const pdfBytes = new TextEncoder().encode('%PDF-1.7 test');

function installNativeStagingMocks(platform: 'android' | 'ios') {
  (globalThis as any).__mockIsNative = true;
  (globalThis as any).__mockPlatform = platform;
  (globalThis as any).__mockAndroidSdk = 35;
  (globalThis as any).__mockFs = {
    mkdir: async () => {},
    readFile: async () => { throw new Error('No manifest'); },
    readdir: async () => ({ files: [] }),
    getUri: async (opts: any) => ({ uri: `file:///private/${opts.path}` }),
    stat: async () => ({ size: pdfBytes.byteLength }),
  };
  (globalThis as any).__mockFt = {
    addListener: async () => ({ remove: async () => {} }),
    downloadFile: async (opts: any) => ({ path: opts.path }),
  };
}

function clearNativeMocks() {
  for (const key of ['__mockIsNative', '__mockPlatform', '__mockAndroidSdk', '__mockFs', '__mockFt', '__mockNativeFiles', '__mockShare']) {
    delete (globalThis as any)[key];
  }
}

test('1. safeFileName produces sanitized, URL-safe filenames for Arabic and English', () => {
  const arName = safeFileName('محاضرة علم الأدوية (الأولى)', 'pdf');
  assert.ok(arName.endsWith('.pdf'));
  assert.ok(arName.includes('الأدوية'));
  assert.ok(!arName.includes('(') && !arName.includes(')'), 'Special characters should be replaced safely');

  const enName = safeFileName('Pharmacology 101 - Lecture #1', 'pdf');
  assert.ok(enName.endsWith('.pdf'));
  assert.ok(enName.startsWith('Pharmacology 101 - Lecture'));
});

test('2. exportPdfToDevice triggers browser forceDownload on web / PC platform', async () => {
  (globalThis as any).__mockIsNative = false;

  let downloadedUrl = '';
  let downloadedFileName = '';

  // Mock global DOM / window for forceDownload
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  try {
    (globalThis as any).fetch = async () => new Response(pdfBytes, { status: 200, headers: { 'content-type': 'application/pdf' } });
    (globalThis as any).window = {
      URL: {
        createObjectURL: () => 'blob:test-pdf',
        revokeObjectURL: () => {},
      },
    };
    (globalThis as any).document = {
      createElement: (tag: string) => {
        const el: any = { tag };
        return el;
      },
      body: {
        appendChild: (el: any) => {
          if (el.tag === 'a') {
            downloadedUrl = el.href;
            downloadedFileName = el.download;
            el.click = () => {};
          }
        },
        removeChild: () => {},
      },
    };

    const result = await exportPdfToDevice({
      url: 'https://example.com/lectures/sample.pdf',
      title: 'محاضرة الفسيولوجي',
      lectureId: 'lec-101',
    });

    await new Promise(resolve => setTimeout(resolve, 120));

    assert.equal(result.success, true);
    assert.equal(downloadedUrl, 'blob:test-pdf');
    assert.ok(downloadedFileName.includes('الفسيولوجي'));
    assert.ok(downloadedFileName.endsWith('.pdf'));
  } finally {
    (globalThis as any).document = originalDocument;
    (globalThis as any).fetch = originalFetch;
    (globalThis as any).window = originalWindow;
    delete (globalThis as any).__mockIsNative;
  }
});

test('3. exportPdfToDevice on Android publishes through the native Downloads API', async () => {
  installNativeStagingMocks('android');
  let saved: any = null;
  (globalThis as any).__mockNativeFiles = {
    savePdf: async (opts: any) => {
      saved = opts;
      return { status: 'saved', location: 'Downloads/Mohadaraty', bytes: pdfBytes.byteLength };
    },
  };

  try {
    const result = await exportPdfToDevice({
      url: 'https://example.com/lectures/sample.pdf',
      title: 'Biochemistry 01',
      lectureId: 'lec-android',
    });

    assert.equal(result.success, true);
    assert.ok(saved.filename.includes('Biochemistry 01.pdf'));
    assert.ok(saved.sourceUri.startsWith('file:///private/shared/'));
    assert.equal(saved.mimeType, 'application/pdf');
  } finally {
    clearNativeMocks();
  }
});

test('4. exportPdfToDevice on iOS saves automatically into its Files-visible Documents folder', async () => {
  installNativeStagingMocks('ios');
  let saved: any = null;
  (globalThis as any).__mockNativeFiles = {
    savePdf: async (opts: any) => {
      saved = opts;
      return { status: 'saved', location: 'On My iPhone/Mohadaraty', bytes: pdfBytes.byteLength };
    },
  };

  try {
    const result = await exportPdfToDevice({
      url: 'https://example.com/lectures/sample.pdf',
      title: 'Pathology Lecture 2',
      lectureId: 'lec-ios',
    });

    assert.equal(result.success, true);
    assert.equal(saved.filename, 'Pathology Lecture 2.pdf');
    assert.ok(saved.sourceUri.startsWith('file:///private/shared/'));
  } finally {
    clearNativeMocks();
  }
});

test('5. Android 7-10 private transfer bypasses the permission-gated Capacitor transfer and retries one transient error', async () => {
  installNativeStagingMocks('android');
  (globalThis as any).__mockAndroidSdk = 29;
  let privateAttempts = 0;
  let stockAttempts = 0;
  (globalThis as any).__mockFt.downloadFile = async () => { stockAttempts++; return { path: '' }; };
  (globalThis as any).__mockNativeFiles = {
    getRuntimeInfo: async () => ({ platform: 'android', sdkInt: 29 }),
    addListener: async () => ({ remove: async () => {} }),
    downloadPrivate: async (opts: any) => {
      privateAttempts++;
      if (privateAttempts === 1) throw Object.assign(new Error('network unreachable'), { code: 'NATIVE_TRANSFER_NETWORK' });
      return { path: opts.path, bytes: pdfBytes.byteLength };
    },
  };
  try {
    const result = await downloadNativeFile({ url: 'https://example.test/lecture.pdf', path: 'file:///private/staging.pdf' });
    assert.equal(result.bytes, pdfBytes.byteLength);
    assert.equal(privateAttempts, 2);
    assert.equal(stockAttempts, 0);
  } finally {
    clearNativeMocks();
  }
});

test('6. a native save failure is not reported as success', async () => {
  installNativeStagingMocks('android');
  (globalThis as any).__mockNativeFiles = {
    savePdf: async () => { throw Object.assign(new Error('MediaStore rejected insert'), { code: 'FILE_SAVE_FAILED' }); },
  };
  try {
    const result = await exportPdfToDevice({
      url: 'https://example.test/lecture.pdf', title: 'Failed save', lectureId: 'failed-save',
    });
    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'FILE_SAVE_FAILED');
  } finally {
    clearNativeMocks();
  }
});

test('7. a cancelled legacy save picker is reported as cancellation', async () => {
  installNativeStagingMocks('android');
  (globalThis as any).__mockNativeFiles = {
    savePdf: async () => { throw Object.assign(new Error('Save cancelled'), { code: 'FILE_CANCELLED' }); },
  };
  try {
    const result = await exportPdfToDevice({
      url: 'https://example.test/lecture.pdf', title: 'Cancelled save', lectureId: 'cancel-save',
    });
    assert.equal(result.success, false);
    assert.equal(result.cancelled, true);
    assert.equal(result.errorCode, undefined);
  } finally {
    clearNativeMocks();
  }
});

test('8. permanent transfer errors are not retried', async () => {
  installNativeStagingMocks('android');
  (globalThis as any).__mockAndroidSdk = 29;
  let attempts = 0;
  (globalThis as any).__mockNativeFiles = {
    getRuntimeInfo: async () => ({ platform: 'android', sdkInt: 29 }),
    addListener: async () => ({ remove: async () => {} }),
    downloadPrivate: async () => {
      attempts++;
      throw Object.assign(new Error('HTTP 404'), { code: 'NATIVE_TRANSFER_HTTP', data: { httpStatus: 404 } });
    },
  };
  try {
    await assert.rejects(() => downloadNativeFile({
      url: 'https://example.test/missing.pdf', path: 'file:///private/missing.pdf',
    }));
    assert.equal(attempts, 1);
  } finally {
    clearNativeMocks();
  }
});

test('9. Android 7-10 share stages through the permission-free private transfer', async () => {
  installNativeStagingMocks('android');
  (globalThis as any).__mockAndroidSdk = 29;
  let privateTransfers = 0;
  let sharedFiles: string[] = [];
  (globalThis as any).__mockNativeFiles = {
    getRuntimeInfo: async () => ({ platform: 'android', sdkInt: 29 }),
    downloadPrivate: async (opts: any) => {
      privateTransfers++;
      return { path: opts.path, bytes: pdfBytes.byteLength };
    },
  };
  (globalThis as any).__mockShare = {
    share: async (opts: any) => { sharedFiles = opts.files; },
  };
  try {
    const result = await shareFile({
      url: 'https://example.test/huawei.pdf',
      name: 'Huawei lecture',
      extension: 'pdf',
      mimeType: 'application/pdf',
      lectureId: 'huawei-lecture',
    });
    assert.equal(result, 'shared');
    assert.equal(privateTransfers, 1);
    assert.deepEqual(sharedFiles, ['file:///private/shared/Huawei lecture.pdf']);
  } finally {
    clearNativeMocks();
  }
});

test('10. native projects keep the public-save compatibility contracts', () => {
  const androidPlugin = readFileSync(new URL('../android/app/src/main/java/com/mohadaraty/app/NativeFilesPlugin.java', import.meta.url), 'utf8');
  const manifest = readFileSync(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
  const infoPlist = readFileSync(new URL('../ios/App/App/Info.plist', import.meta.url), 'utf8');
  assert.match(androidPlugin, /MediaStore\.Downloads\.EXTERNAL_CONTENT_URI/);
  assert.match(androidPlugin, /Intent\.ACTION_CREATE_DOCUMENT/);
  assert.match(manifest, /WRITE_EXTERNAL_STORAGE[^>]+maxSdkVersion="28"/);
  assert.match(infoPlist, /<key>UIFileSharingEnabled<\/key>\s*<true\/>/);
  assert.match(infoPlist, /<key>LSSupportsOpeningDocumentsInPlace<\/key>\s*<true\/>/);
});

test('11. Multi-selection state management handles toggle, select all, and deselect all', () => {
  const lectures = [
    { id: 'l1', title: 'Lecture 1' },
    { id: 'l2', title: 'Lecture 2' },
    { id: 'l3', title: 'Lecture 3' },
  ];

  let selected = new Set<string>();

  // Toggle single
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selected = next;
  };

  toggle('l1');
  assert.equal(selected.has('l1'), true);
  assert.equal(selected.size, 1);

  toggle('l2');
  assert.equal(selected.size, 2);

  toggle('l1'); // untoggle
  assert.equal(selected.has('l1'), false);
  assert.equal(selected.size, 1);

  // Select all
  selected = new Set(lectures.map(l => l.id));
  assert.equal(selected.size, 3);

  // Deselect all
  selected = new Set();
  assert.equal(selected.size, 0);
});

test('12. exportPdfToDevice provides content URI and localized feedback, and openNativePdf launches viewer', async () => {
  installNativeStagingMocks('android');
  let openedUri = '';
  (globalThis as any).__mockNativeFiles = {
    savePdf: async () => ({
      status: 'saved',
      uri: 'content://media/external/downloads/42',
      location: 'Downloads',
      bytes: pdfBytes.byteLength,
    }),
    openPdf: async (opts: { uri: string }) => {
      openedUri = opts.uri;
      return { opened: true };
    },
  };

  try {
    const arResult = await exportPdfToDevice({
      url: 'https://example.com/lectures/sample.pdf',
      title: 'Biochemistry 01',
      lectureId: 'lec-android-open',
      lang: 'ar',
    });
    assert.equal(arResult.success, true);
    assert.equal(arResult.uri, 'content://media/external/downloads/42');
    assert.equal(arResult.message, 'تم حفظ المحاضرة في مجلد التنزيلات');

    const enResult = await exportPdfToDevice({
      url: 'https://example.com/lectures/sample.pdf',
      title: 'Biochemistry 01',
      lectureId: 'lec-android-open',
      lang: 'en',
    });
    assert.equal(enResult.message, 'Lecture saved to Downloads folder');

    const opened = await openNativePdf(arResult.uri!);
    assert.equal(opened, true);
    assert.equal(openedUri, 'content://media/external/downloads/42');
  } finally {
    clearNativeMocks();
  }
});
