package com.mohadaraty.app.pdf;

import android.graphics.Color;
import android.graphics.RectF;
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
import com.github.barteksc.pdfviewer.listener.OnPageChangeListener;
import com.github.barteksc.pdfviewer.listener.OnTapListener;
import com.github.barteksc.pdfviewer.scroll.DefaultScrollHandle;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

@CapacitorPlugin(name = "MohadaratyPdf")
public class PdfViewerPlugin extends Plugin {

    private PDFView pdfView;
    private final List<RectF> interactiveZones = Collections.synchronizedList(new ArrayList<>());
    private View.OnTouchListener touchForwarder;
    private int originalWebViewBg = Color.WHITE;

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

        getActivity().runOnUiThread(() -> {
            try {
                View webView = bridge.getWebView();
                ViewGroup parent = (ViewGroup) webView.getParent();

                if (pdfView != null) {
                    parent.removeView(pdfView);
                    pdfView.recycle();
                    pdfView = null;
                }

                // Make webView background transparent so PDFView renders underneath
                webView.setBackgroundColor(Color.TRANSPARENT);

                pdfView = new PDFView(getContext(), null);
                FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                );

                // Add PDFView behind the webView
                int webViewIndex = parent.indexOfChild(webView);
                parent.addView(pdfView, Math.max(0, webViewIndex), params);

                String cleanPath = filePath.startsWith("file://") ? filePath.substring(7) : filePath;
                File file = new File(cleanPath);
                if (!file.exists()) {
                    call.reject("File does not exist: " + filePath);
                    return;
                }

                pdfView.fromFile(file)
                        .defaultPage(Math.max(0, initialPage - 1))
                        .enableSwipe(true)
                        .swipeHorizontal(swipeHorizontal)
                        .enableDoubletap(true)
                        .enableAnnotationRendering(true)
                        .nightMode(nightMode)
                        .spacing(12) // Consistent gap between pages matching Notewise
                        .onPageChange(new OnPageChangeListener() {
                            @Override
                            public void onPageChanged(int page, int pageCount) {
                                JSObject ret = new JSObject();
                                ret.put("page", page + 1);
                                ret.put("pageCount", pageCount);
                                notifyListeners("onPageChange", ret);
                            }
                        })
                        .onTap(new OnTapListener() {
                            @Override
                            public boolean onTap(MotionEvent e) {
                                JSObject ret = new JSObject();
                                ret.put("x", e.getX());
                                ret.put("y", e.getY());
                                notifyListeners("onDocumentTap", ret);
                                return false;
                            }
                        })
                        .onLongPress(new OnLongPressListener() {
                            @Override
                            public void onLongPress(MotionEvent e) {
                                JSObject ret = new JSObject();
                                ret.put("x", e.getX());
                                ret.put("y", e.getY());
                                notifyListeners("onDocumentLongPress", ret);
                            }
                        })
                        .load();

                // Install touch forwarder on webView
                touchForwarder = (v, event) -> {
                    if (pdfView == null) return false;

                    float x = event.getX();
                    float y = event.getY();

                    // Check if touched point falls inside any interactive React zone (pills, sheets, drawers)
                    boolean insideZone = false;
                    synchronized (interactiveZones) {
                        for (RectF rect : interactiveZones) {
                            if (rect.contains(x, y)) {
                                insideZone = true;
                                break;
                            }
                        }
                    }

                    if (insideZone) {
                        // Let WebView handle it (click button, scroll drawer)
                        return false;
                    } else {
                        // Forward directly to native PDFView for 120fps hardware-accelerated gestures
                        pdfView.dispatchTouchEvent(event);
                        return true;
                    }
                };

                webView.setOnTouchListener(touchForwarder);

                JSObject res = new JSObject();
                res.put("success", true);
                call.resolve(res);

            } catch (Exception e) {
                call.reject("Failed to open PDF: " + e.getMessage(), e);
            }
        });
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
            } catch (JSONException ignored) {
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
            if (pdfView != null) {
                pdfView.jumpTo(Math.max(0, page - 1), true);
            }
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
            View webView = bridge.getWebView();
            if (webView != null) {
                webView.setOnTouchListener(null);
                webView.setBackgroundColor(originalWebViewBg);
            }

            if (pdfView != null) {
                ViewGroup parent = (ViewGroup) pdfView.getParent();
                if (parent != null) {
                    parent.removeView(pdfView);
                }
                pdfView.recycle();
                pdfView = null;
            }

            interactiveZones.clear();
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (pdfView != null) {
            pdfView.recycle();
            pdfView = null;
        }
        super.handleOnDestroy();
    }
}
