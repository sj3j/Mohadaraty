import test from 'node:test';
import assert from 'node:assert/strict';
import { shareMultipleFiles, type ShareFileInput } from '../src/lib/shareFile';

test('1. Native multi-file share passes array of native file:// URIs without FileReader', async () => {
  (globalThis as any).__mockIsNative = true;

  let sharedPayload: any = null;
  (globalThis as any).__mockShare = {
    share: async (options: any) => {
      sharedPayload = options;
      return {};
    },
  };

  const mockFiles: Record<string, string> = {
    'lectures/lec-1.pdf': 'mock_pdf_1',
    'lectures/lec-2.pdf': 'mock_pdf_2',
    'lectures/lec-3.pdf': 'mock_pdf_3',
  };

  (globalThis as any).__mockFs = {
    readdir: async () => ({ files: [] }),
    deleteFile: async () => {},
    mkdir: async () => {},
    stat: async ({ path }: { path: string }) => {
      if (mockFiles[path] !== undefined) return { size: 1024, mtime: Date.now() };
      throw new Error('Not found');
    },
    copy: async ({ from, to }: { from: string; to: string }) => {
      mockFiles[to] = mockFiles[from] || 'copied';
      return {};
    },
    getUri: async ({ path }: { path: string }) => ({
      uri: `file:///data/user/0/com.mohadaraty.app/cache/${path}`,
    }),
  };

  (globalThis as any).__mockFt = {
    downloadFile: async ({ path }: { path: string }) => {
      mockFiles[path] = 'downloaded';
      return { path };
    },
  };

  // Ensure FileReader does not exist or track its usage
  const originalFileReader = (globalThis as any).FileReader;
  (globalThis as any).FileReader = class {
    constructor() {
      throw new Error('FileReader should NEVER be called during native multi-file sharing');
    }
  };

  try {
    const inputs: ShareFileInput[] = [
      {
        url: 'https://example.com/lec1.pdf',
        name: 'محاضرة الفسيولوجي الأولى',
        extension: 'pdf',
        mimeType: 'application/pdf',
        title: 'الفسيولوجي 1',
        lectureId: 'lec-1',
      },
      {
        url: 'https://example.com/lec2.pdf',
        name: 'محاضرة التشريح الثانية',
        extension: 'pdf',
        mimeType: 'application/pdf',
        title: 'التشريح 2',
        lectureId: 'lec-2',
      },
      {
        url: 'https://example.com/lec3.pdf',
        name: 'محاضرة الأدوية الثالثة',
        extension: 'pdf',
        mimeType: 'application/pdf',
        title: 'الأدوية 3',
        lectureId: 'lec-3',
      },
    ];

    const result = await shareMultipleFiles(inputs, 'حزمة المحاضرات المحددة');

    assert.equal(result, 'shared');
    assert.ok(sharedPayload, 'Share.share should be called');
    assert.equal(sharedPayload.title, 'حزمة المحاضرات المحددة');
    assert.ok(Array.isArray(sharedPayload.files), 'files payload should be an array');
    assert.equal(sharedPayload.files.length, 3, 'Should share all 3 native file URIs');
    for (const uri of sharedPayload.files) {
      assert.ok(uri.startsWith('file://'), `URI should be native file scheme: ${uri}`);
      assert.ok(uri.endsWith('.pdf'), `URI should retain .pdf extension: ${uri}`);
    }
  } finally {
    delete (globalThis as any).__mockIsNative;
    delete (globalThis as any).__mockShare;
    delete (globalThis as any).__mockFs;
    delete (globalThis as any).__mockFt;
    (globalThis as any).FileReader = originalFileReader;
  }
});

test('2. Native multi-file share user cancellation returns cancelled without error', async () => {
  (globalThis as any).__mockIsNative = true;

  (globalThis as any).__mockShare = {
    share: async () => {
      const err = new Error('User dismissed share dialog');
      (err as any).name = 'AbortError';
      throw err;
    },
  };

  (globalThis as any).__mockFs = {
    readdir: async () => ({ files: [] }),
    deleteFile: async () => {},
    mkdir: async () => {},
    stat: async () => ({ size: 500 }),
    copy: async () => ({}),
    getUri: async ({ path }: { path: string }) => ({
      uri: `file:///data/cache/${path}`,
    }),
  };

  try {
    const inputs: ShareFileInput[] = [
      {
        url: 'https://example.com/lec1.pdf',
        name: 'Lecture 1',
        extension: 'pdf',
        mimeType: 'application/pdf',
        title: 'Lecture 1',
        lectureId: 'lec-1',
      },
      {
        url: 'https://example.com/lec2.pdf',
        name: 'Lecture 2',
        extension: 'pdf',
        mimeType: 'application/pdf',
        title: 'Lecture 2',
        lectureId: 'lec-2',
      },
    ];

    const result = await shareMultipleFiles(inputs, 'Test Bundle');
    assert.equal(result, 'cancelled');
  } finally {
    delete (globalThis as any).__mockIsNative;
    delete (globalThis as any).__mockShare;
    delete (globalThis as any).__mockFs;
  }
});

test('3. Web multi-file share invokes navigator.share when canShare({ files }) is supported', async () => {
  (globalThis as any).__mockIsNative = false;

  let webSharePayload: any = null;
  const originalNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  Object.defineProperty(globalThis, 'navigator', {
    value: {
      canShare: (data: any) => Boolean(data && data.files && data.files.length > 0),
      share: async (data: any) => {
        webSharePayload = data;
        return;
      },
    },
    configurable: true,
    writable: true,
  });

  try {
    const dummyBytes = new Uint8Array([37, 80, 68, 70]).buffer; // %PDF
    const inputs: ShareFileInput[] = [
      {
        url: 'https://example.com/lec1.pdf',
        name: 'Lecture 1',
        extension: 'pdf',
        mimeType: 'application/pdf',
        title: 'Lecture 1',
        bytes: dummyBytes,
      },
      {
        url: 'https://example.com/lec2.pdf',
        name: 'Lecture 2',
        extension: 'pdf',
        mimeType: 'application/pdf',
        title: 'Lecture 2',
        bytes: dummyBytes,
      },
    ];

    const result = await shareMultipleFiles(inputs, 'Web Lecture Bundle');

    assert.equal(result, 'shared');
    assert.ok(webSharePayload, 'navigator.share should be called');
    assert.equal(webSharePayload.title, 'Web Lecture Bundle');
    assert.ok(Array.isArray(webSharePayload.files), 'Payload should have files array');
    assert.equal(webSharePayload.files.length, 2);
    assert.equal(webSharePayload.files[0].name, 'Lecture 1.pdf');
    assert.equal(webSharePayload.files[1].name, 'Lecture 2.pdf');
  } finally {
    if (originalNavDesc) {
      Object.defineProperty(globalThis, 'navigator', originalNavDesc);
    } else {
      delete (globalThis as any).navigator;
    }
    delete (globalThis as any).__mockIsNative;
  }
});

test('4. Web multi-file share falls back to zip bundle when canShare({ files }) is unsupported', async () => {
  (globalThis as any).__mockIsNative = false;

  const originalNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalDocument = (globalThis as any).document;
  const originalUrl = (globalThis as any).URL;

  let downloadedFileName = '';

  Object.defineProperty(globalThis, 'navigator', {
    value: {
      canShare: () => false, // Cannot share files
    },
    configurable: true,
    writable: true,
  });

  (globalThis as any).URL = {
    createObjectURL: () => 'blob:mock-zip-url',
    revokeObjectURL: () => {},
  };

  (globalThis as any).document = {
    createElement: (tag: string) => ({ tag }),
    body: {
      appendChild: (el: any) => {
        if (el.tag === 'a') {
          downloadedFileName = el.download;
          el.click = () => {};
        }
      },
      removeChild: () => {},
    },
  };

  try {
    const dummyBytes = new Uint8Array([37, 80, 68, 70]).buffer;
    const inputs: ShareFileInput[] = [
      {
        url: 'https://example.com/lec1.pdf',
        name: 'Lecture 1',
        extension: 'pdf',
        mimeType: 'application/pdf',
        title: 'Lecture 1',
        bytes: dummyBytes,
      },
      {
        url: 'https://example.com/lec2.pdf',
        name: 'Lecture 2',
        extension: 'pdf',
        mimeType: 'application/pdf',
        title: 'Lecture 2',
        bytes: dummyBytes,
      },
    ];

    const result = await shareMultipleFiles(inputs, 'Zip Fallback Bundle');

    assert.equal(result, 'downloaded');
    assert.equal(downloadedFileName, 'mohadaraty_bundle.zip');
  } finally {
    if (originalNavDesc) {
      Object.defineProperty(globalThis, 'navigator', originalNavDesc);
    } else {
      delete (globalThis as any).navigator;
    }
    (globalThis as any).document = originalDocument;
    (globalThis as any).URL = originalUrl;
    delete (globalThis as any).__mockIsNative;
  }
});
