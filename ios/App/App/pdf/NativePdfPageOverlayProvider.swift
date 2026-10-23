import UIKit
import PDFKit
import PencilKit

@available(iOS 16.0, *)
public class NativePdfPageOverlayProvider: NSObject, PDFPageOverlayViewProvider, PKCanvasViewDelegate {

    public typealias StrokeCallback = (_ page: Int, _ action: String, _ stroke: PdfBridgeStroke?, _ strokeId: String?) -> Void

    private weak var pdfView: PDFView?
    private var pageCanvases: [PDFPage: PKCanvasView] = [:]
    private var onStrokeUpdate: StrokeCallback?

    private var activeToolName: String = "pencil"
    private var activeColorHex: String = "#4f46e5"
    private var activeStrokeWidth: CGFloat = 4.0
    private var fingerDrawingEnabled: Bool = true
    private var isAnnotationMode: Bool = false

    public init(pdfView: PDFView, onStrokeUpdate: @escaping StrokeCallback) {
        self.pdfView = pdfView
        self.onStrokeUpdate = onStrokeUpdate
        super.init()
    }

    public func setInteraction(
        mode: String,
        tool: String,
        color: String,
        width: String,
        fingerDrawing: Bool
    ) {
        self.isAnnotationMode = (mode == "annotate")
        self.activeToolName = tool
        self.activeColorHex = color
        self.fingerDrawingEnabled = fingerDrawing

        var baseWidth: CGFloat = 4.0
        if tool == "free_highlighter" {
            baseWidth = (width == "thick") ? 32.0 : ((width == "thin") ? 14.0 : 22.0)
        } else {
            baseWidth = (width == "thick") ? 7.0 : ((width == "thin") ? 2.0 : 4.0)
        }
        self.activeStrokeWidth = baseWidth

        // Update all currently attached PKCanvasViews
        for (_, canvas) in pageCanvases {
            configureCanvas(canvas)
        }
    }

    private func configureCanvas(_ canvas: PKCanvasView) {
        canvas.isUserInteractionEnabled = isAnnotationMode && (activeToolName != "hand")
        canvas.drawingPolicy = fingerDrawingEnabled ? .anyInput : .pencilOnly

        let uiColor = PdfGeometryAdapter.colorFromHex(activeColorHex)

        if activeToolName == "eraser" {
            canvas.tool = PKEraserTool(.vector)
        } else if activeToolName == "free_highlighter" {
            canvas.tool = PKInkingTool(.marker, color: uiColor.withAlphaComponent(0.38), width: activeStrokeWidth)
        } else {
            canvas.tool = PKInkingTool(.pen, color: uiColor, width: activeStrokeWidth)
        }
    }

    // MARK: - PDFPageOverlayViewProvider

    public func pdfView(_ pdfView: PDFView, overlayViewFor page: PDFPage) -> UIView? {
        if let existing = pageCanvases[page] {
            return existing
        }

        let canvas = PKCanvasView(frame: .zero)
        canvas.backgroundColor = .clear
        canvas.isOpaque = false
        canvas.delegate = self
        configureCanvas(canvas)

        pageCanvases[page] = canvas
        return canvas
    }

    public func pdfView(_ pdfView: PDFView, willDisplayOverlayView overlayView: UIView, for page: PDFPage) {
        if let canvas = overlayView as? PKCanvasView {
            configureCanvas(canvas)
        }
    }

    public func pdfView(_ pdfView: PDFView, willEndDisplayingOverlayView overlayView: UIView, for page: PDFPage) {
        // Safe disposal / cleanup of off-screen page overlay
        if let canvas = overlayView as? PKCanvasView {
            canvas.delegate = nil
        }
        pageCanvases.removeValue(forKey: page)
    }

    // MARK: - PKCanvasViewDelegate

    public func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
        guard let pdfView = self.pdfView,
              let document = pdfView.document else { return }

        // Find the page associated with this canvas
        guard let (page, _) = pageCanvases.first(where: { $0.value === canvasView }) else {
            return
        }

        let pageIndex = document.index(for: page) + 1
        let cropBox = page.bounds(for: .cropBox)

        if let lastStroke = canvasView.drawing.strokes.last {
            let bridgeStroke = PdfGeometryAdapter.strokeFromPencilKit(
                pkStroke: lastStroke,
                pageIndex: pageIndex,
                tool: activeToolName,
                colorHex: activeColorHex,
                strokeWidth: activeStrokeWidth,
                pageBounds: cropBox
            )
            onStrokeUpdate?(pageIndex, "add", bridgeStroke, nil)
        }
    }

    public func cleanUp() {
        for (_, canvas) in pageCanvases {
            canvas.delegate = nil
        }
        pageCanvases.removeAll()
        pdfView = nil
        onStrokeUpdate = nil
    }
}
