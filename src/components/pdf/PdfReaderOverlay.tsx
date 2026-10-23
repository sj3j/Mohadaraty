import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import PdfPage, { type PageHandle } from './PdfPage';
import PdfSearchPanel from './PdfSearchPanel';
import NoteEditorSheet from './NoteEditorSheet';
import NotesDrawer from './NotesDrawer';
import PdfAttachmentsDrawer from './PdfAttachmentsDrawer';
import PdfTranslationSheet from './PdfTranslationSheet';
import NotewiseHeaderPill from './NotewiseHeaderPill';
import NotewisePagePill from './NotewisePagePill';
import NotewiseDocumentSheet from './NotewiseDocumentSheet';
import NotewiseOverviewModal from './NotewiseOverviewModal';
import NotewiseSelectionCapsule from './NotewiseSelectionCapsule';
import NotewiseAnnotationDock from './NotewiseAnnotationDock';
import PdfDrawingLayer from './PdfDrawingLayer';
import { PdfTextBoxOverlay } from './PdfTextBoxOverlay';
import type { DrawingTool, StrokeWidth, PdfStroke } from '../../types/pdfDrawing.types';
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
import { getUserFileBlob, getLecturePageStrokes, saveLecturePageStrokes } from '../../lib/localDb';
import { secureRequestId } from '../../lib/secureRandom';
import { hasSubscriptionAccess } from '../../../shared/subscriptionAccess';
import {
  commitCanonicalOperation,
  migrateStrokeToCanonical,
} from '../../services/unifiedPdfAnnotationService';
import { exportAnnotatedPdf } from '../../services/pdfExportService';
import {
  NativePdf,
  isNativePdfSupported,
  type InteractiveZone,
  type ReaderInteractionState,
} from '../../lib/nativePdfViewer';
import {
  DEFAULT_READER_INTERACTION,
  PdfInteractionRevisionCoordinator,
} from '../../lib/pdfInteractionState';
import { getNativePdfFilePath, cacheNativePdfBytes } from '../../lib/nativePdfRepository';
import type { HighlightColor, PdfAnnotation } from '../../types/pdfAnnotation.types';
import type { Language, UserProfile } from '../../types';
import '../../styles/pdf-text-layer.css';

interface Props {
  lectureId: string;
  lectureTitle: string;
  pdfUrl: string;
  stageId?: string;
  subjectId?: string;
  lang: Language;
  onClose: () => void;
  onOpenSubscription?: () => void;
  isLocalFile?: boolean;
  user?: UserProfile | null;
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

const NO_ANNOTATIONS: PdfAnnotation[] = [];
const MAX_MATCHES = 500;
const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const STABLE_INTERACTION_ROUTING = import.meta.env.VITE_PDF_STABLE_INTERACTION_ROUTING !== 'false';
const NATIVE_INK_V2 = import.meta.env.VITE_PDF_NATIVE_INK_V2 === 'true';

const RESIST = 0.25;
const RUBBER = 0.55;
const SPRING = 0.2;
const SPRING_TIMEOUT_MS = 600;
const RASTER_DEBOUNCE_MS = 200;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function elasticScale(s: number): number {
  const out =
    s > MAX_SCALE ? MAX_SCALE * Math.pow(s / MAX_SCALE, RESIST) :
    s < MIN_SCALE ? MIN_SCALE * Math.pow(s / MIN_SCALE, RESIST) : s;
  return clamp(out, MIN_SCALE / 1.8, MAX_SCALE * 1.8);
}

function rubber(d: number, span: number): number {
  return (d * RUBBER) / (1 + (Math.abs(d) * RUBBER) / Math.max(1, span));
}

function band(v: number, lo: number, hi: number, span: number): number {
  if (lo > hi) { const m = (lo + hi) / 2; return m + rubber(v - m, span); }
  if (v > hi) return hi + rubber(v - hi, span);
  if (v < lo) return lo - rubber(lo - v, span);
  return v;
}

export default function PdfReaderOverlay({
  lectureId, lectureTitle, pdfUrl, stageId, subjectId, lang,
  onClose, onOpenSubscription, isLocalFile, user,
}: Props) {
  const isRtl = lang === 'ar';
  const hasTranslationAccess = hasSubscriptionAccess(user);

  // Native vs Web state
  const [isNative, setIsNative] = useState(() => isNativePdfSupported());
  const [nativeLoading, setNativeLoading] = useState(false);
  const [nativeReady, setNativeReady] = useState(false);
  const [interactionPending, setInteractionPending] = useState(false);
  const [confirmedInteractionRevision, setConfirmedInteractionRevision] = useState(0);

  // PDF & UI States
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [pageCount, setPageCount] = useState(0);
  const [pageSizes, setPageSizes] = useState<{ w: number; h: number }[]>([]);
  const [scale, setScale] = useState(1);
  const [rasterScale, setRasterScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [current, setCurrent] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [staleFile, setStaleFile] = useState(false);

  // Notewise Mode & UI States
  const [isAnnotationMode, setIsAnnotationMode] = useState(false);
  const [activeHighlightColor, setActiveHighlightColor] = useState<HighlightColor>('yellow');
  const [activeDrawingTool, setActiveDrawingTool] = useState<DrawingTool>('pencil');
  const [activeDrawColor, setActiveDrawColor] = useState<string>('#4f46e5');
  const [activeDrawWidth, setActiveDrawWidth] = useState<StrokeWidth>('medium');
  const [pageStrokes, setPageStrokes] = useState<Record<number, PdfStroke[]>>({});
  const [history, setHistory] = useState<Record<number, { past: PdfStroke[][]; future: PdfStroke[][] }>>({});

  const [chromeVisible, setChromeVisible] = useState(true);
  const [isNightMode, setIsNightMode] = useState(() => {
    if (typeof document === 'undefined') return false;
    return document.documentElement.classList.contains('dark');
  });
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [docSheetOpen, setDocSheetOpen] = useState(false);
  const [jumpModalOpen, setJumpModalOpen] = useState(false);
  const [jumpTargetPage, setJumpTargetPage] = useState('');

  // Find in PDF search states
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [indexing, setIndexing] = useState(false);
  const [indexed, setIndexed] = useState(0);
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [matchIndex, setMatchIndex] = useState(0);
  const [listOpen, setListOpen] = useState(false);

  // Selection & Actions
  const [selection, setSelection] = useState<SelectionSnapshot | null>(null);
  const [selectionPos, setSelectionPos] = useState<{ x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<PdfAnnotation | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [orphanIds, setOrphanIds] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);

  const [translationOpen, setTranslationOpen] = useState(false);
  const [translationTarget, setTranslationTarget] = useState<string | null>(null);
  const closeTranslation = useCallback(() => {
    setTranslationOpen(false);
    setTranslationTarget(null);
  }, []);
  const openTranslation = useCallback((text?: string) => {
    setTranslationTarget(text ?? selection?.text ?? '');
    setTranslationOpen(true);
  }, [selection]);

  const [simosanOpen, setSimosanOpen] = useState(false);
  const [simosanSeed, setSimosanSeed] = useState<string | null>(null);
  const [simosanReady, setSimosanReady] = useState(false);

  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [attachmentsCount, setAttachmentsCount] = useState(0);

  // Bookmarks state (persisted per lecture)
  const [bookmarkedPages, setBookmarkedPages] = useState<Set<number>>(() => {
    try {
      const saved = localStorage.getItem(`pdf_bookmarks_${lectureId}`);
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });

  const toggleBookmark = useCallback((pageNum: number) => {
    setBookmarkedPages(prev => {
      const next = new Set(prev);
      if (next.has(pageNum)) next.delete(pageNum);
      else next.add(pageNum);
      try {
        localStorage.setItem(`pdf_bookmarks_${lectureId}`, JSON.stringify(Array.from(next)));
      } catch {}
      return next;
    });
  }, [lectureId]);

  useEffect(() => {
    if (!lectureId) return;
    import('../../services/lectureAttachmentService').then(({ getLectureAttachments }) => {
      getLectureAttachments(lectureId, user).then((items) => {
        setAttachmentsCount(items.filter((a) => a.status === 'approved').length);
      }).catch(() => {});
    });
  }, [lectureId, user]);

  const fitScaleRef = useRef(1);
  const pendingPage = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pages = useRef(new Map<number, PageHandle>());
  const fingerprint = useRef('');
  const mountedRef = useRef(true);
  const nativeReadyRef = useRef(false);
  const annotationModeRef = useRef(isAnnotationMode);
  const nightModeRef = useRef(isNightMode);
  const isRtlRef = useRef(isRtl);
  const lectureTitleRef = useRef(lectureTitle);
  const chromeVisibleRef = useRef(chromeVisible);
  const webOverlayActiveRef = useRef(false);
  const interactionCoordinatorRef = useRef(
    new PdfInteractionRevisionCoordinator(DEFAULT_READER_INTERACTION),
  );
  const confirmedInteractionRef = useRef<ReaderInteractionState>(DEFAULT_READER_INTERACTION);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    annotationModeRef.current = isAnnotationMode;
  }, [isAnnotationMode]);

  useEffect(() => {
    nightModeRef.current = isNightMode;
  }, [isNightMode]);

  useEffect(() => {
    isRtlRef.current = isRtl;
  }, [isRtl]);

  useEffect(() => {
    lectureTitleRef.current = lectureTitle;
  }, [lectureTitle]);

  useEffect(() => {
    chromeVisibleRef.current = chromeVisible;
  }, [chromeVisible]);

  const { annotations, byPage, upsert, remove, removeAll } = useLectureAnnotations(lectureId);

  // Back dismissals registered in order of priority
  useBackDismiss(true, onClose, 'pdfReader');
  useBackDismiss(drawerOpen, () => setDrawerOpen(false), 'pdfNotes');
  useBackDismiss(!!editing, () => setEditing(null), 'pdfNote');
  useBackDismiss(simosanOpen, () => setSimosanOpen(false), 'pdfSimosan');
  useBackDismiss(translationOpen || !!translationTarget, closeTranslation, 'pdfTranslation');
  useBackDismiss(overviewOpen, () => setOverviewOpen(false), 'pdfOverview');
  useBackDismiss(docSheetOpen, () => setDocSheetOpen(false), 'pdfDocSheet');
  useBackDismiss(jumpModalOpen, () => setJumpModalOpen(false), 'pdfJump');

  useEffect(() => {
    if (isLocalFile) {
      setSimosanReady(false);
      return;
    }
    let alive = true;
    fetchSimosanState().then((s) => { if (alive) setSimosanReady(!!s?.available); });
    return () => { alive = false; };
  }, [isLocalFile]);

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

  // Jump to specific page across Native and Web
  const goToPage = useCallback((pageNum: number) => {
    const p = Math.max(1, Math.min(pageCount || 1, pageNum));
    setCurrent(p);
    if (isNative) {
      NativePdf.goToPage({ page: p }).catch(() => {});
    } else {
      const handle = pages.current.get(p);
      if (handle?.el) {
        handle.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  }, [isNative, pageCount]);

  // Load strokes on mount or page change
  useEffect(() => {
    if (!lectureId || !current) return;
    if (pageStrokes[current] !== undefined) {
      if (isNative && nativeReady && NATIVE_INK_V2) {
        NativePdf.setPageStrokes({ page: current, strokes: pageStrokes[current] || [] }).catch(() => {});
      }
      return;
    }
    getLecturePageStrokes(lectureId, current)
      .then((strokes) => {
        setPageStrokes((prev) => ({ ...prev, [current]: strokes }));
        if (isNative && nativeReady && NATIVE_INK_V2) {
          NativePdf.setPageStrokes({ page: current, strokes: strokes || [] }).catch(() => {});
        }
      })
      .catch(() => {});
  }, [lectureId, current, pageStrokes, isNative, nativeReady]);

  const handleAddStroke = useCallback(
    (pageNum: number, stroke: PdfStroke) => {
      const s = { ...stroke, lectureId };
      setPageStrokes((prev) => {
        const currentList = prev[pageNum] || [];
        const nextList = [...currentList, s];
        saveLecturePageStrokes(lectureId, pageNum, nextList).catch(() => {});
        return { ...prev, [pageNum]: nextList };
      });
      setHistory((prev) => {
        const pageHist = prev[pageNum] || { past: [], future: [] };
        const currentList = pageStrokes[pageNum] || [];
        return {
          ...prev,
          [pageNum]: {
            past: [...pageHist.past, currentList],
            future: [],
          },
        };
      });
    },
    [lectureId, pageStrokes],
  );

  const handleEraseStroke = useCallback(
    (pageNum: number, strokeId: string) => {
      setPageStrokes((prev) => {
        const currentList = prev[pageNum] || [];
        const nextList = currentList.filter((s) => s.id !== strokeId);
        if (nextList.length === currentList.length) return prev;
        saveLecturePageStrokes(lectureId, pageNum, nextList).catch(() => {});
        return { ...prev, [pageNum]: nextList };
      });
      setHistory((prev) => {
        const pageHist = prev[pageNum] || { past: [], future: [] };
        const currentList = pageStrokes[pageNum] || [];
        return {
          ...prev,
          [pageNum]: {
            past: [...pageHist.past, currentList],
            future: [],
          },
        };
      });
    },
    [lectureId, pageStrokes],
  );

  const handleUndo = useCallback(() => {
    const pageHist = history[current];
    if (!pageHist || pageHist.past.length === 0) return;
    const previous = pageHist.past[pageHist.past.length - 1];
    const newPast = pageHist.past.slice(0, -1);
    const present = pageStrokes[current] || [];

    setHistory((prev) => ({
      ...prev,
      [current]: {
        past: newPast,
        future: [present, ...(prev[current]?.future || [])],
      },
    }));

    setPageStrokes((prev) => {
      saveLecturePageStrokes(lectureId, current, previous).catch(() => {});
      return { ...prev, [current]: previous };
    });
  }, [current, history, pageStrokes, lectureId]);

  const handleRedo = useCallback(() => {
    const pageHist = history[current];
    if (!pageHist || pageHist.future.length === 0) return;
    const next = pageHist.future[0];
    const newFuture = pageHist.future.slice(1);
    const present = pageStrokes[current] || [];

    setHistory((prev) => ({
      ...prev,
      [current]: {
        past: [...(prev[current]?.past || []), present],
        future: newFuture,
      },
    }));

    setPageStrokes((prev) => {
      saveLecturePageStrokes(lectureId, current, next).catch(() => {});
      return { ...prev, [current]: next };
    });
  }, [current, history, pageStrokes, lectureId]);

  const canUndo = (history[current]?.past?.length ?? 0) > 0;
  const canRedo = (history[current]?.future?.length ?? 0) > 0;

  const isAnyWebOverlayOpen =
    searchOpen ||
    drawerOpen ||
    simosanOpen ||
    attachmentsOpen ||
    overviewOpen ||
    docSheetOpen ||
    jumpModalOpen ||
    !!editing ||
    translationOpen ||
    !!translationTarget;
  webOverlayActiveRef.current = isAnyWebOverlayOpen;

  const applyConfirmedInteraction = useCallback((state: ReaderInteractionState) => {
    confirmedInteractionRef.current = state;
    annotationModeRef.current = state.mode === 'annotate';
    setIsAnnotationMode(state.mode === 'annotate');
    setActiveDrawingTool(state.tool);
    setChromeVisible(state.chromeVisible);
    setConfirmedInteractionRevision(state.revision);
    setInteractionPending(false);
  }, []);

  const requestInteraction = useCallback(async (
    patch: Partial<Omit<ReaderInteractionState, 'revision'>>,
  ): Promise<ReaderInteractionState | null> => {
    const coordinator = interactionCoordinatorRef.current;
    const requested = coordinator.request(patch);
    setInteractionPending(true);

    if (import.meta.env.DEV) {
      console.debug(
        `[PDF_INTERACTION] requested_mode=${requested.mode} requested_tool=${requested.tool} revision=${requested.revision}`,
      );
    }

    if (!isNative) {
      const confirmed = coordinator.confirm({
        appliedRevision: requested.revision,
        appliedState: requested,
      });
      if (confirmed) applyConfirmedInteraction(confirmed);
      return confirmed;
    }

    if (!nativeReadyRef.current) return null;

    try {
      const result = await NativePdf.setInteraction(requested);
      if (!mountedRef.current) return null;
      const confirmed = coordinator.confirm(result);
      if (confirmed) {
        applyConfirmedInteraction(confirmed);
        if (import.meta.env.DEV) {
          console.debug(`[PDF_INTERACTION] applied_revision=${result.appliedRevision}`);
        }
      }
      return confirmed;
    } catch (error) {
      if (!mountedRef.current) return null;
      const rolledBack = coordinator.rollbackLatest(
        requested.revision,
        confirmedInteractionRef.current,
      );
      if (rolledBack) {
        setInteractionPending(false);
        console.error('[PDF_INTERACTION] native transition rejected', error);
        setToast(isRtlRef.current ? 'تعذّر تغيير وضع التفاعل' : 'Could not change interaction mode');
        window.setTimeout(() => setToast(null), 1600);
      }
      return null;
    }
  }, [applyConfirmedInteraction, isNative]);

  // Rollback-only legacy rectangle routing. Stable routing never consults
  // asynchronously calculated DOM rectangles for a gesture owner.
  useEffect(() => {
    if (!isNative || STABLE_INTERACTION_ROUTING) return;

    if (isAnyWebOverlayOpen) {
      NativePdf.setInteractiveZones({
        zones: [{ left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }],
      }).catch(() => {});
      return;
    }

    const zones: InteractiveZone[] = [];
    if (chromeVisible) {
      // Top header zone: ample clearance for status bar / notch safe-area + pill height
      zones.push({ left: 0, top: 0, right: window.innerWidth, bottom: 120 });
      // Bottom left page counter pill zone
      zones.push({ left: 0, top: window.innerHeight - 90, right: 220, bottom: window.innerHeight });
    }

    if (isAnnotationMode) {
      if (
        activeDrawingTool === 'pencil' ||
        activeDrawingTool === 'free_highlighter' ||
        activeDrawingTool === 'eraser' ||
        activeDrawingTool === 'text'
      ) {
        // Fullscreen touch layer for responsive freehand drawing & erasing
        zones.push({ left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight });
      } else {
        // Bottom annotation dock + color palette popover + stroke width popover
        zones.push({
          left: 0,
          top: Math.max(0, window.innerHeight - 230),
          right: window.innerWidth,
          bottom: window.innerHeight,
        });
      }
    }

    if (selectionPos) {
      zones.push({
        left: Math.max(0, selectionPos.x - 180),
        top: Math.max(0, selectionPos.y - 120),
        right: Math.min(window.innerWidth, selectionPos.x + 180),
        bottom: selectionPos.y + 20,
      });
    }

    NativePdf.setInteractiveZones({ zones }).catch(() => {});
  }, [
    isNative,
    chromeVisible,
    drawerOpen,
    simosanOpen,
    attachmentsOpen,
    overviewOpen,
    docSheetOpen,
    jumpModalOpen,
    editing,
    translationOpen,
    searchOpen,
    isAnnotationMode,
    activeDrawingTool,
    selectionPos,
    isAnyWebOverlayOpen,
  ]);

  // Modal ownership is part of the revisioned contract. Mode, tool, and chrome
  // changes use explicit handlers so React updates only after native ack.
  useEffect(() => {
    if (!isNative || !STABLE_INTERACTION_ROUTING || !nativeReady) return;
    void requestInteraction({
      webOverlayActive: isAnyWebOverlayOpen,
    });
  }, [
    isNative,
    nativeReady,
    isAnyWebOverlayOpen,
    requestInteraction,
  ]);

  // Toggle html/body transparency for native viewer
  useEffect(() => {
    if (isNative) {
      document.documentElement.classList.add('pdf-native-transparent');
    } else {
      document.documentElement.classList.remove('pdf-native-transparent');
    }
    return () => {
      document.documentElement.classList.remove('pdf-native-transparent');
    };
  }, [isNative]);

  // ---- Native PDF Engine Initialization (Android & iOS) -----------------
  useEffect(() => {
    if (!isNative || !lectureId) return;
    let active = true;
    nativeReadyRef.current = false;
    setNativeReady(false);

    (async () => {
      try {
        setNativeLoading(true);
        let localPath = await getNativePdfFilePath(lectureId, pdfUrl);

        if (!localPath) {
          const localBlob = isLocalFile ? await getUserFileBlob(lectureId) : null;
          let buf: ArrayBuffer | null = localBlob ? await localBlob.arrayBuffer() : null;
          if (!buf) {
            buf = (await readStoredPdf(pdfUrl, lectureId)) ?? (await fetchPdfBytes(pdfUrl));
          }
          if (buf && active) {
            localPath = await cacheNativePdfBytes(lectureId, buf);
          }
        }

        if (!localPath || !active) return;

        const meta = await getDocMeta(lectureId);
        const initPage = meta?.lastPage && meta.lastPage > 1 ? meta.lastPage : 1;

        await NativePdf.openPdf({
          filePath: localPath,
          initialPage: initPage,
          nightMode: nightModeRef.current,
          stableInteractionRouting: STABLE_INTERACTION_ROUTING,
          nativeInkV2: NATIVE_INK_V2,
        });

        const coordinator = interactionCoordinatorRef.current;
        const requested = coordinator.request({
          chromeVisible: chromeVisibleRef.current,
          webOverlayActive: webOverlayActiveRef.current,
          tool: activeDrawingTool,
          color: activeDrawColor,
          width: activeDrawWidth,
        });
        const interactionResult = await NativePdf.setInteraction(requested);
        const confirmed = coordinator.confirm(interactionResult);

        if (active) {
          if (confirmed) applyConfirmedInteraction(confirmed);
          nativeReadyRef.current = true;
          setNativeReady(true);
          setNativeLoading(false);
          setCurrent(initPage);
        }
      } catch (err) {
        console.error('[PdfReaderOverlay] Native PDFium failed, falling back to Web:', err);
        if (active) {
          const coordinator = interactionCoordinatorRef.current;
          const desired = coordinator.currentDesired();
          const confirmed = coordinator.confirm({
            appliedRevision: desired.revision,
            appliedState: desired,
          });
          if (confirmed) applyConfirmedInteraction(confirmed);
          nativeReadyRef.current = false;
          setNativeReady(false);
          setIsNative(false);
          setNativeLoading(false);
        }
      }
    })();

    const subPage = NativePdf.addListener('onPageChange', (data) => {
      setCurrent(data.page);
      if (data.pageCount) setPageCount(data.pageCount);
    });

    const subStrokes = NativePdf.addListener('onStrokesUpdated', (event: any) => {
      const pageNum = event.page;
      const opId = event.opId || secureRequestId();
      if (event.action === 'add' && event.stroke) {
        const stroke = event.stroke as PdfStroke;
        setPageStrokes((prev) => {
          const currentList = prev[pageNum] || [];
          const nextList = [...currentList, stroke];
          saveLecturePageStrokes(lectureId, pageNum, nextList).catch(() => {});
          return { ...prev, [pageNum]: nextList };
        });
        setHistory((prev) => {
          const pageHist = prev[pageNum] || { past: [], future: [] };
          const currentList = pageStrokes[pageNum] || [];
          return {
            ...prev,
            [pageNum]: {
              past: [...pageHist.past, currentList],
              future: [],
            },
          };
        });

        // Persist through Canonical Unified Service
        void commitCanonicalOperation({
          opId,
          type: 'add',
          documentId: lectureId,
          pageIndex: pageNum,
          annotation: migrateStrokeToCanonical(stroke),
          clientTimestamp: Date.now(),
        });
      } else if (event.action === 'erase' && event.strokeId) {
        setPageStrokes((prev) => {
          const currentList = prev[pageNum] || [];
          const nextList = currentList.filter((s) => s.id !== event.strokeId);
          if (nextList.length === currentList.length) return prev;
          saveLecturePageStrokes(lectureId, pageNum, nextList).catch(() => {});
          return { ...prev, [pageNum]: nextList };
        });
        setHistory((prev) => {
          const pageHist = prev[pageNum] || { past: [], future: [] };
          const currentList = pageStrokes[pageNum] || [];
          return {
            ...prev,
            [pageNum]: {
              past: [...pageHist.past, currentList],
              future: [],
            },
          };
        });

        // Persist through Canonical Unified Service
        void commitCanonicalOperation({
          opId,
          type: 'delete',
          documentId: lectureId,
          pageIndex: pageNum,
          annotationId: event.strokeId,
          clientTimestamp: Date.now(),
        });
      }
    });

    const subTap = NativePdf.addListener('onDocumentTap', () => {
      if (!annotationModeRef.current) {
        const desired = interactionCoordinatorRef.current.currentDesired();
        void requestInteraction({ chromeVisible: !desired.chromeVisible });
      }
      setSelection(null);
      setSelectionPos(null);
    });

    const subLongPress = NativePdf.addListener('onDocumentLongPress', (data) => {
      setSelectionPos({ x: data.x, y: data.y });
      setSelection({
        text: lectureTitleRef.current,
        fragments: [],
      });
    });

    return () => {
      active = false;
      nativeReadyRef.current = false;
      setNativeReady(false);
      subPage.then((h) => h.remove()).catch(() => {});
      subStrokes.then((h) => h.remove()).catch(() => {});
      subTap.then((h) => h.remove()).catch(() => {});
      subLongPress.then((h) => h.remove()).catch(() => {});
      NativePdf.closePdf().catch(() => {});
    };
  }, [isNative, lectureId, pdfUrl, isLocalFile, applyConfirmedInteraction, requestInteraction]);

  // Night Mode handler
  const handleToggleNightMode = useCallback(() => {
    const next = !isNightMode;
    setIsNightMode(next);
    if (isNative) {
      NativePdf.setNightMode({ nightMode: next }).catch(() => {});
    }
  }, [isNightMode, isNative]);

  // ---- Web Fallback Document Loading (Browser / Dev) --------------------
  useEffect(() => {
    if (isNative) return;
    let cancelled = false;
    const ac = new AbortController();

    (async () => {
      try {
        const [pdfjs, localBlob] = await Promise.all([
          loadPdfjs(),
          isLocalFile ? getUserFileBlob(lectureId) : Promise.resolve(null),
        ]);
        if (cancelled) return;

        let buf: ArrayBuffer | null = localBlob ? await localBlob.arrayBuffer() : null;
        if (!buf) {
          const local = await readStoredPdf(pdfUrl, lectureId);
          if (cancelled) return;
          buf = local ?? (await fetchPdfBytes(pdfUrl, ac.signal));
        }
        if (cancelled || !buf) return;

        const doc = await pdfjs.getDocument({
          ...PDFJS_DOC_OPTIONS,
          data: freshBytes(buf),
        }).promise;
        if (cancelled) { (doc as any).destroy(); return; }

        const sizes: { w: number; h: number }[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const p = await doc.getPage(i);
          const v = p.getViewport({ scale: 1, rotation: 0 });
          sizes.push({ w: v.width, h: v.height });
        }
        if (cancelled) { (doc as any).destroy(); return; }

        fingerprint.current = doc.fingerprints?.[0] ?? '';

        const meta = await getDocMeta(lectureId);
        if (meta?.fingerprint && meta.fingerprint !== fingerprint.current) setStaleFile(true);
        if (meta?.lastPage && meta.lastPage > 1) pendingPage.current = meta.lastPage;

        setPdfDoc(doc);
        setPageCount(doc.numPages);
        setPageSizes(sizes);

        const avail = (scrollRef.current?.clientWidth ?? window.innerWidth) - 16;
        const widest = Math.max(...sizes.map((z) => z.w));
        if (widest > 0) {
          const fit = +Math.max(MIN_SCALE, Math.min(MAX_SCALE, avail / widest)).toFixed(2);
          fitScaleRef.current = fit;
          setScale(fit);
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
  }, [isNative, pdfUrl, lectureId, isLocalFile, isRtl]);

  // Teardown web doc
  useEffect(() => () => { try { (pdfDoc as any)?.destroy(); } catch {} }, [pdfDoc]);

  // Remember read position
  useEffect(() => {
    if (!current || !lectureId) return;
    const id = setTimeout(() => setDocMeta(lectureId, { lastPage: current }), 400);
    return () => clearTimeout(id);
  }, [current, lectureId]);

  // Layout for Web Fallback
  const layout = useMemo(() => {
    const swap = rotation % 180 !== 0;
    let y = 0;
    return pageSizes.map((s) => {
      const w = (swap ? s.h : s.w) * scale;
      const h = (swap ? s.w : s.h) * scale;
      const top = y;
      y += h + 24;
      return { top, w, h };
    });
  }, [pageSizes, scale, rotation]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || layout.length === 0) return;
    const mid = el.scrollTop + el.clientHeight / 2;
    let n = 1;
    for (let i = 0; i < layout.length; i++) {
      if (layout[i].top <= mid) n = i + 1; else break;
    }
    setCurrent(n);
  }, [layout]);

  // DOM position -> canonical offset within a page
  const canonicalOffset = useCallback((h: PageHandle, node: Node, offset: number): number | null => {
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
    const span = el?.closest('[data-item-index]') as HTMLElement | null;
    if (!span) return null;
    const itemIndex = Number(span.dataset.itemIndex);
    const r = h.canonical.itemRanges[itemIndex];
    if (!r) return null;
    return r.start + canonicalOffsetWithin(span.textContent ?? '', offset);
  }, []);

  const fragmentFor = useCallback((range: Range, h: PageHandle): SelectionFragment | null => {
    if (!range.intersectsNode(h.textLayerEl)) return null;

    const spans = [...h.spanByItem.values()];
    if (spans.length === 0) return null;

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
  }, [canonicalOffset]);

  // Web Text Selection listener
  useEffect(() => {
    if (isNative) return;
    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim() || sel.rangeCount === 0) {
        setSelection(null);
        setSelectionPos(null);
        return;
      }

      const text = sel.toString().trim();
      try {
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          setSelectionPos({ x: rect.left + rect.width / 2, y: rect.top });
          const fragments: SelectionFragment[] = [];
          for (const h of pages.current.values()) {
            const f = fragmentFor(range, h);
            if (f) fragments.push(f);
          }
          setSelection({
            text,
            fragments: fragments.sort((a, b) => a.pageNumber - b.pageNumber),
          });
        }
      } catch {}
    };

    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [isNative, fragmentFor]);

  // Create Highlight & Note
  const handleHighlight = async (color: HighlightColor) => {
    if (!selection) return;
    const snap = selection;
    const now = Date.now();
    const groupId = snap.fragments.length > 1 ? secureRequestId() : undefined;

    if (snap.fragments.length > 0) {
      for (const f of snap.fragments) {
        const a: PdfAnnotation = {
          id: secureRequestId(),
          lectureId,
          docFingerprint: fingerprint.current,
          kind: 'highlight',
          page: f.pageNumber,
          color,
          groupId,
          createdAt: now,
          updatedAt: now,
          anchor: buildAnchor({
            text: f.canonicalText,
            start: f.start,
            end: f.end,
            quads: f.quads,
            pageW: f.pageW,
            pageH: f.pageH,
          }),
          schema: 1,
        };
        await upsert(a);
      }
    } else {
      const a: PdfAnnotation = {
        id: secureRequestId(),
        lectureId,
        docFingerprint: fingerprint.current,
        kind: 'highlight',
        page: current,
        color,
        createdAt: now,
        updatedAt: now,
        anchor: {
          pageW: 0,
          pageH: 0,
          start: 0,
          end: 0,
          exact: snap.text.slice(0, 300),
          prefix: '',
          suffix: '',
          quads: [],
          algo: 1,
        },
        schema: 1,
      };
      await upsert(a);
    }

    setSelection(null);
    setSelectionPos(null);
    window.getSelection()?.removeAllRanges();
    setToast(isRtl ? 'تم التظليل' : 'Highlighted');
    setTimeout(() => setToast(null), 1200);
  };

  const handleAddNote = async () => {
    const noteId = secureRequestId();
    const now = Date.now();
    const f = selection?.fragments?.[0];
    const a: PdfAnnotation = {
      id: noteId,
      lectureId,
      docFingerprint: fingerprint.current,
      kind: 'pin',
      page: f ? f.pageNumber : current,
      color: activeHighlightColor,
      createdAt: now,
      updatedAt: now,
      anchor: f
        ? buildAnchor({
            text: f.canonicalText,
            start: f.start,
            end: f.end,
            quads: f.quads,
            pageW: f.pageW,
            pageH: f.pageH,
          })
        : selection?.text
        ? {
            pageW: 0,
            pageH: 0,
            start: 0,
            end: 0,
            exact: selection.text.slice(0, 300),
            prefix: '',
            suffix: '',
            quads: [],
            algo: 1,
          }
        : undefined,
      note: '',
      schema: 1,
    };
    await upsert(a);
    setSelection(null);
    setSelectionPos(null);
    window.getSelection()?.removeAllRanges();
    setEditing(a);
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

  const handleExportAnnotatedPdf = async () => {
    try {
      setToast(isRtl ? 'جاري تجهيز وتصدير ملف الـ PDF...' : 'Generating annotated PDF...');
      const result = await exportAnnotatedPdf({
        lectureId,
        lectureTitle,
        pdfUrl,
      });

      if (!result.success || !result.exportedBlob) {
        setToast(isRtl ? 'فشل تصدير ملف PDF' : 'Failed to export PDF');
        setTimeout(() => setToast(null), 2500);
        return;
      }

      const url = URL.createObjectURL(result.exportedBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${lectureTitle || 'lecture'}-annotated.pdf`.replace(/[\\/:*?"<>|]/g, '_');
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);

      setToast(isRtl ? 'تم تصدير ملف PDF بنجاح' : 'PDF exported successfully');
      setTimeout(() => setToast(null), 2000);
    } catch (err) {
      console.error('[PdfReaderOverlay] Export PDF failed:', err);
      setToast(isRtl ? 'حدث خطأ أثناء تصدير PDF' : 'Error exporting PDF');
      setTimeout(() => setToast(null), 2500);
    }
  };

  const shareLecture = async () => {
    try {
      const { Share } = await import('@capacitor/share');
      if ((await Share.canShare()).value) {
        await Share.share({
          title: lectureTitle,
          url: pdfUrl,
          dialogTitle: isRtl ? 'مشاركة المحاضرة' : 'Share Lecture',
        });
      }
    } catch {
      await copyText(pdfUrl);
      setToast(isRtl ? 'تم نسخ الرابط' : 'Link copied');
      setTimeout(() => setToast(null), 1200);
    }
  };

  return (
    <div
      dir={isRtl ? 'rtl' : 'ltr'}
      aria-busy={interactionPending}
      data-interaction-revision={confirmedInteractionRevision}
      data-interaction-pending={interactionPending ? 'true' : 'false'}
      className={`pdfReaderSurface fixed inset-0 z-[160] flex flex-col overflow-hidden select-none ${
        isNative ? 'bg-transparent' : isNightMode ? 'bg-zinc-950 text-white' : 'bg-slate-100 dark:bg-zinc-950'
      }`}
    >
      {/* Notewise Floating Header Pill (Hidden when search is open) */}
      <AnimatePresence>
        {chromeVisible && !searchOpen && (
          <motion.div
            initial={{ y: -30, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -30, opacity: 0 }}
            transition={{ duration: 0.16 }}
            className="contents"
          >
            <NotewiseHeaderPill
              isRtl={isRtl}
              isAnnotationMode={isAnnotationMode}
              onToggleMode={() => {
                const desired = interactionCoordinatorRef.current.currentDesired();
                void requestInteraction({
                  mode: desired.mode === 'annotate' ? 'read' : 'annotate',
                  chromeVisible: true,
                });
              }}
              onBack={onClose}
              onOpenOverview={() => setOverviewOpen(true)}
              onOpenSearch={() => setSearchOpen(true)}
              onOpenTranslation={() => openTranslation()}
              onOpenDocSheet={() => setDocSheetOpen(true)}
              onOpenSimosan={() => openSimosan()}
              simosanAvailable={simosanReady}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Stale file warning banner */}
      {staleFile && (
        <div className="fixed top-18 left-4 right-4 z-40 p-2.5 rounded-xl bg-amber-500/90 text-white text-xs font-bold shadow-lg backdrop-blur flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>
            {isRtl
              ? 'هذه الملاحظات كُتبت على نسخة أقدم من هذا الملف.'
              : 'These notes were made on an older version of this file.'}
          </span>
        </div>
      )}

      {/* Web Fallback Scroll View (Only rendered when native engine is off) */}
      {!isNative && (
        <div
          ref={scrollRef}
          onScroll={onScroll}
          onClick={() => {
            if (!isAnnotationMode) setChromeVisible((prev) => !prev);
          }}
          dir="ltr"
          className="flex-1 overflow-y-auto bg-slate-100 dark:bg-zinc-950 pt-20 pb-20 px-2"
          style={{ WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain' }}
        >
          {error && (
            <div className="flex flex-col items-center justify-center h-full gap-3 px-8 text-center">
              <AlertTriangle className="w-12 h-12 text-amber-500" />
              <p className="text-slate-600 dark:text-zinc-300 font-bold">{error}</p>
            </div>
          )}

          {!error && !pdfDoc && (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
            </div>
          )}

          {pdfDoc && (
            <div className="flex flex-col items-center gap-4">
              {layout.map((box, i) => {
                const n = i + 1;
                return (
                  <div
                    key={n}
                    className="relative my-3 shadow-lg shadow-black/20 shrink-0"
                    style={{
                      width: box.w,
                      height: box.h,
                      filter: isNightMode ? 'invert(0.9) contrast(0.95) hue-rotate(180deg)' : 'none',
                      transition: 'filter 0.2s ease-in-out',
                    }}
                  >
                    <PdfPage
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
                      flashId={flashId}
                      noMargin
                    />
                    <PdfDrawingLayer
                      pageNumber={n}
                      pageWidth={box.w}
                      pageHeight={box.h}
                      scale={scale}
                      strokes={pageStrokes[n] || []}
                      activeTool={activeDrawingTool}
                      activeColor={activeDrawColor}
                      activeWidth={activeDrawWidth}
                      isAnnotationMode={isAnnotationMode}
                      onAddStroke={(s) => handleAddStroke(n, s)}
                      onEraseStroke={(id) => handleEraseStroke(n, id)}
                    />
                    <PdfTextBoxOverlay
                      pageNumber={n}
                      pageWidth={box.w}
                      pageHeight={box.h}
                      scale={scale}
                      annotations={annotations}
                      activeTool={activeDrawingTool}
                      activeColor={activeDrawColor}
                      isAnnotationMode={isAnnotationMode}
                      onSaveText={upsert}
                      onDeleteText={remove}
                      isRtl={isRtl}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Native Mode Drawing & Text Overlay */}
      {isNative && !nativeLoading && (
        <div
          className={`absolute inset-0 z-10 ${
            isAnnotationMode &&
            (activeDrawingTool === 'pencil' ||
              activeDrawingTool === 'free_highlighter' ||
              activeDrawingTool === 'eraser' ||
              activeDrawingTool === 'text')
              ? 'pointer-events-auto'
              : 'pointer-events-none'
          }`}
        >
          {!NATIVE_INK_V2 && (
            <PdfDrawingLayer
              pageNumber={current}
              pageWidth={window.innerWidth}
              pageHeight={window.innerHeight}
              scale={1}
              strokes={pageStrokes[current] || []}
              activeTool={activeDrawingTool}
              activeColor={activeDrawColor}
              activeWidth={activeDrawWidth}
              isAnnotationMode={isAnnotationMode}
              onAddStroke={(s) => handleAddStroke(current, s)}
              onEraseStroke={(id) => handleEraseStroke(current, id)}
            />
          )}
          <PdfTextBoxOverlay
            pageNumber={current}
            pageWidth={window.innerWidth}
            pageHeight={window.innerHeight}
            scale={1}
            annotations={annotations}
            activeTool={activeDrawingTool}
            activeColor={activeDrawColor}
            isAnnotationMode={isAnnotationMode}
            onSaveText={upsert}
            onDeleteText={remove}
            isRtl={isRtl}
          />
        </div>
      )}

      {/* Native Loading Spinner */}
      {isNative && nativeLoading && (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-stone-500">
          <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
          <span className="text-xs font-semibold">{isRtl ? 'جارٍ تحميل المحاضرة...' : 'Loading lecture...'}</span>
        </div>
      )}

      {/* Notewise Floating Page Pill (Page X/Y, Zoom, Night Mode) */}
      <AnimatePresence>
        {chromeVisible && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.16 }}
            className="contents"
          >
            <NotewisePagePill
              currentPage={current}
              pageCount={pageCount}
              scalePercent={Math.round(scale * 100)}
              isNightMode={isNightMode}
              isAnnotationMode={isAnnotationMode}
              onToggleNightMode={handleToggleNightMode}
              onOpenPageJump={() => {
                setJumpTargetPage(String(current));
                setJumpModalOpen(true);
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Notewise Annotation Dock (Active only in Annotation Mode) */}
      <NotewiseAnnotationDock
        isVisible={isAnnotationMode}
        activeTool={activeDrawingTool}
        activeColor={activeDrawColor}
        activeWidth={activeDrawWidth}
        canUndo={canUndo}
        canRedo={canRedo}
        onSelectTool={(tool) => {
          void requestInteraction({ mode: 'annotate', tool });
        }}
        onChangeColor={setActiveDrawColor}
        onChangeWidth={setActiveDrawWidth}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onAddNote={handleAddNote}
        onOpenSimosan={() => openSimosan()}
        onCloseDock={() => {
          void requestInteraction({ mode: 'read' });
        }}
        isRtl={isRtl}
        simosanAvailable={simosanReady}
      />

      {/* Floating Selection Capsule Menu (with Simosan AI) */}
      <NotewiseSelectionCapsule
        position={selectionPos}
        selectedText={selection?.text || ''}
        isRtl={isRtl}
        onAskSimosan={(txt) => {
          setSelection(null);
          setSelectionPos(null);
          openSimosan(txt);
        }}
        onHighlight={handleHighlight}
        onAddNote={handleAddNote}
        onCopy={async () => {
          if (selection?.text) {
            await copyText(selection.text);
            setSelection(null);
            setSelectionPos(null);
            setToast(isRtl ? 'تم النسخ' : 'Copied');
            setTimeout(() => setToast(null), 1200);
          }
        }}
        onTranslate={() => {
          if (selection?.text) {
            const txt = selection.text;
            setSelection(null);
            setSelectionPos(null);
            openTranslation(txt);
          }
        }}
        onShare={() => {
          if (selection?.text) {
            shareText(selection.text, lectureTitle);
            setSelection(null);
            setSelectionPos(null);
          }
        }}
        simosanAvailable={simosanReady}
      />

      {/* Notewise 3-Column Page Overview Modal */}
      <NotewiseOverviewModal
        isOpen={overviewOpen}
        onClose={() => setOverviewOpen(false)}
        pageCount={pageCount}
        currentPage={current}
        annotations={annotations}
        isRtl={isRtl}
        onSelectPage={goToPage}
        onToggleBookmark={toggleBookmark}
        bookmarkedPages={bookmarkedPages}
      />

      {/* Notewise Document Bottom Sheet */}
      <NotewiseDocumentSheet
        isOpen={docSheetOpen}
        onClose={() => setDocSheetOpen(false)}
        lectureTitle={lectureTitle}
        pageCount={pageCount}
        currentPage={current}
        notesCount={annotations.length}
        attachmentsCount={attachmentsCount}
        isNightMode={isNightMode}
        isRtl={isRtl}
        onToggleNightMode={handleToggleNightMode}
        onShare={shareLecture}
        onExportNotes={doExport}
        onExportPdf={handleExportAnnotatedPdf}
        onOpenAttachments={() => setAttachmentsOpen(true)}
        onOpenNotes={() => setDrawerOpen(true)}
        onOpenTranslation={() => openTranslation()}
        onOpenSimosan={() => openSimosan()}
        onOpenPageJump={() => {
          setJumpTargetPage(String(current));
          setJumpModalOpen(true);
        }}
        simosanAvailable={simosanReady}
      />

      {/* Jump to Page Modal */}
      {jumpModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm pointer-events-auto">
          <div className="w-full max-w-xs bg-white dark:bg-zinc-900 rounded-3xl p-5 shadow-2xl border border-zinc-200 dark:border-zinc-800 text-center">
            <h4 className="text-sm font-bold text-slate-900 dark:text-zinc-100 mb-1">
              {isRtl ? 'الانتقال إلى صفحة' : 'Go to Page'}
            </h4>
            <p className="text-xs text-slate-500 dark:text-zinc-400 mb-4">
              {isRtl ? `أدخل رقم الصفحة (1 - ${pageCount || 1})` : `Enter page number (1 - ${pageCount || 1})`}
            </p>
            <input
              type="number"
              min={1}
              max={pageCount || 1}
              value={jumpTargetPage}
              onChange={(e) => setJumpTargetPage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const p = parseInt(jumpTargetPage, 10);
                  if (!isNaN(p)) goToPage(p);
                  setJumpModalOpen(false);
                }
              }}
              autoFocus
              className="w-full px-4 py-2.5 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 text-center text-lg font-bold mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setJumpModalOpen(false)}
                className="flex-1 py-2.5 rounded-xl bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 text-xs font-semibold hover:bg-slate-200 dark:hover:bg-zinc-700"
              >
                {isRtl ? 'إلغاء' : 'Cancel'}
              </button>
              <button
                type="button"
                onClick={() => {
                  const p = parseInt(jumpTargetPage, 10);
                  if (!isNaN(p)) goToPage(p);
                  setJumpModalOpen(false);
                }}
                className="flex-1 py-2.5 rounded-xl bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-700 shadow-md shadow-indigo-600/30"
              >
                {isRtl ? 'انتقال' : 'Go'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Search in PDF Panel */}
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
            onToggleList={() => setListOpen((o) => !o)}
            onPrev={() => {
              if (matches.length > 0) {
                const next = (matchIndex - 1 + matches.length) % matches.length;
                setMatchIndex(next);
                goToPage(matches[next].pageNumber);
              }
            }}
            onNext={() => {
              if (matches.length > 0) {
                const next = (matchIndex + 1) % matches.length;
                setMatchIndex(next);
                goToPage(matches[next].pageNumber);
              }
            }}
            onPick={(i) => {
              setMatchIndex(i);
              setListOpen(false);
              goToPage(matches[i].pageNumber);
            }}
            onClose={() => setSearchOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* Note Editor Sheet */}
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

      {/* Notes & Highlights Drawer */}
      <AnimatePresence>
        {drawerOpen && (
          <NotesDrawer
            annotations={annotations}
            orphanIds={orphanIds}
            isRtl={isRtl}
            onGoTo={(a) => {
              setDrawerOpen(false);
              goToPage(a.page);
              setFlashId(a.id);
              setTimeout(() => setFlashId(null), 1400);
            }}
            onDelete={remove}
            onExport={doExport}
            onDeleteAll={() => setConfirmWipe(true)}
            onClose={() => setDrawerOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* Attachments Drawer */}
      <AnimatePresence>
        {attachmentsOpen && (
          <PdfAttachmentsDrawer
            lecture={{
              id: lectureId,
              title: lectureTitle,
              pdfUrl: pdfUrl,
              stageId: stageId,
              subjectId: subjectId,
              type: 'theoretical',
              createdAt: null,
              uploadedBy: '',
            }}
            user={user ?? null}
            isRtl={isRtl}
            isOpen={attachmentsOpen}
            onClose={() => setAttachmentsOpen(false)}
            onCountChange={setAttachmentsCount}
            onOpenSubscription={onOpenSubscription}
          />
        )}
      </AnimatePresence>

      {/* Simosan AI Drawer */}
      <AnimatePresence>
        {simosanOpen && (
          <SimosanDrawer
            isRtl={isRtl}
            lectureId={lectureId}
            seedSelection={simosanSeed}
            onJumpToPage={goToPage}
            onClose={() => setSimosanOpen(false)}
            onOpenSubscription={onOpenSubscription}
          />
        )}
      </AnimatePresence>

      {/* Translation Sheet */}
      <AnimatePresence>
        {(translationOpen || translationTarget !== null) && (
          <PdfTranslationSheet
            sourceText={translationTarget || ''}
            isRtl={isRtl}
            hasAccess={hasTranslationAccess}
            onOpenSubscription={onOpenSubscription}
            onClose={closeTranslation}
          />
        )}
      </AnimatePresence>

      {/* Confirm Wipe Modal */}
      <ConfirmModal
        isOpen={confirmWipe}
        onClose={() => setConfirmWipe(false)}
        onConfirm={() => {
          removeAll();
          setConfirmWipe(false);
          setDrawerOpen(false);
        }}
        title={isRtl ? 'حذف كل الملاحظات' : 'Delete all notes'}
        message={
          isRtl
            ? 'سيتم حذف كل التظليلات والملاحظات في هذه المحاضرة من هذا الجهاز. لا يمكن التراجع.'
            : 'Every highlight and note for this lecture will be removed from this device. This cannot be undone.'
        }
      />

      {/* Toast Notification */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            role="status"
            className="fixed inset-x-0 bottom-24 z-50 flex justify-center pointer-events-none"
          >
            <span className="rounded-full bg-zinc-900/95 dark:bg-zinc-100 text-white dark:text-zinc-900 text-xs font-bold px-4 py-2 shadow-xl backdrop-blur">
              {toast}
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
