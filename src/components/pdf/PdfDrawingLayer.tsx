import React, { useRef, useState, useCallback, useMemo } from 'react';
import type {
  DrawingTool,
  StrokeWidth,
  PdfStroke,
  StrokePoint,
} from '../../types/pdfDrawing.types';
import { PENCIL_WIDTHS, FREE_HIGHLIGHTER_WIDTHS } from '../../types/pdfDrawing.types';
import { secureRequestId } from '../../lib/secureRandom';

interface Props {
  pageNumber: number;
  pageWidth: number;
  pageHeight: number;
  scale: number;
  strokes: PdfStroke[];
  activeTool: DrawingTool;
  activeColor: string;
  activeWidth: StrokeWidth;
  isAnnotationMode: boolean;
  onAddStroke: (stroke: PdfStroke) => void;
  onEraseStroke: (strokeId: string) => void;
}

/**
 * Converts a list of normalized (0..1) points into a smoothed SVG path string (scaled to pixels).
 */
export function pointsToSvgPath(points: StrokePoint[], width: number, height: number): string {
  if (!points || points.length === 0) return '';
  if (points.length === 1) {
    const x = points[0].x * width;
    const y = points[0].y * height;
    return `M ${x} ${y} L ${x + 0.1} ${y + 0.1}`;
  }

  const p0 = { x: points[0].x * width, y: points[0].y * height };
  let path = `M ${p0.x} ${p0.y}`;

  if (points.length === 2) {
    const p1 = { x: points[1].x * width, y: points[1].y * height };
    path += ` L ${p1.x} ${p1.y}`;
    return path;
  }

  // Smooth curve through midpoints
  for (let i = 1; i < points.length - 1; i++) {
    const curr = { x: points[i].x * width, y: points[i].y * height };
    const next = { x: points[i + 1].x * width, y: points[i + 1].y * height };
    const midX = (curr.x + next.x) / 2;
    const midY = (curr.y + next.y) / 2;
    path += ` Q ${curr.x} ${curr.y}, ${midX} ${midY}`;
  }

  const last = { x: points[points.length - 1].x * width, y: points[points.length - 1].y * height };
  path += ` L ${last.x} ${last.y}`;
  return path;
}

/**
 * Calculates shortest distance from point (px, py) to line segment (x1, y1)-(x2, y2).
 */
export function pointToSegmentDistance(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    return Math.hypot(px - x1, py - y1);
  }
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  return Math.hypot(px - projX, py - projY);
}

/**
 * Checks if a point intersects a stroke within a given hit threshold.
 */
export function strokeIntersectsPoint(
  stroke: PdfStroke,
  normX: number,
  normY: number,
  thresholdNorm: number,
): boolean {
  const pts = stroke.points;
  if (!pts || pts.length === 0) return false;

  for (let i = 0; i < pts.length; i++) {
    if (i === 0) {
      if (Math.hypot(normX - pts[0].x, normY - pts[0].y) <= thresholdNorm) {
        return true;
      }
    } else {
      const dist = pointToSegmentDistance(
        normX,
        normY,
        pts[i - 1].x,
        pts[i - 1].y,
        pts[i].x,
        pts[i].y,
      );
      if (dist <= thresholdNorm) {
        return true;
      }
    }
  }
  return false;
}

export const PdfDrawingLayer: React.FC<Props> = ({
  pageNumber,
  pageWidth,
  pageHeight,
  scale,
  strokes,
  activeTool,
  activeColor,
  activeWidth,
  isAnnotationMode,
  onAddStroke,
  onEraseStroke,
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [currentPoints, setCurrentPoints] = useState<StrokePoint[] | null>(null);
  const isDrawing = useRef(false);
  const activePointerId = useRef<number | null>(null);

  const isInteractive =
    isAnnotationMode &&
    (activeTool === 'pencil' || activeTool === 'free_highlighter' || activeTool === 'eraser');

  const strokeWidthPx = useMemo(() => {
    const base =
      activeTool === 'free_highlighter'
        ? FREE_HIGHLIGHTER_WIDTHS[activeWidth] || 22
        : PENCIL_WIDTHS[activeWidth] || 4;
    return base * scale;
  }, [activeTool, activeWidth, scale]);

  const getNormalizedPoint = useCallback(
    (clientX: number, clientY: number): StrokePoint | null => {
      if (!svgRef.current) return null;
      const rect = svgRef.current.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      return { x, y };
    },
    [],
  );

  const checkEraserHit = useCallback(
    (clientX: number, clientY: number) => {
      if (!svgRef.current) return;
      const rect = svgRef.current.getBoundingClientRect();
      const normPt = getNormalizedPoint(clientX, clientY);
      if (!normPt) return;

      // 20px hit threshold converted to normalized units
      const thresholdNorm = 24 / Math.max(rect.width, rect.height);

      for (const stroke of strokes) {
        if (strokeIntersectsPoint(stroke, normPt.x, normPt.y, thresholdNorm)) {
          onEraseStroke(stroke.id);
        }
      }
    },
    [strokes, getNormalizedPoint, onEraseStroke],
  );

  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!isInteractive || !e.isPrimary) return;

    // Capture pointer
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
    activePointerId.current = e.pointerId;
    isDrawing.current = true;

    if (activeTool === 'eraser') {
      checkEraserHit(e.clientX, e.clientY);
      return;
    }

    const pt = getNormalizedPoint(e.clientX, e.clientY);
    if (pt) {
      pt.p = e.pressure > 0 ? e.pressure : 0.5;
      setCurrentPoints([pt]);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!isDrawing.current || (activePointerId.current !== null && activePointerId.current !== e.pointerId)) return;

    if (activeTool === 'eraser') {
      checkEraserHit(e.clientX, e.clientY);
      return;
    }

    const pt = getNormalizedPoint(e.clientX, e.clientY);
    if (pt) {
      pt.p = e.pressure > 0 ? e.pressure : 0.5;
      setCurrentPoints((prev) => (prev ? [...prev, pt] : [pt]));
    }
  };

  const handlePointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!isDrawing.current || (activePointerId.current !== null && activePointerId.current !== e.pointerId)) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}

    isDrawing.current = false;
    activePointerId.current = null;

    if (activeTool !== 'eraser' && currentPoints && currentPoints.length > 0) {
      const newStroke: PdfStroke = {
        id: secureRequestId(),
        lectureId: '', // populated by caller
        page: pageNumber,
        tool: activeTool === 'free_highlighter' ? 'free_highlighter' : 'pencil',
        color: activeColor,
        width:
          activeTool === 'free_highlighter'
            ? FREE_HIGHLIGHTER_WIDTHS[activeWidth] || 22
            : PENCIL_WIDTHS[activeWidth] || 4,
        opacity: activeTool === 'free_highlighter' ? 0.38 : 1.0,
        points: currentPoints,
        createdAt: Date.now(),
      };
      onAddStroke(newStroke);
    }

    setCurrentPoints(null);
  };

  const handlePointerCancel = (e: React.PointerEvent<SVGSVGElement>) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
    isDrawing.current = false;
    activePointerId.current = null;
    setCurrentPoints(null);
  };

  // pageWidth and pageHeight are already the pixel layout dimensions (box.w, box.h)
  const pixelWidth = pageWidth;
  const pixelHeight = pageHeight;

  return (
    <svg
      ref={svgRef}
      className={`absolute inset-0 w-full h-full ${
        isInteractive ? 'cursor-crosshair' : 'pointer-events-none'
      }`}
      style={{
        zIndex: isInteractive ? 30 : 10,
        touchAction: isInteractive ? 'none' : 'auto',
        pointerEvents: isInteractive ? 'auto' : 'none',
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      {/* Committed Strokes */}
      {strokes.map((stroke) => {
        const pathData = pointsToSvgPath(stroke.points, pixelWidth, pixelHeight);
        if (!pathData) return null;
        const width = (stroke.width || 4) * scale;
        const isHighlighter = stroke.tool === 'free_highlighter';

        return (
          <path
            key={stroke.id}
            d={pathData}
            fill="none"
            stroke={stroke.color}
            strokeWidth={width}
            strokeOpacity={isHighlighter ? stroke.opacity || 0.38 : 1}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={isHighlighter ? { mixBlendMode: 'multiply' } : undefined}
          />
        );
      })}

      {/* Live Drawing Stroke */}
      {currentPoints && currentPoints.length > 0 && activeTool !== 'eraser' && (
        <path
          d={pointsToSvgPath(currentPoints, pixelWidth, pixelHeight)}
          fill="none"
          stroke={activeColor}
          strokeWidth={strokeWidthPx}
          strokeOpacity={activeTool === 'free_highlighter' ? 0.38 : 1}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={activeTool === 'free_highlighter' ? { mixBlendMode: 'multiply' } : undefined}
        />
      )}
    </svg>
  );
};

export default PdfDrawingLayer;
