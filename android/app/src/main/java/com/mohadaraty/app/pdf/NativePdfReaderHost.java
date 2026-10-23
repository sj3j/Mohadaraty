package com.mohadaraty.app.pdf;

import android.content.Context;
import android.view.MotionEvent;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import com.github.barteksc.pdfviewer.PDFView;

import org.json.JSONObject;

import java.util.List;

public class NativePdfReaderHost extends FrameLayout {

    private final PDFView pdfView;
    private final PdfInkOverlayView inkOverlayView;
    private final NativeGestureCoordinator gestureCoordinator;

    private boolean isAnnotationMode = false;
    private String activeTool = "pencil";
    private boolean fingerDrawing = true;
    private boolean nativeInkV2Active = true;

    public NativePdfReaderHost(Context context, PDFView pdfView) {
        super(context);
        this.pdfView = pdfView;
        this.inkOverlayView = new PdfInkOverlayView(context);
        this.gestureCoordinator = new NativeGestureCoordinator(pdfView, inkOverlayView);

        LayoutParams layoutParams = new LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        );

        addView(pdfView, layoutParams);
        addView(inkOverlayView, layoutParams);
    }

    public PDFView getPdfView() {
        return pdfView;
    }

    public PdfInkOverlayView getInkOverlayView() {
        return inkOverlayView;
    }

    public NativeGestureCoordinator getGestureCoordinator() {
        return gestureCoordinator;
    }

    public void setInteractionState(
            boolean isAnnotationMode,
            String activeTool,
            int activeColor,
            float activeWidth,
            boolean fingerDrawing,
            boolean nativeInkV2Active
    ) {
        this.isAnnotationMode = isAnnotationMode;
        this.activeTool = activeTool;
        this.fingerDrawing = fingerDrawing;
        this.nativeInkV2Active = nativeInkV2Active;

        inkOverlayView.setActiveTool(activeTool);
        inkOverlayView.setActiveColor(activeColor);
        inkOverlayView.setActiveWidth(activeWidth);

        // Visibility / interaction optimization:
        if (!nativeInkV2Active || (!isAnnotationMode && !"hand".equals(activeTool))) {
            inkOverlayView.setVisibility(VISIBLE);
        } else {
            inkOverlayView.setVisibility(VISIBLE);
        }
    }

    public void onPageChanged(int page) {
        inkOverlayView.setCurrentPage(page);
    }

    public void setPageStrokes(int page, List<PdfInkOverlayView.NativeStroke> strokes) {
        inkOverlayView.setPageStrokes(page, strokes);
    }

    public void setStrokeCommitListener(PdfInkOverlayView.StrokeCommitListener listener) {
        inkOverlayView.setStrokeCommitListener(listener);
    }

    @Override
    public boolean onInterceptTouchEvent(MotionEvent ev) {
        if (!nativeInkV2Active) {
            return super.onInterceptTouchEvent(ev);
        }
        // Direct event routing handled in dispatchTouchEvent
        return false;
    }

    @Override
    public boolean dispatchTouchEvent(MotionEvent ev) {
        if (nativeInkV2Active) {
            return gestureCoordinator.dispatchTouchEvent(
                    ev,
                    isAnnotationMode,
                    activeTool,
                    fingerDrawing,
                    nativeInkV2Active
            );
        }
        return super.dispatchTouchEvent(ev);
    }
}
