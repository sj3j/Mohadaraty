import test from 'node:test';
import assert from 'node:assert/strict';
import { exportPdfToDevice } from '../src/lib/deviceExport';
import { safeFileName } from '../src/lib/shareFileName';

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
  try {
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

    assert.equal(result.success, true);
    assert.equal(downloadedUrl, 'https://example.com/lectures/sample.pdf');
    assert.ok(downloadedFileName.includes('الفسيولوجي'));
    assert.ok(downloadedFileName.endsWith('.pdf'));
  } finally {
    (globalThis as any).document = originalDocument;
    delete (globalThis as any).__mockIsNative;
  }
});

test('3. exportPdfToDevice on Android attempts Documents copy then falls back gracefully', async () => {
  (globalThis as any).__mockIsNative = true;
  (globalThis as any).__mockPlatform = 'android';

  let copiedFrom = '';
  let copiedTo = '';
  let copiedDir = '';

  (globalThis as any).__mockFs = {
    copy: async (opts: any) => {
      copiedFrom = opts.from;
      copiedTo = opts.to;
      copiedDir = opts.toDirectory;
    },
    stat: async () => ({ size: 1024 }),
    getUri: async () => ({ uri: 'file:///data/user/0/app/lectures/lec-android.pdf' }),
  };

  try {
    const result = await exportPdfToDevice({
      url: 'https://example.com/lectures/sample.pdf',
      title: 'Biochemistry 01',
      lectureId: 'lec-android',
    });

    assert.equal(result.success, true);
    assert.ok(copiedTo.includes('Biochemistry 01.pdf'));
    assert.equal(copiedDir, 'DOCUMENTS');
  } finally {
    delete (globalThis as any).__mockIsNative;
    delete (globalThis as any).__mockPlatform;
    delete (globalThis as any).__mockFs;
  }
});

test('4. exportPdfToDevice on iOS triggers native file share sheet for Save to Files', async () => {
  (globalThis as any).__mockIsNative = true;
  (globalThis as any).__mockPlatform = 'ios';

  let sharedTitle = '';
  let sharedFiles: string[] = [];

  (globalThis as any).__mockShare = {
    share: async (opts: any) => {
      sharedTitle = opts.title;
      sharedFiles = opts.files;
    },
  };

  (globalThis as any).__mockFs = {
    stat: async () => ({ size: 2048 }),
    getUri: async () => ({ uri: 'file:///var/mobile/Containers/Data/Application/lectures/lec-ios.pdf' }),
    readdir: async () => ({ files: [] }),
    copy: async () => {},
  };

  try {
    const result = await exportPdfToDevice({
      url: 'https://example.com/lectures/sample.pdf',
      title: 'Pathology Lecture 2',
      lectureId: 'lec-ios',
    });

    assert.equal(result.success, true);
    assert.equal(sharedTitle, 'Pathology Lecture 2');
    assert.ok(sharedFiles.length > 0);
  } finally {
    delete (globalThis as any).__mockIsNative;
    delete (globalThis as any).__mockPlatform;
    delete (globalThis as any).__mockShare;
    delete (globalThis as any).__mockFs;
  }
});

test('5. Multi-selection state management handles toggle, select all, and deselect all', () => {
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
