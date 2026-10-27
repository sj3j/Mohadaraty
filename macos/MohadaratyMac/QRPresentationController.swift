import AppKit

final class QRPresentationController: NSObject, NSWindowDelegate {
    private unowned let runtime: MacRuntime
    private var window: NSWindow?

    init(runtime: MacRuntime) { self.runtime = runtime }

    func show(dataURL: String, title: String, subtitle: String) throws {
        guard let comma = dataURL.firstIndex(of: ","),
              let data = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...])),
              let image = NSImage(data: data) else { throw NativeBridgeFailure("invalid_qr_image") }

        let imageView = NSImageView(image: image)
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.setContentHuggingPriority(.defaultLow, for: .vertical)
        let titleLabel = NSTextField(labelWithString: title)
        titleLabel.font = .boldSystemFont(ofSize: 28)
        titleLabel.alignment = .center
        let subtitleLabel = NSTextField(labelWithString: subtitle)
        subtitleLabel.font = .systemFont(ofSize: 18)
        subtitleLabel.alignment = .center
        let stack = NSStackView(views: [titleLabel, imageView, subtitleLabel])
        stack.orientation = .vertical
        stack.spacing = 18
        stack.edgeInsets = NSEdgeInsets(top: 28, left: 28, bottom: 28, right: 28)

        let target = window ?? NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1000, height: 800),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        target.identifier = NSUserInterfaceItemIdentifier("mohadaraty-qr")
        target.title = title.isEmpty ? "Attendance QR" : title
        target.contentView = stack
        target.delegate = self
        target.minSize = NSSize(width: 640, height: 600)
        target.center()
        target.makeKeyAndOrderFront(nil)
        if !target.styleMask.contains(.fullScreen) { target.toggleFullScreen(nil) }
        window = target
    }

    func close() { window?.close() }

    func windowWillClose(_ notification: Notification) {
        window = nil
        runtime.webController.dispatchNativeEvent(name: "presentation", detail: ["event": "closed"])
    }
}

