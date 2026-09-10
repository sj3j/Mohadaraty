import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertTriangle, ChevronLeft, ChevronRight, Loader2, Minus, NotebookPen, Plus, RotateCw,
  Search, Sparkles, X,
} from 'lucide-react';
import PdfPage, { type PageHandle } from './PdfPage';
import SelectionToolbar from './SelectionToolbar';
import PdfSearchPanel from './PdfSearchPanel';
import NoteEditorSheet from './NoteEditorSheet';
import NotesDrawer from './NotesDrawer';
import { ConfirmModal } from '../ui/ConfirmModal';
import { loadPdfjs, fetchPdfBytes, freshBytes, PDFJS_DOC_OPTIONS } from '../../lib/pdfjs';
import { readStoredPdf } from '../../hooks/useOfflinePDF';
import { buildAnchor, canonicalOffsetWithin, rectsToQuads } from '../../lib/pdfAnchor';
import { copyText, shareText, translateText, webSearchText } from '../../lib/textActions';
import {
  buildPageSearchIndex, searchPageIndex,
  type PageSearchIndex, type SearchMatch,
} from '../../lib/pdfSearch';
import { useLectureAnnotations } from '../../hooks/useLectureAnnotations';
import { useBackDismiss } from '../../hooks/useBackDismiss';
import SimosanDrawer from './SimosanDrawer';
import { exportLecture, getDocMeta, setDocMeta } from '../../services/pdfAnnotationService';
import { fetchSimosanState } from '../../services/simosanService';
import type { HighlightColor, PdfAnnotation } from '../../types/pdfAnnotation.types';
import type { Language } from '../../types';
import '../../styles/pdf-text-layer.css';

interface Props {
  lectureId: string;
  lectureTitle: string;
  pdfUrl: string;
  lang: Language;
  onClose: () => void;
}

interface SelectionFragment {
  pageNumber: number;
  start: number;
  end: number;
  quads: [number, number, number, number][];
  pageW: number;
  pageH: number;
  canonicalText: string;
}

interface SelectionSnapshot {
  text: string;
  fragments: SelectionFragment[];
}

// Stable identity so a page without annotations does not defeat PdfPage memo.
const NO_ANNOTATIONS: PdfAnnotation[] = [];

/** A query matching more than this is already unusable as a list. */
const MAX_MATCHES = 500;

const MIN_SCALE = 0.5;
const MAX_SCALE = 3;

/**
 * Pinch physics.
 *
 * RESIST is a power law in LOG space, which is why one constant serves both
 * ends: an additive band tuned to feel right at MAX 3 feels like nothing at
 * MIN 0.5. It cannot run away either - 16x past the limit still only reads 6.
 *
 * RUBBER is the translate band, where a hard asymptote IS what is wanted:
 * overscroll approaches RUBBER x the viewport and never passes it.
 *
 * SPRING is quoted per 60Hz frame and normalised by real dt at the point of
 * use. 90/120Hz Android panels are common, and a raw per-frame factor would
 * settle twice as fast on a Pixel as on a budget phone.
 */
const RESIST = 0.25;
const RUBBER = 0.55;
const SPRING = 0.2;
/** Past this the spring is force-committed rather than chasing an epsilon. */
const SPRING_TIMEOUT_MS = 600;
/** How far the canvas raster trails the layout scale. */
const RASTER_DEBOUNCE_MS = 200;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Elastic resistance past the scale limits. Continuous at the boundary. */
function elasticScale(s: number): number {
  const out =
    s > MAX_SCALE ? MAX_SCALE * Math.pow(s / MAX_SCALE, RESIST) :
    s < MIN_SCALE ? MIN_SCALE * Math.pow(s / MIN_SCALE, RESIST) : s;
  // Belt and braces, so a wild pointer reading can never reach the bounds maths.
  return clamp(out, MIN_SCALE / 1.8, MAX_SCALE * 1.8);
}

/** Asymptotic overscroll: approaches span * RUBBER, never passes it. */
function rubber(d: number, span: number): number {
  return (d * RUBBER) / (1 + (Math.abs(d) * RUBBER) / Math.max(1, span));
}

/**
 * Clamp with elastic give.
 *
 * When lo > hi the content is smaller than the window, so there is no valid
 * range at all - centre it rather than pinning it to an edge, which is what
 * left a zoomed-out page stuck against the left margin.
 */
function band(v: number, lo: number, hi: number, span: number): number {
  if (lo > hi) { const m = (lo + hi) / 2; return m + rubber(v - m, span); }
  if (v > hi) return hi + rubber(v - hi, span);
  if (v < lo) return lo - rubber(lo - v, span);
  return v;
}

export default function PdfReaderOverlay({ lectureId, lectureTitle, pdfUrl, lang, onClose }: Props) {
  const isRtl = lang === 'ar';

  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [pageCount, setPageCount] = useState(0);
  const [pageSizes, setPageSizes] = useState<{ w: number; h: number }[]>([]);
  const [scale, setScale] = useState(1);
  /**
   * Scale the page canvases are rasterised at, trailing `scale` by a debounce.
   *
   * Committing both together meant every zoom step tore down three canvases and
   * three text layers at once, and PdfPage blanked each canvas synchronously
   * while the replacement was still awaiting - which is what flashed the reader
   * white on every pinch. Now the layout resizes immediately and the existing
   * bitmap stretches to fill it until the sharp one lands.
   */
  const [rasterScale, setRasterScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [current, setCurrent] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [staleFile, setStaleFile] = useState(false);

  const [selection, setSelection] = useState<SelectionSnapshot | null>(null);
  const [editing, setEditing] = useState<PdfAnnotation | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [orphanIds, setOrphanIds] = useState<Set<string>>(new Set());
  /** Transient confirmation for the selection actions. It lives here rather
   *  than inside SelectionToolbar because every one of those actions clears the
   *  selection, which unmounts the toolbar before it could show anything. */
  const [toast, setToast] = useState<string | null>(null);

  const [simosanOpen, setSimosanOpen] = useState(false);
  const [simosanSeed, setSimosanSeed] = useState<string | null>(null);
  /** Null until the access probe returns. The entry points stay hidden rather
   *  than rendering an action that would only be refused. */
  const [simosanReady, setSimosanReady] = useState(false);

  /**
   * The active pinch, or null.
   *
   * `O` is the zoom layer's UNTRANSFORMED top-left in client coordinates and
   * `p0` the anchor point in layer-local coordinates. Together they are what
   * keeps content under the fingers: with transform-origin at 0 0 the visual
   * position of `p0` is O + t + k*p0, so solving that for the live focal point
   * gives the translate directly - at any scale, however far the fingers drift.
   *
   * The container metrics are snapshotted once here and never re-read mid
   * gesture. The CSS scrollable overflow region takes transformed descendant
   * boxes into account, so scrollWidth/scrollHeight stop meaning anything the
   * moment the transform goes live.
   */
  const gesture = useRef<{
    idA: number; idB: number;
    startDist: number; sBase: number;
    O: { x: number; y: number };
    p0: { x: number; y: number };
    F: { x: number; y: number };
    S0x: number; S0y: number;
    sw: number; sh: number; w: number; h: number;
    rectLeft: number; rectTop: number;
  } | null>(null);

  /**
   * The live transform is deliberately NOT React state.
   *
   * It used to be, and a setState on every pointermove re-rendered this whole
   * component - which maps over `layout` and mounts canvas-backed PdfPages. On a
   * mid-range phone that re-render cannot keep up with the pointer stream, so the
   * transform landed at a low, irregular rate and the zoom read as jumping in
   * steps rather than gliding. Writing the transform straight to the node inside
   * a rAF keeps the gesture at display rate and renders nothing.
   *
   * `s` is an ABSOLUTE scale rather than a factor, so a pinch that begins while
   * the release spring is still running composes with what is already applied
   * instead of snapping back to 1 first.
   */
  const live = useRef({ s: 1, tx: 0, ty: 0 });
  const spring = useRef<number | null>(null);
  const zoomLayerRef = useRef<HTMLDivElement>(null);
  const zoomLabelRef = useRef<HTMLSpanElement>(null);
  const zoomRaf = useRef<number | null>(null);
  /** Committed scale, readable from rAF callbacks without re-binding them. */
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  /** Paints the live transform once per frame. */
  const paintZoom = useCallback(() => {
    zoomRaf.current = null;
    const layer = zoomLayerRef.current;
    const { s, tx, ty } = live.current;
    const k = s / scaleRef.current;

    if (import.meta.env.DEV && !(Number.isFinite(k) && Number.isFinite(tx) && Number.isFinite(ty))) {
      // A transform containing NaN is dropped by CSS silently, so without this
      // the gesture would simply stop moving with nothing logged anywhere. There
      // are no React types in this project, so a typo'd ref field reaches here
      // as undefined rather than as a compile error.
      console.error('[pdf] non-finite transform', { s, tx, ty, scale: scaleRef.current });
      return;
    }

    if (layer) {
      layer.style.transform = k === 1 && tx === 0 && ty === 0
        ? ''
        : `translate3d(${tx}px, ${ty}px, 0) scale(${k})`;
    }
    // The readout tracked the committed scale only, so during a pinch the number
    // sat frozen and then snapped on release. Written here it counts smoothly.
    const label = zoomLabelRef.current;
    if (label) label.textContent = `${Math.round(s * 100)}%`;
  }, []);

  const scheduleZoomPaint = useCallback(() => {
    if (zoomRaf.current == null) zoomRaf.current = requestAnimationFrame(paintZoom);
  }, [paintZoom]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pages = useRef(new Map<number, PageHandle>());
  const fingerprint = useRef('');
  const pendingPage = useRef<number | null>(null);

  const { annotations, byPage, upsert, remove, removeAll } = useLectureAnnotations(lectureId);

  useBackDismiss(true, onClose, 'pdfReader');
  useBackDismiss(drawerOpen, () => setDrawerOpen(false), 'pdfNotes');
  useBackDismiss(!!editing, () => setEditing(null), 'pdfNote');
  // Registered last so it sits on top of the shared layer stack - a back press
  // while Simosan is open must close Simosan, not the notes drawer beneath it.
  useBackDismiss(simosanOpen, () => setSimosanOpen(false), 'pdfSimosan');

  // One probe per open. The server is the authority on both subscription and
  // the global kill switch, so this only decides whether to draw the button.
  useEffect(() => {
    let alive = true;
    fetchSimosanState().then((s) => { if (alive) setSimosanReady(!!s?.available); });
    return () => { alive = false; };
  }, []);

  const openSimosan = useCallback((seed?: string) => {
    setSimosanSeed(seed ?? null);
    setSimosanOpen(true);
  }, []);

  const registerPage = useCallback((n: number, h: PageHandle | null) => {
    if (h) pages.current.set(n, h);
    else pages.current.delete(n);
  }, []);

  const markOrphan = useCallback((id: string, orphaned: boolean) => {
    setOrphanIds(prev => {
      if (orphaned === prev.has(id)) return prev;
      const next = new Set(prev);
      if (orphaned) next.add(id); else next.delete(id);
      return next;
    });
  }, []);

  // ---- document loading -------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();

    (async () => {
      try {
        // Prefer the downloaded copy: it works offline and skips the network
        // entirely for a lecture the student already saved.
        const [pdfjs, local] = await Promise.all([
          loadPdfjs(),
          readStoredPdf(pdfUrl),
        ]);
        if (cancelled) return;
        const buf = local ?? await fetchPdfBytes(pdfUrl, ac.signal);
        if (cancelled) return;

        const doc = await pdfjs.getDocument({
          ...PDFJS_DOC_OPTIONS,
          data: freshBytes(buf),
        }).promise;
        if (cancelled) { doc.destroy(); return; }

        const sizes: { w: number; h: number }[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const p = await doc.getPage(i);
          const v = p.getViewport({ scale: 1, rotation: 0 });
          sizes.push({ w: v.width, h: v.height });
        }
        if (cancelled) { doc.destroy(); return; }

        fingerprint.current = doc.fingerprints?.[0] ?? '';

        // Warn rather than silently misplace highlights if the file changed.
        const meta = await getDocMeta(lectureId);
        if (meta?.fingerprint && meta.fingerprint !== fingerprint.current) setStaleFile(true);

        // Claim the remembered page BEFORE any state update below. `layout` is
        // derived from pageSizes, so the effect that consumes this fires as soon
        // as setPageSizes lands - and anything set after a later `await` would
        // arrive too late to be seen.
        if (meta?.lastPage && meta.lastPage > 1) pendingPage.current = meta.lastPage;

        setPdfDoc(doc);
        setPageCount(doc.numPages);
        setPageSizes(sizes);

        // Always open at fit-width. These are wide lecture slides, and the
        // PDF's natural size overflows a phone screen and clips the text.
        // Zoom is deliberately NOT restored: persisting it meant one bad stored
        // value stuck forever, and reopening at readable width is what every
        // PDF reader does. Page position is still remembered.
        const avail = (scrollRef.current?.clientWidth ?? window.innerWidth) - 16;
        const widest = Math.max(...sizes.map(z => z.w));
        if (widest > 0) {
          const fit = +Math.max(MIN_SCALE, Math.min(MAX_SCALE, avail / widest)).toFixed(2);
          setScale(fit);
          // Prime the raster with it as well. Left to the debounce, opening a
          // lecture would rasterise three canvases at scale 1 and throw them
          // away 200ms later - the fit scale is not a gesture and needs no lag.
          setRasterScale(fit);
        }

        await setDocMeta(lectureId, {
          fingerprint: fingerprint.current,
          pageCount: doc.numPages,
        });

      } catch (e: any) {
        if (cancelled || e?.name === 'AbortError') return;
        console.error('PDF load failed', e);
        setError(
          isRtl
            ? 'تعذّر فتح ملف المحاضرة. تحقق من الاتصال وحاول مرة أخرى.'
            : 'Could not open this lecture file. Check your connection and try again.',
        );
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfUrl, lectureId]);

  // Tear the document down explicitly - the worker holds page resources.
  useEffect(() => () => { try { pdfDoc?.destroy(); } catch { /* already gone */ } }, [pdfDoc]);

  // Remember where the reader was left.
  useEffect(() => {
    if (!pdfDoc) return;
    const id = setTimeout(() => setDocMeta(lectureId, { lastPage: current }), 400);
    return () => clearTimeout(id);
  }, [current, lectureId, pdfDoc]);

  // ---- layout / virtualization -----------------------------------------
  const layout = useMemo(() => {
    const swap = rotation % 180 !== 0;
    let y = 0;
    return pageSizes.map((s) => {
      const w = (swap ? s.h : s.w) * scale;
      const h = (swap ? s.w : s.h) * scale;
      const top = y;
      y += h + 24; // matches the my-3 gap on each page
      return { top, w, h };
    });
  }, [pageSizes, scale, rotation]);

  /**
   * Let the raster catch up once the zoom stops moving.
   *
   * Rotation needs no special case here. It is a raster dep of PdfPage in its
   * own right, so a rotation rebuilds the canvas and the text layer immediately
   * whatever this holds - and special-casing it here only had the effect of
   * disabling the debounce for good once the reader was rotated.
   */
  useEffect(() => {
    const id = setTimeout(() => setRasterScale(scale), RASTER_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [scale]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || layout.length === 0) return;
    // A pinch pins scrollTop and writes a transform instead, so anything firing
    // here mid-gesture is the browser clamping, not the user moving. Acting on
    // it would setCurrent every frame - the exact re-render storm the live
    // transform exists to avoid.
    if (gesture.current) return;
    const mid = el.scrollTop + el.clientHeight / 2;
    let n = 1;
    for (let i = 0; i < layout.length; i++) {
      if (layout[i].top <= mid) n = i + 1; else break;
    }
    setCurrent(n);
  }, [layout]);

  /**
   * Two-finger pinch zoom, with focal tracking, two-finger pan and elastic
   * limits on both scale and translate.
   *
   * The live gesture only sets a CSS transform on the page column - re-rendering
   * canvases on every pointermove would drop frames badly on a mid-range phone.
   * The real `scale` is committed once the release spring settles, which is also
   * when the pages re-rasterise crisply.
   *
   * The page viewport meta sets user-scalable=no, so the browser's own pinch is
   * off and these gestures arrive as plain pointer events with nothing to fight.
   *
   * Note there is deliberately no preventDefault() in here. Per the Pointer
   * Events spec it has no defined effect on panning and Chrome ignores it;
   * touch-action is the only thing that suppresses the WebView's own scroll.
   */
  const pointers = useRef(new Map<number, { x: number; y: number }>());

  /** Anchor to hold still across a committed scale or rotation change. */
  const zoomAnchor = useRef<
    { el: HTMLElement; relX: number; relY: number; wantX: number; wantY: number } | null
  >(null);
  const prevScale = useRef(scale);
  const prevRotation = useRef(rotation);

  /** Midpoint of the two PINNED pointers, in client coordinates. */
  const focal = () => {
    const g = gesture.current!;
    const a = pointers.current.get(g.idA)!;
    const b = pointers.current.get(g.idB)!;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  const dist = () => {
    const g = gesture.current!;
    const a = pointers.current.get(g.idA)!;
    const b = pointers.current.get(g.idB)!;
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  /**
   * Translate limits for a given live factor.
   *
   * The usable span is k*scrollWidth - clientWidth: the SCALED SCROLLABLE
   * extent, meaning every mounted page and placeholder, not the viewport box. A
   * single-element formula like rect.width * (k - 1) is right for one
   * transformed div and out by orders of magnitude down a 100-page lecture.
   */
  const bounds = (g: NonNullable<typeof gesture.current>, k: number) => {
    const cMinX = (g.rectLeft - g.S0x) - g.O.x;
    const cMinY = (g.rectTop - g.S0y) - g.O.y;
    return {
      txMax: g.rectLeft - g.O.x - k * cMinX,
      txMin: g.rectLeft + g.w - g.O.x - k * (cMinX + g.sw),
      tyMax: g.rectTop - g.O.y - k * cMinY,
      tyMin: g.rectTop + g.h - g.O.y - k * (cMinY + g.sh),
    };
  };

  /** The mounted page under a client point, or the nearest one. */
  const pageAt = (x: number, y: number) => {
    let nearest: { el: HTMLElement; pr: DOMRect; d: number } | null = null;
    for (const h of pages.current.values()) {
      const pr = h.el.getBoundingClientRect();
      if (pr.height <= 0 || pr.width <= 0) continue;
      if (y >= pr.top && y <= pr.bottom) return { el: h.el, pr };
      const d = Math.abs((pr.top + pr.bottom) / 2 - y);
      if (!nearest || d < nearest.d) nearest = { el: h.el, pr, d };
    }
    return nearest ? { el: nearest.el, pr: nearest.pr } : null;
  };

  const anchorAt = (x: number, y: number) => {
    const hit = pageAt(x, y);
    if (!hit) return null;
    return {
      el: hit.el,
      relX: (x - hit.pr.left) / hit.pr.width,
      relY: (y - hit.pr.top) / hit.pr.height,
      wantX: x, wantY: y,
    };
  };

  /** Anchor on the viewport centre - what the +/- and rotate buttons use. */
  const captureCentreAnchor = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const R = el.getBoundingClientRect();
    zoomAnchor.current = anchorAt(R.left + el.clientWidth / 2, R.top + el.clientHeight / 2);
  }, []);

  /**
   * Fold the live transform into the committed scale and native scroll.
   *
   * The transform is cleared BEFORE the commit, not in a layout effect here.
   * React runs a child's effects before its parent's, so deferring the clear
   * would let PdfPage's paint() measure getClientRects() through a live
   * transform - and every highlight would land k times too far out.
   */
  const commitGesture = useCallback((g: NonNullable<typeof gesture.current>) => {
    const el = scrollRef.current;
    const layer = zoomLayerRef.current;
    if (!el || !layer) return;
    if (zoomRaf.current != null) { cancelAnimationFrame(zoomRaf.current); zoomRaf.current = null; }

    const { s, tx, ty } = live.current;
    const committed = scaleRef.current;

    // Pure two-finger pan: the scale never really moved, so no render is needed
    // at all. Fold the translate into scroll and drop the transform in one tick.
    if (Math.abs(s - committed) < 0.005) {
      layer.style.transform = '';
      layer.style.willChange = '';
      live.current = { s: committed, tx: 0, ty: 0 };
      // Content sits at +t; scrolling by -t leaves it exactly where it looks.
      el.scrollLeft = clamp(g.S0x - tx, 0, el.scrollWidth - el.clientWidth);
      el.scrollTop = clamp(g.S0y - ty, 0, el.scrollHeight - el.clientHeight);
      onScroll();
      return;
    }

    zoomAnchor.current = anchorAt(g.F.x, g.F.y);
    layer.style.transform = '';
    live.current = { s, tx: 0, ty: 0 };

    // flushSync so React commits the new scale and lays the pages out before the
    // browser paints. The scroll correction in the layout effect below then runs
    // in the same frame, and no intermediate position is ever shown.
    flushSync(() => setScale(+clamp(s, MIN_SCALE, MAX_SCALE).toFixed(3)));
    layer.style.willChange = '';
  }, [onScroll]);

  /**
   * Settle scale and translate back into range, then commit.
   *
   * Both are sprung in one loop because the translate limits are a function of
   * the live scale: a target computed once at release would be out of bounds
   * again by the time the scale finished moving.
   */
  const startSpring = useCallback((g: NonNullable<typeof gesture.current>) => {
    const sEnd = clamp(live.current.s, MIN_SCALE, MAX_SCALE);
    const t0 = performance.now();
    let last = t0;

    const step = (now: number) => {
      // Clamped so a backgrounded tab does not resume with one enormous step.
      const dt = Math.min(64, Math.max(1, now - last));
      last = now;
      const f = 1 - Math.pow(1 - SPRING, dt / 16.667);

      live.current.s += (sEnd - live.current.s) * f;
      const k = live.current.s / scaleRef.current;
      const b = bounds(g, k);
      const tEndX = b.txMin > b.txMax
        ? (b.txMin + b.txMax) / 2
        : clamp(live.current.tx, b.txMin, b.txMax);
      const tEndY = b.tyMin > b.tyMax
        ? (b.tyMin + b.tyMax) / 2
        : clamp(live.current.ty, b.tyMin, b.tyMax);
      live.current.tx += (tEndX - live.current.tx) * f;
      live.current.ty += (tEndY - live.current.ty) * f;
      paintZoom();

      const settled =
        Math.abs(live.current.s - sEnd) < 0.002 &&
        Math.abs(tEndX - live.current.tx) < 0.5 &&
        Math.abs(tEndY - live.current.ty) < 0.5;

      if (settled || now - t0 > SPRING_TIMEOUT_MS) {
        live.current.s = sEnd;
        live.current.tx = tEndX;
        live.current.ty = tEndY;
        spring.current = null;
        commitGesture(g);
        return;
      }
      spring.current = requestAnimationFrame(step);
    };
    spring.current = requestAnimationFrame(step);
  }, [paintZoom, commitGesture]);

  /**
   * Drop everything the gesture owns.
   *
   * Backgrounding mid-pinch is routine on Android, and without this the
   * touch-action override stayed on the node - which killed panning for the
   * rest of the session.
   */
  const abortGesture = useCallback(() => {
    const el = scrollRef.current;
    const layer = zoomLayerRef.current;
    if (spring.current != null) { cancelAnimationFrame(spring.current); spring.current = null; }
    if (zoomRaf.current != null) { cancelAnimationFrame(zoomRaf.current); zoomRaf.current = null; }
    const g = gesture.current;
    if (g && el) {
      try { el.releasePointerCapture(g.idA); el.releasePointerCapture(g.idB); } catch { /* already gone */ }
    }
    gesture.current = null;
    pointers.current.clear();
    if (el) el.style.touchAction = '';
    if (layer) { layer.style.transform = ''; layer.style.willChange = ''; }
    live.current = { s: scaleRef.current, tx: 0, ty: 0 };
    const label = zoomLabelRef.current;
    if (label) label.textContent = `${Math.round(scaleRef.current * 100)}%`;
  }, []);

  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') abortGesture(); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', abortGesture);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', abortGesture);
      abortGesture();
    };
  }, [abortGesture]);

  const onPointerDown = (e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // A third finger is tracked but never joins the gesture. The old code took
    // the first two in map order, so lifting a middle finger silently swapped
    // which pair was measured against the same startDist and the scale jumped.
    if (pointers.current.size !== 2 || gesture.current) return;

    const el = scrollRef.current;
    const layer = zoomLayerRef.current;
    if (!el || !layer) return;

    // Stop any spring first, so O and p0 below are measured against a transform
    // that is not still moving under them.
    if (spring.current != null) { cancelAnimationFrame(spring.current); spring.current = null; }

    const [idA, idB] = [...pointers.current.keys()];
    const a = pointers.current.get(idA)!;
    const b = pointers.current.get(idB)!;
    const F0 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

    const { tx, ty, s } = live.current;
    const kPrev = s / scale;
    const lr = layer.getBoundingClientRect();
    // With transform-origin at 0 0 the rect's top-left is the untransformed
    // top-left plus the translate, so the origin comes back exactly - which is
    // what lets a pinch start from a transform that is already applied.
    const O = { x: lr.left - tx, y: lr.top - ty };
    const R = el.getBoundingClientRect();

    gesture.current = {
      idA, idB,
      startDist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      sBase: s,
      O,
      p0: { x: (F0.x - O.x - tx) / kPrev, y: (F0.y - O.y - ty) / kPrev },
      F: F0,
      S0x: el.scrollLeft, S0y: el.scrollTop,
      sw: el.scrollWidth, sh: el.scrollHeight,
      w: el.clientWidth, h: el.clientHeight,
      rectLeft: R.left, rectTop: R.top,
    };

    // Set on the node rather than through a render: touch-action is read when
    // the gesture starts, so flipping it via state on the NEXT frame is already
    // too late and the WebView keeps panning underneath the pinch.
    el.style.touchAction = 'none';
    layer.style.willChange = 'transform';
    // Capture both, so a release that lands outside the element still reaches
    // us. Capturing the FIRST pointer instead would swallow long-press text
    // selection and the highlight taps, so it deliberately waits for the second.
    try { el.setPointerCapture(idA); el.setPointerCapture(idB); } catch { /* not captureable */ }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const g = gesture.current;
    if (!g || (e.pointerId !== g.idA && e.pointerId !== g.idB)) return;

    const F = focal();
    g.F = F;
    live.current.s = elasticScale(g.sBase * (dist() / g.startDist));

    const k = live.current.s / scaleRef.current;
    const b = bounds(g, k);
    // The ideal translate keeps p0 exactly under the focal point; the band then
    // pulls it back toward the legal range, which is what gives at the edges.
    live.current.tx = band(F.x - g.O.x - k * g.p0.x, b.txMin, b.txMax, g.w);
    live.current.ty = band(F.y - g.O.y - k * g.p0.y, b.tyMin, b.tyMax, g.h);

    // A live transform changes the scrollable overflow region, and shrinking it
    // makes the browser clamp scroll - which would slide the content out from
    // under the fingers even though touch scrolling is off. Pin it instead.
    const el = scrollRef.current;
    if (el) {
      if (el.scrollLeft !== g.S0x) el.scrollLeft = g.S0x;
      if (el.scrollTop !== g.S0y) el.scrollTop = g.S0y;
    }

    scheduleZoomPaint();
  };

  const endPointer = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (!g) return;
    // End on either PINNED id. Waiting for the map to fall below two kept the
    // gesture alive when a third finger lifted, measuring a different pair.
    if (e.pointerId !== g.idA && e.pointerId !== g.idB) return;

    // Cleared before the release, because releasePointerCapture fires
    // lostpointercapture - which is wired to this same handler - and a
    // re-entrant call would start a second spring for the same gesture.
    gesture.current = null;
    const el = scrollRef.current;
    if (el) {
      try { el.releasePointerCapture(g.idA); el.releasePointerCapture(g.idB); } catch { /* already gone */ }
      el.style.touchAction = '';
    }
    startSpring(g);
  };

  const scrollToPage = useCallback((n: number) => {
    const el = scrollRef.current;
    if (!el || !layout[n - 1]) return;
    el.scrollTo({ top: Math.max(0, layout[n - 1].top - 8), behavior: 'smooth' });
  }, [layout]);

  /**
   * Hold position across a zoom or rotation.
   *
   * Changing scale makes every page taller but does not move scrollTop and does
   * not fire a scroll event - so the viewport silently lands on a different page
   * while `current` still points at the old one, and the pages actually on
   * screen fall outside the mounted window and render as blank placeholders.
   *
   * The anchor is a RATIO inside a real page element, measured before the change
   * and re-measured after. Ratios are transform-invariant, so this is exact by
   * construction - where the factor arithmetic it replaces was wrong three ways:
   * it centred horizontally on the viewport rather than on the gesture, it
   * assumed scrollHeight scales with the zoom when the 24px page gaps do not,
   * and it leaned on a `layout` that over-counts those gaps because adjacent
   * my-3 margins collapse to 12px rather than summing to 24.
   *
   * useLayoutEffect, not useEffect: this runs inside the commit's flushSync and
   * has to land before the browser paints, or the correction is visible as a jump.
   */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (prevScale.current === scale && prevRotation.current === rotation) return;
    prevScale.current = scale;
    prevRotation.current = rotation;

    // Idle state has to track the committed scale, or the next pinch would start
    // from a stale absolute and jump on the first frame.
    if (!gesture.current && spring.current == null) live.current = { s: scale, tx: 0, ty: 0 };

    const a = zoomAnchor.current;
    zoomAnchor.current = null;
    if (layout.length === 0) return;

    if (a) {
      const pr = a.el.getBoundingClientRect();
      if (pr.height > 0 && pr.width > 0) {
        // have - want is how far the anchor moved down/right; scrolling by that
        // much puts it back exactly where the fingers left it.
        el.scrollTop = clamp(
          el.scrollTop + (pr.top + a.relY * pr.height) - a.wantY,
          0, el.scrollHeight - el.clientHeight,
        );
        el.scrollLeft = clamp(
          el.scrollLeft + (pr.left + a.relX * pr.width) - a.wantX,
          0, el.scrollWidth - el.clientWidth,
        );
      }
    }

    onScroll();
  }, [scale, rotation, layout, onScroll]);

  // Once the page boxes exist, honour a remembered page.
  useEffect(() => {
    if (pendingPage.current && layout.length > 0) {
      const n = pendingPage.current;
      pendingPage.current = null;
      requestAnimationFrame(() => scrollToPage(n));
    }
  }, [layout, scrollToPage]);

  /** Only the visible page and its neighbours are mounted - the rest are boxes. */
  const isLive = (n: number) => Math.abs(n - current) <= 1;

  // ---- selection --------------------------------------------------------
  /** DOM position -> canonical offset within a page. */
  const canonicalOffset = (h: PageHandle, node: Node, offset: number): number | null => {
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
    const span = el?.closest('[data-item-index]') as HTMLElement | null;
    if (!span) return null;
    const itemIndex = Number(span.dataset.itemIndex);
    const r = h.canonical.itemRanges[itemIndex];
    if (!r) return null;
    return r.start + canonicalOffsetWithin(span.textContent ?? '', offset);
  };

  const fragmentFor = (range: Range, h: PageHandle): SelectionFragment | null => {
    if (!range.intersectsNode(h.textLayerEl)) return null;

    const spans = [...h.spanByItem.values()];
    if (spans.length === 0) return null;

    // Clamp the selection to this page: if it started or ended on another page,
    // use this page's own first/last text node instead.
    const sub = document.createRange();
    const startsHere = h.textLayerEl.contains(range.startContainer);
    const endsHere = h.textLayerEl.contains(range.endContainer);
    try {
      if (startsHere) sub.setStart(range.startContainer, range.startOffset);
      else sub.setStart(spans[0].firstChild ?? spans[0], 0);

      if (endsHere) sub.setEnd(range.endContainer, range.endOffset);
      else {
        const last = spans[spans.length - 1];
        const node = last.firstChild ?? last;
        sub.setEnd(node, node.textContent?.length ?? 0);
      }
    } catch {
      return null;
    }
    if (sub.collapsed) return null;

    const start = canonicalOffset(h, sub.startContainer, sub.startOffset);
    const end = canonicalOffset(h, sub.endContainer, sub.endOffset);
    if (start === null || end === null || end <= start) return null;

    const box = h.el.getBoundingClientRect();
    const clientRects = Array.from(sub.getClientRects()) as DOMRect[];
    return {
      pageNumber: h.pageNumber,
      start,
      end,
      quads: rectsToQuads(clientRects, { left: box.left, top: box.top }, h.viewport),
      pageW: h.pageW,
      pageH: h.pageH,
      canonicalText: h.canonical.text,
    };
  };

  /**
   * Snapshot the selection the moment it happens.
   *
   * iOS collapses the selection on the first DOM mutation, so reading
   * window.getSelection() later - inside the toolbar's click handler - returns
   * nothing. Everything the toolbar needs is captured here instead.
   */
  const captureSelection = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { setSelection(null); return; }

    const range = sel.getRangeAt(0);
    const text = sel.toString().trim();
    if (!text) { setSelection(null); return; }

    const fragments: SelectionFragment[] = [];
    for (const h of pages.current.values()) {
      const f = fragmentFor(range, h);
      if (f) fragments.push(f);
    }
    if (fragments.length === 0) { setSelection(null); return; }

    setSelection({
      text,
      fragments: fragments.sort((a, b) => a.pageNumber - b.pageNumber),
    });
  }, []);

  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const onChange = () => {
      clearTimeout(t);
      // Never snapshot mid-gesture. captureSelection measures getClientRects()
      // and stores the result as PDF-space quads, so a snapshot taken through a
      // live transform would be persisted wrong by the live factor. Re-arm
      // instead of dropping it, so a selection made just before a pinch is not lost.
      t = setTimeout(function run() {
        if (gesture.current || spring.current != null) { t = setTimeout(run, 140); return; }
        captureSelection();
      }, 140);
    };
    document.addEventListener('selectionchange', onChange);
    return () => { document.removeEventListener('selectionchange', onChange); clearTimeout(t); };
  }, [captureSelection]);

  const clearSelection = () => {
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  };

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1800);
    return () => clearTimeout(t);
  }, [toast]);

  /**
   * Run one selection action, then clear.
   *
   * The text is read BEFORE clearing for the same reason captureSelection
   * exists: the selection is gone by the time an awaited call resolves.
   */
  const runSelectionAction = (
    act: (text: string) => Promise<'ok' | 'copied' | 'failed'>,
    messages: { ok: string; copied?: string; failed: string },
  ) => {
    const text = selection?.text;
    if (!text) return;
    clearSelection();
    void act(text).then((r) => {
      if (r === 'ok') setToast(messages.ok);
      else if (r === 'copied') setToast(messages.copied ?? messages.ok);
      else setToast(messages.failed);
    });
  };

  /* ---------------------------------------------------------------- search */

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [matchIndex, setMatchIndex] = useState(0);
  const [listOpen, setListOpen] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [indexed, setIndexed] = useState(0);
  /** pageNumber -> its searchable text. Survives closing and reopening search. */
  const searchIndex = useRef<Map<number, PageSearchIndex>>(new Map());

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery('');
    setMatches([]);
    setMatchIndex(0);
    setListOpen(false);
  }, []);

  useBackDismiss(searchOpen, closeSearch, 'pdfSearch');

  /**
   * Pull every page's text once, in page order.
   *
   * It cannot come from the mounted text layers: only a window of three pages
   * is mounted at a time, so the DOM knows nothing about page 40 while page 2
   * is on screen. getTextContent() is the only source that sees the whole
   * document, and it is cheap next to rendering - no canvas, no fonts.
   *
   * Results are published page by page rather than at the end, so a hit on page
   * 2 is usable while page 200 is still being read.
   */
  useEffect(() => {
    if (!searchOpen || !pdfDoc) return;

    const total: number = pdfDoc.numPages;
    if (searchIndex.current.size >= total) { setIndexed(total); return; }

    let cancelled = false;
    setIndexing(true);

    void (async () => {
      for (let n = 1; n <= total; n++) {
        if (cancelled) return;
        if (!searchIndex.current.has(n)) {
          try {
            const page = await pdfDoc.getPage(n);
            const tc = await page.getTextContent();
            searchIndex.current.set(n, buildPageSearchIndex(n, tc.items));
          } catch {
            // A page that will not yield text contributes no matches. Indexing
            // the rest still beats failing the whole search.
          }
        }
        if (cancelled) return;
        setIndexed(n);
      }
      setIndexing(false);
    })();

    return () => { cancelled = true; setIndexing(false); };
  }, [searchOpen, pdfDoc]);

  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 180);
    return () => clearTimeout(t);
  }, [query]);

  /**
   * Highest page already searched for the CURRENT query.
   *
   * Results extend as indexing advances rather than being recomputed from page
   * one each time. Recomputing looked simpler but was wrong twice over: it made
   * the whole search quadratic in a long lecture, and because the debounce
   * restarted on every indexed page, a two-hundred-page PDF showed no results
   * at all until indexing finished.
   */
  const searchedUpTo = useRef(0);

  useEffect(() => {
    searchedUpTo.current = 0;
    setMatches([]);
    setMatchIndex(0);
  }, [debouncedQuery]);

  useEffect(() => {
    if (!searchOpen || searchedUpTo.current >= indexed) return;

    const from = searchedUpTo.current + 1;
    searchedUpTo.current = indexed;

    const found: SearchMatch[] = [];
    for (let n = from; n <= indexed; n++) {
      const idx = searchIndex.current.get(n);
      if (idx) found.push(...searchPageIndex(idx, debouncedQuery));
    }
    if (found.length === 0) return;

    setMatches(prev => (prev.length >= MAX_MATCHES ? prev : [...prev, ...found].slice(0, MAX_MATCHES)));
  }, [debouncedQuery, indexed, searchOpen]);

  const activeHit = matches[matchIndex] ?? null;

  /**
   * Follow the active hit.
   *
   * Keyed on the hit's identity rather than on the index, so retyping a query
   * that happens to keep the same index still scrolls, and a re-render that
   * changes neither does not.
   */
  const jumpedTo = useRef('');
  useEffect(() => {
    if (!activeHit) { jumpedTo.current = ''; return; }
    const key = `${activeHit.pageNumber}:${activeHit.start}`;
    if (jumpedTo.current === key) return;
    jumpedTo.current = key;
    scrollToPage(activeHit.pageNumber);
  }, [activeHit, scrollToPage]);

  const stepMatch = (delta: number) => {
    if (matches.length === 0) return;
    setMatchIndex(i => (i + delta + matches.length) % matches.length);
  };

  /** One annotation per page the selection touched, tied by a shared groupId. */
  const createHighlight = async (color: HighlightColor, openNote: boolean) => {
    const snap = selection;
    if (!snap) return;

    const groupId = snap.fragments.length > 1 ? crypto.randomUUID() : undefined;
    const now = Date.now();
    let first: PdfAnnotation | null = null;

    for (const f of snap.fragments) {
      const a: PdfAnnotation = {
        id: crypto.randomUUID(),
        lectureId,
        docFingerprint: fingerprint.current,
        kind: 'highlight',
        page: f.pageNumber,
        color,
        groupId,
        anchor: buildAnchor({
          text: f.canonicalText,
          start: f.start,
          end: f.end,
          quads: f.quads,
          pageW: f.pageW,
          pageH: f.pageH,
        }),
        createdAt: now,
        updatedAt: now,
        schema: 1,
      };
      if (!first) first = a;
      await upsert(a);
    }

    clearSelection();
    if (openNote && first) setEditing(first);
  };

  const addPin = async (pageNumber: number, point: { x: number; y: number }) => {
    // Same reason as captureSelection: convertToPdfPoint reads a rect measured
    // through the live transform, so a pin dropped during the release spring
    // would be stored at a completely different point on the page.
    if (gesture.current || spring.current != null) return;
    const now = Date.now();
    const a: PdfAnnotation = {
      id: crypto.randomUUID(),
      lectureId,
      docFingerprint: fingerprint.current,
      kind: 'pin',
      page: pageNumber,
      color: 'yellow',
      point,
      createdAt: now,
      updatedAt: now,
      schema: 1,
    };
    await upsert(a);
    setEditing(a);
  };

  const goTo = (a: PdfAnnotation) => {
    setDrawerOpen(false);
    scrollToPage(a.page);
    setFlashId(a.id);
    setTimeout(() => setFlashId(null), 1400);
  };

  const doExport = async () => {
    const json = await exportLecture(lectureId, lectureTitle);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${lectureTitle || 'lecture'}-notes.json`.replace(/[\\/:*?"<>|]/g, '_');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const Back = isRtl ? ChevronRight : ChevronLeft;
  const Fwd = isRtl ? ChevronLeft : ChevronRight;
  const noteCount = annotations.length;

  return (
    <div
      dir={isRtl ? 'rtl' : 'ltr'}
      className="pdfReaderSurface fixed inset-0 z-[160] bg-white dark:bg-zinc-900 flex flex-col overflow-hidden"
    >
      <header className="shrink-0 flex items-center gap-2 px-3 pt-[max(env(safe-area-inset-top),0.5rem)] pb-2 border-b border-slate-200 dark:border-zinc-800">
        <button
          onClick={onClose}
          aria-label={isRtl ? 'إغلاق' : 'Close'}
          className="p-2 rounded-full text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
        >
          <X className="w-6 h-6" />
        </button>

        <h1 dir="auto" className="flex-1 min-w-0 truncate font-bold text-slate-900 dark:text-stone-100">
          {lectureTitle}
        </h1>

        <button
          onClick={() => setSearchOpen(true)}
          aria-label={isRtl ? 'بحث في المحاضرة' : 'Search this lecture'}
          className="p-2 rounded-full text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
        >
          <Search className="w-6 h-6" />
        </button>

        {simosanReady && (
          <button
            onClick={() => openSimosan()}
            aria-label={isRtl ? 'اسأل سيموسان' : 'Ask Simosan'}
            className="p-2 rounded-full text-violet-500 hover:bg-violet-50 dark:hover:bg-violet-950/40 transition-colors"
          >
            <Sparkles className="w-6 h-6" />
          </button>
        )}

        <button
          onClick={() => setDrawerOpen(true)}
          aria-label={isRtl ? 'ملاحظاتي' : 'My notes'}
          className="relative p-2 rounded-full text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
        >
          <NotebookPen className="w-6 h-6" />
          {noteCount > 0 && (
            <span className="absolute -top-0.5 -end-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-sky-500 text-white text-[10px] font-black flex items-center justify-center">
              {noteCount}
            </span>
          )}
        </button>
      </header>

      {staleFile && (
        <div className="shrink-0 flex items-start gap-2 px-4 py-2 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-400 text-xs font-bold">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            {isRtl
              ? 'هذه الملاحظات كُتبت على نسخة أقدم من هذا الملف، وقد لا تكون في مواضعها.'
              : 'These notes were made on an older version of this file and may not line up.'}
          </span>
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={onScroll}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onLostPointerCapture={endPointer}
        dir="ltr"
        // touch-action is switched to 'none' imperatively on the second
        // pointerdown and cleared on release - see onPointerDown. It cannot be
        // driven from state: the browser latches touch-action when the gesture
        // begins, so a value arriving on the next render is already too late.
        // overscroll-behavior stops the Android overscroll glow and stops a
        // pinch at the top of the document chaining a scroll to the fixed
        // surface behind this one.
        style={{ touchAction: 'auto', overscrollBehavior: 'contain' }}
        className="flex-1 overflow-y-auto overflow-x-auto bg-slate-200 dark:bg-zinc-950 px-2"
      >
        {error && (
          <div className="flex flex-col items-center justify-center h-full gap-3 px-8 text-center">
            <AlertTriangle className="w-12 h-12 text-amber-500" />
            <p dir={isRtl ? 'rtl' : 'ltr'} className="text-slate-600 dark:text-slate-300 font-bold">{error}</p>
          </div>
        )}

        {!error && !pdfDoc && (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-8 h-8 animate-spin text-sky-500" />
          </div>
        )}

        {pdfDoc && (
        <div
          ref={zoomLayerRef}
          // transform and willChange are written directly to this node during a
          // pinch; only the origin is declarative. Once the gesture commits, the
          // pages re-render at the real scale so text stays crisp.
          //
          // The origin MUST stay at 0 0. The focal maths solves O + t + k*p0 for
          // the translate, which only holds when scaling happens about the
          // layer's own top-left; at 50% 0 the content slid out from under the
          // fingers as it grew.
          style={{ transformOrigin: '0 0' }}
        >
        {layout.map((box, i) => {
          const n = i + 1;
          return isLive(n) ? (
            <PdfPage
              key={n}
              pdfDoc={pdfDoc}
              pageNumber={n}
              scale={scale}
              rasterScale={rasterScale}
              rotation={rotation}
              boxW={box.w}
              boxH={box.h}
              annotations={byPage.get(n) ?? NO_ANNOTATIONS}
              registerPage={registerPage}
              onHighlightTap={setEditing}
              onOrphan={markOrphan}
              onPinPoint={addPin}
              flashId={flashId}
              searchMatch={searchOpen && activeHit?.pageNumber === n ? activeHit : null}
            />
          ) : (
            // Placeholder keeps the scroll height honest while unmounted, so
            // scrolling a 100-page lecture does not shift under the finger.
            <div
              key={n}
              className="mx-auto my-3 bg-white/60 dark:bg-zinc-800/40 rounded"
              style={{ width: box.w, height: box.h }}
            />
          );
        })}
        </div>
        )}
      </div>

      <footer className="shrink-0 flex items-center justify-center gap-1 px-3 py-2 pb-[max(env(safe-area-inset-bottom),0.5rem)] border-t border-slate-200 dark:border-zinc-800">
        <button
          onClick={() => scrollToPage(Math.max(1, current - 1))}
          disabled={current <= 1}
          aria-label={isRtl ? 'السابق' : 'Previous'}
          className="p-2 rounded-full text-slate-600 dark:text-slate-300 disabled:opacity-30 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
        >
          <Back className="w-5 h-5" />
        </button>

        <span dir="ltr" className="min-w-[72px] text-center text-sm font-bold text-slate-600 dark:text-slate-300 tabular-nums">
          {current} / {pageCount || '-'}
        </span>

        <button
          onClick={() => scrollToPage(Math.min(pageCount, current + 1))}
          disabled={current >= pageCount}
          aria-label={isRtl ? 'التالي' : 'Next'}
          className="p-2 rounded-full text-slate-600 dark:text-slate-300 disabled:opacity-30 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
        >
          <Fwd className="w-5 h-5" />
        </button>

        <span className="w-px h-6 bg-slate-200 dark:bg-zinc-700 mx-2" />

        <button
          onClick={() => { captureCentreAnchor(); setScale(s => Math.max(MIN_SCALE, +(s - 0.25).toFixed(2))); }}
          disabled={scale <= MIN_SCALE}
          aria-label={isRtl ? 'تصغير' : 'Zoom out'}
          className="p-2 rounded-full text-slate-600 dark:text-slate-300 disabled:opacity-30 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
        >
          <Minus className="w-5 h-5" />
        </button>
        <span
          ref={zoomLabelRef}
          className="min-w-[46px] text-center text-xs font-bold text-slate-500 tabular-nums"
        >
          {Math.round(scale * 100)}%
        </span>
        <button
          onClick={() => { captureCentreAnchor(); setScale(s => Math.min(MAX_SCALE, +(s + 0.25).toFixed(2))); }}
          disabled={scale >= MAX_SCALE}
          aria-label={isRtl ? 'تكبير' : 'Zoom in'}
          className="p-2 rounded-full text-slate-600 dark:text-slate-300 disabled:opacity-30 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
        >
          <Plus className="w-5 h-5" />
        </button>
        <button
          onClick={() => { captureCentreAnchor(); setRotation(r => (r + 90) % 360); }}
          aria-label={isRtl ? 'تدوير' : 'Rotate'}
          className="p-2 rounded-full text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
        >
          <RotateCw className="w-5 h-5" />
        </button>
      </footer>

      <AnimatePresence>
        {selection && (
          <SelectionToolbar
            isRtl={isRtl}
            onPick={(c) => createHighlight(c, false)}
            onNote={() => createHighlight('yellow', true)}
            onCopy={() => runSelectionAction(copyText, {
              ok: isRtl ? 'تم النسخ' : 'Copied',
              failed: isRtl ? 'تعذّر النسخ' : 'Could not copy',
            })}
            onTranslate={() => runSelectionAction((t) => translateText(t, lang), {
              ok: isRtl ? 'جارٍ فتح الترجمة' : 'Opening Translate',
              failed: isRtl ? 'تعذّر فتح الترجمة' : 'Could not open Translate',
            })}
            onSearchWeb={() => runSelectionAction(webSearchText, {
              ok: isRtl ? 'جارٍ فتح البحث' : 'Opening search',
              failed: isRtl ? 'تعذّر فتح البحث' : 'Could not open search',
            })}
            onShare={() => runSelectionAction((t) => shareText(t, lectureTitle), {
              ok: isRtl ? 'تمت المشاركة' : 'Shared',
              copied: isRtl ? 'تم النسخ بدل المشاركة' : 'Copied instead',
              failed: isRtl ? 'تعذّرت المشاركة' : 'Could not share',
            })}
            onDismiss={clearSelection}
            onAskSimosan={simosanReady ? () => {
              const seed = selection.text;
              clearSelection();
              openSimosan(seed);
            } : undefined}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {searchOpen && (
          <PdfSearchPanel
            isRtl={isRtl}
            query={query}
            onQueryChange={setQuery}
            indexing={indexing}
            indexed={indexed}
            total={pageCount}
            matches={matches}
            activeIndex={matchIndex}
            listOpen={listOpen}
            onToggleList={() => setListOpen(o => !o)}
            onPrev={() => stepMatch(-1)}
            onNext={() => stepMatch(1)}
            onPick={(i) => { setMatchIndex(i); setListOpen(false); }}
            onClose={closeSearch}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            dir={isRtl ? 'rtl' : 'ltr'}
            role="status"
            className="absolute inset-x-0 bottom-24 z-[6] flex justify-center pointer-events-none"
          >
            <span className="rounded-full bg-zinc-900/95 text-white text-xs font-bold px-4 py-2 shadow-lg backdrop-blur">
              {toast}
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {editing && (
          <NoteEditorSheet
            annotation={editing}
            isRtl={isRtl}
            onSave={(note) => upsert({ ...editing, note, updatedAt: Date.now() })}
            onDelete={() => { remove(editing.id); setEditing(null); }}
            onClose={() => setEditing(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {drawerOpen && (
          <NotesDrawer
            annotations={annotations}
            orphanIds={orphanIds}
            isRtl={isRtl}
            onGoTo={goTo}
            onDelete={remove}
            onExport={doExport}
            onDeleteAll={() => setConfirmWipe(true)}
            onClose={() => setDrawerOpen(false)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {simosanOpen && (
          <SimosanDrawer
            isRtl={isRtl}
            lectureId={lectureId}
            seedSelection={simosanSeed}
            onJumpToPage={scrollToPage}
            onClose={() => setSimosanOpen(false)}
          />
        )}
      </AnimatePresence>

      <ConfirmModal
        isOpen={confirmWipe}
        onClose={() => setConfirmWipe(false)}
        onConfirm={() => { removeAll(); setConfirmWipe(false); setDrawerOpen(false); }}
        title={isRtl ? 'حذف كل الملاحظات' : 'Delete all notes'}
        message={isRtl
          ? 'سيتم حذف كل التظليلات والملاحظات في هذه المحاضرة من هذا الجهاز. لا يمكن التراجع.'
          : 'Every highlight and note for this lecture will be removed from this device. This cannot be undone.'}
      />
    </div>
  );
}
