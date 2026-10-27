import SwiftUI
import AppKit

@main
struct MohadaratyMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            WebViewContainer(controller: MacRuntime.shared.webController)
                .frame(minWidth: 1024, minHeight: 700)
                .onAppear { MacRuntime.shared.configureMainWindow() }
        }
        .defaultSize(width: 1280, height: 800)
        .commands {
            CommandGroup(replacing: .newItem) { }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(didWake),
            name: NSWorkspace.didWakeNotification,
            object: nil
        )
        MacRuntime.shared.fileService.cleanupStaleShares()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            sender.windows.first(where: { $0.identifier?.rawValue != "mohadaraty-qr" })?.makeKeyAndOrderFront(nil)
        }
        return true
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        MacRuntime.shared.sendLifecycle("didBecomeActive")
    }

    func applicationWillResignActive(_ notification: Notification) {
        MacRuntime.shared.sendLifecycle("willResignActive")
    }

    func applicationWillTerminate(_ notification: Notification) {
        MacRuntime.shared.sendLifecycle("willTerminate")
    }

    @objc private func didWake() {
        MacRuntime.shared.sendLifecycle("didWake")
    }
}

final class MacRuntime {
    static let shared = MacRuntime()

    let attendanceStore = AttendanceStore()
    let fileService = MacFileService()
    lazy var presentationController = QRPresentationController(runtime: self)
    lazy var bridge = MacBridge(runtime: self)
    lazy var webController = WebViewController(runtime: self)

    private init() { }

    func configureMainWindow() {
        DispatchQueue.main.async {
            guard let window = NSApp.windows.first(where: { $0.identifier?.rawValue != "mohadaraty-qr" }) else { return }
            window.minSize = NSSize(width: 1024, height: 700)
            window.setContentSize(NSSize(width: max(window.frame.width, 1280), height: max(window.frame.height, 800)))
            window.center()
        }
    }

    func sendLifecycle(_ event: String) {
        webController.dispatchNativeEvent(name: "lifecycle", detail: ["event": event])
    }
}

