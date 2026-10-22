import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Trash2, Check, Move, Type } from 'lucide-react';
import type { PdfAnnotation, HighlightColor } from '../../types/pdfAnnotation.types';
import type { DrawingTool } from '../../types/pdfDrawing.types';

interface Props {
  pageNumber: number;
  pageWidth: number;
  pageHeight: number;
  scale?: number;
  annotations: PdfAnnotation[];
  activeTool: DrawingTool;
  activeColor: string;
  isAnnotationMode: boolean;
  onSaveText: (a: PdfAnnotation) => void;
  onDeleteText: (id: string) => void;
  isRtl?: boolean;
}

export const PdfTextBoxOverlay: React.FC<Props> = ({
  pageNumber,
  pageWidth,
  pageHeight,
  scale = 1,
  annotations,
  activeTool,
  activeColor,
  isAnnotationMode,
  onSaveText,
  onDeleteText,
  isRtl = true,
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editFontSize, setEditFontSize] = useState<'sm' | 'base' | 'lg'>('base');
  const [editColor, setEditColor] = useState<HighlightColor>('yellow');
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragStartRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Filter text annotations for this page
  const textItems = annotations.filter((a) => a.kind === 'text' && a.page === pageNumber);

  // Auto-focus when entering edit mode
  useEffect(() => {
    if (editingId && textareaRef.current) {
      textareaRef.current.focus();
      // Set cursor to end
      const len = textareaRef.current.value.length;
      textareaRef.current.setSelectionRange(len, len);
    }
  }, [editingId]);

  // Start editing an existing text annotation
  const handleStartEdit = (item: PdfAnnotation, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setEditingId(item.id);
    setEditText(item.text || item.note || '');
    setEditFontSize(item.fontSize || 'base');
    setEditColor(item.color || 'yellow');
  };

  // Commit and save text
  const handleCommitEdit = useCallback(() => {
    if (!editingId) return;

    const trimmed = editText.trim();
    if (!trimmed) {
      // Empty text gets cleanly removed
      onDeleteText(editingId);
    } else {
      const existing = textItems.find((a) => a.id === editingId);
      if (existing) {
        onSaveText({
          ...existing,
          text: trimmed,
          note: trimmed,
          fontSize: editFontSize,
          color: editColor,
          updatedAt: Date.now(),
        });
      }
    }
    setEditingId(null);
  }, [editingId, editText, editFontSize, editColor, textItems, onSaveText, onDeleteText]);

  // Click on background container when activeTool === 'text' creates a new text box
  const handleContainerClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (activeTool !== 'text' || !isAnnotationMode) return;

    // If we're already editing, commit first
    if (editingId) {
      handleCommitEdit();
      return;
    }

    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    // Normalize coordinates (0.0 to 1.0)
    const normX = Math.max(0.02, Math.min(0.85, clickX / rect.width));
    const normY = Math.max(0.02, Math.min(0.92, clickY / rect.height));

    const newId = `txt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const newAnnotation: PdfAnnotation = {
      id: newId,
      lectureId: '',
      docFingerprint: '',
      kind: 'text',
      page: pageNumber,
      color: (activeColor as HighlightColor) || 'yellow',
      text: '',
      note: '',
      fontSize: 'base',
      point: { x: normX, y: normY },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      schema: 1,
    };

    onSaveText(newAnnotation);
    setEditingId(newId);
    setEditText('');
    setEditFontSize('base');
    setEditColor((activeColor as HighlightColor) || 'yellow');
  };

  // Dragging support for moving text boxes
  const handleDragStart = (id: string, e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    const item = textItems.find((a) => a.id === id);
    if (!item || !item.point) return;

    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

    dragStartRef.current = {
      startX: clientX,
      startY: clientY,
      origX: item.point.x,
      origY: item.point.y,
    };
    setDraggingId(id);
  };

  useEffect(() => {
    if (!draggingId) return;

    const onPointerMove = (e: MouseEvent | TouchEvent) => {
      if (!dragStartRef.current || !containerRef.current) return;
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
      const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

      const rect = containerRef.current.getBoundingClientRect();
      const deltaX = (clientX - dragStartRef.current.startX) / rect.width;
      const deltaY = (clientY - dragStartRef.current.startY) / rect.height;

      const newX = Math.max(0.02, Math.min(0.92, dragStartRef.current.origX + deltaX));
      const newY = Math.max(0.02, Math.min(0.95, dragStartRef.current.origY + deltaY));

      const item = textItems.find((a) => a.id === draggingId);
      if (item) {
        onSaveText({
          ...item,
          point: { x: newX, y: newY },
          updatedAt: Date.now(),
        });
      }
    };

    const onPointerUp = () => {
      setDraggingId(null);
      dragStartRef.current = null;
    };

    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('mouseup', onPointerUp);
    window.addEventListener('touchmove', onPointerMove, { passive: false });
    window.addEventListener('touchend', onPointerUp);

    return () => {
      window.removeEventListener('mousemove', onPointerMove);
      window.removeEventListener('mouseup', onPointerUp);
      window.removeEventListener('touchmove', onPointerMove);
      window.removeEventListener('touchend', onPointerUp);
    };
  }, [draggingId, textItems, onSaveText]);

  // Font size styles mapping
  const fontSizeClasses = {
    sm: 'text-xs sm:text-sm',
    base: 'text-sm sm:text-base',
    lg: 'text-base sm:text-xl font-bold',
  };

  return (
    <div
      ref={containerRef}
      onClick={handleContainerClick}
      className={`absolute inset-0 select-none ${
        activeTool === 'text' && isAnnotationMode
          ? 'cursor-text pointer-events-auto z-20'
          : 'pointer-events-none z-15'
      }`}
      style={{ width: pageWidth, height: pageHeight }}
    >
      {textItems.map((item) => {
        const isEditing = editingId === item.id;
        const posX = (item.point?.x ?? 0.05) * 100;
        const posY = (item.point?.y ?? 0.05) * 100;
        const sizeClass = fontSizeClasses[item.fontSize || 'base'];

        if (isEditing) {
          return (
            <div
              key={item.id}
              onClick={(e) => e.stopPropagation()}
              className="absolute pointer-events-auto z-40 flex flex-col bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl border border-indigo-500/80 p-2.5 min-w-[220px] max-w-[340px] animate-in fade-in zoom-in-95 duration-150"
              style={{
                left: `${Math.min(posX, 70)}%`,
                top: `${Math.min(posY, 85)}%`,
              }}
            >
              {/* Mini Toolbar */}
              <div className="flex items-center justify-between pb-2 mb-2 border-b border-zinc-200 dark:border-zinc-800 text-xs">
                {/* Drag handle */}
                <button
                  type="button"
                  onMouseDown={(e) => handleDragStart(item.id, e)}
                  onTouchStart={(e) => handleDragStart(item.id, e)}
                  className="cursor-move p-1 text-slate-400 hover:text-slate-700 dark:hover:text-zinc-200"
                  title={isRtl ? 'تحريك المربع' : 'Move'}
                >
                  <Move className="w-3.5 h-3.5" />
                </button>

                {/* Font Size Switches: S / M / L */}
                <div className="flex items-center gap-1 bg-slate-100 dark:bg-zinc-800 rounded-lg p-0.5">
                  {(['sm', 'base', 'lg'] as const).map((sz) => (
                    <button
                      key={sz}
                      type="button"
                      onClick={() => setEditFontSize(sz)}
                      className={`px-1.5 py-0.5 rounded text-[11px] font-semibold transition ${
                        editFontSize === sz
                          ? 'bg-white dark:bg-zinc-700 text-indigo-600 dark:text-indigo-400 shadow-xs'
                          : 'text-slate-500 dark:text-zinc-400'
                      }`}
                    >
                      {sz === 'sm' ? (isRtl ? 'ص' : 'S') : sz === 'base' ? (isRtl ? 'م' : 'M') : (isRtl ? 'ك' : 'L')}
                    </button>
                  ))}
                </div>

                {/* Actions: Delete & Check */}
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      onDeleteText(item.id);
                      setEditingId(null);
                    }}
                    className="p-1 rounded-md text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40"
                    title={isRtl ? 'حذف' : 'Delete'}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={handleCommitEdit}
                    className="p-1 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 active:scale-95 transition"
                    title={isRtl ? 'حفظ' : 'Done'}
                  >
                    <Check className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Editable Text Area */}
              <textarea
                ref={textareaRef}
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onBlur={handleCommitEdit}
                dir="auto"
                rows={3}
                placeholder={isRtl ? 'اكتب ملاحظتك هنا...' : 'Type your note here...'}
                className={`w-full bg-transparent resize-none outline-none text-slate-900 dark:text-zinc-100 placeholder:text-slate-400 leading-relaxed ${fontSizeClasses[editFontSize]}`}
              />
            </div>
          );
        }

        // View mode: Cleanly rendered on-page text box
        const displayText = item.text || item.note;
        if (!displayText) return null;

        return (
          <div
            key={item.id}
            onClick={(e) => {
              if (isAnnotationMode) {
                handleStartEdit(item, e);
              }
            }}
            className={`absolute pointer-events-auto rounded-lg px-2.5 py-1.5 transition-all group max-w-[85%] ${
              isAnnotationMode
                ? 'cursor-pointer hover:ring-2 hover:ring-indigo-500/60 hover:bg-white/90 dark:hover:bg-zinc-900/90 shadow-xs'
                : ''
            }`}
            style={{
              left: `${posX}%`,
              top: `${posY}%`,
            }}
          >
            {/* Move handle visible on hover in annotation mode */}
            {isAnnotationMode && (
              <div
                onMouseDown={(e) => handleDragStart(item.id, e)}
                onTouchStart={(e) => handleDragStart(item.id, e)}
                className="opacity-0 group-hover:opacity-100 absolute -top-3 -start-2 p-1 bg-white dark:bg-zinc-800 rounded-full shadow-md text-slate-500 hover:text-indigo-600 cursor-move transition-opacity"
              >
                <Move className="w-3 h-3" />
              </div>
            )}

            <p
              dir="auto"
              className={`whitespace-pre-wrap font-medium leading-relaxed tracking-normal text-slate-900 dark:text-zinc-100 ${sizeClass}`}
            >
              {displayText}
            </p>
          </div>
        );
      })}
    </div>
  );
};
