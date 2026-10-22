import UIKit
import PDFKit
import Capacitor
import WebKit

@objc(MohadaratyPdfPlugin)
public class MohadaratyPdfPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MohadaratyPdfPlugin"
    public let jsName = "MohadaratyPdf"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "openPdf", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "closePdf", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "goToPage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setNightMode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setInteractiveZones", returnType: CAPPluginReturnPromise)
    ]

    public static var isPdfActive: Bool = false
    public static var activeZones: [CGRect] = []

    private var pdfView: PDFView?
    private var pageObserver: Any?
    private static var hasSwizzledHitTest: Bool = false

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

        DispatchQueue.main.async { [weak self] in
            guard let self = self, let bridge = self.bridge, let webView = bridge.webView else {
                call.reject("Bridge unavailable")
                return
            }

            self.cleanup()

            webView.isOpaque = false
            webView.backgroundColor = .clear
            webView.scrollView.backgroundColor = .clear

            let pdfView = PDFView(frame: webView.bounds)
            pdfView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            pdfView.displayMode = .singlePageContinuous
            pdfView.displayDirection = .vertical
            pdfView.displaysPageBreaks = true
            pdfView.autoScales = true

            if nightMode {
                pdfView.backgroundColor = .black
                if let invertFilter = CIFilter(name: "CIColorInvert") {
                    pdfView.layer.filters = [invertFilter]
                }
            } else {
                pdfView.backgroundColor = UIColor(white: 0.95, alpha: 1.0)
                pdfView.layer.filters = []
            }

            guard let url = URL(string: filePath.hasPrefix("file://") ? filePath : "file://" + filePath),
                  let doc = PDFDocument(url: url) else {
                call.reject("Cannot load PDF at \(filePath)")
                return
            }

            pdfView.document = doc

            if initialPage > 1, let page = doc.page(at: initialPage - 1) {
                pdfView.go(to: page)
            }

            if let superview = webView.superview {
                superview.insertSubview(pdfView, belowSubview: webView)
            }

            self.pdfView = pdfView
            Self.isPdfActive = true

            self.pageObserver = NotificationCenter.default.addObserver(
                forName: .PDFViewPageChanged,
                object: pdfView,
                queue: .main
            ) { [weak self] _ in
                guard let self = self, let pdfView = self.pdfView, let doc = pdfView.document, let current = pdfView.currentPage else { return }
                let pageIndex = doc.index(for: current) + 1
                self.notifyListeners("onPageChange", data: [
                    "page": pageIndex,
                    "pageCount": doc.pageCount
                ])
            }

            call.resolve(["success": true])
        }
    }

    @objc func setInteractiveZones(_ call: CAPPluginCall) {
        let zones = call.getArray("zones", [JSObject]()) ?? []
        var newZones: [CGRect] = []
        for item in zones {
            let left = item["left"] as? Double ?? 0
            let top = item["top"] as? Double ?? 0
            let right = item["right"] as? Double ?? 0
            let bottom = item["bottom"] as? Double ?? 0
            newZones.append(CGRect(x: left, y: top, width: right - left, height: bottom - top))
        }
        Self.activeZones = newZones
        call.resolve()
    }

    @objc func goToPage(_ call: CAPPluginCall) {
        let pageNum = call.getInt("page", 1)
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let pdfView = self.pdfView, let doc = pdfView.document else {
                call.reject("PDF not open")
                return
            }
            if let page = doc.page(at: max(0, min(pageNum - 1, doc.pageCount - 1))) {
                pdfView.go(to: page)
            }
            call.resolve()
        }
    }

    @objc func setNightMode(_ call: CAPPluginCall) {
        let night = call.getBool("nightMode", false)
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let pdfView = self.pdfView else {
                call.resolve()
                return
            }
            if night {
                pdfView.backgroundColor = .black
                if let invertFilter = CIFilter(name: "CIColorInvert") {
                    pdfView.layer.filters = [invertFilter]
                }
            } else {
                pdfView.backgroundColor = UIColor(white: 0.95, alpha: 1.0)
                pdfView.layer.filters = []
            }
            call.resolve()
        }
    }

    @objc func closePdf(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.cleanup()
            self?.bridge?.webView?.isOpaque = true
            self?.bridge?.webView?.backgroundColor = .white
            call.resolve()
        }
    }

    private func cleanup() {
        Self.isPdfActive = false
        Self.activeZones.removeAll()

        if let observer = pageObserver {
            NotificationCenter.default.removeObserver(observer)
            pageObserver = nil
        }
        pdfView?.layer.filters = []
        pdfView?.removeFromSuperview()
        pdfView = nil
    }
}

extension WKWebView {
    @objc func mohadaraty_hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        if MohadaratyPdfPlugin.isPdfActive {
            let insideZone = MohadaratyPdfPlugin.activeZones.contains { $0.contains(point) }
            if !insideZone {
                // Pass touch through to the underlying native PDFView
                return nil
            }
        }
        return self.mohadaraty_hitTest(point, with: event)
    }
}
