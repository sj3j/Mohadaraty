import UIKit
import PDFKit
import Capacitor
import WebKit

fileprivate struct PdfInteractionState {
    let mode: String
    let tool: String
    let color: String
    let width: String
    let fingerDrawing: Bool
    let chromeVisible: Bool
    let webOverlayActive: Bool
    let revision: Int

    static let initial = PdfInteractionState(
        mode: "read",
        tool: "pencil",
        color: "#4f46e5",
        width: "medium",
        fingerDrawing: true,
        chromeVisible: true,
        webOverlayActive: false,
        revision: 0
    )

    var dictionary: [String: Any] {
        [
            "mode": mode,
            "tool": tool,
            "color": color,
            "width": width,
            "fingerDrawing": fingerDrawing,
            "chromeVisible": chromeVisible,
            "webOverlayActive": webOverlayActive,
            "revision": revision
        ]
    }
}

@objc(MohadaratyPdfPlugin)
public class MohadaratyPdfPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MohadaratyPdfPlugin"
    public let jsName = "MohadaratyPdf"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "openPdf", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "closePdf", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "goToPage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setNightMode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setInteraction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPageStrokes", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setInteractiveZones", returnType: CAPPluginReturnPromise)
    ]

    fileprivate static var isPdfActive = false
    fileprivate static var activeZones: [CGRect] = []
    fileprivate static var interactionState = PdfInteractionState.initial
    fileprivate static var stableInteractionRouting = true
    fileprivate static var nativeInkV2 = false
    fileprivate static weak var activeWebView: WKWebView?

    private var pdfView: PDFView?
    private var pageObserver: Any?
    private var overlayProvider: Any? // NativePdfPageOverlayProvider on iOS 15+
    private var originalWebViewOpaque = true
    private var originalWebViewBackground: UIColor?
    private var originalScrollBackground: UIColor?
    private var hasCapturedWebViewAppearance = false
    private static var hasSwizzledHitTest = false

    public override func load() {
        super.load()
        Self.setupTouchPassthrough()
    }

    private static func setupTouchPassthrough() {
        guard !hasSwizzledHitTest else { return }
        hasSwizzledHitTest = true

        let originalSelector = #selector(UIView.hitTest(_:with:))
        let swizzledSelector = #selector(WKWebView.mohadaraty_hitTest(_:with:))

        guard let originalMethod = class_getInstanceMethod(WKWebView.self, originalSelector),
              let swizzledMethod = class_getInstanceMethod(WKWebView.self, swizzledSelector) else { return }

        method_exchangeImplementations(originalMethod, swizzledMethod)
    }

    @objc func openPdf(_ call: CAPPluginCall) {
        guard let filePath = call.getString("filePath") else {
            call.reject("filePath is required")
            return
        }

        let initialPage = call.getInt("initialPage", 1)
        let nightMode = call.getBool("nightMode", false)
        let stableRouting = call.getBool("stableInteractionRouting", true)
        let nativeInkV2 = call.getBool("nativeInkV2", false)

        DispatchQueue.main.async { [weak self] in
            guard let self = self, let bridge = self.bridge, let webView = bridge.webView else {
                call.reject("Bridge unavailable")
                return
            }

            self.cleanup(restoreWebView: false)
            Self.interactionState = .initial
            Self.stableInteractionRouting = stableRouting
            Self.nativeInkV2 = nativeInkV2

            if !self.hasCapturedWebViewAppearance {
                self.originalWebViewOpaque = webView.isOpaque
                self.originalWebViewBackground = webView.backgroundColor
                self.originalScrollBackground = webView.scrollView.backgroundColor
                self.hasCapturedWebViewAppearance = true
            }
            webView.isOpaque = false
            webView.backgroundColor = .clear
            webView.scrollView.backgroundColor = .clear

            let pdfView = PDFView(frame: webView.bounds)
            pdfView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            pdfView.displayMode = .singlePageContinuous
            pdfView.displayDirection = .vertical
            pdfView.displaysPageBreaks = true
            pdfView.autoScales = true

            self.applyNightMode(nightMode, to: pdfView)

            // PencilKit page overlays are iOS 16+. iOS 15 intentionally keeps
            // the safe PDFKit read/navigation path rather than accepting ink
            // it cannot restore page-by-page.
            var nativeInkAvailable = false
            if nativeInkV2 {
                if #available(iOS 16.0, *) {
                    let provider = NativePdfPageOverlayProvider(pdfView: pdfView) { [weak self] (page, action, stroke, strokeId) in
                        guard let self = self else { return }
                        var ret: [String: Any] = [
                            "page": page,
                            "action": action
                        ]
                        if let s = stroke {
                            ret["stroke"] = s.dictionary
                            ret["opId"] = "op_add_\(s.id)"
                        }
                        if let sid = strokeId {
                            ret["strokeId"] = sid
                            ret["opId"] = "op_erase_\(sid)"
                        }
                        self.notifyListeners("onStrokesUpdated", data: ret)
                    }
                    pdfView.pageOverlayViewProvider = provider
                    self.overlayProvider = provider
                    nativeInkAvailable = true
                }
            }

            let path = filePath.hasPrefix("file://") ? String(filePath.dropFirst(7)) : filePath
            let url = URL(fileURLWithPath: path)
            guard let document = PDFDocument(url: url) else {
                self.restore(webView: webView)
                call.reject("Cannot load PDF at \(filePath)")
                return
            }

            pdfView.document = document
            if initialPage > 1, let page = document.page(at: initialPage - 1) {
                pdfView.go(to: page)
            }

            guard let superview = webView.superview else {
                self.restore(webView: webView)
                call.reject("WebView has no superview")
                return
            }
            superview.insertSubview(pdfView, belowSubview: webView)

            self.pdfView = pdfView
            Self.activeWebView = webView
            Self.isPdfActive = true

            self.pageObserver = NotificationCenter.default.addObserver(
                forName: .PDFViewPageChanged,
                object: pdfView,
                queue: .main
            ) { [weak self] _ in
                guard let self = self,
                      let pdfView = self.pdfView,
                      let document = pdfView.document,
                      let current = pdfView.currentPage else { return }
                self.notifyListeners("onPageChange", data: [
                    "page": document.index(for: current) + 1,
                    "pageCount": document.pageCount
                ])
            }

            call.resolve([
                "success": true,
                "nativeInkAvailable": nativeInkAvailable
            ])
        }
    }

    @objc func setInteraction(_ call: CAPPluginCall) {
        let mode = call.getString("mode", "read")
        let tool = call.getString("tool", "pencil")
        let color = call.getString("color", "#4f46e5")
        let width = call.getString("width", "medium")
        let revision = call.getInt("revision", -1)
        let requested = PdfInteractionState(
            mode: mode,
            tool: tool,
            color: color,
            width: width,
            fingerDrawing: call.getBool("fingerDrawing", true),
            chromeVisible: call.getBool("chromeVisible", true),
            webOverlayActive: call.getBool("webOverlayActive", false),
            revision: revision
        )

        guard mode == "read" || mode == "annotate" else {
            call.reject("mode must be read or annotate")
            return
        }
        guard revision >= 0 else {
            call.reject("revision must be a non-negative integer")
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard requested.revision > Self.interactionState.revision else {
                call.resolve([
                    "appliedRevision": Self.interactionState.revision,
                    "appliedState": Self.interactionState.dictionary,
                    "stale": true
                ])
                return
            }

            Self.interactionState = requested

            if #available(iOS 16.0, *) {
                if let provider = self?.overlayProvider as? NativePdfPageOverlayProvider {
                    provider.setInteraction(
                        mode: requested.mode,
                        tool: requested.tool,
                        color: requested.color,
                        width: requested.width,
                        fingerDrawing: requested.fingerDrawing
                    )
                }
            }

            #if DEBUG
            print("[PDF_INTERACTION] action=applied mode=\(requested.mode) tool=\(requested.tool) revision=\(requested.revision)")
            #endif
            call.resolve([
                "appliedRevision": requested.revision,
                "appliedState": requested.dictionary
            ])
        }
    }

    @objc func setPageStrokes(_ call: CAPPluginCall) {
        let page = call.getInt("page", 1)
        let rawStrokes = call.getArray("strokes", JSObject.self) ?? []
        let strokes = rawStrokes.compactMap {
            PdfBridgeStroke.from(dictionary: $0.mapValues { $0 as Any })
        }
        DispatchQueue.main.async { [weak self] in
            if #available(iOS 16.0, *) {
                (self?.overlayProvider as? NativePdfPageOverlayProvider)?.setPageStrokes(
                    pageIndex: page,
                    strokes: strokes
                )
            }
            call.resolve()
        }
    }

    @objc func setInteractiveZones(_ call: CAPPluginCall) {
        let zones = call.getArray("zones", JSObject.self) ?? []
        let mapped = zones.map { item -> CGRect in
            let left = item["left"] as? Double ?? 0
            let top = item["top"] as? Double ?? 0
            let right = item["right"] as? Double ?? 0
            let bottom = item["bottom"] as? Double ?? 0
            return CGRect(x: left, y: top, width: right - left, height: bottom - top)
        }
        DispatchQueue.main.async {
            Self.activeZones = mapped
            call.resolve()
        }
    }

    @objc func goToPage(_ call: CAPPluginCall) {
        let pageNumber = call.getInt("page", 1)
        DispatchQueue.main.async { [weak self] in
            guard let pdfView = self?.pdfView, let document = pdfView.document else {
                call.reject("PDF not open")
                return
            }
            if let page = document.page(at: max(0, min(pageNumber - 1, document.pageCount - 1))) {
                pdfView.go(to: page)
            }
            call.resolve()
        }
    }

    @objc func setNightMode(_ call: CAPPluginCall) {
        let nightMode = call.getBool("nightMode", false)
        DispatchQueue.main.async { [weak self] in
            if let self = self, let pdfView = self.pdfView {
                self.applyNightMode(nightMode, to: pdfView)
            }
            call.resolve()
        }
    }

    @objc func closePdf(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.cleanup(restoreWebView: true)
            Self.interactionState = .initial
            call.resolve()
        }
    }

    private func applyNightMode(_ nightMode: Bool, to pdfView: PDFView) {
        if nightMode {
            pdfView.backgroundColor = .black
            if let invertFilter = CIFilter(name: "CIColorInvert") {
                pdfView.layer.filters = [invertFilter]
            }
        } else {
            pdfView.backgroundColor = UIColor(white: 0.95, alpha: 1.0)
            pdfView.layer.filters = []
        }
    }

    private func restore(webView: WKWebView) {
        webView.isOpaque = originalWebViewOpaque
        webView.backgroundColor = originalWebViewBackground
        webView.scrollView.backgroundColor = originalScrollBackground
        hasCapturedWebViewAppearance = false
    }

    private func cleanup(restoreWebView: Bool) {
        Self.isPdfActive = false
        if #available(iOS 16.0, *) {
            if let provider = overlayProvider as? NativePdfPageOverlayProvider {
                provider.cleanUp()
            }
        }
        overlayProvider = nil

        if let observer = pageObserver {
            NotificationCenter.default.removeObserver(observer)
            pageObserver = nil
        }
        pdfView?.layer.filters = []
        pdfView?.removeFromSuperview()
        pdfView = nil

        if let webView = Self.activeWebView, restoreWebView {
            restore(webView: webView)
        }
        Self.activeWebView = nil
    }
}

extension WKWebView {
    @objc func mohadaraty_hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard MohadaratyPdfPlugin.isPdfActive,
              MohadaratyPdfPlugin.activeWebView === self else {
            return self.mohadaraty_hitTest(point, with: event)
        }

        let ownsTouch: Bool
        if MohadaratyPdfPlugin.stableInteractionRouting {
            let state = MohadaratyPdfPlugin.interactionState
            let topChrome = point.y <= 120
            // The annotation dock is centered and can expose palette/width
            // popovers across the full lower area. The old 240pt-left-only
            // region swallowed its centre/right controls as PDF gestures.
            let bottomChrome = state.mode == "annotate"
                ? point.y >= bounds.height - 240
                : (point.y >= bounds.height - 100 && point.x <= 240)
            let chromeHit = state.chromeVisible && (topChrome || bottomChrome)

            if state.webOverlayActive {
                ownsTouch = true
            } else if MohadaratyPdfPlugin.nativeInkV2 {
                // In Phase 2 nativeInkV2 mode, PencilKit / PDFKit directly own drawing and reading touches.
                // WKWebView only intercepts top/bottom app chrome or open modals.
                ownsTouch = chromeHit
            } else {
                ownsTouch = state.mode == "annotate" || chromeHit
            }
        } else {
            ownsTouch = MohadaratyPdfPlugin.activeZones.contains { $0.contains(point) }
        }

        #if DEBUG
        print("[PDF_TOUCH] action=HIT_TEST owner=\(ownsTouch ? "WEB" : "PDF") revision=\(MohadaratyPdfPlugin.interactionState.revision)")
        #endif
        return ownsTouch ? self.mohadaraty_hitTest(point, with: event) : nil
    }
}
