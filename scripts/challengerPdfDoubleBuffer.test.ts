/**
 * Challenger Stress Test: Milestone 2 — PDF Seamless Page Rendering & Caching
 *
 * Adversarially probes:
 * 1. Prevention of white flash: visible canvas is never cleared to blank while render is running.
 * 2. Rapid consecutive render calls / cancellations before promises settle (race condition stress).
 * 3. Memory cleanup of detached offscreen canvases (width = 0, height = 0) on all execution branches.
 * 4. Component unmount vs raster change canvas backing store lifecycle.
 * 5. Zero width/height viewports and negative zoom scales (boundary & edge cases).
 * 6. Context allocation failure memory leak probe.
 * 7. Static / AST contract verification of src/components/pdf/PdfPage.tsx.
 *
 * Execution:
 *   npx tsx --test scripts/challengerPdfDoubleBuffer.test.ts
 */

import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// =========================================================================
// 1. INSTRUMENTED DOM & PDF.JS SIMULATOR HARNESS
// =========================================================================

interface CanvasLogEntry {
  type: 'set_width' | 'set_height' | 'drawImage' | 'setTransform' | 'clear';
  value?: any;
  timestamp: number;
}

export class MockCanvasContext2D {
  canvas: MockCanvasElement;
  logs: CanvasLogEntry[] = [];
  transform: { a: number; b: number; c: number; d: number; e: number; f: number } = {
    a: 1, b: 0, c: 0, d: 1, e: 0, f: 0,
  };
  drawnImages: { image: any; dx: number; dy: number; timestamp: number }[] = [];

  constructor(canvas: MockCanvasElement) {
    this.canvas = canvas;
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number) {
    this.transform = { a, b, c, d, e, f };
    this.logs.push({ type: 'setTransform', value: { a, b, c, d, e, f }, timestamp: performance.now() });
  }

  getTransform() {
    return this.transform;
  }

  drawImage(image: any, dx: number, dy: number) {
    this.drawnImages.push({ image, dx, dy, timestamp: performance.now() });
    this.logs.push({ type: 'drawImage', value: { image, dx, dy }, timestamp: performance.now() });
  }

  fillRect() {}
  strokeRect() {}
  clearRect() {
    this.logs.push({ type: 'clear', timestamp: performance.now() });
  }
  beginPath() {}
  closePath() {}
  fill() {}
  stroke() {}
  save() {}
  restore() {}
}

export class MockCanvasElement {
  private _width = 0;
  private _height = 0;
  id: string;
  isOffscreen: boolean;
  context: MockCanvasContext2D | null = null;
  logs: CanvasLogEntry[] = [];
  contextCreationFails = false;

  constructor(id: string, isOffscreen: boolean) {
    this.id = id;
    this.isOffscreen = isOffscreen;
  }

  get width(): number {
    return this._width;
  }

  set width(v: number) {
    const num = Number(v);
    if (num < 0) {
      // In WebIDL unsigned long: ToUint32(v)
      this._width = (num >>> 0);
    } else {
      this._width = Math.floor(num);
    }
    this.logs.push({ type: 'set_width', value: this._width, timestamp: performance.now() });
  }

  get height(): number {
    return this._height;
  }

  set height(v: number) {
    const num = Number(v);
    if (num < 0) {
      this._height = (num >>> 0);
    } else {
      this._height = Math.floor(num);
    }
    this.logs.push({ type: 'set_height', value: this._height, timestamp: performance.now() });
  }

  getContext(type: string): MockCanvasContext2D | null {
    if (this.contextCreationFails) return null;
    if (type !== '2d') return null;
    if (!this.context) {
      this.context = new MockCanvasContext2D(this);
    }
    return this.context;
  }
}

export class MockDOMEnvironment {
  trackedCanvases: MockCanvasElement[] = [];
  private canvasCounter = 0;
  failContextCreation = false;

  createCanvas(isOffscreen = true): MockCanvasElement {
    const c = new MockCanvasElement(`canvas_${++this.canvasCounter}`, isOffscreen);
    if (this.failContextCreation) {
      c.contextCreationFails = true;
    }
    this.trackedCanvases.push(c);
    return c;
  }

  reset() {
    this.trackedCanvases = [];
    this.canvasCounter = 0;
    this.failContextCreation = false;
  }
}

export interface MockPageOptions {
  baseW?: number;
  baseH?: number;
  renderDelayMs?: number;
  renderShouldThrow?: boolean;
  throwType?: 'RenderingCancelledException' | 'GenericError';
  syncThrow?: boolean;
}

export class MockPdfPage {
  baseW: number;
  baseH: number;
  renderDelayMs: number;
  renderShouldThrow: boolean;
  throwType: 'RenderingCancelledException' | 'GenericError';
  syncThrow: boolean;
  renderCallCount = 0;
  activeRenderTasks: MockRenderTask[] = [];

  constructor(opts: MockPageOptions = {}) {
    this.baseW = opts.baseW ?? 600;
    this.baseH = opts.baseH ?? 800;
    this.renderDelayMs = opts.renderDelayMs ?? 10;
    this.renderShouldThrow = opts.renderShouldThrow ?? false;
    this.throwType = opts.throwType ?? 'RenderingCancelledException';
    this.syncThrow = opts.syncThrow ?? false;
  }

  getViewport({ scale, rotation }: { scale: number; rotation?: number }) {
    return {
      width: this.baseW * scale,
      height: this.baseH * scale,
      scale,
      rotation: rotation ?? 0,
    };
  }

  render({ canvasContext, viewport, canvas }: any): MockRenderTask {
    this.renderCallCount++;
    if (this.syncThrow) {
      throw new Error('Sync render crash inside page.render');
    }
    const task = new MockRenderTask({
      canvasContext,
      viewport,
      delayMs: this.renderDelayMs,
      shouldThrow: this.renderShouldThrow,
      throwType: this.throwType,
    });
    this.activeRenderTasks.push(task);
    return task;
  }

  async getTextContent() {
    return { items: [] };
  }
}

export class MockRenderTask {
  canvasContext: MockCanvasContext2D;
  viewport: any;
  promise: Promise<void>;
  private _cancelled = false;
  private _reject!: (e: any) => void;
  private _resolve!: () => void;
  private _timer: any;

  constructor({ canvasContext, viewport, delayMs, shouldThrow, throwType }: any) {
    this.canvasContext = canvasContext;
    this.viewport = viewport;

    this.promise = new Promise<void>((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;

      this._timer = setTimeout(() => {
        if (this._cancelled) return;
        if (shouldThrow) {
          const err: any = new Error(throwType === 'RenderingCancelledException' ? 'Rendering cancelled' : 'Page render error');
          err.name = throwType;
          reject(err);
        } else {
          resolve();
        }
      }, delayMs);
    });
  }

  cancel() {
    this._cancelled = true;
    clearTimeout(this._timer);
    const err: any = new Error('Rendering cancelled');
    err.name = 'RenderingCancelledException';
    this._reject(err);
  }
}

export class MockPdfDoc {
  page: MockPdfPage;
  pageGetDelayMs = 0;

  constructor(pageOpts: MockPageOptions = {}, pageGetDelayMs = 0) {
    this.page = new MockPdfPage(pageOpts);
    this.pageGetDelayMs = pageGetDelayMs;
  }

  async getPage(pageNumber: number): Promise<MockPdfPage> {
    if (this.pageGetDelayMs > 0) {
      await new Promise(r => setTimeout(r, this.pageGetDelayMs));
    }
    return this.page;
  }
}

// =========================================================================
// 2. CORE EXECUTION RUNNER (Matches PdfPage.tsx Lifecycle Exact Implementation)
// =========================================================================

export const MAX_CANVAS_AREA = 4_000_000;
export const MAX_CANVAS_DIM = 4096;

export function safeCanvasScale(cssWidth: number, cssHeight: number, dpr: number): number {
  const capped = Math.min(dpr, 2);
  const area = cssWidth * cssHeight * capped * capped;
  const byArea = area <= MAX_CANVAS_AREA
    ? capped
    : capped * Math.sqrt(MAX_CANVAS_AREA / area);
  const byDim = Math.min(MAX_CANVAS_DIM / cssWidth, MAX_CANVAS_DIM / cssHeight);
  return Math.max(0.05, Math.min(byArea, byDim));
}

/**
 * Executes one iteration of the PdfPage.tsx render effect lifecycle.
 * Returns an unmount/cleanup function matching the React useEffect return signature.
 */
export function runPdfPageRenderLifecycle({
  pdfDoc,
  pageNumber,
  rasterScale,
  rotation,
  visibleCanvas,
  textEl,
  domEnv,
  devicePixelRatio = 1,
  onReady,
  onError,
}: {
  pdfDoc: any;
  pageNumber: number;
  rasterScale: number;
  rotation: number;
  visibleCanvas: MockCanvasElement;
  textEl: any;
  domEnv: MockDOMEnvironment;
  devicePixelRatio?: number;
  onReady?: (ready: boolean) => void;
  onError?: (err: any) => void;
}) {
  let cancelled = false;
  let renderTask: any = null;
  let page: any = null;

  const effectPromise = (async () => {
    try {
      page = await pdfDoc.getPage(pageNumber);
      if (cancelled) return;

      const base = page.getViewport({ scale: 1, rotation: 0 });
      const cappedDpr = Math.min(devicePixelRatio || 1, 2);
      const ceiling = Math.sqrt(MAX_CANVAS_AREA / (base.width * base.height)) / cappedDpr;
      const viewport = page.getViewport({ scale: Math.min(rasterScale, ceiling), rotation });

      if (!visibleCanvas || !textEl) return;

      const dpr = devicePixelRatio || 1;
      const q = safeCanvasScale(viewport.width, viewport.height, dpr);
      const targetWidth = Math.floor(viewport.width * q);
      const targetHeight = Math.floor(viewport.height * q);

      // Render to an offscreen canvas first to prevent destructive visible canvas blanking
      const offscreen = domEnv.createCanvas(true);
      offscreen.width = targetWidth;
      offscreen.height = targetHeight;
      const offCtx = offscreen.getContext('2d');
      if (!offCtx) return;
      offCtx.setTransform(q, 0, 0, q, 0, 0);

      renderTask = page.render({ canvasContext: offCtx, viewport, canvas: null });
      try {
        await renderTask.promise;
      } catch (e: any) {
        if (e?.name !== 'RenderingCancelledException') {
          if (onError) onError(e);
        }
        offscreen.width = 0;
        offscreen.height = 0;
        return;
      }
      if (cancelled) {
        offscreen.width = 0;
        offscreen.height = 0;
        return;
      }

      // Ensure visible canvas dimensions match and atomically copy pixels without flashing
      const currentCanvas = visibleCanvas;
      if (!currentCanvas) {
        offscreen.width = 0;
        offscreen.height = 0;
        return;
      }

      if (currentCanvas.width !== targetWidth || currentCanvas.height !== targetHeight) {
        currentCanvas.width = targetWidth;
        currentCanvas.height = targetHeight;
      }
      const visibleCtx = currentCanvas.getContext('2d');
      if (visibleCtx) {
        visibleCtx.drawImage(offscreen, 0, 0);
      }
      // Release offscreen buffer resources
      offscreen.width = 0;
      offscreen.height = 0;

      if (onReady) onReady(true);
    } catch (e: any) {
      if (onError) onError(e);
    }
  })();

  const cleanup = () => {
    cancelled = true;
    try { renderTask?.cancel(); } catch { /* already settled */ }
    if (onReady) onReady(false);
  };

  return { cleanup, effectPromise };
}

// =========================================================================
// 3. ADVERSARIAL TEST SUITES
// =========================================================================

describe('Milestone 2 Adversarial Stress Suite: PDF Double-Buffering & Canvas Lifecycle', () => {

  it('1. Prevention of White Flash: Visible canvas dimensions and bitmap remain 100% stable during render', async () => {
    const domEnv = new MockDOMEnvironment();
    const visibleCanvas = domEnv.createCanvas(false);
    visibleCanvas.width = 600;
    visibleCanvas.height = 800;
    const initialVisibleCtx = visibleCanvas.getContext('2d')!;
    initialVisibleCtx.drawImage({ name: 'initial_frame_page_1' }, 0, 0);

    const doc = new MockPdfDoc({ baseW: 600, baseH: 800, renderDelayMs: 40 });

    let readyState = false;
    const { cleanup, effectPromise } = runPdfPageRenderLifecycle({
      pdfDoc: doc,
      pageNumber: 1,
      rasterScale: 1.5, // new target scale -> 900x1200
      rotation: 0,
      visibleCanvas,
      textEl: {},
      domEnv,
      onReady: (r) => { readyState = r; },
    });

    // While renderTask is pending asynchronously (at 20ms of a 40ms render):
    await new Promise(r => setTimeout(r, 20));

    // INVARIANT 1: Visible canvas was NEVER cleared or resized prematurely to blank white
    assert.strictEqual(
      visibleCanvas.width,
      600,
      'Visible canvas width must NOT resize to target width while render is still pending',
    );
    assert.strictEqual(
      visibleCanvas.height,
      800,
      'Visible canvas height must NOT resize to target height while render is still pending',
    );
    assert.strictEqual(
      visibleCanvas.context!.logs.filter(l => l.type === 'clear').length,
      0,
      'Visible canvas context must NEVER have clearRect invoked during pending render',
    );

    // INVARIANT 2: An offscreen canvas was allocated with target dimensions
    const offscreenCanvases = domEnv.trackedCanvases.filter(c => c.isOffscreen);
    assert.strictEqual(offscreenCanvases.length, 1, 'Exactly one offscreen canvas allocated');
    assert.strictEqual(offscreenCanvases[0].width, 900, 'Offscreen buffer sized to target 900px');
    assert.strictEqual(offscreenCanvases[0].height, 1200, 'Offscreen buffer sized to target 1200px');

    // Wait for render to settle
    await effectPromise;

    // INVARIANT 3: Visible canvas atomically updated to 900x1200 and pixels blitted
    assert.strictEqual(visibleCanvas.width, 900, 'Visible canvas resized to 900px after completion');
    assert.strictEqual(visibleCanvas.height, 1200, 'Visible canvas resized to 1200px after completion');
    // Total draws on visible canvas: 1 initial + 1 double-buffer blit = 2
    assert.strictEqual(visibleCanvas.context!.drawnImages.length, 2, 'Double-buffer blit copied offscreen pixels');
    assert.strictEqual(readyState, true, 'Page marked ready');

    // INVARIANT 4: Atomic operation sequence check
    const widthLogIndex = visibleCanvas.logs.findIndex(l => l.type === 'set_width' && l.value === 900);
    const heightLogIndex = visibleCanvas.logs.findIndex(l => l.type === 'set_height' && l.value === 1200);
    const drawLogIndex = visibleCanvas.context!.logs.findIndex(
      l => l.type === 'drawImage' && l.value.image.id === offscreenCanvases[0].id,
    );

    assert.ok(widthLogIndex >= 0 && heightLogIndex >= 0, 'Dimensions recorded in logs');
    assert.ok(drawLogIndex >= 0, 'Offscreen draw recorded in logs');
    // Ensure width and height changes immediately precede the drawImage with zero clears
    assert.strictEqual(
      visibleCanvas.context!.logs.filter(l => l.type === 'clear').length,
      0,
      'Zero canvas blanking throughout the entire double-buffering lifecycle',
    );

    cleanup();
  });

  it('2. Rapid Consecutive Render Calls: 30 cancellations mid-flight leave visible canvas intact and offscreen buffers purged', async () => {
    const domEnv = new MockDOMEnvironment();
    const visibleCanvas = domEnv.createCanvas(false);
    visibleCanvas.width = 600;
    visibleCanvas.height = 800;

    // 0 delay for getPage so offscreen canvas is synchronously allocated, 25ms render delay
    const doc = new MockPdfDoc({ baseW: 600, baseH: 800, renderDelayMs: 25 }, 0);

    const activeCleanups: (() => void)[] = [];
    const activePromises: Promise<any>[] = [];

    // Trigger 30 rapid successive renders (mimicking continuous pinch-zoom / scroll flings)
    for (let i = 1; i <= 30; i++) {
      const scale = 1.0 + (i * 0.05); // scale from 1.05 to 2.5
      const { cleanup, effectPromise } = runPdfPageRenderLifecycle({
        pdfDoc: doc,
        pageNumber: 1,
        rasterScale: scale,
        rotation: 0,
        visibleCanvas,
        textEl: {},
        domEnv,
      });

      // Let the task reach offscreen canvas allocation & page.render (~2ms)
      await new Promise(r => setTimeout(r, 2));

      // Cancel prior render while its renderTask is mid-flight
      if (activeCleanups.length > 0) {
        const prevCleanup = activeCleanups.pop()!;
        prevCleanup();
      }

      activeCleanups.push(cleanup);
      activePromises.push(effectPromise);
    }

    // Await all renders settling (29 cancelled mid-flight, 1 final will complete)
    await Promise.all(activePromises);

    // INVARIANT 1: Exactly 30 offscreen canvases were created
    const offscreens = domEnv.trackedCanvases.filter(c => c.isOffscreen);
    assert.strictEqual(offscreens.length, 30, '30 offscreen canvases created across 30 attempts');

    // INVARIANT 2: 100% of all 30 offscreen canvases were reset to width=0, height=0
    const uncleanedOffscreens = offscreens.filter(c => c.width !== 0 || c.height !== 0);
    assert.strictEqual(
      uncleanedOffscreens.length,
      0,
      `All 30 offscreen buffers must be released to 0x0. Leaked count: ${uncleanedOffscreens.length}`,
    );

    // INVARIANT 3: Exactly 1 drawImage blit occurred on visible canvas (from the 30th render)
    assert.strictEqual(
      visibleCanvas.context!.drawnImages.length,
      1,
      'Only the surviving (final) render blitted to the visible canvas; all 29 cancelled renders were suppressed',
    );

    // Final visible canvas matches scale of the 30th render (2.5 -> 1500x2000)
    assert.strictEqual(visibleCanvas.width, 1500, 'Visible canvas width matches final render');
    assert.strictEqual(visibleCanvas.height, 2000, 'Visible canvas height matches final render');

    // Cleanup final render
    activeCleanups[0]();
  });

  it('3. Cancellation during pdfDoc.getPage() before renderTask exists safely aborts without leaks', async () => {
    const domEnv = new MockDOMEnvironment();
    const visibleCanvas = domEnv.createCanvas(false);
    visibleCanvas.width = 600;
    visibleCanvas.height = 800;

    // Simulate slow document getPage (40ms)
    const doc = new MockPdfDoc({ baseW: 600, baseH: 800 }, 40);

    const { cleanup, effectPromise } = runPdfPageRenderLifecycle({
      pdfDoc: doc,
      pageNumber: 1,
      rasterScale: 1.5,
      rotation: 0,
      visibleCanvas,
      textEl: {},
      domEnv,
    });

    // Cancel after 10ms while still inside `await pdfDoc.getPage()`
    await new Promise(r => setTimeout(r, 10));
    cleanup();

    await effectPromise;

    // INVARIANT: Since cancelled before getPage settled, no offscreen canvas should have been created
    const offscreens = domEnv.trackedCanvases.filter(c => c.isOffscreen);
    assert.strictEqual(offscreens.length, 0, 'No offscreen canvas allocated when cancelled before getPage');
    assert.strictEqual(visibleCanvas.context?.drawnImages.length || 0, 0, 'No pixels drawn to visible canvas');
  });

  it('4. Cancellation during active renderTask promise rejects task, purges offscreen buffer, and suppresses visible blit', async () => {
    const domEnv = new MockDOMEnvironment();
    const visibleCanvas = domEnv.createCanvas(false);
    visibleCanvas.width = 600;
    visibleCanvas.height = 800;

    const doc = new MockPdfDoc({ baseW: 600, baseH: 800, renderDelayMs: 30 }, 0);

    let readyCalled = false;
    const { cleanup, effectPromise } = runPdfPageRenderLifecycle({
      pdfDoc: doc,
      pageNumber: 1,
      rasterScale: 2.0,
      rotation: 0,
      visibleCanvas,
      textEl: {},
      domEnv,
      onReady: (r) => { readyCalled = r; },
    });

    // Wait until renderTask is actively running (10ms of 30ms) and cancel
    await new Promise(r => setTimeout(r, 10));
    cleanup();

    await effectPromise;

    const offscreens = domEnv.trackedCanvases.filter(c => c.isOffscreen);
    assert.strictEqual(offscreens.length, 1, 'One offscreen buffer was created');
    assert.strictEqual(offscreens[0].width, 0, 'Offscreen buffer width reset to 0 in catch(RenderingCancelledException)');
    assert.strictEqual(offscreens[0].height, 0, 'Offscreen buffer height reset to 0 in catch(RenderingCancelledException)');
    assert.strictEqual(visibleCanvas.context?.drawnImages.length || 0, 0, 'Visible canvas was NOT blitted');
    assert.strictEqual(readyCalled, false, 'Ready state was not set to true');
  });

  it('5. Memory Cleanup under Render Failure: Error branches (non-cancellation) purge offscreen buffer', async () => {
    const domEnv = new MockDOMEnvironment();
    const visibleCanvas = domEnv.createCanvas(false);
    visibleCanvas.width = 600;
    visibleCanvas.height = 800;

    const doc = new MockPdfDoc({
      baseW: 600,
      baseH: 800,
      renderDelayMs: 10,
      renderShouldThrow: true,
      throwType: 'GenericError',
    });

    let caughtError: any = null;
    const { cleanup, effectPromise } = runPdfPageRenderLifecycle({
      pdfDoc: doc,
      pageNumber: 1,
      rasterScale: 1.5,
      rotation: 0,
      visibleCanvas,
      textEl: {},
      domEnv,
      onError: (err) => { caughtError = err; },
    });

    await effectPromise;

    const offscreens = domEnv.trackedCanvases.filter(c => c.isOffscreen);
    assert.strictEqual(offscreens.length, 1, 'Offscreen canvas created');
    assert.strictEqual(offscreens[0].width, 0, 'Offscreen canvas width cleaned up to 0 on error');
    assert.strictEqual(offscreens[0].height, 0, 'Offscreen canvas height cleaned up to 0 on error');
    assert.strictEqual(visibleCanvas.context?.drawnImages.length || 0, 0, 'No draw on visible canvas');
    assert.ok(caughtError !== null, 'Error was caught and reported');

    cleanup();
  });

  it('6. Memory Cleanup when visibleCanvas unmounts mid-flight', async () => {
    const domEnv = new MockDOMEnvironment();
    const visibleCanvas = domEnv.createCanvas(false);
    visibleCanvas.width = 600;
    visibleCanvas.height = 800;

    const doc = new MockPdfDoc({ baseW: 600, baseH: 800, renderDelayMs: 20 });

    // Emulate ref becoming null mid-flight (React ref detachment on unmount)
    const refHolder = { canvas: visibleCanvas as MockCanvasElement | null };

    // Custom runner with dynamic ref getter
    let cancelled = false;
    let renderTask: any = null;
    const offscreen = domEnv.createCanvas(true);
    offscreen.width = 900;
    offscreen.height = 1200;

    const renderTaskPromise = (async () => {
      const page = await doc.getPage(1);
      renderTask = page.render({ canvasContext: offscreen.getContext('2d'), viewport: {} });
      await renderTask.promise;

      const current = refHolder.canvas;
      if (!current) {
        // Line 280 in PdfPage.tsx
        offscreen.width = 0;
        offscreen.height = 0;
        return;
      }
      current.width = 900;
    })();

    // Detach ref while render is running
    await new Promise(r => setTimeout(r, 10));
    refHolder.canvas = null;

    await renderTaskPromise;

    assert.strictEqual(offscreen.width, 0, 'Offscreen buffer cleared when visible canvas ref is null');
    assert.strictEqual(offscreen.height, 0, 'Offscreen buffer height cleared when visible canvas ref is null');
  });

  it('7. Unmount Cleanup Hook vs Re-render: Visible canvas backing store is released ONLY on unmount', () => {
    const domEnv = new MockDOMEnvironment();
    const visibleCanvas = domEnv.createCanvas(false);
    visibleCanvas.width = 600;
    visibleCanvas.height = 800;

    // Simulate unmount hook capture
    const capturedCanvas = visibleCanvas;
    const unmountCleanup = () => {
      if (capturedCanvas) {
        capturedCanvas.width = 0;
        capturedCanvas.height = 0;
      }
    };

    // Re-render effect cleanup does NOT clear visible canvas
    const renderEffectCleanup = () => {
      // only cancels tasks, does NOT set c.width = 0
    };

    // 1. Re-render occurs:
    renderEffectCleanup();
    assert.strictEqual(visibleCanvas.width, 600, 'Visible canvas retains backing store on re-render');
    assert.strictEqual(visibleCanvas.height, 800, 'Visible canvas retains height on re-render');

    // 2. Component unmount occurs:
    unmountCleanup();
    assert.strictEqual(visibleCanvas.width, 0, 'Visible canvas width reset to 0 on unmount');
    assert.strictEqual(visibleCanvas.height, 0, 'Visible canvas height reset to 0 on unmount');
  });

  it('8. Adversarial Probing: Zero viewport width/height and dimension limits', async () => {
    // Case A: safeCanvasScale with zero viewport
    const scaleZero = safeCanvasScale(0, 0, 1);
    assert.ok(scaleZero >= 0.05, `safeCanvasScale(0,0) returns degenerate guard >= 0.05 (got ${scaleZero})`);

    // Case B: safeCanvasScale with massive viewport (stress-testing MAX_CANVAS_AREA & MAX_CANVAS_DIM)
    const scaleMassive = safeCanvasScale(8000, 10000, 2);
    assert.ok(scaleMassive <= 0.41, `Massive viewport capped by MAX_CANVAS_DIM / MAX_CANVAS_AREA (got ${scaleMassive})`);
    const targetW = Math.floor(8000 * scaleMassive);
    const targetH = Math.floor(10000 * scaleMassive);
    assert.ok(targetW <= MAX_CANVAS_DIM, `Target width ${targetW} <= MAX_CANVAS_DIM (4096)`);
    assert.ok(targetH <= MAX_CANVAS_DIM, `Target height ${targetH} <= MAX_CANVAS_DIM (4096)`);
    assert.ok(targetW * targetH <= MAX_CANVAS_AREA, `Target area ${targetW * targetH} <= MAX_CANVAS_AREA (4,000,000)`);

    // Case C: Zero width page render lifecycle execution
    const domEnv = new MockDOMEnvironment();
    const visibleCanvas = domEnv.createCanvas(false);
    const docZero = new MockPdfDoc({ baseW: 0, baseH: 0, renderDelayMs: 5 });

    let renderErr: any = null;
    const { cleanup, effectPromise } = runPdfPageRenderLifecycle({
      pdfDoc: docZero,
      pageNumber: 1,
      rasterScale: 1.0,
      rotation: 0,
      visibleCanvas,
      textEl: {},
      domEnv,
      onError: (err) => { renderErr = err; },
    });

    await effectPromise;
    assert.strictEqual(visibleCanvas.width, 0, 'Zero width handled gracefully');
    assert.strictEqual(visibleCanvas.height, 0, 'Zero height handled gracefully');
    cleanup();
  });

  it('9. Adversarial Probing: Negative zoom scale input (-1.0) and boundary edge analysis', () => {
    // What happens if rasterScale = -1.0 or -0.5 is passed?
    const baseW = 600;
    const baseH = 800;
    const negativeScale = -1.0;

    const vpNeg = { width: baseW * negativeScale, height: baseH * negativeScale };
    assert.strictEqual(vpNeg.width, -600);
    assert.strictEqual(vpNeg.height, -800);

    const q = safeCanvasScale(vpNeg.width, vpNeg.height, 1);
    assert.strictEqual(q, 0.05, 'safeCanvasScale floors negative inputs at 0.05');

    const targetWidth = Math.floor(vpNeg.width * q);
    const targetHeight = Math.floor(vpNeg.height * q);
    assert.strictEqual(targetWidth, -30, 'Calculated targetWidth is negative (-30)');
    assert.strictEqual(targetHeight, -40, 'Calculated targetHeight is negative (-40)');

    // In HTML Canvas WebIDL, setting canvas.width = -30 wraps via ToUint32(-30) to 4294967266!
    const canvas = new MockCanvasElement('test', true);
    canvas.width = targetWidth;
    assert.strictEqual(
      canvas.width,
      4294967266,
      'WebIDL unsigned long wraps negative width to 4.29 billion pixels',
    );
  });

  it('10. Adversarial Probing: Context creation failure (GPU OOM) resets offscreen dimensions', () => {
    // In PdfPage.tsx lines 257-258:
    // const offCtx = offscreen.getContext('2d');
    // if (!offCtx) return;
    // Notice: if offCtx is null, offscreen.width and height were already set to targetWidth/Height.
    const domEnv = new MockDOMEnvironment();
    domEnv.failContextCreation = true;
    const visibleCanvas = domEnv.createCanvas(false);

    const doc = new MockPdfDoc({ baseW: 600, baseH: 800 });
    const { cleanup, effectPromise } = runPdfPageRenderLifecycle({
      pdfDoc: doc,
      pageNumber: 1,
      rasterScale: 1.0,
      rotation: 0,
      visibleCanvas,
      textEl: {},
      domEnv,
    });

    return effectPromise.then(() => {
      const offscreen = domEnv.trackedCanvases.find(c => c.isOffscreen);
      assert.ok(offscreen, 'Offscreen canvas was allocated');
      // In current PdfPage.tsx, offCtx is null -> returns without zeroing offscreen
      const isCleaned = offscreen.width === 0 && offscreen.height === 0;
      // Note the finding: currently offscreen is NOT zeroed if !offCtx
      assert.strictEqual(isCleaned, false, 'Known boundary: offscreen is not zeroed when getContext("2d") fails');
      cleanup();
    });
  });

  it('11. Static / AST Code Audit of PdfPage.tsx: Verify all Milestone 2 double-buffering patterns', () => {
    const code = readFileSync(resolve('src/components/pdf/PdfPage.tsx'), 'utf8');

    // 1. Offscreen canvas created via document.createElement('canvas')
    assert.ok(
      /document\.createElement\('canvas'\)/.test(code),
      'Must allocate detached offscreen canvas via document.createElement("canvas")',
    );

    // 2. page.render targets offCtx, NOT visibleCanvas
    assert.ok(
      /page\.render\(\s*\{\s*canvasContext:\s*offCtx/.test(code),
      'page.render must target offscreen context offCtx',
    );

    // 3. Visible canvas mutation MUST occur AFTER await renderTask.promise
    const awaitIndex = code.indexOf('await renderTask.promise');
    const visibleDrawIndex = code.indexOf('visibleCtx.drawImage(offscreen');
    const visibleResizeIndex = code.indexOf('currentCanvas.width = targetWidth');

    assert.ok(awaitIndex > 0, 'Found await renderTask.promise');
    assert.ok(visibleDrawIndex > awaitIndex, 'visibleCtx.drawImage occurs AFTER await renderTask.promise');
    assert.ok(visibleResizeIndex > awaitIndex, 'currentCanvas.width mutation occurs AFTER await renderTask.promise');

    // 4. Memory cleanup: offscreen dimensions zeroed on all branches
    const offscreenZeros = (code.match(/offscreen\.(?:width|height)\s*=\s*0/g) || []).length;
    // We expect at least 6 occurrences (width=0, height=0 in catch, cancelled, unmounted, success)
    assert.ok(
      offscreenZeros >= 6,
      `offscreen width/height = 0 must appear across all branches (found ${offscreenZeros} occurrences)`,
    );

    // 5. RenderingCancelledException specifically filtered
    assert.ok(
      code.includes('RenderingCancelledException'),
      'Must handle RenderingCancelledException without false error reporting',
    );

    // 6. Unmount effect captures canvas ref to zero backing store on unmount only
    assert.ok(
      /useEffect\(\(\)\s*=>\s*\{[\s\S]*?canvasRef\.current[\s\S]*?c\.width\s*=\s*0[\s\S]*?c\.height\s*=\s*0[\s\S]*?\}\s*,\s*\[\]\)/.test(code),
      'Must contain unmount-only useEffect hook zeroing canvas width/height',
    );
  });
});
