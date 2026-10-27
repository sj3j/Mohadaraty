package com.mohadaraty.app.pdf;

import android.graphics.PointF;
import android.graphics.RectF;

import com.github.barteksc.pdfviewer.PDFView;
import com.shockwave.pdfium.util.SizeF;

/**
 * Converts between the full-screen ink overlay and the displayed PDF page.
 * PDFView's child canvas occupies the whole reader; normalising against that
 * canvas displaces notes whenever a page is centred, zoomed, or scrolled.
 */
final class PdfPageGeometryAdapter {
    private final PDFView pdfView;

    PdfPageGeometryAdapter(PDFView pdfView) {
        this.pdfView = pdfView;
    }

    RectF pageBounds(int pageNumber) {
        int target = Math.max(0, pageNumber - 1);
        float zoom = pdfView.getZoom();
        float offset = pdfView.isSwipeVertical()
                ? pdfView.getCurrentYOffset()
                : pdfView.getCurrentXOffset();
        float cursor = offset;
        float spacing = pdfView.getSpacingPx();

        for (int page = 0; page < target; page++) {
            SizeF size = pdfView.getPageSize(page);
            // PDFView stores page offsets in unscaled units, then scales both
            // page size and configured spacing by zoom.
            cursor += ((pdfView.isSwipeVertical() ? size.getHeight() : size.getWidth()) + spacing) * zoom;
        }

        SizeF size = pdfView.getPageSize(target);
        float width = size.getWidth() * zoom;
        float height = size.getHeight() * zoom;
        if (pdfView.isSwipeVertical()) {
            float left = pdfView.getCurrentXOffset()
                    + (maxPageWidth() - size.getWidth()) * zoom / 2f;
            return new RectF(left, cursor, left + width, cursor + height);
        }
        float top = pdfView.getCurrentYOffset()
                + (maxPageHeight() - size.getHeight()) * zoom / 2f;
        return new RectF(cursor, top, cursor + width, top + height);
    }

    int pageAt(float x, float y) {
        for (int index = 0; index < pdfView.getPageCount(); index++) {
            if (pageBounds(index + 1).contains(x, y)) return index + 1;
        }
        return -1;
    }

    /** PDFView's onDrawAll callback has page-offset translation but not centring. */
    PointF pageLayerInset(int zeroBasedPage) {
        SizeF size = pdfView.getPageSize(zeroBasedPage);
        float zoom = pdfView.getZoom();
        if (pdfView.isSwipeVertical()) {
            return new PointF((maxPageWidth() - size.getWidth()) * zoom / 2f, 0f);
        }
        return new PointF(0f, (maxPageHeight() - size.getHeight()) * zoom / 2f);
    }

    private float maxPageWidth() {
        float max = 0f;
        for (int index = 0; index < pdfView.getPageCount(); index++) {
            max = Math.max(max, pdfView.getPageSize(index).getWidth());
        }
        return max;
    }

    private float maxPageHeight() {
        float max = 0f;
        for (int index = 0; index < pdfView.getPageCount(); index++) {
            max = Math.max(max, pdfView.getPageSize(index).getHeight());
        }
        return max;
    }

    float normalizedX(float x, int pageNumber) {
        RectF bounds = pageBounds(pageNumber);
        return clamp((x - bounds.left) / Math.max(1f, bounds.width()));
    }

    float normalizedY(float y, int pageNumber) {
        RectF bounds = pageBounds(pageNumber);
        return clamp((y - bounds.top) / Math.max(1f, bounds.height()));
    }

    float viewX(float normalizedX, int pageNumber) {
        RectF bounds = pageBounds(pageNumber);
        return bounds.left + clamp(normalizedX) * bounds.width();
    }

    float viewY(float normalizedY, int pageNumber) {
        RectF bounds = pageBounds(pageNumber);
        return bounds.top + clamp(normalizedY) * bounds.height();
    }

    private float clamp(float value) {
        return Math.max(0f, Math.min(1f, value));
    }
}
