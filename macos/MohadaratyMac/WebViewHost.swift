import SwiftUI
import WebKit
import AppKit
import UniformTypeIdentifiers

struct WebViewContainer: NSViewRepresentable {
    let controller: WebViewController

    func makeNSView(context: Context) -> WKWebView { controller.webView }
    func updateNSView(_ nsView: WKWebView, context: Context) { }
}

final class WebViewController: NSObject, WKNavigationDelegate, WKUIDelegate {
    let webView: WKWebView
    private let runtime: MacRuntime
    private let schemeHandler = BundleSchemeHandler()
    private let smokeOutput: String?
    private let offlineSmoke: Bool

    init(runtime: MacRuntime) {
        self.runtime = runtime
        let arguments = ProcessInfo.processInfo.arguments
        if let index = arguments.firstIndex(of: "--ci-smoke-output"), arguments.indices.contains(index + 1) {
            smokeOutput = arguments[index + 1]
        } else {
            smokeOutput = nil
        }
        offlineSmoke = arguments.contains("--ci-offline")

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.setURLSchemeHandler(schemeHandler, forURLScheme: "capacitor")
        configuration.userContentController.addScriptMessageHandler(runtime.bridge, contentWorld: .page, name: "mohadaraty")

        let descriptor = """
        window.__MOHADARATY_MAC__ = Object.freeze({
          platform: 'macos', bridgeVersion: 1,
          appVersion: '\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0")',
          capabilities: Object.freeze(['attendance','files','presentation','environment'])
        });
        """
        configuration.userContentController.addUserScript(WKUserScript(source: descriptor, injectionTime: .atDocumentStart, forMainFrameOnly: true))

        if offlineSmoke {
            let offline = """
            window.__MOHADARATY_CI_OFFLINE__ = true;
            const __nativeFetch = window.fetch.bind(window);
            window.fetch = function(input, init) {
              const value = typeof input === 'string' ? input : (input && input.url) || '';
              if (/^https?:/i.test(value)) return Promise.reject(new TypeError('CI offline simulation'));
              return __nativeFetch(input, init);
            };
            const __xhrOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url) {
              if (/^https?:/i.test(String(url))) throw new DOMException('CI offline simulation', 'NetworkError');
              return __xhrOpen.apply(this, arguments);
            };
            """
            configuration.userContentController.addUserScript(WKUserScript(source: offline, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }

        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsMagnification = true
        webView.setValue(false, forKey: "drawsBackground")
        webView.load(URLRequest(url: URL(string: "capacitor://localhost/index.html")!))
    }

    deinit {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "mohadaraty", contentWorld: .page)
    }

    func dispatchNativeEvent(name: String, detail: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(detail),
              let data = try? JSONSerialization.data(withJSONObject: detail),
              let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async { [weak self] in
            self?.webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('mohadaraty:\(name)', {detail: \(json)}));")
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "capacitor" || url.scheme == "about" {
            decisionHandler(.allow)
            return
        }
        if navigationAction.targetFrame?.isMainFrame != false, url.scheme == "https" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(url.scheme == "https" ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, url.scheme == "https" { NSWorkspace.shared.open(url) }
        return nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let smokeOutput else { return }
        let offlineLiteral = offlineSmoke ? "true" : "false"
        let script = """
        return await (async function() {
          const result = { origin: location.origin, secureContext: window.isSecureContext,
            bridgeVersion: window.__MOHADARATY_MAC__ && window.__MOHADARATY_MAC__.bridgeVersion,
            offline: \(offlineLiteral), rootMounted: false, loginReady: false, webCrypto: false, indexedDb: false, apiHealth: \(offlineLiteral) ? 'blocked' : 'pending' };
          try { const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('mohadaraty')); result.webCrypto = digest.byteLength === 32; } catch (_) {}
          try { result.indexedDb = !!indexedDB; } catch (_) {}
          await new Promise(resolve => setTimeout(resolve, 8000));
          result.rootMounted = !!document.querySelector('#root') && document.querySelector('#root').childElementCount > 0;
          result.loginReady = !!document.querySelector('[data-macos-smoke="login-ready"]');
          if (!\(offlineLiteral)) { try { const r = await fetch('https://mohadaraty.vercel.app/api/health'); result.apiHealth = r.ok ? 'ok' : 'http_' + r.status; } catch (e) { result.apiHealth = 'failed'; } }
          return JSON.stringify(result);
        })();
        """
        webView.callAsyncJavaScript(script, arguments: [:], in: nil, contentWorld: .page) { result in
            let output: String
            switch result {
            case .success(let value): output = (value as? String) ?? "{\"error\":\"invalid_smoke_result\"}"
            case .failure: output = "{\"error\":\"javascript_smoke_failed\"}"
            }
            try? output.write(toFile: smokeOutput, atomically: true, encoding: .utf8)
        }
    }
}

final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root: URL

    override init() {
        root = Bundle.main.resourceURL!.appendingPathComponent("WebApp", isDirectory: true).standardizedFileURL
        super.init()
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let requestURL = urlSchemeTask.request.url,
              requestURL.scheme == "capacitor", requestURL.host == "localhost" else {
            fail(urlSchemeTask, "invalid_origin"); return
        }
        var path = requestURL.path.removingPercentEncoding ?? requestURL.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        if path.split(separator: "/").contains("..") { fail(urlSchemeTask, "invalid_path"); return }

        var fileURL = root.appendingPathComponent(String(path.drop(while: { $0 == "/" }))).standardizedFileURL
        if fileURL.pathExtension.isEmpty { fileURL = root.appendingPathComponent("index.html") }
        guard fileURL.path.hasPrefix(root.path + "/"),
              FileManager.default.fileExists(atPath: fileURL.path),
              let data = try? Data(contentsOf: fileURL, options: .mappedIfSafe) else {
            fail(urlSchemeTask, "asset_not_found"); return
        }
        let response = URLResponse(url: requestURL, mimeType: mimeType(for: fileURL), expectedContentLength: data.count, textEncodingName: isText(fileURL) ? "utf-8" : nil)
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) { }

    private func fail(_ task: WKURLSchemeTask, _ reason: String) {
        task.didFailWithError(NSError(domain: "MohadaratyAsset", code: 1, userInfo: [NSLocalizedDescriptionKey: reason]))
    }

    private func isText(_ url: URL) -> Bool { ["html", "js", "css", "json", "svg", "txt"].contains(url.pathExtension.lowercased()) }
    private func mimeType(for url: URL) -> String {
        if let type = UTType(filenameExtension: url.pathExtension), let mime = type.preferredMIMEType { return mime }
        switch url.pathExtension.lowercased() {
        case "js": return "text/javascript"
        case "wasm": return "application/wasm"
        case "bcmap": return "application/octet-stream"
        default: return "application/octet-stream"
        }
    }
}

