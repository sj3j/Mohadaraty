import UIKit
import Capacitor
import FirebaseCore
import CoreLocation
import WebKit

@objc(NativeFilesPlugin)
public class NativeFilesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeFilesPlugin"
    public let jsName = "NativeFiles"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getRuntimeInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "savePdf", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openPdf", returnType: CAPPluginReturnPromise)
    ]

    @objc func getRuntimeInfo(_ call: CAPPluginCall) {
        call.resolve(["platform": "ios", "sdkInt": 999])
    }

    @objc func savePdf(_ call: CAPPluginCall) {
        guard let sourceValue = call.getString("sourceUri"),
              let sourceURL = URL(string: sourceValue), sourceURL.isFileURL,
              let filename = call.getString("filename"), !filename.isEmpty,
              !filename.contains("/"), !filename.contains("\\") else {
            call.reject("Invalid PDF save parameters", "FILE_SAVE_INVALID")
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let canonicalSource = sourceURL.standardizedFileURL
                let appRoot = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true).standardizedFileURL.path + "/"
                guard canonicalSource.path.hasPrefix(appRoot) else {
                    throw NSError(domain: "NativeFiles", code: 1, userInfo: [NSLocalizedDescriptionKey: "Source is outside app storage"])
                }
                let attributes = try FileManager.default.attributesOfItem(atPath: canonicalSource.path)
                guard let size = attributes[.size] as? NSNumber, size.int64Value > 0 else {
                    throw NSError(domain: "NativeFiles", code: 2, userInfo: [NSLocalizedDescriptionKey: "Source PDF is missing or empty"])
                }
                let probe = try FileHandle(forReadingFrom: canonicalSource)
                let headerData = probe.readData(ofLength: 1024)
                try probe.close()
                guard headerData.range(of: Data("%PDF-".utf8)) != nil else {
                    throw NSError(domain: "NativeFiles", code: 3, userInfo: [NSLocalizedDescriptionKey: "Source is not a PDF"])
                }

                let documents = try FileManager.default.url(
                    for: .documentDirectory,
                    in: .userDomainMask,
                    appropriateFor: nil,
                    create: true
                )
                let destination = self.uniqueDestination(in: documents, filename: filename)
                try FileManager.default.copyItem(at: canonicalSource, to: destination)
                let savedAttributes = try FileManager.default.attributesOfItem(atPath: destination.path)
                let savedSize = (savedAttributes[.size] as? NSNumber)?.int64Value ?? 0
                guard savedSize > 0 else {
                    try? FileManager.default.removeItem(at: destination)
                    throw NSError(domain: "NativeFiles", code: 4, userInfo: [NSLocalizedDescriptionKey: "Saved PDF is empty"])
                }
                DispatchQueue.main.async {
                    let activityVC = UIActivityViewController(activityItems: [destination], applicationActivities: nil)
                    if let rootVC = self.bridge?.viewController {
                        if let popover = activityVC.popoverPresentationController {
                            popover.sourceView = rootVC.view
                            popover.sourceRect = CGRect(x: rootVC.view.bounds.midX, y: rootVC.view.bounds.midY, width: 0, height: 0)
                            popover.permittedArrowDirections = []
                        }
                        rootVC.present(activityVC, animated: true, completion: nil)
                    }
                }
                call.resolve([
                    "status": "saved",
                    "uri": destination.absoluteString,
                    "location": "On My iPhone/Mohadaraty",
                    "bytes": savedSize
                ])
            } catch {
                call.reject(error.localizedDescription, "FILE_SAVE_FAILED", error)
            }
        }
    }

    @objc func openPdf(_ call: CAPPluginCall) {
        guard let uriString = call.getString("uri"),
              let url = URL(string: uriString) else {
            call.reject("Invalid URI", "INVALID_URI")
            return
        }

        DispatchQueue.main.async {
            let activityVC = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            if let rootVC = self.bridge?.viewController {
                if let popover = activityVC.popoverPresentationController {
                    popover.sourceView = rootVC.view
                    popover.sourceRect = CGRect(x: rootVC.view.bounds.midX, y: rootVC.view.bounds.midY, width: 0, height: 0)
                    popover.permittedArrowDirections = []
                }
                rootVC.present(activityVC, animated: true) {
                    call.resolve(["opened": true])
                }
            } else {
                call.reject("ViewController unavailable", "ACTIVITY_UNAVAILABLE")
            }
        }
    }

    private func uniqueDestination(in folder: URL, filename: String) -> URL {
        let original = folder.appendingPathComponent(filename, isDirectory: false)
        if !FileManager.default.fileExists(atPath: original.path) { return original }
        let source = filename as NSString
        let stem = source.deletingPathExtension
        let ext = source.pathExtension
        for suffix in 1..<10_000 {
            let candidateName = ext.isEmpty ? "\(stem) (\(suffix))" : "\(stem) (\(suffix)).\(ext)"
            let candidate = folder.appendingPathComponent(candidateName, isDirectory: false)
            if !FileManager.default.fileExists(atPath: candidate.path) { return candidate }
        }
        return folder.appendingPathComponent("\(Date().timeIntervalSince1970)_\(filename)", isDirectory: false)
    }
}

@objc(SettingsLauncherPlugin)
public class SettingsLauncherPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SettingsLauncherPlugin"
    public let jsName = "SettingsLauncher"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isLocationServicesEnabled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openAppSettings", returnType: CAPPluginReturnPromise)
    ]

    @objc func isLocationServicesEnabled(_ call: CAPPluginCall) {
        call.resolve(["enabled": CLLocationManager.locationServicesEnabled()])
    }

    @objc func openAppSettings(_ call: CAPPluginCall) {
        guard let url = URL(string: UIApplication.openSettingsURLString) else {
            call.reject("settings_unavailable")
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { opened in
                if opened { call.resolve() }
                else { call.reject("settings_unavailable") }
            }
        }
    }
}

@objc(SystemBarsPlugin)
public class SystemBarsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SystemBarsPlugin"
    public let jsName = "SystemBars"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setStyle", returnType: CAPPluginReturnPromise)
    ]

    @objc func setStyle(_ call: CAPPluginCall) {
        let dark = call.getBool("darkBackground", false)
        DispatchQueue.main.async {
            if let window = UIApplication.shared.windows.first {
                window.overrideUserInterfaceStyle = dark ? .dark : .light
            }
            call.resolve(["darkBackground": dark])
        }
    }
}

public class MyLectureBridgeViewController: CAPBridgeViewController {
    public override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        MohadaratyWebView(frame: frame, configuration: configuration)
    }

    public override func capacitorDidLoad() {
        bridge?.registerPluginInstance(SystemBarsPlugin())
        bridge?.registerPluginInstance(SettingsLauncherPlugin())
        bridge?.registerPluginInstance(NativeFilesPlugin())
        bridge?.registerPluginInstance(AttendanceStoragePlugin())
        bridge?.registerPluginInstance(MohadaratyPdfPlugin())
    }
}

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        FirebaseApp.configure()
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

}
