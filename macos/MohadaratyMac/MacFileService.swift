import Foundation
import AppKit
import UniformTypeIdentifiers

final class MacFileService: NSObject {
    private let maxInlineBytes = 25 * 1024 * 1024
    private let maxRemoteBytes = 250 * 1024 * 1024
    private var sharingPicker: NSSharingServicePicker?
    private var revealedPaths = Set<String>()

    func handle(method: String, payload: [String: Any], completion: @escaping (Result<Any, Error>) -> Void) {
        switch method {
        case "saveData", "shareData":
            do {
                let data = try decodeData(payload)
                let name = try safeName(payload["suggestedName"] as? String)
                if method == "saveData" { presentSave(data: data, name: name, mime: payload["mimeType"] as? String, completion: completion) }
                else { presentShare(urls: [try temporaryFile(data: data, name: name)], completion: completion) }
            } catch { completion(.failure(error)) }
        case "saveRemoteFile", "shareRemoteFile":
            download(payload: payload) { result in
                switch result {
                case .failure(let error): completion(.failure(error))
                case .success(let item):
                    if method == "saveRemoteFile" { self.presentSave(downloaded: item.url, name: item.name, mime: payload["mimeType"] as? String, completion: completion) }
                    else { self.presentShare(urls: [item.url], completion: completion) }
                }
            }
        case "shareRemoteFiles":
            shareRemoteFiles(payload: payload, completion: completion)
        case "revealSavedFile":
            guard let path = payload["path"] as? String, revealedPaths.contains(path), FileManager.default.fileExists(atPath: path) else {
                completion(.failure(NativeBridgeFailure("file_not_owned"))); return
            }
            DispatchQueue.main.async {
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
                completion(.success(["status": "revealed"]))
            }
        default: completion(.failure(NativeBridgeFailure("unknown_method")))
        }
    }

    func cleanupStaleShares() {
        let directory = shareDirectory()
        guard let entries = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        let cutoff = Date().addingTimeInterval(-86_400)
        for url in entries {
            if let values = try? url.resourceValues(forKeys: [.contentModificationDateKey]), values.contentModificationDate ?? .distantPast < cutoff {
                try? FileManager.default.removeItem(at: url)
            }
        }
    }

    private func decodeData(_ payload: [String: Any]) throws -> Data {
        guard let encoding = payload["encoding"] as? String, let value = payload["data"] as? String else { throw NativeBridgeFailure("invalid_file_data") }
        let data: Data?
        if encoding == "utf8" { data = value.data(using: .utf8) }
        else if encoding == "base64" { data = Data(base64Encoded: value) }
        else { data = nil }
        guard let data, data.count <= maxInlineBytes else { throw NativeBridgeFailure("file_too_large") }
        return data
    }

    private func safeName(_ value: String?) throws -> String {
        guard let raw = value?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { throw NativeBridgeFailure("invalid_filename") }
        let name = raw.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: "\\", with: "-")
        guard name != ".", name != "..", name.utf8.count <= 240 else { throw NativeBridgeFailure("invalid_filename") }
        return name
    }

    private func download(payload: [String: Any], completion: @escaping (Result<(url: URL, name: String), Error>) -> Void) {
        do {
            guard let text = payload["url"] as? String, let url = URL(string: text), url.scheme == "https" else { throw NativeBridgeFailure("invalid_remote_url") }
            let name = try safeName(payload["suggestedName"] as? String)
            var request = URLRequest(url: url)
            request.timeoutInterval = 90
            URLSession.shared.downloadTask(with: request) { temporary, response, error in
                if error != nil { completion(.failure(NativeBridgeFailure("download_failed", retryable: true))); return }
                if let expected = response?.expectedContentLength, expected > self.maxRemoteBytes { completion(.failure(NativeBridgeFailure("file_too_large"))); return }
                guard let temporary,
                      let size = try? temporary.resourceValues(forKeys: [.fileSizeKey]).fileSize,
                      size <= self.maxRemoteBytes else { completion(.failure(NativeBridgeFailure("file_too_large"))); return }
                do {
                    let destination = self.shareDirectory().appendingPathComponent(UUID().uuidString + "-" + name)
                    try FileManager.default.copyItem(at: temporary, to: destination)
                    completion(.success((destination, name)))
                } catch { completion(.failure(NativeBridgeFailure("file_write_failed", retryable: true))) }
            }.resume()
        } catch { completion(.failure(error)) }
    }

    private func presentSave(data: Data, name: String, mime: String?, completion: @escaping (Result<Any, Error>) -> Void) {
        do { presentSave(downloaded: try temporaryFile(data: data, name: name), name: name, mime: mime, completion: completion) }
        catch { completion(.failure(error)) }
    }

    private func presentSave(downloaded: URL, name: String, mime: String?, completion: @escaping (Result<Any, Error>) -> Void) {
        DispatchQueue.main.async {
            let panel = NSSavePanel()
            panel.nameFieldStringValue = name
            panel.canCreateDirectories = true
            if let mime, let type = UTType(mimeType: mime) { panel.allowedContentTypes = [type] }
            panel.begin { response in
                guard response == .OK, let destination = panel.url else { completion(.success(["status": "cancelled"])); return }
                do {
                    let parent = destination.deletingLastPathComponent()
                    let staging = parent.appendingPathComponent(".mohadaraty-\(UUID().uuidString).tmp")
                    try FileManager.default.copyItem(at: downloaded, to: staging)
                    if FileManager.default.fileExists(atPath: destination.path) {
                        _ = try FileManager.default.replaceItemAt(destination, withItemAt: staging)
                    } else {
                        try FileManager.default.moveItem(at: staging, to: destination)
                    }
                    self.revealedPaths.insert(destination.path)
                    completion(.success(["status": "saved", "path": destination.path]))
                } catch { completion(.failure(NativeBridgeFailure("file_write_failed", retryable: true))) }
            }
        }
    }

    private func shareRemoteFiles(payload: [String: Any], completion: @escaping (Result<Any, Error>) -> Void) {
        guard let items = payload["items"] as? [[String: Any]], !items.isEmpty, items.count <= 20 else { completion(.failure(NativeBridgeFailure("invalid_file_list"))); return }
        let group = DispatchGroup()
        let lock = NSLock()
        var urls: [URL] = []
        var firstError: Error?
        for item in items {
            group.enter()
            download(payload: item) { result in
                lock.lock()
                if case .success(let value) = result { urls.append(value.url) }
                if case .failure(let error) = result, firstError == nil { firstError = error }
                lock.unlock()
                group.leave()
            }
        }
        group.notify(queue: .main) {
            if let firstError { completion(.failure(firstError)) }
            else { self.presentShare(urls: urls, completion: completion) }
        }
    }

    private func presentShare(urls: [URL], completion: @escaping (Result<Any, Error>) -> Void) {
        DispatchQueue.main.async {
            guard let view = NSApp.keyWindow?.contentView ?? NSApp.mainWindow?.contentView else { completion(.failure(NativeBridgeFailure("window_unavailable"))); return }
            let picker = NSSharingServicePicker(items: urls)
            self.sharingPicker = picker
            picker.show(relativeTo: view.bounds, of: view, preferredEdge: .minY)
            completion(.success(["status": "shared"]))
        }
    }

    private func temporaryFile(data: Data, name: String) throws -> URL {
        let url = shareDirectory().appendingPathComponent(UUID().uuidString + "-" + name)
        do { try data.write(to: url, options: .atomic); return url }
        catch { throw NativeBridgeFailure("file_write_failed", retryable: true) }
    }

    private func shareDirectory() -> URL {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("com.mohadaraty.app", isDirectory: true)
            .appendingPathComponent("Shared", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }
}

