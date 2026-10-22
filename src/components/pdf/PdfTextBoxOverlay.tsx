import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Trash2, Check, Move, Pencil } from 'lucide-react';
import { HIGHLIGHT_COLORS, type PdfAnnotation, type HighlightColor } from '../../types/pdfAnnotation.types';
import type { DrawingTool } from '../../types/pdfDrawing.types';

export const TEXT_PALETTE: { id: HighlightColor; hex: string; label: string }[] = [
  { id: 'yellow', hex: '#fde68a', label: 'أصفر' },
  { id: 'green', hex: '#bbf7d0', label: 'أخضر' },
  { id: 'blue', hex: '#bfdbfe', label: 'أزرق' },
  { id: 'pink', hex: '#fbcfe8', label: 'وردي' },
  { id: 'orange', hex: '#fed7aa', label: 'برتقالي' },
];

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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editFontSize, setEditFontSize] = useState<'sm' | 'base' | 'lg'>('base');
  const [editColor, setEditColor] = useState<HighlightColor>('yellow');
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const isInteractingToolbarRef = useRef(false);
  const dragStartRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Filter text annotations for this page
  const textItems = annotations.filter((a) => a.kind === 'text' && a.page === pageNumber);

  // Auto-focus when entering edit mode
  useEffect(() => {
    if (editingId && textareaRef.current) {
      textareaRef.current.focus();
      const len = textareaRef.current.value.length;
      textareaRef.current.setSelectionRange(len, len);
    }
  }, [editingId]);

  // Start editing an existing text annotation
  const handleStartEdit = (item: PdfAnnotation, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setEditingId(item.id);
    setSelectedId(null);
    setEditText(item.text || item.note || '');
    setEditFontSize(item.fontSize || 'base');
    setEditColor(item.color || 'yellow');
  };

  // Immediate font size change
  const handleFontSizeChange = (sz: 'sm' | 'base' | 'lg', targetItem?: PdfAnnotation) => {
    setEditFontSize(sz);
    const item = targetItem || textItems.find((a) => a.id === editingId) || textItems.find((a) => a.id === selectedId);
    if (item) {
      onSaveText({
        ...item,
        fontSize: sz,
        updatedAt: Date.now(),
      });
    }
  };

  // Immediate color change
  const handleColorChange = (c: HighlightColor, targetItem?: PdfAnnotation) => {
    setEditColor(c);
    const item = targetItem || textItems.find((a) => a.id === editingId) || textItems.find((a) => a.id === selectedId);
    if (item) {
      onSaveText({
        ...item,
        color: c,
        updatedAt: Date.now(),
      });
    }
  };

  // Immediate delete
  const handleDelete = (id: string, e?: React.MouseEvent | React.TouchEvent) => {
    e?.stopPropagation();
    e?.preventDefault();
    onDeleteText(id);
    if (editingId === id) setEditingId(null);
    if (selectedId === id) setSelectedId(null);
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
    if (activeTool !== 'text' || !isAnnotationMode) {
      setSelectedId(null);
      return;
    }

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
    setSelectedId(null);
    setEditText('');
    setEditFontSize('base');
    setEditColor((activeColor as HighlightColor) || 'yellow');
  };

  // Dragging support for moving text boxes
  const handleDragStart = (id: string, e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    e.preventDefault();
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
        const isSelected = selectedId === item.id && !isEditing;
        const posX = (item.point?.x ?? 0.05) * 100;
        const posY = (item.point?.y ?? 0.05) * 100;
        const activeItemSize = isEditing ? editFontSize : item.fontSize || 'base';
        const activeItemColor = isEditing ? editColor : item.color || 'yellow';
        const sizeClass = fontSizeClasses[activeItemSize];

        // 1. ACTIVE EDITING MODE CARD
        if (isEditing) {
          return (
            <div
              key={item.id}
              onClick={(e) => e.stopPropagation()}
              className="absolute pointer-events-auto z-40 flex flex-col bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl border border-indigo-500/80 p-2.5 min-w-[240px] max-w-[360px] animate-in fade-in zoom-in-95 duration-150"
              style={{
                left: `${Math.min(posX, 70)}%`,
                top: `${Math.min(posY, 85)}%`,
              }}
            >
              {/* Mini Toolbar */}
              <div
                className="flex items-center justify-between pb-2 mb-2 border-b border-zinc-200 dark:border-zinc-800 text-xs gap-1"
                onMouseDown={() => { isInteractingToolbarRef.current = true; }}
              >
                {/* Drag handle */}
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    isInteractingToolbarRef.current = true;
                    handleDragStart(item.id, e);
                  }}
                  onTouchStart={(e) => {
                    isInteractingToolbarRef.current = true;
                    handleDragStart(item.id, e);
                  }}
                  className="cursor-move p-1 text-slate-400 hover:text-slate-700 dark:hover:text-zinc-200 transition"
                  title={isRtl ? 'تحريك المربع' : 'Move'}
                >
                  <Move className="w-3.5 h-3.5" />
                </button>

                {/* Font Size Switches: S / M / L with e.preventDefault() */}
                <div className="flex items-center gap-0.5 bg-slate-100 dark:bg-zinc-800 rounded-lg p-0.5">
                  {(['sm', 'base', 'lg'] as const).map((sz) => (
                    <button
                      key={sz}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        isInteractingToolbarRef.current = true;
                        handleFontSizeChange(sz, item);
                      }}
                      className={`px-2 py-0.5 rounded text-[11px] font-bold transition ${
                        activeItemSize === sz
                          ? 'bg-white dark:bg-zinc-700 text-indigo-600 dark:text-indigo-400 shadow-xs scale-105'
                          : 'text-slate-500 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-200'
                      }`}
                    >
                      {sz === 'sm' ? (isRtl ? 'ص' : 'S') : sz === 'base' ? (isRtl ? 'م' : 'M') : (isRtl ? 'ك' : 'L')}
                    </button>
                  ))}
                </div>

                {/* Color Swatches */}
                <div className="flex items-center gap-1 px-1">
                  {TEXT_PALETTE.map((pal) => (
                    <button
                      key={pal.id}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        isInteractingToolbarRef.current = true;
                        handleColorChange(pal.id, item);
                      }}
                      style={{ backgroundColor: pal.hex }}
                      className={`w-3.5 h-3.5 rounded-full border transition-transform ${
                        activeItemColor === pal.id
                          ? 'ring-2 ring-indigo-500 ring-offset-1 scale-110 border-transparent'
                          : 'border-zinc-300 dark:border-zinc-700 hover:scale-105'
                      }`}
                      title={pal.label}
                    />
                  ))}
                </div>

                {/* Actions: Delete & Check */}
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      isInteractingToolbarRef.current = true;
                      handleDelete(item.id, e);
                    }}
                    className="p-1 rounded-md text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40 active:scale-95 transition"
                    title={isRtl ? 'حذف' : 'Delete'}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      isInteractingToolbarRef.current = false;
                      handleCommitEdit();
                    }}
                    className="p-1 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 active:scale-95 transition shadow-xs"
                    title={isRtl ? 'حفظ' : 'Done'}
                  >
                    <Check className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Editable Text Area */}
              <textarea
                ref={textareaRef}
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onBlur={() => {
                  if (isInteractingToolbarRef.current) {
                    isInteractingToolbarRef.current = false;
                    return;
                  }
                  handleCommitEdit();
                }}
                dir="auto"
                rows={3}
                placeholder={isRtl ? 'اكتب ملاحظتك هنا...' : 'Type your note here...'}
                className={`w-full bg-transparent resize-none outline-none text-slate-900 dark:text-zinc-100 placeholder:text-slate-400 leading-relaxed ${fontSizeClasses[editFontSize]}`}
              />
            </div>
          );
        }

        // 2. VIEW MODE: Cleanly rendered on-page text box with optional Floating Action Capsule
        const displayText = item.text || item.note;
        if (!displayText) return null;

        return (
          <div
            key={item.id}
            onClick={(e) => {
              if (isAnnotationMode) {
                e.stopPropagation();
                setSelectedId(item.id);
              }
            }}
            className={`absolute pointer-events-auto rounded-lg px-2.5 py-1.5 transition-all group max-w-[85%] ${
              isAnnotationMode
                ? 'cursor-pointer hover:ring-2 hover:ring-indigo-500/50 hover:bg-white/80 dark:hover:bg-zinc-900/80'
                : ''
            } ${
              isSelected
                ? 'ring-2 ring-indigo-500 bg-white/95 dark:bg-zinc-900/95 shadow-lg'
                : ''
            }`}
            style={{
              left: `${posX}%`,
              top: `${posY}%`,
            }}
          >
            {/* FLOATING ACTION CAPSULE IN VIEW MODE */}
            {isAnnotationMode && isSelected && (
              <div
                onClick={(e) => e.stopPropagation()}
                className="absolute -top-11 start-0 z-30 flex items-center gap-1.5 bg-white/95 dark:bg-zinc-900/95 backdrop-blur-md px-2 py-1 rounded-full shadow-xl border border-zinc-200/90 dark:border-zinc-800 animate-in fade-in zoom-in-95 duration-100"
              >
                {/* Drag handle */}
                <button
                  type="button"
                  onMouseDown={(e) => handleDragStart(item.id, e)}
                  onTouchStart={(e) => handleDragStart(item.id, e)}
                  className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-zinc-200 cursor-move"
                  title={isRtl ? 'تحريك' : 'Move'}
                >
                  <Move className="w-3.5 h-3.5" />
                </button>

                {/* Edit Pencil */}
                <button
                  type="button"
                  onClick={(e) => handleStartEdit(item, e)}
                  className="p-1 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-zinc-800 rounded-md transition"
                  title={isRtl ? 'تعديل النص' : 'Edit Text'}
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>

                {/* S / M / L Size switcher */}
                <div className="flex items-center gap-0.5 bg-slate-100 dark:bg-zinc-800 rounded-md p-0.5">
                  {(['sm', 'base', 'lg'] as const).map((sz) => (
                    <button
                      key={sz}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleFontSizeChange(sz, item);
                      }}
                      className={`px-1.5 py-0.5 rounded text-[10px] font-bold transition ${
                        activeItemSize === sz
                          ? 'bg-white dark:bg-zinc-700 text-indigo-600 dark:text-indigo-400 shadow-xs'
                          : 'text-slate-500 dark:text-zinc-400 hover:text-slate-800'
                      }`}
                    >
                      {sz === 'sm' ? (isRtl ? 'ص' : 'S') : sz === 'base' ? (isRtl ? 'م' : 'M') : (isRtl ? 'ك' : 'L')}
                    </button>
                  ))}
                </div>

                {/* Color dots */}
                <div className="flex items-center gap-1 px-0.5">
                  {TEXT_PALETTE.map((pal) => (
                    <button
                      key={pal.id}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleColorChange(pal.id, item);
                      }}
                      style={{ backgroundColor: pal.hex }}
                      className={`w-3 h-3 rounded-full border transition-transform ${
                        activeItemColor === pal.id
                          ? 'ring-2 ring-indigo-500 ring-offset-1 scale-110 border-transparent'
                          : 'border-zinc-300 dark:border-zinc-700 hover:scale-105'
                      }`}
                      title={pal.label}
                    />
                  ))}
                </div>

                {/* Delete button */}
                <button
                  type="button"
                  onClick={(e) => handleDelete(item.id, e)}
                  className="p-1 rounded-md text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40 transition"
                  title={isRtl ? 'حذف' : 'Delete'}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {/* Quick hover move handle when capsule is not open */}
            {isAnnotationMode && !isSelected && (
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
