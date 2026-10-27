import Foundation
import SQLite3
import CryptoKit
import Security

final class AttendanceStore {
    private let queue = DispatchQueue(label: "com.mohadaraty.app.attendance", qos: .userInitiated)
    private var database: OpaquePointer?
    private let keychainService = "com.mohadaraty.app.attendance"
    private let payloadKeyAccount = "payload-key-v1"
    private let signingKeyAccount = "signing-key-v1"
    private let installationAccount = "installation-id-v1"
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    deinit { if let database { sqlite3_close(database) } }

    func handle(method: String, payload: [String: Any], completion: @escaping (Result<Any, Error>) -> Void) {
        queue.async {
            do {
                try self.openIfNeeded()
                let value: Any
                switch method {
                case "initialize":
                    do {
                        _ = try self.payloadKey()
                        _ = try self.signingKey()
                        _ = try self.installationId()
                        try self.recoverInterruptedWork()
                        value = try self.health(ownerUid: payload["ownerUid"] as? String ?? "")
                    } catch let failure as NativeBridgeFailure where failure.code == "key_unavailable" {
                        value = [
                            "storageType": "native_sqlite", "isDurable": false, "healthState": "key_unavailable",
                            "unresolvedReceiptsCount": 0, "unresolvedCommandsCount": 0,
                            "unreadableRecordsCount": 1, "legacyMigrationPending": false
                        ]
                    }
                case "capture": value = try self.capture(payload)
                case "listReceipts": value = try self.listReceipts(ownerUid: try self.requiredString(payload, "ownerUid"))
                case "getReceipt": value = try self.getReceipt(requestId: try self.requiredString(payload, "requestId")) ?? NSNull()
                case "commitDoctorSession": try self.commitDoctorSession(payload); value = [:]
                case "enqueueDoctorCommand": try self.upsertCommand(try self.requiredObject(payload, "command")); value = [:]
                case "listDoctorCommands": value = try self.listCommands(ownerUid: try self.requiredString(payload, "ownerUid"))
                case "updateDoctorCommand": try self.upsertCommand(try self.requiredObject(payload, "command")); value = [:]
                case "updateReceipt": try self.updateReceipt(payload); value = [:]
                case "transitionReceipt": value = try self.transitionReceipt(payload) ?? NSNull()
                case "acquireUploadLease": value = try self.acquireLease(payload)
                case "acknowledgeBatch": try self.acknowledge(payload); value = [:]
                case "releaseUploadLease": try self.releaseLease(try self.requiredString(payload, "leaseId")); value = [:]
                case "getMetadata": value = try self.getMetadata(payload) ?? NSNull()
                case "setMetadata": try self.setMetadata(payload); value = [:]
                case "deleteMetadata": try self.deleteMetadata(payload); value = [:]
                case "recoverInterruptedWork": try self.recoverInterruptedWork(); value = [:]
                case "getHealth": value = try self.health(ownerUid: try self.requiredString(payload, "ownerUid"))
                case "getPublicIdentity": value = try self.publicIdentity()
                case "signReceipt": value = ["signature": try self.signMessage(try self.requiredString(payload, "message"))]
                case "signDoctorQr": value = ["signature": try self.signDoctorQr(payload)]
                case "signRotationMessage": value = ["signature": try self.signMessage(try self.requiredString(payload, "message"))]
                default: throw NativeBridgeFailure("unknown_method")
                }
                completion(.success(value))
            } catch let failure as NativeBridgeFailure {
                completion(.failure(failure))
            } catch {
                completion(.failure(self.map(error)))
            }
        }
    }

    private func openIfNeeded() throws {
        if database != nil { return }
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("com.mohadaraty.app", isDirectory: true)
            .appendingPathComponent("Attendance", isDirectory: true)
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        let path = base.appendingPathComponent("attendance.sqlite3").path
        var pointer: OpaquePointer?
        guard sqlite3_open_v2(path, &pointer, SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK, let pointer else {
            throw NativeBridgeFailure("storage_unavailable", retryable: true)
        }
        database = pointer
        try execute("PRAGMA journal_mode=WAL;")
        try execute("PRAGMA synchronous=FULL;")
        try execute("PRAGMA foreign_keys=ON;")
        try execute("""
          CREATE TABLE IF NOT EXISTS attendance_receipts (
            request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, occurrence_id TEXT NOT NULL,
            owner_uid TEXT NOT NULL, status TEXT NOT NULL, local_device_conflict INTEGER NOT NULL DEFAULT 0,
            payload TEXT NOT NULL, lease_id TEXT, lease_expires_at INTEGER,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS receipts_owner_status ON attendance_receipts(owner_uid,status,created_at);
          CREATE INDEX IF NOT EXISTS receipts_session_owner ON attendance_receipts(session_id,owner_uid);
          CREATE TABLE IF NOT EXISTS attendance_locks (
            session_id TEXT PRIMARY KEY, owner_uid TEXT NOT NULL, created_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS attendance_commands (
            request_id TEXT PRIMARY KEY, owner_uid TEXT NOT NULL, session_id TEXT,
            local_order INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
            payload TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS commands_owner_order ON attendance_commands(owner_uid,status,local_order);
          CREATE TABLE IF NOT EXISTS attendance_meta (
            scope_key TEXT PRIMARY KEY, owner_uid TEXT NOT NULL, meta_key TEXT NOT NULL,
            payload TEXT NOT NULL, updated_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS attendance_migration_journal (
            version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL
          );
          INSERT OR IGNORE INTO attendance_migration_journal(version,applied_at) VALUES(1, strftime('%s','now') * 1000);
          PRAGMA user_version=1;
        """)
    }

    private func capture(_ payload: [String: Any]) throws -> [String: Any] {
        var receipt = try requiredObject(payload, "receipt")
        let requestId = try requiredString(receipt, "requestId")
        let ownerUid = try requiredString(receipt, "ownerUid")
        let sessionId = try requiredString(receipt, "sessionId")
        let occurrenceId = receipt["occurrenceId"] as? String ?? ""
        try execute("BEGIN EXCLUSIVE;")
        do {
            if let existing = try queryObject("SELECT payload FROM attendance_receipts WHERE session_id=? AND owner_uid=? AND status!='invalid' LIMIT 1;", [sessionId, ownerUid]) {
                try execute("COMMIT;")
                return ["receipt": existing, "alreadySaved": true]
            }
            let lockOwner = try queryString("SELECT owner_uid FROM attendance_locks WHERE session_id=? LIMIT 1;", [sessionId])
            let conflict = lockOwner != nil && lockOwner != ownerUid
            if lockOwner == nil {
                try run("INSERT OR IGNORE INTO attendance_locks(session_id,owner_uid,created_at) VALUES(?,?,?);", [sessionId, ownerUid, millis()])
            }
            receipt["localDeviceConflict"] = conflict
            if conflict, let signature = payload["conflictSignature"] as? String { receipt["deviceSignature"] = signature }
            let status = receipt["status"] as? String ?? "pending"
            let encrypted = try encryptJSON(receipt)
            let now = millis()
            try run("INSERT INTO attendance_receipts(request_id,session_id,occurrence_id,owner_uid,status,local_device_conflict,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?);", [requestId, sessionId, occurrenceId, ownerUid, status, conflict ? 1 : 0, encrypted, now, now])
            try execute("COMMIT;")
            return ["receipt": receipt, "alreadySaved": false]
        } catch { try? execute("ROLLBACK;"); throw error }
    }

    private func listReceipts(ownerUid: String) throws -> [[String: Any]] {
        try queryObjects("SELECT payload FROM attendance_receipts WHERE owner_uid=? ORDER BY created_at;", [ownerUid])
    }

    private func getReceipt(requestId: String) throws -> [String: Any]? {
        try queryObject("SELECT payload FROM attendance_receipts WHERE request_id=? LIMIT 1;", [requestId])
    }

    private func updateReceipt(_ payload: [String: Any]) throws {
        let requestId = try requiredString(payload, "requestId")
        let receipt = try requiredObject(payload, "receipt")
        let status = receipt["status"] as? String ?? "pending"
        let encrypted = try encryptJSON(receipt)
        guard try run("UPDATE attendance_receipts SET status=?,payload=?,updated_at=? WHERE request_id=?;", [status, encrypted, millis(), requestId]) > 0 else {
            throw NativeBridgeFailure("receipt_not_found")
        }
    }

    private func transitionReceipt(_ payload: [String: Any]) throws -> [String: Any]? {
        let requestId = try requiredString(payload, "requestId")
        guard var receipt = try getReceipt(requestId: requestId) else { return nil }
        let status = try requiredString(payload, "status")
        receipt["status"] = status
        for key in ["resolution", "reason", "recordRevision"] where payload[key] != nil { receipt[key] = payload[key] }
        try updateReceipt(["requestId": requestId, "receipt": receipt])
        return receipt
    }

    private func commitDoctorSession(_ payload: [String: Any]) throws {
        let meta = try requiredObject(payload, "meta")
        let command = try requiredObject(payload, "command")
        try execute("BEGIN IMMEDIATE;")
        do {
            try setMetadata(["key": try requiredString(meta, "key"), "data": meta["data"] ?? NSNull(), "ownerUid": command["ownerUid"] as? String ?? ""])
            try upsertCommand(command)
            try execute("COMMIT;")
        } catch {
            try? execute("ROLLBACK;")
            throw error
        }
    }

    private func upsertCommand(_ command: [String: Any]) throws {
        let requestId = try requiredString(command, "requestId")
        let owner = try requiredString(command, "ownerUid")
        let session = command["sessionId"] as? String ?? ""
        let order = number(command["localOrder"])
        let status = command["status"] as? String ?? "pending"
        let encrypted = try encryptJSON(command)
        let now = millis()
        try run("""
          INSERT INTO attendance_commands(request_id,owner_uid,session_id,local_order,status,payload,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET
          owner_uid=excluded.owner_uid,session_id=excluded.session_id,local_order=excluded.local_order,
          status=excluded.status,payload=excluded.payload,updated_at=excluded.updated_at;
        """, [requestId, owner, session, order, status, encrypted, now, now])
    }

    private func listCommands(ownerUid: String) throws -> [[String: Any]] {
        try queryObjects("SELECT payload FROM attendance_commands WHERE owner_uid=? AND status!='acknowledged' ORDER BY local_order,created_at;", [ownerUid])
    }

    private func acquireLease(_ payload: [String: Any]) throws -> [String: Any] {
        let owner = try requiredString(payload, "ownerUid")
        let limit = max(1, min(number(payload["limit"], fallback: 25), 100))
        let duration = max(10_000, min(number(payload["leaseDurationMs"], fallback: 120_000), 600_000))
        try recoverInterruptedWork()
        let leaseId = UUID().uuidString
        let expiry = millis() + Int64(duration)
        try execute("BEGIN IMMEDIATE;")
        do {
            let ids = try queryStrings("SELECT request_id FROM attendance_receipts WHERE owner_uid=? AND status IN ('pending','retry') AND lease_id IS NULL ORDER BY created_at LIMIT ?;", [owner, limit])
            for id in ids { try run("UPDATE attendance_receipts SET status='uploading',lease_id=?,lease_expires_at=?,updated_at=? WHERE request_id=?;", [leaseId, expiry, millis(), id]) }
            try execute("COMMIT;")
            let receipts = try queryObjects("SELECT payload FROM attendance_receipts WHERE lease_id=? ORDER BY created_at;", [leaseId])
            return ["leaseId": leaseId, "receipts": receipts]
        } catch { try? execute("ROLLBACK;"); throw error }
    }

    private func acknowledge(_ payload: [String: Any]) throws {
        let leaseId = try requiredString(payload, "leaseId")
        let items = payload["acknowledgements"] as? [[String: Any]] ?? []
        try execute("BEGIN IMMEDIATE;")
        do {
            for item in items {
                let requestId = try requiredString(item, "requestId")
                guard var receipt = try getReceipt(requestId: requestId) else { continue }
                let resolution = item["resolution"] as? String ?? "confirmed"
                receipt["resolution"] = resolution
                receipt["status"] = resolution == "retry" ? "pending" : resolution
                for key in ["reason", "recordId", "recordRevision", "recordStatus", "receivedAt"] where item[key] != nil { receipt[key] = item[key] }
                let encrypted = try encryptJSON(receipt)
                try run("UPDATE attendance_receipts SET status=?,payload=?,lease_id=NULL,lease_expires_at=NULL,updated_at=? WHERE request_id=? AND lease_id=?;", [receipt["status"]!, encrypted, millis(), requestId, leaseId])
                try run("UPDATE attendance_commands SET status='acknowledged',updated_at=? WHERE request_id=?;", [millis(), requestId])
            }
            try execute("COMMIT;")
        } catch { try? execute("ROLLBACK;"); throw error }
    }

    private func releaseLease(_ leaseId: String) throws {
        try run("UPDATE attendance_receipts SET status='pending',lease_id=NULL,lease_expires_at=NULL,updated_at=? WHERE lease_id=?;", [millis(), leaseId])
    }

    private func recoverInterruptedWork() throws {
        try run("UPDATE attendance_receipts SET status='pending',lease_id=NULL,lease_expires_at=NULL,updated_at=? WHERE lease_expires_at IS NOT NULL AND lease_expires_at < ?;", [millis(), millis()])
    }

    private func getMetadata(_ payload: [String: Any]) throws -> Any? {
        let key = try requiredString(payload, "key")
        let owner = payload["ownerUid"] as? String ?? ""
        return try queryJSON("SELECT payload FROM attendance_meta WHERE scope_key=? LIMIT 1;", [owner + "|" + key])
    }

    private func setMetadata(_ payload: [String: Any]) throws {
        let key = try requiredString(payload, "key")
        let owner = payload["ownerUid"] as? String ?? ""
        let encrypted = try encryptJSON(payload["data"] ?? NSNull())
        try run("INSERT INTO attendance_meta(scope_key,owner_uid,meta_key,payload,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(scope_key) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at;", [owner + "|" + key, owner, key, encrypted, millis()])
    }

    private func deleteMetadata(_ payload: [String: Any]) throws {
        let key = try requiredString(payload, "key")
        let owner = payload["ownerUid"] as? String ?? ""
        try run("DELETE FROM attendance_meta WHERE scope_key=?;", [owner + "|" + key])
    }

    private func health(ownerUid: String) throws -> [String: Any] {
        let unresolvedReceipts = try scalar("SELECT COUNT(*) FROM attendance_receipts WHERE owner_uid=? AND status NOT IN ('confirmed','rejected','voided');", [ownerUid])
        let unresolvedCommands = try scalar("SELECT COUNT(*) FROM attendance_commands WHERE owner_uid=? AND status!='acknowledged';", [ownerUid])
        return [
            "storageType": "native_sqlite", "isDurable": true, "healthState": "ready",
            "unresolvedReceiptsCount": unresolvedReceipts, "unresolvedCommandsCount": unresolvedCommands,
            "unreadableRecordsCount": 0, "legacyMigrationPending": false
        ]
    }

    private func publicIdentity() throws -> [String: Any] {
        let key = try signingKey()
        let bytes = key.publicKey.x963Representation
        guard bytes.count == 65, bytes.first == 0x04 else { throw NativeBridgeFailure("signing_key_invalid") }
        let x = base64URL(bytes.subdata(in: 1..<33))
        let y = base64URL(bytes.subdata(in: 33..<65))
        return [
            "fingerprint": "[\"P-256\",\"\(x)\",\"\(y)\"]",
            "publicKey": ["kty": "EC", "crv": "P-256", "x": x, "y": y],
            "installationId": try installationId(), "legacyKeyAvailable": false
        ]
    }

    private func signMessage(_ message: String) throws -> String {
        let signature = try signingKey().signature(for: SHA256.hash(data: Data(message.utf8)))
        return base64URL(signature.rawRepresentation)
    }

    private func signDoctorQr(_ payload: [String: Any]) throws -> String {
        var permit = payload["permit"] as? String ?? ""
        var claims: [String: Any]
        if let nested = payload["claims"] as? [String: Any] { claims = nested }
        else if let nested = payload["claims"] as? String, let data = nested.data(using: .utf8), let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] { claims = object }
        else { claims = payload }
        if permit.isEmpty { permit = claims["permit"] as? String ?? "" }
        claims.removeValue(forKey: "permit")
        let header: [String: Any] = ["alg": "ES256", "typ": "JWT", "permit": permit]
        let encodedHeader = base64URL(try JSONSerialization.data(withJSONObject: header, options: [.sortedKeys]))
        let encodedClaims = base64URL(try JSONSerialization.data(withJSONObject: claims, options: [.sortedKeys]))
        let message = encodedHeader + "." + encodedClaims
        let token = message + "." + (try signMessage(message))
        guard token.utf8.count <= 2330 else { throw NativeBridgeFailure("doctor_qr_payload_exceeds_limit") }
        return token
    }

    private func payloadKey() throws -> SymmetricKey {
        if let data = try keychainRead(payloadKeyAccount) { return SymmetricKey(data: data) }
        if try scalar("SELECT (SELECT COUNT(*) FROM attendance_receipts)+(SELECT COUNT(*) FROM attendance_commands)+(SELECT COUNT(*) FROM attendance_meta);", []) > 0 {
            throw NativeBridgeFailure("key_unavailable", "Encrypted attendance data exists but its key is unavailable.")
        }
        let key = SymmetricKey(size: .bits256)
        let data = key.withUnsafeBytes { Data($0) }
        try keychainWrite(payloadKeyAccount, data)
        return key
    }

    private func signingKey() throws -> P256.Signing.PrivateKey {
        if let data = try keychainRead(signingKeyAccount) { return try P256.Signing.PrivateKey(rawRepresentation: data) }
        if try scalar("SELECT (SELECT COUNT(*) FROM attendance_receipts)+(SELECT COUNT(*) FROM attendance_commands);", []) > 0 {
            throw NativeBridgeFailure("key_unavailable", "Pending attendance evidence exists but its signing key is unavailable.")
        }
        let key = P256.Signing.PrivateKey()
        try keychainWrite(signingKeyAccount, key.rawRepresentation)
        return key
    }

    private func installationId() throws -> String {
        if let data = try keychainRead(installationAccount), let value = String(data: data, encoding: .utf8) { return value }
        if try scalar("SELECT (SELECT COUNT(*) FROM attendance_receipts)+(SELECT COUNT(*) FROM attendance_commands);", []) > 0 {
            throw NativeBridgeFailure("key_unavailable", "Pending attendance evidence exists but its installation identity is unavailable.")
        }
        let value = UUID().uuidString
        try keychainWrite(installationAccount, Data(value.utf8))
        return value
    }

    private func keychainRead(_ account: String) throws -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: keychainService,
            kSecAttrAccount as String: account, kSecAttrSynchronizable as String: false,
            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw NativeBridgeFailure("key_unavailable", retryable: true) }
        return data
    }

    private func keychainWrite(_ account: String, _ data: Data) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: keychainService,
            kSecAttrAccount as String: account, kSecAttrSynchronizable as String: false,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: data
        ]
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess || status == errSecDuplicateItem else { throw NativeBridgeFailure("key_unavailable", retryable: true) }
    }

    private func encryptJSON(_ object: Any) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.fragmentsAllowed, .sortedKeys])
        let sealed = try AES.GCM.seal(data, using: payloadKey())
        guard let combined = sealed.combined else { throw NativeBridgeFailure("encryption_failed") }
        return combined.base64EncodedString()
    }

    private func decryptJSON(_ value: String) throws -> Any {
        guard let data = Data(base64Encoded: value) else { throw NativeBridgeFailure("storage_corrupt") }
        do {
            let clear = try AES.GCM.open(try AES.GCM.SealedBox(combined: data), using: payloadKey())
            return try JSONSerialization.jsonObject(with: clear, options: [.fragmentsAllowed])
        } catch let failure as NativeBridgeFailure { throw failure }
        catch { throw NativeBridgeFailure("storage_corrupt") }
    }

    private func execute(_ sql: String) throws {
        guard let database else { throw NativeBridgeFailure("storage_unavailable") }
        var error: UnsafeMutablePointer<CChar>?
        guard sqlite3_exec(database, sql, nil, nil, &error) == SQLITE_OK else {
            if let error { sqlite3_free(error) }
            throw NativeBridgeFailure("storage_write_failed", retryable: true)
        }
    }

    @discardableResult private func run(_ sql: String, _ values: [Any]) throws -> Int {
        let statement = try prepare(sql, values)
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_DONE else { throw NativeBridgeFailure("storage_write_failed", retryable: sqlite3_errcode(database) == SQLITE_BUSY) }
        return Int(sqlite3_changes(database))
    }

    private func queryObjects(_ sql: String, _ values: [Any]) throws -> [[String: Any]] {
        let statement = try prepare(sql, values)
        defer { sqlite3_finalize(statement) }
        var result: [[String: Any]] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            guard let text = columnText(statement, 0), let object = try decryptJSON(text) as? [String: Any] else { throw NativeBridgeFailure("storage_corrupt") }
            result.append(object)
        }
        return result
    }

    private func queryObject(_ sql: String, _ values: [Any]) throws -> [String: Any]? { try queryObjects(sql, values).first }
    private func queryJSON(_ sql: String, _ values: [Any]) throws -> Any? {
        let statement = try prepare(sql, values); defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW, let text = columnText(statement, 0) else { return nil }
        return try decryptJSON(text)
    }
    private func queryStrings(_ sql: String, _ values: [Any]) throws -> [String] {
        let statement = try prepare(sql, values); defer { sqlite3_finalize(statement) }
        var result: [String] = []
        while sqlite3_step(statement) == SQLITE_ROW { if let text = columnText(statement, 0) { result.append(text) } }
        return result
    }
    private func queryString(_ sql: String, _ values: [Any]) throws -> String? { try queryStrings(sql, values).first }
    private func scalar(_ sql: String, _ values: [Any]) throws -> Int {
        let statement = try prepare(sql, values); defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW else { return 0 }
        return Int(sqlite3_column_int64(statement, 0))
    }

    private func prepare(_ sql: String, _ values: [Any]) throws -> OpaquePointer {
        guard let database else { throw NativeBridgeFailure("storage_unavailable") }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else { throw NativeBridgeFailure("storage_corrupt") }
        do {
            for (offset, value) in values.enumerated() { try bind(statement, Int32(offset + 1), value) }
            return statement
        } catch { sqlite3_finalize(statement); throw error }
    }

    private func bind(_ statement: OpaquePointer, _ index: Int32, _ value: Any) throws {
        let status: Int32
        if value is NSNull { status = sqlite3_bind_null(statement, index) }
        else if let int = value as? Int { status = sqlite3_bind_int64(statement, index, Int64(int)) }
        else if let int = value as? Int64 { status = sqlite3_bind_int64(statement, index, int) }
        else if let number = value as? NSNumber { status = sqlite3_bind_int64(statement, index, number.int64Value) }
        else { status = sqlite3_bind_text(statement, index, String(describing: value), -1, transient) }
        guard status == SQLITE_OK else { throw NativeBridgeFailure("storage_write_failed") }
    }

    private func columnText(_ statement: OpaquePointer, _ index: Int32) -> String? {
        guard let pointer = sqlite3_column_text(statement, index) else { return nil }
        return String(cString: pointer)
    }

    private func requiredString(_ object: [String: Any], _ key: String) throws -> String {
        guard let value = object[key] as? String, !value.isEmpty, value.utf8.count <= 4096 else { throw NativeBridgeFailure("invalid_\(key)") }
        return value
    }
    private func requiredObject(_ object: [String: Any], _ key: String) throws -> [String: Any] {
        guard let value = object[key] as? [String: Any] else { throw NativeBridgeFailure("invalid_\(key)") }
        return value
    }
    private func number(_ value: Any?, fallback: Int = 0) -> Int { (value as? NSNumber)?.intValue ?? fallback }
    private func millis() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
    private func base64URL(_ data: Data) -> String { data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
    private func map(_ error: Error) -> NativeBridgeFailure {
        let ns = error as NSError
        if ns.domain == NSCocoaErrorDomain && ns.code == NSFileWriteOutOfSpaceError { return NativeBridgeFailure("disk_full") }
        return NativeBridgeFailure("attendance_storage_failure", retryable: true)
    }
}

