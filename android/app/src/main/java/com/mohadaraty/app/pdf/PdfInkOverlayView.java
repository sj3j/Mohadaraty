package com.mohadaraty.app.pdf;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PointF;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.view.MotionEvent;
import android.view.View;

import com.github.barteksc.pdfviewer.PDFView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public class PdfInkOverlayView extends View {

    public interface StrokeCommitListener {
        void onStrokeCommitted(int page, JSONObject strokeJson);
        void onStrokeErased(int page, String strokeId);
    }

    public static class NativePoint {
        public final float x;
        public final float y;
        public final float pressure;

        public NativePoint(float x, float y, float pressure) {
            this.x = x;
            this.y = y;
            this.pressure = pressure;
        }
    }

    public static class NativeStroke {
        public final String id;
        public final int page;
        public final String tool;
        public final int color;
        public final float width;
        public final float opacity;
        public final List<NativePoint> points;
        public final long createdAt;

        public NativeStroke(
                String id,
                int page,
                String tool,
                int color,
                float width,
                float opacity,
                List<NativePoint> points,
                long createdAt
        ) {
            this.id = id;
            this.page = page;
            this.tool = tool;
            this.color = color;
            this.width = width;
            this.opacity = opacity;
            this.points = points;
            this.createdAt = createdAt;
        }
    }

    private int currentPage = 1;
    private int activeStrokePage = -1;
    private String activeTool = "pencil";
    private int activeColor = Color.parseColor("#4f46e5");
    private float activeWidth = 4f;
    private boolean isInteractive = false;

    private final Paint pencilPaint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.DITHER_FLAG);
    private final Paint highlighterPaint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.DITHER_FLAG);
    private final Paint currentStrokePaint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.DITHER_FLAG);
    private final PdfPageGeometryAdapter geometry;
    private final PDFView pdfView;

    private final Path currentPath = new Path();
    private final List<NativePoint> currentStrokePoints = new ArrayList<>();
    // Keep page state isolated. A single global list made strokes from the
    // previously viewed page render on the next page until JavaScript happened
    // to send another setPageStrokes call.
    private final Map<Integer, List<NativeStroke>> persistedStrokesByPage = Collections.synchronizedMap(new HashMap<>());
    private StrokeCommitListener commitListener;

    public PdfInkOverlayView(Context context, PDFView pdfView) {
        super(context);
        this.pdfView = pdfView;
        this.geometry = new PdfPageGeometryAdapter(pdfView);
        initPaints();
    }

    private void initPaints() {
        pencilPaint.setStyle(Paint.Style.STROKE);
        pencilPaint.setStrokeCap(Paint.Cap.ROUND);
        pencilPaint.setStrokeJoin(Paint.Join.ROUND);

        highlighterPaint.setStyle(Paint.Style.STROKE);
        highlighterPaint.setStrokeCap(Paint.Cap.ROUND);
        highlighterPaint.setStrokeJoin(Paint.Join.ROUND);

        currentStrokePaint.setStyle(Paint.Style.STROKE);
        currentStrokePaint.setStrokeCap(Paint.Cap.ROUND);
        currentStrokePaint.setStrokeJoin(Paint.Join.ROUND);
    }

    public void setStrokeCommitListener(StrokeCommitListener listener) {
        this.commitListener = listener;
    }

    public void setCurrentPage(int page) {
        this.currentPage = page;
        cancelActiveStroke();
        pdfView.invalidate();
    }

    public void setActiveTool(String tool) {
        this.activeTool = tool;
        invalidate();
    }

    public void setActiveColor(int color) {
        this.activeColor = color;
        invalidate();
    }

    public void setActiveWidth(float width) {
        this.activeWidth = width;
        invalidate();
    }

    public void setInteractive(boolean interactive) {
        if (!interactive) cancelActiveStroke();
        this.isInteractive = interactive;
    }

    public void setPageStrokes(int page, List<NativeStroke> strokes) {
        synchronized (persistedStrokesByPage) {
            persistedStrokesByPage.put(page, strokes == null ? new ArrayList<>() : new ArrayList<>(strokes));
        }
        pdfView.invalidate();
    }

    public void cancelActiveStroke() {
        currentPath.reset();
        currentStrokePoints.clear();
        activeStrokePage = -1;
        invalidate();
    }

    @Override
    public boolean onTouchEvent(MotionEvent event) {
        int action = event.getActionMasked();
        if (!isInteractive) {
            return false;
        }

        if (getWidth() <= 0 || getHeight() <= 0) {
            return false;
        }

        float x = event.getX();
        float y = event.getY();
        float pressure = event.getPressure();
        int pageAtTouch = geometry.pageAt(x, y);

        if ("eraser".equals(activeTool)) {
            if (action == MotionEvent.ACTION_DOWN || action == MotionEvent.ACTION_MOVE) {
                if (pageAtTouch > 0) {
                    eraseStrokesNear(pageAtTouch, geometry.normalizedX(x, pageAtTouch), geometry.normalizedY(y, pageAtTouch), 0.035f);
                }
            }
            return true;
        }

        switch (action) {
            case MotionEvent.ACTION_DOWN: {
                if (pageAtTouch < 0) return false;
                currentStrokePoints.clear();
                currentPath.reset();
                currentPath.moveTo(x, y);
                activeStrokePage = pageAtTouch;

                currentStrokePoints.add(new NativePoint(geometry.normalizedX(x, activeStrokePage), geometry.normalizedY(y, activeStrokePage), pressure));
                invalidate();
                return true;
            }

            case MotionEvent.ACTION_MOVE: {
                // Include historical/coalesced samples if available
                int historySize = event.getHistorySize();
                for (int h = 0; h < historySize; h++) {
                    float hX = event.getHistoricalX(h);
                    float hY = event.getHistoricalY(h);
                    float hP = event.getHistoricalPressure(h);
                    currentPath.lineTo(hX, hY);
                    currentStrokePoints.add(new NativePoint(geometry.normalizedX(hX, activeStrokePage), geometry.normalizedY(hY, activeStrokePage), hP));
                }
                currentPath.lineTo(x, y);
                currentStrokePoints.add(new NativePoint(geometry.normalizedX(x, activeStrokePage), geometry.normalizedY(y, activeStrokePage), pressure));
                invalidate();
                return true;
            }

            case MotionEvent.ACTION_UP: {
                currentPath.lineTo(x, y);
                currentStrokePoints.add(new NativePoint(geometry.normalizedX(x, activeStrokePage), geometry.normalizedY(y, activeStrokePage), pressure));
                commitCurrentStroke();
                invalidate();
                return true;
            }

            case MotionEvent.ACTION_CANCEL: {
                cancelActiveStroke();
                return true;
            }
        }

        return super.onTouchEvent(event);
    }

    private void commitCurrentStroke() {
        if (currentStrokePoints.isEmpty()) {
            cancelActiveStroke();
            return;
        }

        float opacity = "free_highlighter".equals(activeTool) ? 0.38f : 1.0f;
        String strokeId = UUID.randomUUID().toString();
        NativeStroke stroke = new NativeStroke(
                strokeId,
                activeStrokePage,
                activeTool,
                activeColor,
                activeWidth,
                opacity,
                new ArrayList<>(currentStrokePoints),
                System.currentTimeMillis()
        );

        synchronized (persistedStrokesByPage) {
            persistedStrokesByPage.computeIfAbsent(activeStrokePage, ignored -> new ArrayList<>()).add(stroke);
        }

        if (commitListener != null) {
            try {
                JSONObject json = strokeToJson(stroke);
                commitListener.onStrokeCommitted(activeStrokePage, json);
            } catch (JSONException ignored) {}
        }

        currentPath.reset();
        currentStrokePoints.clear();
        activeStrokePage = -1;
        pdfView.invalidate();
    }

    private void eraseStrokesNear(int page, float normX, float normY, float threshold) {
        List<String> erasedIds = new ArrayList<>();
        synchronized (persistedStrokesByPage) {
            List<NativeStroke> pageStrokes = persistedStrokesByPage.get(page);
            if (pageStrokes == null) return;
            for (int i = pageStrokes.size() - 1; i >= 0; i--) {
                NativeStroke stroke = pageStrokes.get(i);
                if (intersects(stroke, normX, normY, threshold)) {
                    erasedIds.add(stroke.id);
                    pageStrokes.remove(i);
                }
            }
        }

        if (!erasedIds.isEmpty()) {
            pdfView.invalidate();
            if (commitListener != null) {
                for (String id : erasedIds) {
                    commitListener.onStrokeErased(page, id);
                }
            }
        }
    }

    private boolean intersects(NativeStroke stroke, float normX, float normY, float threshold) {
        if (stroke.points == null || stroke.points.isEmpty()) return false;
        for (int i = 0; i < stroke.points.size(); i++) {
            NativePoint p = stroke.points.get(i);
            if (i == 0) {
                if (Math.hypot(normX - p.x, normY - p.y) <= threshold) return true;
            } else {
                NativePoint prev = stroke.points.get(i - 1);
                if (pointToSegmentDistance(normX, normY, prev.x, prev.y, p.x, p.y) <= threshold) {
                    return true;
                }
            }
        }
        return false;
    }

    private float pointToSegmentDistance(float px, float py, float x1, float y1, float x2, float y2) {
        float dx = x2 - x1;
        float dy = y2 - y1;
        float lenSq = dx * dx + dy * dy;
        if (lenSq == 0) return (float) Math.hypot(px - x1, py - y1);
        float t = Math.max(0f, Math.min(1f, ((px - x1) * dx + (py - y1) * dy) / lenSq));
        return (float) Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        if (getWidth() <= 0 || getHeight() <= 0) return;

        // Persisted strokes are painted by PDFView's page callback. Keeping
        // them out of this full-screen overlay prevents viewport-anchored ink.
        // This view paints only the temporary stroke while it is being drawn.
        if (!currentStrokePoints.isEmpty() && !"eraser".equals(activeTool)) {
            boolean isHighlighter = "free_highlighter".equals(activeTool);
            currentStrokePaint.setColor(activeColor);
            currentStrokePaint.setStrokeWidth(activeWidth * getResources().getDisplayMetrics().density);
            if (isHighlighter) {
                currentStrokePaint.setAlpha((int) (255 * 0.38f));
            } else {
                currentStrokePaint.setAlpha(255);
            }
            canvas.drawPath(currentPath, currentStrokePaint);
        }
    }

    /** Called by PDFView.onDrawAll with PDFView's own page transform. */
    public void drawPageStrokes(Canvas canvas, float pageWidth, float pageHeight, int zeroBasedPage) {
        final List<NativeStroke> pageStrokes;
        synchronized (persistedStrokesByPage) {
            List<NativeStroke> stored = persistedStrokesByPage.get(zeroBasedPage + 1);
            pageStrokes = stored == null ? Collections.emptyList() : new ArrayList<>(stored);
        }
        if (pageStrokes.isEmpty()) return;

        PointF inset = geometry.pageLayerInset(zeroBasedPage);
        canvas.save();
        canvas.translate(inset.x, inset.y);
        for (NativeStroke stroke : pageStrokes) {
            renderStroke(canvas, stroke, pageWidth, pageHeight, zeroBasedPage);
        }
        canvas.restore();
    }

    private void renderStroke(Canvas canvas, NativeStroke stroke, float pageWidth, float pageHeight, int zeroBasedPage) {
        if (stroke.points == null || stroke.points.size() < 2) return;

        Paint paint = "free_highlighter".equals(stroke.tool) ? highlighterPaint : pencilPaint;
        paint.setColor(stroke.color);
        float rawWidth = Math.max(1f, pdfView.getPageSize(zeroBasedPage).getWidth());
        float zoom = pageWidth / rawWidth;
        paint.setStrokeWidth(stroke.width * getResources().getDisplayMetrics().density * zoom);
        paint.setAlpha((int) (255 * Math.max(0.1f, Math.min(1.0f, stroke.opacity))));

        Path path = new Path();
        NativePoint p0 = stroke.points.get(0);
        path.moveTo(p0.x * pageWidth, p0.y * pageHeight);

        for (int i = 1; i < stroke.points.size(); i++) {
            NativePoint p = stroke.points.get(i);
            path.lineTo(p.x * pageWidth, p.y * pageHeight);
        }

        canvas.drawPath(path, paint);
    }

    public static JSONObject strokeToJson(NativeStroke stroke) throws JSONException {
        JSONObject obj = new JSONObject();
        obj.put("id", stroke.id);
        obj.put("page", stroke.page);
        obj.put("tool", stroke.tool);
        obj.put("color", String.format("#%06X", (0xFFFFFF & stroke.color)));
        obj.put("width", stroke.width);
        obj.put("opacity", stroke.opacity);
        obj.put("createdAt", stroke.createdAt);

        JSONArray pts = new JSONArray();
        for (NativePoint pt : stroke.points) {
            JSONObject pObj = new JSONObject();
            pObj.put("x", pt.x);
            pObj.put("y", pt.y);
            pObj.put("p", pt.pressure);
            pts.put(pObj);
        }
        obj.put("points", pts);
        return obj;
    }

    public static NativeStroke jsonToStroke(JSONObject obj) {
        try {
            String id = obj.getString("id");
            int page = obj.getInt("page");
            String tool = obj.optString("tool", "pencil");
            String colorStr = obj.optString("color", "#4f46e5");
            int color = Color.parseColor(colorStr);
            float width = (float) obj.optDouble("width", 4.0);
            float opacity = (float) obj.optDouble("opacity", 1.0);
            long createdAt = obj.optLong("createdAt", System.currentTimeMillis());

            List<NativePoint> points = new ArrayList<>();
            JSONArray pts = obj.optJSONArray("points");
            if (pts != null) {
                for (int i = 0; i < pts.length(); i++) {
                    JSONObject pObj = pts.getJSONObject(i);
                    float x = (float) pObj.getDouble("x");
                    float y = (float) pObj.getDouble("y");
                    float p = (float) pObj.optDouble("p", 1.0);
                    points.add(new NativePoint(x, y, p));
                }
            }

            return new NativeStroke(id, page, tool, color, width, opacity, points, createdAt);
        } catch (Exception ignored) {
            return null;
        }
    }
}
