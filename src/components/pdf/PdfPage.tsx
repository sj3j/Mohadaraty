import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  canonicalizePage,
  tagTextLayerSpans,
  quadsToRects,
  resolveAnchor,
  geometryMatches,
  rawOffsetForCanonical,
  type CanonicalPage,
  type TextItemLike,
} from '../../lib/pdfAnchor';
import { safeCanvasScale, MAX_CANVAS_AREA } from '../../lib/pdfjs';
import { HIGHLIGHT_COLORS, type PdfAnnotation } from '../../types/pdfAnnotation.types';

/**
 * What the overlay needs from a rendered page in order to turn a selection into
 * an anchor. Registered on render, unregistered on teardown.
 */
export interface PageHandle {
  pageNumber: number;
  el: HTMLElement;
  textLayerEl: HTMLElement;
  canonical: CanonicalPage;
  viewport: any;
  /** itemIndex -> the span pdf.js rendered for it. */
  spanByItem: Map<number, HTMLElement>;
  pageW: number;
  pageH: number;
  hasText: boolean;
}

interface Props {
  pdfDoc: any;
  pageNumber: number;
  /** Layout scale: the size the page is laid out, selected and anchored at. */
  scale: number;
  /**
   * Scale the canvas bitmap is rasterised at.
   *
   * Lags `scale` by a debounce so a pinch does not drive pdf.js on every
   * committed step. In between the two the bitmap is simply stretched over the
   * layout-sized box, which is what replaced the blank frame on each zoom.
   */
  rasterScale: number;
  rotation: number;
  annotations: PdfAnnotation[];
  /**
   * Expected box for this page at the current scale, from the overlay's layout.
   *
   * Applied immediately so the page reserves its correct height before the
   * async render finishes. Sizing from render output alone left the mounted
   * pages briefly at their PREVIOUS scale while the placeholders around them
   * had already grown, so the total scroll height was wrong exactly when the
   * zoom anchor tried to use it - and a zoom jumped several pages.
   */
  boxW: number;
  boxH: number;
  registerPage: (n: number, h: PageHandle | null) => void;
  onHighlightTap: (a: PdfAnnotation) => void;
  onOrphan: (id: string, orphaned: boolean) => void;
  onPinPoint?: (pageNumber: number, point: { x: number; y: number }) => void;
  flashId?: string | null;
}

interface PaintedRect {
  id: string;
  color: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * One page: canvas, highlight layer, text layer.
 *
 * `dir="ltr"` is pinned on the wrapper on purpose. The surrounding app is RTL,
 * and an inherited `direction: rtl` changes how the browser splits bidi runs
 * inside pdf.js's absolutely-positioned spans, which shifts getClientRects()
 * and puts every highlight in the wrong place. Only the reader chrome is RTL.
 *
 * Memoized because the overlay re-renders on every scroll tick (to track the
 * current page) and on every annotation change; without it each mounted page
 * would re-run its canvas render on both.
 */
export default React.memo(function PdfPage({
  pdfDoc, pageNumber, scale, rasterScale, rotation, annotations, boxW, boxH,
  registerPage, onHighlightTap, onOrphan, onPinPoint, flashId,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<PageHandle | null>(null);
  const pageRef = useRef<any>(null);
  const textLayerRef = useRef<any>(null);

  /** Latest layout scale, readable inside the render effect without being a dep. */
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  const [rects, setRects] = useState<PaintedRect[]>([]);
  const [ready, setReady] = useState(false);

  /**
   * Rebuild a DOM Range from canonical character offsets.
   *
   * Highlights are re-derived from the LIVE layout rather than replayed from
   * stored pixel geometry, which is what makes them follow zoom and rotation
   * for free. Stored quads are only the fallback for when the text itself can
   * no longer be found.
   */
  const rangeFor = useCallback((h: PageHandle, start: number, end: number): Range | null => {
    const { canonical, spanByItem } = h;
    let startNode: Node | null = null, startOff = 0, endNode: Node | null = null, endOff = 0;

    for (const r of canonical.itemRanges) {
      const span = spanByItem.get(r.itemIndex);
      if (!span || !span.firstChild) continue;
      const raw = span.textContent ?? '';

      if (startNode === null && start >= r.start && start <= r.end) {
        startNode = span.firstChild;
        startOff = rawOffsetForCanonical(raw, start - r.start);
      }
      if (end >= r.start && end <= r.end) {
        endNode = span.firstChild;
        endOff = rawOffsetForCanonical(raw, end - r.start);
      }
    }

    if (!startNode || !endNode) return null;
    try {
      const range = document.createRange();
      range.setStart(startNode, Math.min(startOff, startNode.textContent?.length ?? 0));
      range.setEnd(endNode, Math.min(endOff, endNode.textContent?.length ?? 0));
      return range.collapsed ? null : range;
    } catch {
      return null;
    }
  }, []);

  /** Resolve every annotation on this page into paintable boxes. */
  const paint = useCallback(() => {
    const h = handleRef.current;
    const wrap = wrapRef.current;
    if (!h || !wrap) return;

    const box = wrap.getBoundingClientRect();
    const out: PaintedRect[] = [];

    for (const a of annotations) {
      if (a.kind === 'pin' && a.point) {
        const [r] = quadsToRects([[a.point.x, a.point.y, a.point.x + 14, a.point.y + 14]], h.viewport);
        out.push({ id: a.id, color: HIGHLIGHT_COLORS[a.color], ...r });
        continue;
      }
      if (!a.anchor) continue;

      const resolved = resolveAnchor(a.anchor, h.canonical.text);
      let painted: PaintedRect[] = [];

      if (resolved) {
        const range = rangeFor(h, resolved.start, resolved.end);
        if (range) {
          // DOMRectList iterates as `unknown` under this lib config.
          const clientRects = Array.from(range.getClientRects()) as DOMRect[];
          painted = clientRects
            .filter(r => r.width > 0.5 && r.height > 0.5)
            .map(r => ({
              id: a.id,
              color: HIGHLIGHT_COLORS[a.color],
              left: r.left - box.left,
              top: r.top - box.top,
              width: r.width,
              height: r.height,
            }));
        }
      }

      // Text is gone but the page is geometrically unchanged - stored quads are
      // still trustworthy.
      if (painted.length === 0 && geometryMatches(a.anchor, h.pageW, h.pageH)) {
        painted = quadsToRects(a.anchor.quads, h.viewport)
          .map(r => ({ id: a.id, color: HIGHLIGHT_COLORS[a.color], ...r }));
      }

      // Nothing located it. The annotation is NOT deleted - it surfaces in the
      // notes drawer instead, note text intact.
      onOrphan(a.id, painted.length === 0);
      out.push(...painted);
    }

    setRects(out);
  }, [annotations, rangeFor, onOrphan]);

  // Render the page, then its text layer.
  useEffect(() => {
    let cancelled = false;
    let renderTask: any = null;
    let page: any = null;

    (async () => {
      page = await pdfDoc.getPage(pageNumber);
      if (cancelled) return;
      pageRef.current = page;

      const base = page.getViewport({ scale: 1, rotation: 0 });

      // Stop climbing once a page cannot get any sharper inside the canvas
      // budget. Past that point the CSS stretch takes over, which is the whole
      // point of the split - rastering higher only thrashes memory for nothing.
      const cappedDpr = Math.min(window.devicePixelRatio || 1, 2);
      const ceiling = Math.sqrt(MAX_CANVAS_AREA / (base.width * base.height)) / cappedDpr;
      const viewport = page.getViewport({ scale: Math.min(rasterScale, ceiling), rotation });

      const canvas = canvasRef.current;
      const textEl = textRef.current;
      if (!canvas || !textEl) return;

      const dpr = window.devicePixelRatio || 1;
      const q = safeCanvasScale(viewport.width, viewport.height, dpr);
      canvas.width = Math.floor(viewport.width * q);
      canvas.height = Math.floor(viewport.height * q);
      // No canvas.style.width/height here on purpose. The CSS box is sized from
      // boxW/boxH - the LAYOUT scale - so this bitmap stretches to fill it while
      // rasterScale is still catching up.

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(q, 0, 0, q, 0, 0);

      renderTask = page.render({ canvasContext: ctx, viewport, canvas: null });
      try {
        await renderTask.promise;
      } catch (e: any) {
        // Cancelling a render on scroll/zoom is normal, not an error.
        if (e?.name !== 'RenderingCancelledException') console.error('page render failed', e);
        return;
      }
      if (cancelled) return;

      // Text layer.
      //
      // Built at the LAYOUT scale, not the raster scale. Its spans are what
      // selection and anchor resolution measure, so they have to match the box
      // on screen rather than whatever the bitmap was last drawn at.
      const { TextLayer } = await import('pdfjs-dist');
      if (cancelled) return;

      const layoutVp = page.getViewport({ scale: scaleRef.current, rotation });

      textEl.innerHTML = '';
      const textContent = await page.getTextContent();
      if (cancelled) return;

      const items = (textContent.items ?? []).filter((i: any) => typeof i.str === 'string') as TextItemLike[];
      const layer = new TextLayer({ textContentSource: textContent, container: textEl, viewport: layoutVp });
      // Published before the await so the cleanup can cancel a render that is
      // still streaming. That is the only way to stop an outgoing layer from
      // appending into a container the incoming one has already cleared.
      textLayerRef.current = layer;
      try {
        await layer.render();
      } catch (e: any) {
        // cancel() rejects this promise, and cancelling on a zoom is routine.
        if (!cancelled) console.error('text layer failed', e);
        return;
      }
      if (cancelled) return;

      const spans = Array.from(textEl.querySelectorAll('span')) as HTMLElement[];
      const tagged = tagTextLayerSpans(spans, items);
      if (import.meta.env.DEV && spans.length > 0 && tagged !== spans.length) {
        console.warn(`[pdf] page ${pageNumber}: tagged ${tagged}/${spans.length} spans - anchors may drift`);
      }

      const spanByItem = new Map<number, HTMLElement>();
      for (const s of spans) {
        const idx = s.dataset.itemIndex;
        if (idx !== undefined) spanByItem.set(Number(idx), s);
      }

      const handle: PageHandle = {
        pageNumber,
        el: wrapRef.current!,
        textLayerEl: textEl,
        canonical: canonicalizePage(items),
        viewport: layoutVp,
        spanByItem,
        pageW: base.width,
        pageH: base.height,
        hasText: items.some(i => (i.str ?? '').trim().length > 0),
      };
      handleRef.current = handle;
      registerPage(pageNumber, handle);
      setReady(true);
    })();

    return () => {
      cancelled = true;
      try { renderTask?.cancel(); } catch { /* already settled */ }
      // Cancel the text layer too. Without this the outgoing layer carries on
      // appending spans into the container the incoming one has just cleared,
      // leaving duplicates positioned for the old viewport.
      try { textLayerRef.current?.cancel(); } catch { /* already settled */ }
      textLayerRef.current = null;
      // Deliberately NOT page.cleanup(). pdfDoc.getPage() hands back a CACHED
      // proxy, so on a rapid zoom the outgoing effect's teardown would wipe the
      // very object the incoming render is drawing from - the canvas then paints
      // nothing and the page shows as blank white. Page data is released when
      // the document is destroyed on unmount, and only three pages are ever
      // mounted, so nothing leaks by leaving it alone.
      // The backing store is NOT released here - see the unmount effect below.
      // Blanking it on every raster change is what flashed each zoom white.
      handleRef.current = null;
      registerPage(pageNumber, null);
      setReady(false);
    };
  }, [pdfDoc, pageNumber, rasterScale, rotation, registerPage]);

  /**
   * Release the backing store, on unmount only.
   *
   * The element is captured here rather than read in the cleanup because React
   * detaches refs before passive cleanups run - by then canvasRef.current is
   * already null and the blanking silently did nothing. This is what keeps
   * memory flat while scrolling a long lecture.
   */
  useEffect(() => {
    const c = canvasRef.current;
    return () => { if (c) { c.width = 0; c.height = 0; } };
  }, []);

  /**
   * Follow the layout scale without re-rastering, then repaint highlights.
   *
   * pdf.js can reposition an already-rendered text layer: update() walks the
   * SAME span elements and rewrites only their scale variables, so
   * data-item-index, spanByItem and canonical all survive and stored anchors
   * keep resolving against them.
   *
   * Rotation is deliberately not handled here. update() passes a bare object to
   * setLayerDimensions, which never swaps width for height, so a rotation has to
   * go through the full rebuild in the render effect above - it does, because
   * rotation is one of that effect's deps and its cleanup nulls the handle,
   * which is what the guard below waits on.
   */
  useEffect(() => {
    const page = pageRef.current;
    const layer = textLayerRef.current;
    const h = handleRef.current;
    if (!ready || !page || !layer || !h) return;

    const layoutVp = page.getViewport({ scale, rotation });
    layer.update({ viewport: layoutVp });
    // The handle is a live view shared by reference with the overlay's page map
    // and read synchronously by every consumer, so mutating it in place is safe.
    h.viewport = layoutVp;
    paint();
  }, [scale, rotation, ready, paint]);

  const handlePointerDown = (e: React.PointerEvent) => {
    const h = handleRef.current;
    if (!h || h.hasText || !onPinPoint) return;
    // Only pages with no text layer accept pins - elsewhere this would fight
    // text selection.
    const box = e.currentTarget.getBoundingClientRect();
    const [x, y] = h.viewport.convertToPdfPoint(e.clientX - box.left, e.clientY - box.top);
    onPinPoint(pageNumber, { x, y });
  };

  return (
    <div
      ref={wrapRef}
      dir="ltr"
      data-page={pageNumber}
      onDoubleClick={handlePointerDown}
      className="relative mx-auto my-3 bg-white shadow-lg shadow-black/20"
      style={{
        width: boxW || undefined,
        height: boxH || undefined,
        ['--total-scale-factor' as any]: scale,
      }}
    >
      {/* Sized from the layout scale, not from the bitmap. Between a zoom
          commit and the debounced re-raster this stretches the old bitmap over
          the new box, which is what replaced the blank white frame. */}
      <canvas
        ref={canvasRef}
        className="block"
        style={{ width: boxW || undefined, height: boxH || undefined }}
      />

      <div className="pdfHighlightLayer">
        {rects.map((r, i) => (
          <div
            key={`${r.id}-${i}`}
            className={`pdfHighlightRect${flashId === r.id ? ' pdfHighlightFlash' : ''}`}
            style={{ left: r.left, top: r.top, width: r.width, height: r.height, background: r.color }}
          />
        ))}
        {rects.map((r, i) => (
          <div
            key={`hit-${r.id}-${i}`}
            className="pdfHighlightHit"
            style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
            onClick={() => {
              const a = annotations.find(x => x.id === r.id);
              if (a) onHighlightTap(a);
            }}
          />
        ))}
      </div>

      <div ref={textRef} className="textLayer" />
    </div>
  );
});
