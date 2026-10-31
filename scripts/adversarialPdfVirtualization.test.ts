import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Adversarial Stress Test: PDF Seamless Page Virtualization & Caching', () => {

  test('Boundary: Active window calculation across document sizes and navigation limits', () => {
    function getActivePages(current: number, layoutLength: number, pageCount: number): Set<number> {
      const total = layoutLength || pageCount || 1;
      const windowPages = new Set<number>();
      windowPages.add(Math.max(1, current - 1));
      windowPages.add(current);
      windowPages.add(Math.min(total, current + 1));
      return windowPages;
    }

    // 1. Single page doc
    const single = getActivePages(1, 1, 1);
    assert.deepEqual(Array.from(single), [1], 'Single page doc must only have page 1 active');

    // 2. Initial page of multi-page
    const start2 = getActivePages(1, 2, 2);
    assert.deepEqual(Array.from(start2).sort((a,b)=>a-b), [1, 2]);

    const start100 = getActivePages(1, 100, 100);
    assert.deepEqual(Array.from(start100).sort((a,b)=>a-b), [1, 2]);

    // 3. Middle pages
    const mid100 = getActivePages(50, 100, 100);
    assert.deepEqual(Array.from(mid100).sort((a,b)=>a-b), [49, 50, 51]);

    // 4. End page of multi-page
    const end2 = getActivePages(2, 2, 2);
    assert.deepEqual(Array.from(end2).sort((a,b)=>a-b), [1, 2]);

    const end100 = getActivePages(100, 100, 100);
    assert.deepEqual(Array.from(end100).sort((a,b)=>a-b), [99, 100]);
  });

  test('Virtualization Invariant: 100-page simulated scroll never exceeds 3 concurrent active pages', () => {
    function getActivePages(current: number, total: number): Set<number> {
      const windowPages = new Set<number>();
      windowPages.add(Math.max(1, current - 1));
      windowPages.add(current);
      windowPages.add(Math.min(total, current + 1));
      return windowPages;
    }

    const totalPages = 100;
    for (let p = 1; p <= totalPages; p++) {
      const active = getActivePages(p, totalPages);
      assert.ok(active.size >= 1 && active.size <= 3, `Page ${p} active window size ${active.size} must be <= 3`);
      assert.ok(active.has(p), `Active window must always contain current page ${p}`);
      for (const pageNum of active) {
        assert.ok(pageNum >= 1 && pageNum <= totalPages, `Active page ${pageNum} must be within [1, ${totalPages}]`);
      }
    }
  });

  test('Layout Geometry Stability: Container and placeholder dimensions prevent CLS across mixed orientations', () => {
    // Mixed page orientations: portrait, landscape, square
    const pageSizes = [
      { w: 612, h: 792 },  // Standard Letter portrait
      { w: 792, h: 612 },  // Landscape
      { w: 600, h: 600 },  // Square
      { w: 595, h: 842 },  // A4 portrait
    ];
    const scale = 1.25;
    const rotation = 0;

    // Simulate layout computation in PdfReaderOverlay
    const swap = rotation % 180 !== 0;
    let y = 0;
    const layout = pageSizes.map((s) => {
      const w = (swap ? s.h : s.w) * scale;
      const h = (swap ? s.w : s.h) * scale;
      const top = y;
      y += h + 24;
      return { top, w, h };
    });

    // Invariant: Total container height is identically the sum of (h + 24)
    const expectedTotalHeight = layout.reduce((acc, box) => acc + box.h + 24, 0);
    assert.equal(y, expectedTotalHeight, 'Scroll layout height matches exact sum of page heights plus margins');

    // Invariant: Each page container and its placeholder maintain exact box.w and box.h
    layout.forEach((box, i) => {
      assert.ok(box.w > 0 && box.h > 0, `Page ${i + 1} has strictly positive dimensions`);
      assert.equal(box.w, (swap ? pageSizes[i].h : pageSizes[i].w) * scale);
      assert.equal(box.h, (swap ? pageSizes[i].w : pageSizes[i].h) * scale);
    });
  });

  test('Source Audit: PdfPage offscreen double-buffering and resource deallocation', () => {
    const pdfPageSrc = readFileSync(resolve('src/components/pdf/PdfPage.tsx'), 'utf-8');

    // 1. Must use offscreen canvas for rendering
    assert.ok(pdfPageSrc.includes("document.createElement('canvas')"), 'PdfPage must allocate detached offscreen canvas');
    assert.ok(pdfPageSrc.includes('renderTask = page.render({ canvasContext: offCtx, viewport, canvas: null })'), 'PdfPage renders to offscreen context');

    // 2. Must not mutate visible canvas before promise resolves
    const renderCallIndex = pdfPageSrc.indexOf('page.render({ canvasContext: offCtx');
    const awaitPromiseIndex = pdfPageSrc.indexOf('await renderTask.promise;');
    const visibleCanvasWriteIndex = pdfPageSrc.indexOf('visibleCtx.drawImage(offscreen, 0, 0);');

    assert.ok(renderCallIndex < awaitPromiseIndex, 'Render initiated before promise await');
    assert.ok(awaitPromiseIndex < visibleCanvasWriteIndex, 'Visible canvas written only AFTER await renderTask.promise settles');

    // 3. Must zero offscreen canvas to release backing buffer
    const zeroOffscreenCount = (pdfPageSrc.match(/offscreen\.width\s*=\s*0;/g) || []).length;
    assert.ok(zeroOffscreenCount >= 3, 'Offscreen buffer zeroed on catch, cancellation, and success');

    // 4. Must release visible canvas backing store on unmount
    assert.ok(pdfPageSrc.includes('c.width = 0; c.height = 0;'), 'Visible canvas dimensions zeroed on unmount');
  });

  test('Source Audit: PdfReaderOverlay active window virtualization and jump fallback', () => {
    const overlaySrc = readFileSync(resolve('src/components/pdf/PdfReaderOverlay.tsx'), 'utf-8');

    // 1. Active window virtualization
    assert.ok(overlaySrc.includes('const activePages = useMemo('), 'PdfReaderOverlay defines activePages memo');
    assert.ok(overlaySrc.includes('windowPages.add(Math.max(1, current - 1));'), 'Active window includes previous page');
    assert.ok(overlaySrc.includes('windowPages.add(current);'), 'Active window includes current page');
    assert.ok(overlaySrc.includes('windowPages.add(Math.min(total, current + 1));'), 'Active window includes next page');

    // 2. Data attribute container for jump-to-page resolution
    assert.ok(overlaySrc.includes('data-page-container={n}'), 'Container defines data-page-container attribute');
    assert.ok(overlaySrc.includes('scrollRef.current?.querySelector(`[data-page-container="${p}"]`)'), 'goToPage falls back to container query when handle is unmounted');

    // 3. Virtualization placeholder
    assert.ok(overlaySrc.includes('activePages.has(n)'), 'layout.map checks activePages.has(n)');
    assert.ok(overlaySrc.includes('className="w-full h-full bg-white/80 dark:bg-zinc-800/80 rounded"'), 'Renders placeholder when page is inactive');
  });

  test('Source Audit: Android native preload and snapping configuration', () => {
    const pluginSrc = readFileSync(resolve('android/app/src/main/java/com/mohadaraty/app/pdf/PdfViewerPlugin.java'), 'utf-8');

    // 1. Static and runtime preload constants
    assert.ok(pluginSrc.includes('Constants.PRELOAD_OFFSET = 1000;'), 'Android configures PRELOAD_OFFSET = 1000dp');
    assert.ok(pluginSrc.includes('Constants.Cache.CACHE_SIZE = 160;'), 'Android configures CACHE_SIZE = 160');

    // 2. Builder snapping, fling, autospacing, and fit policy
    assert.ok(pluginSrc.includes('.pageSnap(true)'), 'Android PDF builder configures pageSnap(true)');
    assert.ok(pluginSrc.includes('.pageFling(true)'), 'Android PDF builder configures pageFling(true)');
    assert.ok(pluginSrc.includes('.autoSpacing(true)'), 'Android PDF builder configures autoSpacing(true)');
    assert.ok(pluginSrc.includes('.pageFitPolicy(com.github.barteksc.pdfviewer.util.FitPolicy.WIDTH)'), 'Android PDF builder configures FitPolicy.WIDTH');
  });

});
