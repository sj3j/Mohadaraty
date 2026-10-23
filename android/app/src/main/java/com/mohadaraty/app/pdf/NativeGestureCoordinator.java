package com.mohadaraty.app.pdf;

import android.view.MotionEvent;

public class NativeGestureCoordinator {

    public enum TouchTarget {
        NONE,
        PDF,
        INK
    }

    private TouchTarget activeTarget = TouchTarget.NONE;
    private final PdfInkOverlayView inkOverlayView;
    private final com.github.barteksc.pdfviewer.PDFView pdfView;

    public NativeGestureCoordinator(com.github.barteksc.pdfviewer.PDFView pdfView, PdfInkOverlayView inkOverlayView) {
        this.pdfView = pdfView;
        this.inkOverlayView = inkOverlayView;
    }

    public TouchTarget getActiveTarget() {
        return activeTarget;
    }

    public boolean dispatchTouchEvent(
            MotionEvent event,
            boolean isAnnotationMode,
            String activeTool,
            boolean fingerDrawing,
            boolean nativeInkV2Active
    ) {
        if (!nativeInkV2Active) {
            return false;
        }

        int action = event.getActionMasked();
        int pointerCount = event.getPointerCount();

        if (action == MotionEvent.ACTION_DOWN) {
            boolean isStylus = isStylus(event);
            boolean isDrawingTool = "pencil".equals(activeTool)
                    || "free_highlighter".equals(activeTool)
                    || "eraser".equals(activeTool);

            if (isAnnotationMode && isDrawingTool && (isStylus || fingerDrawing)) {
                activeTarget = TouchTarget.INK;
            } else {
                activeTarget = TouchTarget.PDF;
            }
        }

        // Multi-touch during drawing mode:
        // Cancel inking so the user can pinch-to-zoom or two-finger pan
        if (activeTarget == TouchTarget.INK && pointerCount > 1) {
            if (inkOverlayView != null) {
                inkOverlayView.cancelActiveStroke();
            }
            activeTarget = TouchTarget.PDF;

            // Deliver valid single-pointer ACTION_DOWN to PDFView so its gesture recognizers initialize cleanly
            if (pdfView != null) {
                MotionEvent downForPdf = MotionEvent.obtain(
                        event.getDownTime(),
                        event.getEventTime(),
                        MotionEvent.ACTION_DOWN,
                        event.getX(0),
                        event.getY(0),
                        event.getPressure(0),
                        event.getSize(0),
                        event.getMetaState(),
                        event.getXPrecision(),
                        event.getYPrecision(),
                        event.getDeviceId(),
                        event.getEdgeFlags()
                );
                pdfView.dispatchTouchEvent(downForPdf);
                downForPdf.recycle();
            }
        }

        boolean handled = false;
        if (activeTarget == TouchTarget.INK && inkOverlayView != null) {
            handled = inkOverlayView.dispatchTouchEvent(event);
        } else if (activeTarget == TouchTarget.PDF && pdfView != null) {
            handled = pdfView.dispatchTouchEvent(event);
        }

        if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
            activeTarget = TouchTarget.NONE;
        }

        return handled;
    }

    private boolean isStylus(MotionEvent event) {
        int toolType = event.getToolType(0);
        return toolType == MotionEvent.TOOL_TYPE_STYLUS || toolType == MotionEvent.TOOL_TYPE_ERASER;
    }
}
