package com.mohadaraty.app.pdf;

import android.content.pm.ApplicationInfo;
import android.graphics.Color;
import android.graphics.RectF;
import android.graphics.drawable.Drawable;
import android.util.Log;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.github.barteksc.pdfviewer.PDFView;
import com.github.barteksc.pdfviewer.listener.OnLongPressListener;
import com.github.barteksc.pdfviewer.listener.OnDrawListener;
import com.github.barteksc.pdfviewer.listener.OnPageChangeListener;
import com.github.barteksc.pdfviewer.listener.OnTapListener;
import com.github.barteksc.pdfviewer.util.Constants;
import com.github.barteksc.pdfviewer.util.FitPolicy;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

@CapacitorPlugin(name = "MohadaratyPdf")
public class PdfViewerPlugin extends Plugin {

    static {
        com.github.barteksc.pdfviewer.util.Constants.PRELOAD_OFFSET = 1000;
        com.github.barteksc.pdfviewer.util.Constants.Cache.CACHE_SIZE = 160;
    }

    private static final String LOG_TAG = "MohadaratyPdf";
    private static final float TOP_CHROME_DP = 120f;
    private static final float BOTTOM_CHROME_DP = 100f;
    private static final float BOTTOM_CHROME_WIDTH_DP = 240f;
    private static final float ANNOTATION_DOCK_HEIGHT_DP = 240f;

    private enum TouchOwner { NONE, WEB, PDF }

    private static final class InteractionState {
        final String mode;
        final String tool;
        final String color;
        final String width;
        final boolean fingerDrawing;
        final boolean chromeVisible;
        final boolean webOverlayActive;
        final int revision;

        InteractionState(
                String mode,
                String tool,
                String color,
                String width,
                boolean fingerDrawing,
                boolean chromeVisible,
                boolean webOverlayActive,
                int revision
        ) {
            this.mode = mode;
            this.tool = tool;
            this.color = color;
            this.width = width;
            this.fingerDrawing = fingerDrawing;
            this.chromeVisible = chromeVisible;
            this.webOverlayActive = webOverlayActive;
            this.revision = revision;
        }

        static InteractionState initial() {
            return new InteractionState("read", "pencil", "#4f46e5", "medium", true, true, false, 0);
        }
    }

    private static final class PendingInteraction {
        final InteractionState state;
        final PluginCall call;

        PendingInteraction(InteractionState state, PluginCall call) {
            this.state = state;
            this.call = call;
        }
    }

    private PDFView pdfView;
    private NativePdfReaderHost readerHost;
    private boolean nativeInkV2 = false;
    private final List<RectF> interactiveZones = Collections.synchronizedList(new ArrayList<>());
    private View.OnTouchListener touchRouter;
    private Drawable originalWebViewBackground;
    private boolean hasOriginalWebViewBackground;
    private boolean stableInteractionRouting = true;
    private InteractionState interactionState = InteractionState.initial();
    private PendingInteraction pendingInteraction;
    private TouchOwner activeTouchOwner = TouchOwner.NONE;
    private MotionEvent lastPdfEvent;

    @PluginMethod
    public void openPdf(PluginCall call) {
        String filePath = call.getString("filePath");
        if (filePath == null || filePath.isEmpty()) {
            call.reject("filePath is required");
            return;
        }

        int initialPage = call.getInt("initialPage", 1);
        boolean nightMode = Boolean.TRUE.equals(call.getBoolean("nightMode", false));
        boolean swipeHorizontal = Boolean.TRUE.equals(call.getBoolean("swipeHorizontal", false));
        stableInteractionRouting = Boolean.TRUE.equals(call.getBoolean("stableInteractionRouting", true));
        nativeInkV2 = Boolean.TRUE.equals(call.getBoolean("nativeInkV2", false));

        getActivity().runOnUiThread(() -> {
            try {
                View webView = bridge.getWebView();
                ViewGroup parent = (ViewGroup) webView.getParent();
                detachPdfView(webView, false);
                interactionState = InteractionState.initial();

                String cleanPath = filePath.startsWith("file://") ? filePath.substring(7) : filePath;
                File file = new File(cleanPath);
                if (!file.exists()) {
                    call.reject("File does not exist: " + filePath);
                    return;
                }

                if (!hasOriginalWebViewBackground) {
                    originalWebViewBackground = webView.getBackground();
                    hasOriginalWebViewBackground = true;
                }
                webView.setBackgroundColor(Color.TRANSPARENT);

                pdfView = new PDFView(getContext(), null);
                readerHost = new NativePdfReaderHost(getContext(), pdfView);
                readerHost.setStrokeCommitListener(new PdfInkOverlayView.StrokeCommitListener() {
                    @Override
                    public void onStrokeCommitted(int page, JSONObject strokeJson) {
                        JSObject ret = new JSObject();
                        ret.put("page", page);
                        ret.put("action", "add");
                        String strokeId = strokeJson != null ? strokeJson.optString("id", "") : "";
                        if (!strokeId.isEmpty()) {
                            ret.put("opId", "op_add_" + strokeId);
                        }
                        try {
                            ret.put("stroke", JSObject.fromJSONObject(strokeJson));
                        } catch (JSONException ignored) {}
                        notifyListeners("onStrokesUpdated", ret);
                    }

                    @Override
                    public void onStrokeErased(int page, String strokeId) {
                        JSObject ret = new JSObject();
                        ret.put("page", page);
                        ret.put("action", "erase");
                        ret.put("strokeId", strokeId);
                        if (strokeId != null && !strokeId.isEmpty()) {
                            ret.put("opId", "op_erase_" + strokeId);
                        }
                        notifyListeners("onStrokesUpdated", ret);
                    }
                });

                FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                );

                int webViewIndex = parent.indexOfChild(webView);
                parent.addView(readerHost, Math.max(0, webViewIndex), params);

                com.github.barteksc.pdfviewer.util.Constants.PRELOAD_OFFSET = 1000;
                com.github.barteksc.pdfviewer.util.Constants.Cache.CACHE_SIZE = 160;

                pdfView.fromFile(file)
                        .defaultPage(Math.max(0, initialPage - 1))
                        .enableSwipe(true)
                        .swipeHorizontal(swipeHorizontal)
                        .enableDoubletap(true)
                        .pageSnap(true)
                        .pageFling(true)
                        .autoSpacing(true)
                        .pageFitPolicy(com.github.barteksc.pdfviewer.util.FitPolicy.WIDTH)
                        .enableAnnotationRendering(true)
                        .nightMode(nightMode)
                        .spacing(12)
                        // The callback is invoked in PDFView's page drawing
                        // pipeline. Saved ink therefore inherits the exact
                        // same scroll, zoom and centring transform as the PDF.
                        .onDrawAll(new OnDrawListener() {
                            @Override
                            public void onLayerDrawn(android.graphics.Canvas canvas, float width, float height, int page) {
                                if (readerHost != null) {
                                    readerHost.getInkOverlayView().drawPageStrokes(canvas, width, height, page);
                                }
                            }
                        })
                        .onPageChange(new OnPageChangeListener() {
                            @Override
                            public void onPageChanged(int page, int pageCount) {
                                if (readerHost != null) {
                                    readerHost.onPageChanged(page + 1);
                                }
                                JSObject ret = new JSObject();
                                ret.put("page", page + 1);
                                ret.put("pageCount", pageCount);
                                notifyListeners("onPageChange", ret);
                            }
                        })
                        .onTap(new OnTapListener() {
                            @Override
                            public boolean onTap(MotionEvent event) {
                                JSObject ret = new JSObject();
                                ret.put("x", event.getX());
                                ret.put("y", event.getY());
                                notifyListeners("onDocumentTap", ret);
                                return false;
                            }
                        })
                        .onLongPress(new OnLongPressListener() {
                            @Override
                            public void onLongPress(MotionEvent event) {
                                JSObject ret = new JSObject();
                                ret.put("x", event.getX());
                                ret.put("y", event.getY());
                                notifyListeners("onDocumentLongPress", ret);
                            }
                        })
                        .load();

                touchRouter = this::routeTouch;
                webView.setOnTouchListener(touchRouter);
                applyInteraction(interactionState);

                JSObject res = new JSObject();
                res.put("success", true);
                res.put("nativeInkAvailable", nativeInkV2);
                call.resolve(res);
            } catch (Exception exception) {
                detachPdfView(bridge.getWebView(), true);
                interactionState = InteractionState.initial();
                call.reject("Failed to open PDF: " + exception.getMessage(), exception);
            }
        });
    }

    @PluginMethod
    public void setInteraction(PluginCall call) {
        String mode = call.getString("mode", "read");
        String tool = call.getString("tool", "pencil");
        String color = call.getString("color", "#4f46e5");
        String width = call.getString("width", "medium");
        int revision = call.getInt("revision", -1);
        boolean fingerDrawing = Boolean.TRUE.equals(call.getBoolean("fingerDrawing", true));
        boolean chromeVisible = Boolean.TRUE.equals(call.getBoolean("chromeVisible", true));
        boolean webOverlayActive = Boolean.TRUE.equals(call.getBoolean("webOverlayActive", false));

        if (!("read".equals(mode) || "annotate".equals(mode))) {
            call.reject("mode must be read or annotate");
            return;
        }
        if (revision < 0) {
            call.reject("revision must be a non-negative integer");
            return;
        }

        InteractionState requested = new InteractionState(
                mode,
                tool,
                color,
                width,
                fingerDrawing,
                chromeVisible,
                webOverlayActive,
                revision
        );
        getActivity().runOnUiThread(() -> requestInteraction(requested, call));
    }

    @PluginMethod
    public void setPageStrokes(PluginCall call) {
        int page = call.getInt("page", 1);
        JSArray strokesArray = call.getArray("strokes");

        getActivity().runOnUiThread(() -> {
            if (readerHost != null) {
                List<PdfInkOverlayView.NativeStroke> list = new ArrayList<>();
                if (strokesArray != null) {
                    for (int i = 0; i < strokesArray.length(); i++) {
                        try {
                            JSONObject obj = strokesArray.getJSONObject(i);
                            PdfInkOverlayView.NativeStroke stroke = PdfInkOverlayView.jsonToStroke(obj);
                            if (stroke != null) {
                                list.add(stroke);
                            }
                        } catch (JSONException ignored) {}
                    }
                }
                readerHost.setPageStrokes(page, list);
            }
            call.resolve();
        });
    }

    private void requestInteraction(InteractionState requested, PluginCall call) {
        int newestKnownRevision = interactionState.revision;
        if (pendingInteraction != null) {
            newestKnownRevision = Math.max(newestKnownRevision, pendingInteraction.state.revision);
        }

        if (requested.revision <= newestKnownRevision) {
            resolveInteraction(call, interactionState, false, true);
            return;
        }

        if (activeTouchOwner != TouchOwner.NONE) {
            if (pendingInteraction != null) {
                resolveInteraction(pendingInteraction.call, interactionState, true, true);
            }
            pendingInteraction = new PendingInteraction(requested, call);
            debugInteraction("deferred", requested);
            return;
        }

        applyInteraction(requested);
        resolveInteraction(call, interactionState, false, false);
    }

    private void applyInteraction(InteractionState state) {
        interactionState = state;
        if (readerHost != null) {
            int colorInt = Color.parseColor(state.color != null ? state.color : "#4f46e5");
            float widthFloat = "thick".equals(state.width) ? 7f : "thin".equals(state.width) ? 2f : 4f;
            if ("free_highlighter".equals(state.tool)) {
                widthFloat = "thick".equals(state.width) ? 32f : "thin".equals(state.width) ? 14f : 22f;
            }
            readerHost.setInteractionState(
                    "annotate".equals(state.mode),
                    state.tool,
                    colorInt,
                    widthFloat,
                    state.fingerDrawing,
                    nativeInkV2
            );
        }
        debugInteraction("applied", state);
    }

    private void applyPendingInteraction() {
        if (pendingInteraction == null) return;
        PendingInteraction pending = pendingInteraction;
        pendingInteraction = null;
        applyInteraction(pending.state);
        resolveInteraction(pending.call, interactionState, false, false);
    }

    private void resolveInteraction(
            PluginCall call,
            InteractionState state,
            boolean deferred,
            boolean stale
    ) {
        JSObject result = new JSObject();
        result.put("appliedRevision", state.revision);
        result.put("appliedState", interactionToJson(state));
        if (deferred) result.put("deferred", true);
        if (stale) result.put("stale", true);
        call.resolve(result);
    }

    private JSObject interactionToJson(InteractionState state) {
        JSObject json = new JSObject();
        json.put("mode", state.mode);
        json.put("tool", state.tool);
        json.put("color", state.color);
        json.put("width", state.width);
        json.put("fingerDrawing", state.fingerDrawing);
        json.put("chromeVisible", state.chromeVisible);
        json.put("webOverlayActive", state.webOverlayActive);
        json.put("revision", state.revision);
        return json;
    }

    private boolean routeTouch(View webView, MotionEvent event) {
        if (pdfView == null && readerHost == null) return false;

        // In Phase 2 Native Ink V2, readerHost owns drawing and PDF navigation directly
        // whenever the user is interacting with the document.
        int action = event.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN) {
            if (activeTouchOwner == TouchOwner.PDF) cancelActivePdfGesture();
            activeTouchOwner = chooseTouchOwner(event);
            debugTouch("DOWN", activeTouchOwner);
        }

        TouchOwner owner = activeTouchOwner;
        if (owner == TouchOwner.PDF) forwardPdfEvent(webView, event);

        boolean terminal = action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL;
        if (terminal) {
            debugTouch(action == MotionEvent.ACTION_UP ? "UP" : "CANCEL", owner);
            activeTouchOwner = TouchOwner.NONE;
            recycleLastPdfEvent();
            applyPendingInteraction();
        }

        return owner == TouchOwner.PDF;
    }

    private TouchOwner chooseTouchOwner(MotionEvent event) {
        if (!stableInteractionRouting) {
            return isInsideLegacyZone(event.getX(), event.getY()) ? TouchOwner.WEB : TouchOwner.PDF;
        }
        if (interactionState.webOverlayActive) {
            return TouchOwner.WEB;
        }
        // In Phase 2 Native Ink V2, annotation gestures belong to native readerHost
        if ("annotate".equals(interactionState.mode)) {
            if (nativeInkV2) {
                if (interactionState.chromeVisible && isInsideStableChrome(event.getX(), event.getY())) {
                    return TouchOwner.WEB;
                }
                return TouchOwner.PDF;
            }
            return TouchOwner.WEB;
        }
        if (interactionState.chromeVisible && isInsideStableChrome(event.getX(), event.getY())) {
            return TouchOwner.WEB;
        }
        return TouchOwner.PDF;
    }

    private boolean isInsideStableChrome(float x, float y) {
        View target = readerHost != null ? readerHost : pdfView;
        if (target == null) return false;
        float density = getContext().getResources().getDisplayMetrics().density;
        if (y <= TOP_CHROME_DP * density) return true;

        boolean isAnnotate = "annotate".equals(interactionState.mode);
        if (isAnnotate) {
            // Full width bottom dock + color/width popovers
            return y >= target.getHeight() - ANNOTATION_DOCK_HEIGHT_DP * density;
        }

        // Read mode: bottom left page counter pill
        return y >= target.getHeight() - BOTTOM_CHROME_DP * density
                && x <= BOTTOM_CHROME_WIDTH_DP * density;
    }

    private boolean isInsideLegacyZone(float x, float y) {
        synchronized (interactiveZones) {
            for (RectF rect : interactiveZones) {
                if (rect.contains(x, y)) return true;
            }
        }
        return false;
    }

    private void forwardPdfEvent(View webView, MotionEvent source) {
        View target = readerHost != null ? readerHost : pdfView;
        if (target == null) return;
        MotionEvent transformed = MotionEvent.obtain(source);
        int[] webLocation = new int[2];
        int[] targetLocation = new int[2];
        webView.getLocationOnScreen(webLocation);
        target.getLocationOnScreen(targetLocation);
        transformed.offsetLocation(webLocation[0] - targetLocation[0], webLocation[1] - targetLocation[1]);

        recycleLastPdfEvent();
        lastPdfEvent = MotionEvent.obtain(transformed);
        target.dispatchTouchEvent(transformed);
        transformed.recycle();
    }

    private void cancelActivePdfGesture() {
        View target = readerHost != null ? readerHost : pdfView;
        if (target == null || lastPdfEvent == null) return;
        MotionEvent cancel = MotionEvent.obtain(lastPdfEvent);
        cancel.setAction(MotionEvent.ACTION_CANCEL);
        target.dispatchTouchEvent(cancel);
        cancel.recycle();
        recycleLastPdfEvent();
        activeTouchOwner = TouchOwner.NONE;
    }

    private void recycleLastPdfEvent() {
        if (lastPdfEvent != null) {
            lastPdfEvent.recycle();
            lastPdfEvent = null;
        }
    }

    @PluginMethod
    public void setInteractiveZones(PluginCall call) {
        JSArray zonesArray = call.getArray("zones");
        if (zonesArray == null) {
            interactiveZones.clear();
            call.resolve();
            return;
        }

        float density = getContext().getResources().getDisplayMetrics().density;
        List<RectF> newZones = new ArrayList<>();
        for (int i = 0; i < zonesArray.length(); i++) {
            try {
                JSONObject obj = zonesArray.getJSONObject(i);
                float left = (float) obj.optDouble("left", 0) * density;
                float top = (float) obj.optDouble("top", 0) * density;
                float right = (float) obj.optDouble("right", 0) * density;
                float bottom = (float) obj.optDouble("bottom", 0) * density;
                newZones.add(new RectF(left, top, right, bottom));
            } catch (JSONException exception) {
                if (isDebugBuild()) Log.w(LOG_TAG, "[PDF_INTERACTION] invalid legacy zone", exception);
            }
        }

        synchronized (interactiveZones) {
            interactiveZones.clear();
            interactiveZones.addAll(newZones);
        }
        call.resolve();
    }

    @PluginMethod
    public void goToPage(PluginCall call) {
        int page = call.getInt("page", 1);
        getActivity().runOnUiThread(() -> {
            if (pdfView != null) pdfView.jumpTo(Math.max(0, page - 1), true);
            if (readerHost != null) readerHost.onPageChanged(page);
            call.resolve();
        });
    }

    @PluginMethod
    public void setNightMode(PluginCall call) {
        boolean nightMode = Boolean.TRUE.equals(call.getBoolean("nightMode", false));
        getActivity().runOnUiThread(() -> {
            if (pdfView != null) {
                pdfView.setNightMode(nightMode);
                pdfView.invalidate();
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void closePdf(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            detachPdfView(bridge.getWebView(), true);
            interactionState = InteractionState.initial();
            call.resolve();
        });
    }

    private void detachPdfView(View webView, boolean restoreBackground) {
        if (webView != null) {
            webView.setOnTouchListener(null);
            if (restoreBackground) {
                webView.setBackground(originalWebViewBackground);
                originalWebViewBackground = null;
                hasOriginalWebViewBackground = false;
            }
        }

        cancelActivePdfGesture();
        if (pendingInteraction != null) {
            resolveInteraction(pendingInteraction.call, interactionState, false, true);
            pendingInteraction = null;
        }

        if (readerHost != null) {
            ViewGroup parent = (ViewGroup) readerHost.getParent();
            if (parent != null) parent.removeView(readerHost);
            readerHost = null;
        }

        if (pdfView != null) {
            ViewGroup parent = (ViewGroup) pdfView.getParent();
            if (parent != null) parent.removeView(pdfView);
            pdfView.recycle();
            pdfView = null;
        }

        activeTouchOwner = TouchOwner.NONE;
        recycleLastPdfEvent();
        interactiveZones.clear();
    }

    private void debugInteraction(String action, InteractionState state) {
        if (!isDebugBuild()) return;
        Log.d(LOG_TAG, "[PDF_INTERACTION] action=" + action
                + " mode=" + state.mode
                + " tool=" + state.tool
                + " revision=" + state.revision);
    }

    private void debugTouch(String action, TouchOwner owner) {
        if (!isDebugBuild()) return;
        Log.d(LOG_TAG, "[PDF_TOUCH] action=" + action
                + " owner=" + owner
                + " revision=" + interactionState.revision);
    }

    private boolean isDebugBuild() {
        return (getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    @Override
    protected void handleOnDestroy() {
        View webView = bridge != null ? bridge.getWebView() : null;
        detachPdfView(webView, true);
        super.handleOnDestroy();
    }
}
