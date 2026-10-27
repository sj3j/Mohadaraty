import UIKit
import PDFKit
import PencilKit

@available(iOS 16.0, *)
public class NativePdfPageOverlayProvider: NSObject, PDFPageOverlayViewProvider, PKCanvasViewDelegate {

    public typealias StrokeCallback = (_ page: Int, _ action: String, _ stroke: PdfBridgeStroke?, _ strokeId: String?) -> Void

    private weak var pdfView: PDFView?
    private var pageCanvases: [PDFPage: PKCanvasView] = [:]
    private var strokesByPage: [Int: [String: PdfBridgeStroke]] = [:]
    // PencilKit has no app-level stroke identity. Keep a stable fingerprint map
    // so hydration and redraw never resend historical strokes to JavaScript.
    private var strokeIdsBySignature: [Int: [String: String]] = [:]
    private var pagesBeingHydrated = Set<Int>()
    private var onStrokeUpdate: StrokeCallback?

    private var activeToolName = "pencil"
    private var activeColorHex = "#4f46e5"
    private var activeStrokeWidth: CGFloat = 4
    private var fingerDrawingEnabled = true
    private var isAnnotationMode = false

    public init(pdfView: PDFView, onStrokeUpdate: @escaping StrokeCallback) {
        self.pdfView = pdfView
        self.onStrokeUpdate = onStrokeUpdate
        super.init()
    }

    public func setInteraction(mode: String, tool: String, color: String, width: String, fingerDrawing: Bool) {
        isAnnotationMode = mode == "annotate"
        activeToolName = tool
        activeColorHex = color
        fingerDrawingEnabled = fingerDrawing
        activeStrokeWidth = tool == "free_highlighter"
            ? (width == "thick" ? 32 : (width == "thin" ? 14 : 22))
            : (width == "thick" ? 7 : (width == "thin" ? 2 : 4))
        for (_, canvas) in pageCanvases { configureCanvas(canvas) }
    }

    public func setPageStrokes(pageIndex: Int, strokes: [PdfBridgeStroke]) {
        strokesByPage[pageIndex] = Dictionary(uniqueKeysWithValues: strokes.map { ($0.id, $0) })
        if let page = pageCanvases.keys.first(where: { currentPageIndex($0) == pageIndex }),
           let canvas = pageCanvases[page] {
            hydrate(canvas: canvas, page: page, pageIndex: pageIndex)
        }
    }

    private func configureCanvas(_ canvas: PKCanvasView) {
        let supportsInk = activeToolName == "pencil" || activeToolName == "free_highlighter" || activeToolName == "eraser"
        canvas.isUserInteractionEnabled = isAnnotationMode && supportsInk
        canvas.drawingPolicy = fingerDrawingEnabled ? .anyInput : .pencilOnly
        let color = PdfGeometryAdapter.colorFromHex(activeColorHex)
        if activeToolName == "eraser" {
            canvas.tool = PKEraserTool(.vector)
        } else if activeToolName == "free_highlighter" {
            canvas.tool = PKInkingTool(.marker, color: color.withAlphaComponent(0.38), width: activeStrokeWidth)
        } else {
            canvas.tool = PKInkingTool(.pen, color: color, width: activeStrokeWidth)
        }
    }

    public func pdfView(_ pdfView: PDFView, overlayViewFor page: PDFPage) -> UIView? {
        if let existing = pageCanvases[page] { return existing }
        let canvas = PKCanvasView(frame: .zero)
        canvas.backgroundColor = .clear
        canvas.isOpaque = false
        canvas.delegate = self
        configureCanvas(canvas)
        pageCanvases[page] = canvas
        hydrate(canvas: canvas, page: page, pageIndex: currentPageIndex(page))
        return canvas
    }

    public func pdfView(_ pdfView: PDFView, willDisplayOverlayView overlayView: UIView, for page: PDFPage) {
        guard let canvas = overlayView as? PKCanvasView else { return }
        configureCanvas(canvas)
        hydrate(canvas: canvas, page: page, pageIndex: currentPageIndex(page))
    }

    public func pdfView(_ pdfView: PDFView, willEndDisplayingOverlayView overlayView: UIView, for page: PDFPage) {
        (overlayView as? PKCanvasView)?.delegate = nil
        pageCanvases.removeValue(forKey: page)
    }

    public func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
        guard let pdfView,
              let (page, _) = pageCanvases.first(where: { $0.value === canvasView }) else { return }
        let pageIndex = currentPageIndex(page)
        guard !pagesBeingHydrated.contains(pageIndex) else { return }

        var removedCandidates = strokeIdsBySignature[pageIndex] ?? [:]
        var current: [String: String] = [:]
        var additions: [PdfBridgeStroke] = []

        for pkStroke in canvasView.drawing.strokes {
            var bridge = PdfGeometryAdapter.strokeFromPencilKit(
                pkStroke: pkStroke,
                pageIndex: pageIndex,
                tool: activeToolName,
                colorHex: activeColorHex,
                strokeWidth: activeStrokeWidth,
                canvas: canvasView,
                pdfView: pdfView,
                page: page
            )
            let signature = signatureFor(bridge)
            if let id = removedCandidates.removeValue(forKey: signature) {
                bridge = PdfBridgeStroke(id: id, page: bridge.page, tool: bridge.tool, color: bridge.color, width: bridge.width, opacity: bridge.opacity, points: bridge.points, createdAt: bridge.createdAt)
            } else {
                additions.append(bridge)
            }
            current[signature] = bridge.id
        }

        for id in removedCandidates.values {
            strokesByPage[pageIndex]?[id] = nil
            onStrokeUpdate?(pageIndex, "erase", nil, id)
        }
        for stroke in additions {
            strokesByPage[pageIndex, default: [:]][stroke.id] = stroke
            onStrokeUpdate?(pageIndex, "add", stroke, nil)
        }
        strokeIdsBySignature[pageIndex] = current
    }

    private func hydrate(canvas: PKCanvasView, page: PDFPage, pageIndex: Int) {
        guard let pdfView else { return }
        pagesBeingHydrated.insert(pageIndex)
        defer { pagesBeingHydrated.remove(pageIndex) }
        let ordered = (strokesByPage[pageIndex] ?? [:]).values.sorted { $0.createdAt < $1.createdAt }
        canvas.drawing = PKDrawing(strokes: ordered.compactMap {
            PdfGeometryAdapter.pencilKitStroke(from: $0, canvas: canvas, pdfView: pdfView, page: page)
        })
        strokeIdsBySignature[pageIndex] = Dictionary(uniqueKeysWithValues: ordered.map { (signatureFor($0), $0.id) })
    }

    private func currentPageIndex(_ page: PDFPage) -> Int {
        guard let document = pdfView?.document else { return 1 }
        return document.index(for: page) + 1
    }

    private func signatureFor(_ stroke: PdfBridgeStroke) -> String {
        let points = stroke.points.map {
            "\(Int(($0.x * 100000).rounded())):\(Int(($0.y * 100000).rounded())):\(Int((($0.p ?? 1) * 1000).rounded()))"
        }.joined(separator: ";")
        // Geometry is immutable for a PKStroke. Using the current selected
        // tool/color here would re-identify every historical stroke when the
        // user changes tools, because PKCanvasView reports the whole drawing.
        return points
    }

    public func cleanUp() {
        for (_, canvas) in pageCanvases { canvas.delegate = nil }
        pageCanvases.removeAll()
        strokesByPage.removeAll()
        strokeIdsBySignature.removeAll()
        pagesBeingHydrated.removeAll()
        pdfView = nil
        onStrokeUpdate = nil
    }
}
