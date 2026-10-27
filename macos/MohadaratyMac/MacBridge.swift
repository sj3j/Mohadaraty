import Foundation
import WebKit

struct NativeBridgeFailure: Error {
    let code: String
    let message: String
    let retryable: Bool

    init(_ code: String, _ message: String? = nil, retryable: Bool = false) {
        self.code = code
        self.message = message ?? code
        self.retryable = retryable
    }
}

final class MacBridge: NSObject, WKScriptMessageHandlerWithReply {
    private unowned let runtime: MacRuntime
    init(runtime: MacRuntime) { self.runtime = runtime }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard message.frameInfo.isMainFrame,
              message.frameInfo.request.url?.scheme == "capacitor",
              message.frameInfo.request.url?.host == "localhost" else {
            replyHandler(nil, "bridge_origin_rejected")
            return
        }
        guard let body = message.body as? [String: Any],
              (body["version"] as? NSNumber)?.intValue == 1,
              let requestId = body["requestId"] as? String, requestId.count <= 128,
              let service = body["service"] as? String,
              let method = body["method"] as? String, method.count <= 80 else {
            replyHandler(nil, "invalid_bridge_request")
            return
        }
        let payload = body["payload"] as? [String: Any] ?? [:]
        let finish: (Result<Any, Error>) -> Void = { result in
            switch result {
            case .success(let value):
                replyHandler(["version": 1, "requestId": requestId, "ok": true, "value": value], nil)
            case .failure(let error):
                let failure = error as? NativeBridgeFailure ?? NativeBridgeFailure("native_failure", "Native operation failed.", retryable: true)
                replyHandler([
                    "version": 1, "requestId": requestId, "ok": false,
                    "error": ["code": failure.code, "message": failure.message, "retryable": failure.retryable]
                ], nil)
            }
        }

        switch service {
        case "environment": handleEnvironment(method: method, completion: finish)
        case "attendance": runtime.attendanceStore.handle(method: method, payload: payload, completion: finish)
        case "files": runtime.fileService.handle(method: method, payload: payload, completion: finish)
        case "presentation": handlePresentation(method: method, payload: payload, completion: finish)
        default: finish(.failure(NativeBridgeFailure("unknown_service")))
        }
    }

    private func handleEnvironment(method: String, completion: @escaping (Result<Any, Error>) -> Void) {
        guard method == "getCapabilities" || method == "selfTest" else {
            completion(.failure(NativeBridgeFailure("unknown_method"))); return
        }
        completion(.success([
            "platform": "macos", "bridgeVersion": 1,
            "appVersion": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0",
            "capabilities": ["attendance", "files", "presentation", "environment"]
        ]))
    }

    private func handlePresentation(method: String, payload: [String: Any], completion: @escaping (Result<Any, Error>) -> Void) {
        DispatchQueue.main.async {
            do {
                switch method {
                case "showQr":
                    guard let dataURL = payload["dataUrl"] as? String,
                          dataURL.hasPrefix("data:image/png;base64,"), dataURL.utf8.count <= 7_000_000 else {
                        throw NativeBridgeFailure("invalid_qr_image")
                    }
                    try self.runtime.presentationController.show(
                        dataURL: dataURL,
                        title: String((payload["title"] as? String ?? "").prefix(160)),
                        subtitle: String((payload["subtitle"] as? String ?? "").prefix(240))
                    )
                    completion(.success(["status": "shown"]))
                case "close":
                    self.runtime.presentationController.close()
                    completion(.success(["status": "closed"]))
                default: throw NativeBridgeFailure("unknown_method")
                }
            } catch { completion(.failure(error)) }
        }
    }
}

