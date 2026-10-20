import Foundation
import Capacitor
import CryptoKit
import Security
import SQLite3

@objc(AttendanceStoragePlugin)
public class AttendanceStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AttendanceStoragePlugin"
    public let jsName = "AttendanceStorage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "initialize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "capture", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listReceipts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getReceipt", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "commitDoctorSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "enqueueDoctorCommand", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listDoctorCommands", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateDoctorCommand", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateReceipt", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "transitionReceipt", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acquireUploadLease", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acknowledgeBatch", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "releaseUploadLease", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getMetadata", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setMetadata", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteMetadata", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "recoverInterruptedWork", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getHealth", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPublicIdentity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signReceipt", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signDoctorQr", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signRotationMessage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "migrateLegacyData", returnType: CAPPluginReturnPromise)
    ]

    private var db: OpaquePointer?
    private let signingKeyAccount = "AttendanceSigningKey"
    private let payloadKeyAccount = "AttendancePayloadKey"
    private let installationIdAccount = "AttendanceInstallationId"
    private let dbQueue = DispatchQueue(label: "com.mohadaraty.app.attendancedb", qos: .userInitiated)

    public override func load() {
        super.load()
        dbQueue.sync {
            setupDatabase()
        }
    }

    private func setupDatabase() {
        guard let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return }
        
        var supportURL = appSupport
        try? FileManager.default.createDirectory(at: supportURL, withIntermediateDirectories: true, attributes: [
            FileAttributeKey.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication
        ])
        
        // Exclude directory and database sidecars from iCloud and iTunes backups
        var rv = URLResourceValues()
        rv.isExcludedFromBackup = true
        try? supportURL.setResourceValues(rv)

        let dbURL = supportURL.appendingPathComponent("attendance_native.sqlite")
        var mutableDbURL = dbURL
        try? mutableDbURL.setResourceValues(rv)

        let dbPath = dbURL.path

        if sqlite3_open(dbPath, &db) == SQLITE_OK {
            sqlite3_exec(db, "PRAGMA journal_mode = WAL;", nil, nil, nil)
            sqlite3_exec(db, "PRAGMA synchronous = FULL;", nil, nil, nil)
            sqlite3_exec(db, "PRAGMA foreign_keys = ON;", nil, nil, nil)

            let createTables = """
            CREATE TABLE IF NOT EXISTS attendance_receipts (
                request_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                occurrence_id TEXT NOT NULL,
                owner_uid TEXT NOT NULL,
                status TEXT NOT NULL,
                encrypted_payload TEXT NOT NULL,
                local_device_conflict INTEGER NOT NULL DEFAULT 0,
                lease_id TEXT,
                lease_expires_at INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_receipts_session ON attendance_receipts (session_id);
            CREATE INDEX IF NOT EXISTS idx_receipts_owner ON attendance_receipts (owner_uid);
            CREATE INDEX IF NOT EXISTS idx_receipts_owner_status ON attendance_receipts (owner_uid, status);

            CREATE TABLE IF NOT EXISTS attendance_locks (
                session_id TEXT PRIMARY KEY,
                owner_uid TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS attendance_commands (
                request_id TEXT PRIMARY KEY,
                owner_uid TEXT NOT NULL,
                status TEXT NOT NULL,
                local_order INTEGER NOT NULL DEFAULT 0,
                encrypted_payload TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_commands_owner ON attendance_commands (owner_uid);

            CREATE TABLE IF NOT EXISTS attendance_meta (
                key TEXT PRIMARY KEY,
                owner_uid TEXT,
                encrypted_value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS attendance_migration_journal (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                action TEXT NOT NULL,
                records_count INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            );
            """
            sqlite3_exec(db, createTables, nil, nil, nil)

            // Forward schema migrations: Ensure columns exist if created on earlier version
            sqlite3_exec(db, "ALTER TABLE attendance_receipts ADD COLUMN lease_id TEXT;", nil, nil, nil)
            sqlite3_exec(db, "ALTER TABLE attendance_receipts ADD COLUMN lease_expires_at INTEGER;", nil, nil, nil)
            sqlite3_exec(db, "ALTER TABLE attendance_meta ADD COLUMN owner_uid TEXT;", nil, nil, nil)
            sqlite3_exec(db, "ALTER TABLE attendance_meta ADD COLUMN encrypted_value TEXT;", nil, nil, nil)
            sqlite3_exec(db, "ALTER TABLE attendance_meta ADD COLUMN updated_at INTEGER;", nil, nil, nil)
        }
    }

    private func databaseHasRecords() -> Bool {
        guard let db = db else { return false }
        var stmt: OpaquePointer?
        if sqlite3_prepare_v2(db, "SELECT count(*) FROM attendance_receipts LIMIT 1;", -1, &stmt, nil) == SQLITE_OK {
            if sqlite3_step(stmt) == SQLITE_ROW {
                let count = sqlite3_column_int(stmt, 0)
                sqlite3_finalize(stmt)
                return count > 0
            }
            sqlite3_finalize(stmt)
        }
        return false
    }

    private func getSigningPrivateKey() throws -> P256.Signing.PrivateKey {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: signingKeyAccount,
            kSecReturnData as String: true
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecSuccess, let data = item as? Data {
            return try P256.Signing.PrivateKey(rawRepresentation: data)
        }
        if status != errSecItemNotFound && status != errSecSuccess {
            throw NSError(domain: "attendance", code: Int(status), userInfo: [
                NSLocalizedDescriptionKey: "Signing key temporarily inaccessible in Keychain (status: \(status))"
            ])
        }

        let key = P256.Signing.PrivateKey()
        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: signingKeyAccount,
            kSecValueData as String: key.rawRepresentation,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        if addStatus != errSecSuccess && addStatus != errSecDuplicateItem {
            throw NSError(domain: "attendance", code: Int(addStatus), userInfo: [
                NSLocalizedDescriptionKey: "Failed to persist signing key to Keychain (status: \(addStatus))"
            ])
        }
        return key
    }

    private func getPayloadKey() throws -> SymmetricKey {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: payloadKeyAccount,
            kSecReturnData as String: true
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecSuccess, let data = item as? Data {
            return SymmetricKey(data: data)
        }
        if status != errSecItemNotFound && status != errSecSuccess {
            throw NSError(domain: "attendance", code: Int(status), userInfo: [
                NSLocalizedDescriptionKey: "Payload key temporarily inaccessible in Keychain (status: \(status))"
            ])
        }

        if databaseHasRecords() {
            throw NSError(domain: "attendance", code: -1001, userInfo: [
                NSLocalizedDescriptionKey: "Database exists with existing records but payload key is missing. Recovery required."
            ])
        }

        let key = SymmetricKey(size: .bits256)
        let keyData = key.withUnsafeBytes { Data($0) }
        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: payloadKeyAccount,
            kSecValueData as String: keyData,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        if addStatus != errSecSuccess && addStatus != errSecDuplicateItem {
            throw NSError(domain: "attendance", code: Int(addStatus), userInfo: [
                NSLocalizedDescriptionKey: "Failed to persist payload key to Keychain (status: \(addStatus))"
            ])
        }
        return key
    }

    private func getOrCreateInstallationId() -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: installationIdAccount,
            kSecReturnData as String: true
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecSuccess, let data = item as? Data, let id = String(data: data, encoding: .utf8) {
            return id
        }

        let newId = UUID().uuidString
        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: installationIdAccount,
            kSecValueData as String: Data(newId.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        SecItemAdd(addQuery as CFDictionary, nil)
        return newId
    }

    private func encryptPayload(_ plaintext: String) throws -> String {
        let key = try getPayloadKey()
        let sealed = try AES.GCM.seal(Data(plaintext.utf8), using: key)
        guard let combined = sealed.combined else { throw NSError(domain: "attendance", code: -1) }
        return combined.base64EncodedString()
    }

    private func decryptPayload(_ ciphertextBase64: String) throws -> String {
        guard let data = Data(base64Encoded: ciphertextBase64) else { throw NSError(domain: "attendance", code: -1) }
        let key = try getPayloadKey()
        let box = try AES.GCM.SealedBox(combined: data)
        let opened = try AES.GCM.open(box, using: key)
        guard let str = String(data: opened, encoding: .utf8) else { throw NSError(domain: "attendance", code: -1) }
        return str
    }

    private func base64Url(_ data: Data) -> String {
        return data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    @objc func initialize(_ call: CAPPluginCall) {
        dbQueue.sync {
            setupDatabase()
        }
        let ownerUid = call.getString("ownerUid") ?? ""
        getHealthInternal(ownerUid: ownerUid) { res in
            call.resolve(res)
        }
    }

    private func getHealthInternal(ownerUid: String, completion: @escaping ([String: Any]) -> Void) {
        dbQueue.sync {
            guard let db = db else {
                completion([
                    "storageType": "native_sqlite",
                    "isDurable": false,
                    "healthState": "unavailable",
                    "unresolvedReceiptsCount": 0,
                    "unresolvedCommandsCount": 0
                ])
                return
            }

            var unresolvedReceipts = 0
            var unresolvedCommands = 0
            var unreadableCount = 0
            var oldestPendingAgeMs: Int64 = 0
            let now = Int64(Date().timeIntervalSince1970 * 1000)

            var stmt: OpaquePointer?
            let sqlR = ownerUid.isEmpty
                ? "SELECT created_at, encrypted_payload FROM attendance_receipts WHERE status = 'pending' ORDER BY created_at ASC;"
                : "SELECT created_at, encrypted_payload FROM attendance_receipts WHERE owner_uid = ? AND status = 'pending' ORDER BY created_at ASC;"

            if sqlite3_prepare_v2(db, sqlR, -1, &stmt, nil) == SQLITE_OK {
                if !ownerUid.isEmpty {
                    sqlite3_bind_text(stmt, 1, (ownerUid as NSString).utf8String, -1, nil)
                }
                while sqlite3_step(stmt) == SQLITE_ROW {
                    unresolvedReceipts += 1
                    let createdAt = sqlite3_column_int64(stmt, 0)
                    if oldestPendingAgeMs == 0 && createdAt > 0 {
                        oldestPendingAgeMs = max(0, now - createdAt)
                    }
                    if let ptr = sqlite3_column_text(stmt, 1) {
                        let enc = String(cString: ptr)
                        if (try? decryptPayload(enc)) == nil {
                            unreadableCount += 1
                        }
                    }
                }
                sqlite3_finalize(stmt)
            }

            let sqlC = ownerUid.isEmpty
                ? "SELECT count(*) FROM attendance_commands WHERE status != 'synced';"
                : "SELECT count(*) FROM attendance_commands WHERE owner_uid = ? AND status != 'synced';"

            if sqlite3_prepare_v2(db, sqlC, -1, &stmt, nil) == SQLITE_OK {
                if !ownerUid.isEmpty {
                    sqlite3_bind_text(stmt, 1, (ownerUid as NSString).utf8String, -1, nil)
                }
                if sqlite3_step(stmt) == SQLITE_ROW {
                    unresolvedCommands = Int(sqlite3_column_int(stmt, 0))
                }
                sqlite3_finalize(stmt)
            }

            var migrationCompleted = false
            if sqlite3_prepare_v2(db, "SELECT count(*) FROM attendance_migration_journal WHERE action = 'legacy_indexeddb_migration';", -1, &stmt, nil) == SQLITE_OK {
                if sqlite3_step(stmt) == SQLITE_ROW {
                    migrationCompleted = sqlite3_column_int(stmt, 0) > 0
                }
                sqlite3_finalize(stmt)
            }

            var healthState = "ready"
            if unreadableCount > 0 {
                healthState = "corrupt"
            }

            completion([
                "storageType": "native_sqlite",
                "isDurable": true,
                "healthState": healthState,
                "unresolvedReceiptsCount": unresolvedReceipts,
                "unresolvedCommandsCount": unresolvedCommands,
                "unreadableRecordsCount": unreadableCount,
                "oldestPendingAgeMs": oldestPendingAgeMs,
                "legacyMigrationPending": !migrationCompleted
            ])
        }
    }

    @objc func getHealth(_ call: CAPPluginCall) {
        let ownerUid = call.getString("ownerUid") ?? ""
        getHealthInternal(ownerUid: ownerUid) { res in
            call.resolve(res)
        }
    }

    @objc func capture(_ call: CAPPluginCall) {
        guard let receiptStr = call.getString("receipt"),
              let receiptData = receiptStr.data(using: .utf8),
              var receiptObj = try? JSONSerialization.jsonObject(with: receiptData) as? [String: Any] else {
            call.reject("receipt parameter required")
            return
        }

        let sessionId = receiptObj["sessionId"] as? String ?? ""
        let ownerUid = receiptObj["ownerUid"] as? String ?? ""
        let requestId = receiptObj["requestId"] as? String ?? ""
        let occurrenceId = receiptObj["occurrenceId"] as? String ?? ""
        let conflictSig = call.getString("conflictSignature")

        dbQueue.sync {
            guard let db = db else {
                call.reject("database_unavailable")
                return
            }

            if sqlite3_exec(db, "BEGIN EXCLUSIVE TRANSACTION;", nil, nil, nil) != SQLITE_OK {
                call.reject("transaction_begin_failed")
                return
            }

            // 1. Check duplicate under same account
            var stmt: OpaquePointer?
            if sqlite3_prepare_v2(db, "SELECT encrypted_payload FROM attendance_receipts WHERE session_id = ? AND owner_uid = ? AND status != 'invalid' LIMIT 1;", -1, &stmt, nil) == SQLITE_OK {
                sqlite3_bind_text(stmt, 1, (sessionId as NSString).utf8String, -1, nil)
                sqlite3_bind_text(stmt, 2, (ownerUid as NSString).utf8String, -1, nil)
                if sqlite3_step(stmt) == SQLITE_ROW {
                    if let textPtr = sqlite3_column_text(stmt, 0) {
                        let enc = String(cString: textPtr)
                        sqlite3_finalize(stmt)
                        sqlite3_exec(db, "COMMIT;", nil, nil, nil)
                        let decrypted = (try? decryptPayload(enc)) ?? ""
                        call.resolve([
                            "receipt": decrypted,
                            "alreadySaved": true
                        ])
                        return
                    }
                }
                sqlite3_finalize(stmt)
            }

            // 2. Check cross-account session lock
            var localDeviceConflict = false
            if sqlite3_prepare_v2(db, "SELECT owner_uid FROM attendance_locks WHERE session_id = ? LIMIT 1;", -1, &stmt, nil) == SQLITE_OK {
                sqlite3_bind_text(stmt, 1, (sessionId as NSString).utf8String, -1, nil)
                if sqlite3_step(stmt) == SQLITE_ROW {
                    if let textPtr = sqlite3_column_text(stmt, 0) {
                        let lockOwner = String(cString: textPtr)
                        if lockOwner != ownerUid {
                            localDeviceConflict = true
                        }
                    }
                } else {
                    var insertLock: OpaquePointer?
                    if sqlite3_prepare_v2(db, "INSERT OR IGNORE INTO attendance_locks (session_id, owner_uid, created_at) VALUES (?, ?, ?);", -1, &insertLock, nil) == SQLITE_OK {
                        sqlite3_bind_text(insertLock, 1, (sessionId as NSString).utf8String, -1, nil)
                        sqlite3_bind_text(insertLock, 2, (ownerUid as NSString).utf8String, -1, nil)
                        sqlite3_bind_int64(insertLock, 3, Int64(Date().timeIntervalSince1970 * 1000))
                        let stepRes = sqlite3_step(insertLock)
                        sqlite3_finalize(insertLock)
                        if stepRes != SQLITE_DONE {
                            sqlite3_exec(db, "ROLLBACK;", nil, nil, nil)
                            call.reject("failed_insert_session_lock")
                            return
                        }
                    }
                }
                sqlite3_finalize(stmt)
            }

            receiptObj["localDeviceConflict"] = localDeviceConflict
            if localDeviceConflict, let sig = conflictSig {
                receiptObj["deviceSignature"] = sig
            }

            guard let updatedData = try? JSONSerialization.data(withJSONObject: receiptObj),
                  let updatedStr = String(data: updatedData, encoding: .utf8),
                  let encrypted = try? encryptPayload(updatedStr) else {
                sqlite3_exec(db, "ROLLBACK;", nil, nil, nil)
                call.reject("encryption_failed")
                return
            }

            var insertStmt: OpaquePointer?
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            let status = (receiptObj["status"] as? String) ?? "pending"

            let insertSql = "INSERT OR REPLACE INTO attendance_receipts (request_id, session_id, occurrence_id, owner_uid, status, encrypted_payload, local_device_conflict, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);"
            if sqlite3_prepare_v2(db, insertSql, -1, &insertStmt, nil) == SQLITE_OK {
                sqlite3_bind_text(insertStmt, 1, (requestId as NSString).utf8String, -1, nil)
                sqlite3_bind_text(insertStmt, 2, (sessionId as NSString).utf8String, -1, nil)
                sqlite3_bind_text(insertStmt, 3, (occurrenceId as NSString).utf8String, -1, nil)
                sqlite3_bind_text(insertStmt, 4, (ownerUid as NSString).utf8String, -1, nil)
                sqlite3_bind_text(insertStmt, 5, (status as NSString).utf8String, -1, nil)
                sqlite3_bind_text(insertStmt, 6, (encrypted as NSString).utf8String, -1, nil)
                sqlite3_bind_int(insertStmt, 7, localDeviceConflict ? 1 : 0)
                sqlite3_bind_int64(insertStmt, 8, now)
                sqlite3_bind_int64(insertStmt, 9, now)
                let insertRes = sqlite3_step(insertStmt)
                sqlite3_finalize(insertStmt)
                if insertRes != SQLITE_DONE {
                    sqlite3_exec(db, "ROLLBACK;", nil, nil, nil)
                    call.reject("failed_insert_receipt")
                    return
                }
            } else {
                sqlite3_exec(db, "ROLLBACK;", nil, nil, nil)
                call.reject("failed_prepare_receipt")
                return
            }

            if sqlite3_exec(db, "COMMIT;", nil, nil, nil) != SQLITE_OK {
                sqlite3_exec(db, "ROLLBACK;", nil, nil, nil)
                call.reject("failed_commit_receipt")
                return
            }

            call.resolve([
                "receipt": updatedStr,
                "alreadySaved": false
            ])
        }
    }

    @objc func listReceipts(_ call: CAPPluginCall) {
        let ownerUid = call.getString("ownerUid") ?? ""
        dbQueue.sync {
            guard let db = db else {
                call.resolve(["receipts": []])
                return
            }
            var list: [String] = []
            var stmt: OpaquePointer?
            if sqlite3_prepare_v2(db, "SELECT encrypted_payload FROM attendance_receipts WHERE owner_uid = ? ORDER BY created_at DESC;", -1, &stmt, nil) == SQLITE_OK {
                sqlite3_bind_text(stmt, 1, (ownerUid as NSString).utf8String, -1, nil)
                while sqlite3_step(stmt) == SQLITE_ROW {
                    if let textPtr = sqlite3_column_text(stmt, 0) {
                        let enc = String(cString: textPtr)
                        if let dec = try? decryptPayload(enc) {
                            list.append(dec)
                        }
                    }
                }
                sqlite3_finalize(stmt)
            }
            call.resolve(["receipts": list])
        }
    }

    @objc func getReceipt(_ call: CAPPluginCall) {
        guard let reqId = call.getString("requestId") else {
            call.reject("requestId required")
            return
        }
        dbQueue.sync {
            guard let db = db else {
                call.resolve([:])
                return
            }
            var stmt: OpaquePointer?
            if sqlite3_prepare_v2(db, "SELECT encrypted_payload FROM attendance_receipts WHERE request_id = ? LIMIT 1;", -1, &stmt, nil) == SQLITE_OK {
                sqlite3_bind_text(stmt, 1, (reqId as NSString).utf8String, -1, nil)
                if sqlite3_step(stmt) == SQLITE_ROW {
                    if let textPtr = sqlite3_column_text(stmt, 0) {
                        let enc = String(cString: textPtr)
                        sqlite3_finalize(stmt)
                        let dec = try? decryptPayload(enc)
                        call.resolve(["receipt": dec as Any])
                        return
                    }
                }
                sqlite3_finalize(stmt)
            }
            call.resolve([:])
        }
    }

    @objc func updateReceipt(_ call: CAPPluginCall) {
        guard let reqId = call.getString("requestId"),
              let receiptStr = call.getString("receipt"),
              let enc = try? encryptPayload(receiptStr) else {
            call.reject("invalid_update_parameters")
            return
        }

        dbQueue.sync {
            guard let db = db else {
                call.reject("database_unavailable")
                return
            }
            var stmt: OpaquePointer?
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            if sqlite3_prepare_v2(db, "UPDATE attendance_receipts SET encrypted_payload = ?, updated_at = ? WHERE request_id = ?;", -1, &stmt, nil) == SQLITE_OK {
                sqlite3_bind_text(stmt, 1, (enc as NSString).utf8String, -1, nil)
                sqlite3_bind_int64(stmt, 2, now)
                sqlite3_bind_text(stmt, 3, (reqId as NSString).utf8String, -1, nil)
                let stepRes = sqlite3_step(stmt)
                sqlite3_finalize(stmt)
                if stepRes != SQLITE_DONE {
                    call.reject("failed_update_receipt")
                    return
                }
            }
            call.resolve()
        }
    }

    @objc func transitionReceipt(_ call: CAPPluginCall) {
        guard let requestId = call.getString("requestId"),
              let newStatus = call.getString("status") else {
            call.reject("requestId and status required")
            return
        }
        let resolution = call.getString("resolution")
        let reason = call.getString("reason")
        let recordRevision = call.getInt("recordRevision")

        dbQueue.sync {
            guard let db = db else {
                call.reject("database_unavailable")
                return
            }
            sqlite3_exec(db, "BEGIN EXCLUSIVE TRANSACTION;", nil, nil, nil)
            var stmt: OpaquePointer?
            var existingReceipt: [String: Any]?

            if sqlite3_prepare_v2(db, "SELECT encrypted_payload FROM attendance_receipts WHERE request_id = ? LIMIT 1;", -1, &stmt, nil) == SQLITE_OK {
                sqlite3_bind_text(stmt, 1, (requestId as NSString).utf8String, -1, nil)
                if sqlite3_step(stmt) == SQLITE_ROW, let textPtr = sqlite3_column_text(stmt, 0) {
                    let enc = String(cString: textPtr)
                    if let dec = try? decryptPayload(enc),
                       let data = dec.data(using: .utf8),
                       let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                        existingReceipt = obj
                    }
                }
                sqlite3_finalize(stmt)
            }

            guard var receipt = existingReceipt else {
                sqlite3_exec(db, "ROLLBACK;", nil, nil, nil)
                call.reject("receipt_not_found")
                return
            }

            let curRev = receipt["recordRevision"] as? Int ?? 0
            if let rev = recordRevision, curRev > rev {
                // Reject revision regression
                sqlite3_exec(db, "COMMIT;", nil, nil, nil)
                if let data = try? JSONSerialization.data(withJSONObject: receipt),
                   let str = String(data: data, encoding: .utf8) {
                    call.resolve(["receipt": str])
                } else {
                    call.resolve([:])
                }
                return
            }

            receipt["status"] = newStatus
            if let res = resolution { receipt["resolution"] = res }
            if let r = reason { receipt["reason"] = r }
            if let rev = recordRevision { receipt["recordRevision"] = rev }
            receipt["updatedAt"] = Int64(Date().timeIntervalSince1970 * 1000)

            guard let updatedData = try? JSONSerialization.data(withJSONObject: receipt),
                  let updatedStr = String(data: updatedData, encoding: .utf8),
                  let enc = try? encryptPayload(updatedStr) else {
                sqlite3_exec(db, "ROLLBACK;", nil, nil, nil)
                call.reject("payload_encryption_failed")
                return
            }

            let now = Int64(Date().timeIntervalSince1970 * 1000)
            if sqlite3_prepare_v2(db, "UPDATE attendance_receipts SET status = ?, encrypted_payload = ?, updated_at = ? WHERE request_id = ?;", -1, &stmt, nil) == SQLITE_OK {
                sqlite3_bind_text(stmt, 1, (newStatus as NSString).utf8String, -1, nil)
                sqlite3_bind_text(stmt, 2, (enc as NSString).utf8String, -1, nil)
                sqlite3_bind_int64(stmt, 3, now)
                sqlite3_bind_text(stmt, 4, (requestId as NSString).utf8String, -1, nil)
                sqlite3_step(stmt)
                sqlite3_finalize(stmt)
            }

            sqlite3_exec(db, "COMMIT;", nil, nil, nil)
            call.resolve(["receipt": updatedStr])
        }
    }

    @objc func acquireUploadLease(_ call: CAPPluginCall) {
        let ownerUid = call.getString("ownerUid") ?? ""
        let limit = call.getInt("limit") ?? 25
        let durationMs = Int64(call.getInt("leaseDurationMs") ?? 60000)
        let leaseId = UUID().uuidString
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let expiresAt = now + durationMs

        dbQueue.sync {
            guard let db = db else {
                call.reject("database_unavailable")
                return
            }
            sqlite3_exec(db, "BEGIN EXCLUSIVE TRANSACTION;", nil, nil, nil)

            var reqIds: [String] = []
            var receipts: [String] = []
            var stmt: OpaquePointer?

            let query = ownerUid.isEmpty
                ? "SELECT request_id, encrypted_payload FROM attendance_receipts WHERE status IN ('pending', 'syncing', 'waiting_for_login') AND (lease_id IS NULL OR lease_expires_at < ?) ORDER BY created_at ASC LIMIT ?;"
                : "SELECT request_id, encrypted_payload FROM attendance_receipts WHERE owner_uid = ? AND status IN ('pending', 'syncing', 'waiting_for_login') AND (lease_id IS NULL OR lease_expires_at < ?) ORDER BY created_at ASC LIMIT ?;"

            if sqlite3_prepare_v2(db, query, -1, &stmt, nil) == SQLITE_OK {
                var bindIdx: Int32 = 1
                if !ownerUid.isEmpty {
                    sqlite3_bind_text(stmt, bindIdx, (ownerUid as NSString).utf8String, -1, nil)
                    bindIdx += 1
                }
                sqlite3_bind_int64(stmt, bindIdx, now)
                bindIdx += 1
                sqlite3_bind_int(stmt, bindIdx, Int32(limit))

                while sqlite3_step(stmt) == SQLITE_ROW {
                    if let idPtr = sqlite3_column_text(stmt, 0), let payPtr = sqlite3_column_text(stmt, 1) {
                        let id = String(cString: idPtr)
                        let enc = String(cString: payPtr)
                        if let dec = try? decryptPayload(enc) {
                            reqIds.append(id)
                            receipts.append(dec)
                        }
                    }
                }
                sqlite3_finalize(stmt)
            }

            for id in reqIds {
                var updateStmt: OpaquePointer?
                if sqlite3_prepare_v2(db, "UPDATE attendance_receipts SET lease_id = ?, lease_expires_at = ?, status = 'syncing', updated_at = ? WHERE request_id = ?;", -1, &updateStmt, nil) == SQLITE_OK {
                    sqlite3_bind_text(updateStmt, 1, (leaseId as NSString).utf8String, -1, nil)
                    sqlite3_bind_int64(updateStmt, 2, expiresAt)
                    sqlite3_bind_int64(updateStmt, 3, now)
                    sqlite3_bind_text(updateStmt, 4, (id as NSString).utf8String, -1, nil)
                    sqlite3_step(updateStmt)
                    sqlite3_finalize(updateStmt)
                }
            }

            sqlite3_exec(db, "COMMIT;", nil, nil, nil)
            call.resolve([
                "leaseId": leaseId,
                "receipts": receipts
            ])
        }
    }

    @objc func acknowledgeBatch(_ call: CAPPluginCall) {
        guard let acks = call.getArray("acknowledgements") as? [[String: Any]] else {
            call.reject("acknowledgements array required")
            return
        }

        dbQueue.sync {
            guard let db = db else {
                call.reject("database_unavailable")
                return
            }
            sqlite3_exec(db, "BEGIN EXCLUSIVE TRANSACTION;", nil, nil, nil)
            let now = Int64(Date().timeIntervalSince1970 * 1000)

            for ack in acks {
                guard let reqId = ack["requestId"] as? String,
                      let resolution = ack["resolution"] as? String else { continue }
                let reason = ack["reason"] as? String
                let recordId = ack["recordId"] as? String
                let recordRevision = ack["recordRevision"] as? Int

                let newStatus: String
                if resolution == "confirmed" || resolution == "already_recorded" {
                    newStatus = "confirmed"
                } else if resolution == "needs_review" {
                    newStatus = "review"
                } else if resolution == "invalid_evidence" {
                    newStatus = "invalid"
                } else {
                    newStatus = "pending"
                }

                var selectStmt: OpaquePointer?
                var existingObj: [String: Any]?
                if sqlite3_prepare_v2(db, "SELECT encrypted_payload FROM attendance_receipts WHERE request_id = ? LIMIT 1;", -1, &selectStmt, nil) == SQLITE_OK {
                    sqlite3_bind_text(selectStmt, 1, (reqId as NSString).utf8String, -1, nil)
                    if sqlite3_step(selectStmt) == SQLITE_ROW, let ptr = sqlite3_column_text(selectStmt, 0) {
                        let enc = String(cString: ptr)
                        if let dec = try? decryptPayload(enc),
                           let data = dec.data(using: .utf8),
                           let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                            existingObj = parsed
                        }
                    }
                    sqlite3_finalize(selectStmt)
                }

                if var receipt = existingObj {
                    let curRev = receipt["recordRevision"] as? Int ?? 0
                    if let rev = recordRevision, curRev > rev {
                        // Monotonic revision check: skip if older
                        continue
                    }
                    receipt["status"] = newStatus
                    receipt["resolution"] = resolution
                    if let r = reason { receipt["reason"] = r }
                    if let rid = recordId { receipt["recordId"] = rid }
                    if let rev = recordRevision { receipt["recordRevision"] = rev }
                    receipt["updatedAt"] = now

                    if let updatedData = try? JSONSerialization.data(withJSONObject: receipt),
                       let updatedStr = String(data: updatedData, encoding: .utf8),
                       let enc = try? encryptPayload(updatedStr) {
                        var updateStmt: OpaquePointer?
                        if sqlite3_prepare_v2(db, "UPDATE attendance_receipts SET status = ?, encrypted_payload = ?, lease_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE request_id = ?;", -1, &updateStmt, nil) == SQLITE_OK {
                            sqlite3_bind_text(updateStmt, 1, (newStatus as NSString).utf8String, -1, nil)
                            sqlite3_bind_text(updateStmt, 2, (enc as NSString).utf8String, -1, nil)
                            sqlite3_bind_int64(updateStmt, 3, now)
                            sqlite3_bind_text(updateStmt, 4, (reqId as NSString).utf8String, -1, nil)
                            sqlite3_step(updateStmt)
                            sqlite3_finalize(updateStmt)
                        }
                    }
                }
            }

            sqlite3_exec(db, "COMMIT;", nil, nil, nil)
            call.resolve()
        }
    }

    @objc func releaseUploadLease(_ call: CAPPluginCall) {
        guard let leaseId = call.getString("leaseId") else {
            call.reject("leaseId required")
            return
        }
        dbQueue.sync {
            guard let db = db else {
                call.resolve()
                return
            }
            var stmt: OpaquePointer?
            if sqlite3_prepare_v2(db, "UPDATE attendance_receipts SET lease_id = NULL, lease_expires_at = NULL, status = 'pending' WHERE lease_id = ?;", -1, &stmt, nil) == SQLITE_OK {
                sqlite3_bind_text(stmt, 1, (leaseId as NSString).utf8String, -1, nil)
                sqlite3_step(stmt)
                sqlite3_finalize(stmt)
            }
            call.resolve()
        }
    }

    @objc func getMetadata(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("key parameter required")
            return
        }
        let ownerUid = call.getString("ownerUid")

        dbQueue.sync {
            guard let db = db else {
                call.resolve(["value": NSNull()])
                return
            }
            var stmt: OpaquePointer?
            let query = (ownerUid != nil && !ownerUid!.isEmpty)
                ? "SELECT encrypted_value FROM attendance_meta WHERE key = ? AND (owner_uid = ? OR owner_uid IS NULL) LIMIT 1;"
                : "SELECT encrypted_value FROM attendance_meta WHERE key = ? LIMIT 1;"

            if sqlite3_prepare_v2(db, query, -1, &stmt, nil) == SQLITE_OK {
                sqlite3_bind_text(stmt, 1, (key as NSString).utf8String, -1, nil)
                if ownerUid != nil && !ownerUid!.isEmpty {
                    sqlite3_bind_text(stmt, 2, (ownerUid! as NSString).utf8String, -1, nil)
                }
                if sqlite3_step(stmt) == SQLITE_ROW, let textPtr = sqlite3_column_text(stmt, 0) {
                    let enc = String(cString: textPtr)
                    sqlite3_finalize(stmt)
                    if let dec = try? decryptPayload(enc) {
                        call.resolve(["value": dec])
                        return
                    }
                }
                sqlite3_finalize(stmt)
            }
            call.resolve(["value": NSNull()])
        }
    }

    @objc func setMetadata(_ call: CAPPluginCall) {
        guard let key = call.getString("key"),
              let value = call.getString("value"),
              let enc = try? encryptPayload(value) else {
            call.reject("invalid_metadata_parameters")
            return
        }
        let ownerUid = call.getString("ownerUid")

        dbQueue.sync {
            guard let db = db else {
                call.reject("database_unavailable")
                return
            }
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            var stmt: OpaquePointer?
            let query = "INSERT OR REPLACE INTO attendance_meta (key, owner_uid, encrypted_value, updated_at) VALUES (?, ?, ?, ?);"
            if sqlite3_prepare_v2(db, query, -1, &stmt, nil) == SQLITE_OK {
                sqlite3_bind_text(stmt, 1, (key as NSString).utf8String, -1, nil)
                if let uid = ownerUid, !uid.isEmpty {
                    sqlite3_bind_text(stmt, 2, (uid as NSString).utf8String, -1, nil)
                } else {
                    sqlite3_bind_null(stmt, 2)
                }
                sqlite3_bind_text(stmt, 3, (enc as NSString).utf8String, -1, nil)
                sqlite3_bind_int64(stmt, 4, now)
                let stepRes = sqlite3_step(stmt)
                sqlite3_finalize(stmt)
                if stepRes != SQLITE_DONE {
                    call.reject("failed_save_metadata")
                    return
                }
            }
            call.resolve()
        }
    }

    @objc func deleteMetadata(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("key parameter required")
            return
        }
        dbQueue.sync {
            guard let db = db else {
                call.resolve()
                return
            }
            var stmt: OpaquePointer?
            if sqlite3_prepare_v2(db, "DELETE FROM attendance_meta WHERE key = ?;", -1, &stmt, nil) == SQLITE_OK {
                sqlite3_bind_text(stmt, 1, (key as NSString).utf8String, -1, nil)
                sqlite3_step(stmt)
                sqlite3_finalize(stmt)
            }
            call.resolve()
        }
    }

    @objc func commitDoctorSession(_ call: CAPPluginCall) {
        guard let metaKey = call.getString("metaKey"),
              let metaData = call.getString("metaData"),
              let cmdStr = call.getString("command"),
              let cmdData = cmdStr.data(using: .utf8),
              var cmdObj = try? JSONSerialization.jsonObject(with: cmdData) as? [String: Any] else {
            call.reject("invalid_commit_parameters")
            return
        }

        dbQueue.sync {
            guard let db = db else {
                call.reject("database_unavailable")
                return
            }
            sqlite3_exec(db, "BEGIN EXCLUSIVE TRANSACTION;", nil, nil, nil)
            var seq: Int64 = 1
            var stmt: OpaquePointer?
            if sqlite3_prepare_v2(db, "SELECT encrypted_value FROM attendance_meta WHERE key = 'attendance-command-sequence' LIMIT 1;", -1, &stmt, nil) == SQLITE_OK {
                if sqlite3_step(stmt) == SQLITE_ROW, let textPtr = sqlite3_column_text(stmt, 0) {
                    let enc = String(cString: textPtr)
                    if let dec = try? decryptPayload(enc), let val = Int64(dec) {
                        seq = val + 1
                    }
                }
                sqlite3_finalize(stmt)
            }

            let now = Int64(Date().timeIntervalSince1970 * 1000)
            if let encSeq = try? encryptPayload(String(seq)) {
                var metaStmt: OpaquePointer?
                if sqlite3_prepare_v2(db, "INSERT OR REPLACE INTO attendance_meta (key, owner_uid, encrypted_value, updated_at) VALUES (?, NULL, ?, ?);", -1, &metaStmt, nil) == SQLITE_OK {
                    sqlite3_bind_text(metaStmt, 1, "attendance-command-sequence", -1, nil)
                    sqlite3_bind_text(metaStmt, 2, (encSeq as NSString).utf8String, -1, nil)
                    sqlite3_bind_int64(metaStmt, 3, now)
                    sqlite3_step(metaStmt)
                    sqlite3_finalize(metaStmt)
                }
            }

            let ownerUid = cmdObj["ownerUid"] as? String ?? ""
            if let encMeta = try? encryptPayload(metaData) {
                var metaStmt: OpaquePointer?
                if sqlite3_prepare_v2(db, "INSERT OR REPLACE INTO attendance_meta (key, owner_uid, encrypted_value, updated_at) VALUES (?, ?, ?, ?);", -1, &metaStmt, nil) == SQLITE_OK {
                    sqlite3_bind_text(metaStmt, 1, (metaKey as NSString).utf8String, -1, nil)
                    sqlite3_bind_text(metaStmt, 2, (ownerUid as NSString).utf8String, -1, nil)
                    sqlite3_bind_text(metaStmt, 3, (encMeta as NSString).utf8String, -1, nil)
                    sqlite3_bind_int64(metaStmt, 4, now)
                    sqlite3_step(metaStmt)
                    sqlite3_finalize(metaStmt)
                }
            }

            cmdObj["localOrder"] = seq
            guard let updatedCmdData = try? JSONSerialization.data(withJSONObject: cmdObj),
                  let updatedCmdStr = String(data: updatedCmdData, encoding: .utf8),
                  let enc = try? encryptPayload(updatedCmdStr) else {
                sqlite3_exec(db, "ROLLBACK;", nil, nil, nil)
                call.reject("encryption_failed")
                return
            }

            let reqId = cmdObj["requestId"] as? String ?? ""
            let status = cmdObj["status"] as? String ?? "pending"

            var cmdStmt: OpaquePointer?
            if sqlite3_prepare_v2(db, "INSERT OR REPLACE INTO attendance_commands (request_id, owner_uid, status, local_order, encrypted_payload, created_at) VALUES (?, ?, ?, ?, ?, ?);", -1, &cmdStmt, nil) == SQLITE_OK {
                sqlite3_bind_text(cmdStmt, 1, (reqId as NSString).utf8String, -1, nil)
                sqlite3_bind_text(cmdStmt, 2, (ownerUid as NSString).utf8String, -1, nil)
                sqlite3_bind_text(cmdStmt, 3, (status as NSString).utf8String, -1, nil)
                sqlite3_bind_int64(cmdStmt, 4, seq)
                sqlite3_bind_text(cmdStmt, 5, (enc as NSString).utf8String, -1, nil)
                sqlite3_bind_int64(cmdStmt, 6, now)
                sqlite3_step(cmdStmt)
                sqlite3_finalize(cmdStmt)
            }

            sqlite3_exec(db, "COMMIT;", nil, nil, nil)
            call.resolve()
        }
    }

    @objc func enqueueDoctorCommand(_ call: CAPPluginCall) {
        guard let cmdStr = call.getString("command"),
              let cmdData = cmdStr.data(using: .utf8),
              let cmdObj = try? JSONSerialization.jsonObject(with: cmdData) as? [String: Any],
              let enc = try? encryptPayload(cmdStr) else {
            call.reject("command parameter required")
            return
        }

        let reqId = cmdObj["requestId"] as? String ?? ""
        let ownerUid = cmdObj["ownerUid"] as? String ?? ""
        let status = cmdObj["status"] as? String ?? "pending"
        let order = Int64(cmdObj["localOrder"] as? Int ?? 0)
        let now = Int64(Date().timeIntervalSince1970 * 1000)

        dbQueue.sync {
            guard let db = db else {
                call.reject("database_unavailable")
                return
            }
            var cmdStmt: OpaquePointer?
            if sqlite3_prepare_v2(db, "INSERT OR REPLACE INTO attendance_commands (request_id, owner_uid, status, local_order, encrypted_payload, created_at) VALUES (?, ?, ?, ?, ?, ?);", -1, &cmdStmt, nil) == SQLITE_OK {
                sqlite3_bind_text(cmdStmt, 1, (reqId as NSString).utf8String, -1, nil)
                sqlite3_bind_text(cmdStmt, 2, (ownerUid as NSString).utf8String, -1, nil)
                sqlite3_bind_text(cmdStmt, 3, (status as NSString).utf8String, -1, nil)
                sqlite3_bind_int64(cmdStmt, 4, order)
                sqlite3_bind_text(cmdStmt, 5, (enc as NSString).utf8String, -1, nil)
                sqlite3_bind_int64(cmdStmt, 6, now)
                sqlite3_step(cmdStmt)
                sqlite3_finalize(cmdStmt)
            }
            call.resolve()
        }
    }

    @objc func listDoctorCommands(_ call: CAPPluginCall) {
        let ownerUid = call.getString("ownerUid") ?? ""
        dbQueue.sync {
            guard let db = db else {
                call.resolve(["commands": []])
                return
            }
            var list: [String] = []
            var stmt: OpaquePointer?
            if sqlite3_prepare_v2(db, "SELECT encrypted_payload FROM attendance_commands WHERE owner_uid = ? ORDER BY local_order ASC;", -1, &stmt, nil) == SQLITE_OK {
                sqlite3_bind_text(stmt, 1, (ownerUid as NSString).utf8String, -1, nil)
                while sqlite3_step(stmt) == SQLITE_ROW {
                    if let textPtr = sqlite3_column_text(stmt, 0) {
                        let enc = String(cString: textPtr)
                        if let dec = try? decryptPayload(enc) {
                            list.append(dec)
                        }
                    }
                }
                sqlite3_finalize(stmt)
            }
            call.resolve(["commands": list])
        }
    }

    @objc func updateDoctorCommand(_ call: CAPPluginCall) {
        enqueueDoctorCommand(call)
    }

    @objc func recoverInterruptedWork(_ call: CAPPluginCall) {
        dbQueue.sync {
            guard let db = db else {
                call.resolve()
                return
            }
            // Recover any expired or abandoned upload leases
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            var stmt: OpaquePointer?
            if sqlite3_prepare_v2(db, "UPDATE attendance_receipts SET lease_id = NULL, lease_expires_at = NULL, status = 'pending' WHERE lease_expires_at < ?;", -1, &stmt, nil) == SQLITE_OK {
                sqlite3_bind_int64(stmt, 1, now)
                sqlite3_step(stmt)
                sqlite3_finalize(stmt)
            }
            call.resolve()
        }
    }

    @objc func getPublicIdentity(_ call: CAPPluginCall) {
        do {
            let key = try getSigningPrivateKey()
            let x963 = key.publicKey.x963Representation
            guard x963.count == 65 && x963[0] == 0x04 else {
                throw NSError(domain: "attendance", code: -1, userInfo: [
                    NSLocalizedDescriptionKey: "Invalid X9.63 public key length or prefix"
                ])
            }
            let xData = x963.subdata(in: 1..<33)
            let yData = x963.subdata(in: 33..<65)
            let xStr = base64Url(xData)
            let yStr = base64Url(yData)

            let jwk: [String: Any] = [
                "kty": "EC",
                "crv": "P-256",
                "x": xStr,
                "y": yStr
            ]
            let fingerprint = "[\"P-256\",\"\(xStr)\",\"\(yStr)\"]"

            call.resolve([
                "fingerprint": fingerprint,
                "publicKey": jwk,
                "installationId": getOrCreateInstallationId()
            ])
        } catch {
            call.reject("Failed to obtain public identity: \(error.localizedDescription)")
        }
    }

    @objc func signReceipt(_ call: CAPPluginCall) {
        let messageToSign: String
        if let explicitMsg = call.getString("message") {
            messageToSign = explicitMsg
        } else if let receiptStr = call.getString("receipt"),
                  let receiptData = receiptStr.data(using: .utf8),
                  let receipt = try? JSONSerialization.jsonObject(with: receiptData) as? [String: Any] {
            let arr: [Any] = [
                receipt["requestId"] as? String ?? "",
                receipt["ownerUid"] as? String ?? "",
                receipt["sessionId"] as? String ?? "",
                receipt["occurrenceId"] as? String ?? "",
                receipt["qrToken"] as? String ?? "",
                receipt["installationId"] as? String ?? "",
                (receipt["localDeviceConflict"] as? Bool) == true
            ]
            if let arrData = try? JSONSerialization.data(withJSONObject: arr, options: []),
               let arrStr = String(data: arrData, encoding: .utf8) {
                messageToSign = arrStr
            } else {
                call.reject("invalid_receipt_encoding")
                return
            }
        } else {
            call.reject("receipt or message parameter required")
            return
        }

        do {
            let key = try getSigningPrivateKey()
            let sig = try key.signature(for: SHA256.hash(data: Data(messageToSign.utf8)))
            call.resolve(["signature": base64Url(sig.rawRepresentation)])
        } catch {
            call.reject("signReceipt failed: \(error.localizedDescription)")
        }
    }

    @objc func signDoctorQr(_ call: CAPPluginCall) {
        var permit = call.getString("permit") ?? ""
        guard let claimsStr = call.getString("claims"),
              let claimsData = claimsStr.data(using: .utf8),
              var claims = try? JSONSerialization.jsonObject(with: claimsData) as? [String: Any] else {
            call.reject("claims parameter required")
            return
        }

        if permit.isEmpty {
            permit = claims["permit"] as? String ?? ""
        }
        claims.removeValue(forKey: "permit")

        let headerObj: [String: Any] = ["alg": "ES256", "typ": "JWT", "permit": permit]
        guard let headerData = try? JSONSerialization.data(withJSONObject: headerObj),
              let claimsCleanData = try? JSONSerialization.data(withJSONObject: claims) else {
            call.reject("failed header or claims encoding")
            return
        }

        let encodedHeader = base64Url(headerData)
        let encodedClaims = base64Url(claimsCleanData)
        let message = "\(encodedHeader).\(encodedClaims)"

        do {
            let key = try getSigningPrivateKey()
            let sig = try key.signature(for: SHA256.hash(data: Data(message.utf8)))
            let token = "\(message).\(base64Url(sig.rawRepresentation))"

            guard token.utf8.count <= 2330 else {
                call.reject("doctor_qr_payload_exceeds_limit")
                return
            }

            call.resolve(["signature": token])
        } catch {
            call.reject("signDoctorQr failed: \(error.localizedDescription)")
        }
    }

    @objc func signRotationMessage(_ call: CAPPluginCall) {
        guard let message = call.getString("message") else {
            call.reject("message parameter required")
            return
        }
        do {
            let key = try getSigningPrivateKey()
            let sig = try key.signature(for: SHA256.hash(data: Data(message.utf8)))
            call.resolve(["signature": base64Url(sig.rawRepresentation)])
        } catch {
            call.reject("signRotationMessage failed: \(error.localizedDescription)")
        }
    }

    @objc func migrateLegacyData(_ call: CAPPluginCall) {
        let receipts = call.getArray("receipts", String.self) ?? []
        let locks = call.getArray("locks", String.self) ?? []
        let commands = call.getArray("commands", String.self) ?? []
        let meta = call.getArray("meta", String.self) ?? []

        dbQueue.sync {
            guard let db = db else {
                call.reject("database_unavailable")
                return
            }

            sqlite3_exec(db, "BEGIN EXCLUSIVE TRANSACTION;", nil, nil, nil)
            var count = 0
            let now = Int64(Date().timeIntervalSince1970 * 1000)

            for rStr in receipts {
                if let rData = rStr.data(using: .utf8),
                   let r = try? JSONSerialization.jsonObject(with: rData) as? [String: Any],
                   let enc = try? encryptPayload(rStr) {
                    let reqId = r["requestId"] as? String ?? ""
                    let sId = r["sessionId"] as? String ?? ""
                    let oId = r["occurrenceId"] as? String ?? ""
                    let uId = r["ownerUid"] as? String ?? ""
                    let status = r["status"] as? String ?? "pending"
                    let conflict = (r["localDeviceConflict"] as? Bool ?? false) ? 1 : 0

                    var stmt: OpaquePointer?
                    let sql = "INSERT OR IGNORE INTO attendance_receipts (request_id, session_id, occurrence_id, owner_uid, status, encrypted_payload, local_device_conflict, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);"
                    if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
                        sqlite3_bind_text(stmt, 1, (reqId as NSString).utf8String, -1, nil)
                        sqlite3_bind_text(stmt, 2, (sId as NSString).utf8String, -1, nil)
                        sqlite3_bind_text(stmt, 3, (oId as NSString).utf8String, -1, nil)
                        sqlite3_bind_text(stmt, 4, (uId as NSString).utf8String, -1, nil)
                        sqlite3_bind_text(stmt, 5, (status as NSString).utf8String, -1, nil)
                        sqlite3_bind_text(stmt, 6, (enc as NSString).utf8String, -1, nil)
                        sqlite3_bind_int(stmt, 7, Int32(conflict))
                        sqlite3_bind_int64(stmt, 8, now)
                        sqlite3_bind_int64(stmt, 9, now)
                        if sqlite3_step(stmt) == SQLITE_DONE {
                            count += 1
                        }
                        sqlite3_finalize(stmt)
                    }
                }
            }

            for lStr in locks {
                if let lData = lStr.data(using: .utf8),
                   let l = try? JSONSerialization.jsonObject(with: lData) as? [String: Any] {
                    let sId = l["sessionId"] as? String ?? ""
                    let uId = l["ownerUid"] as? String ?? ""
                    var stmt: OpaquePointer?
                    if sqlite3_prepare_v2(db, "INSERT OR IGNORE INTO attendance_locks (session_id, owner_uid, created_at) VALUES (?, ?, ?);", -1, &stmt, nil) == SQLITE_OK {
                        sqlite3_bind_text(stmt, 1, (sId as NSString).utf8String, -1, nil)
                        sqlite3_bind_text(stmt, 2, (uId as NSString).utf8String, -1, nil)
                        sqlite3_bind_int64(stmt, 3, now)
                        sqlite3_step(stmt)
                        sqlite3_finalize(stmt)
                    }
                }
            }

            for cStr in commands {
                if let cData = cStr.data(using: .utf8),
                   let c = try? JSONSerialization.jsonObject(with: cData) as? [String: Any],
                   let enc = try? encryptPayload(cStr) {
                    let reqId = c["requestId"] as? String ?? ""
                    let uId = c["ownerUid"] as? String ?? ""
                    let status = c["status"] as? String ?? "pending"
                    let order = Int64(c["localOrder"] as? Int ?? 0)
                    var stmt: OpaquePointer?
                    if sqlite3_prepare_v2(db, "INSERT OR IGNORE INTO attendance_commands (request_id, owner_uid, status, local_order, encrypted_payload, created_at) VALUES (?, ?, ?, ?, ?, ?);", -1, &stmt, nil) == SQLITE_OK {
                        sqlite3_bind_text(stmt, 1, (reqId as NSString).utf8String, -1, nil)
                        sqlite3_bind_text(stmt, 2, (uId as NSString).utf8String, -1, nil)
                        sqlite3_bind_text(stmt, 3, (status as NSString).utf8String, -1, nil)
                        sqlite3_bind_int64(stmt, 4, order)
                        sqlite3_bind_text(stmt, 5, (enc as NSString).utf8String, -1, nil)
                        sqlite3_bind_int64(stmt, 6, now)
                        sqlite3_step(stmt)
                        sqlite3_finalize(stmt)
                    }
                }
            }

            for mStr in meta {
                if let mData = mStr.data(using: .utf8),
                   let m = try? JSONSerialization.jsonObject(with: mData) as? [String: Any],
                   let enc = try? encryptPayload(mStr) {
                    let k = m["key"] as? String ?? ""
                    let uId = m["ownerUid"] as? String
                    var stmt: OpaquePointer?
                    if sqlite3_prepare_v2(db, "INSERT OR REPLACE INTO attendance_meta (key, owner_uid, encrypted_value, updated_at) VALUES (?, ?, ?, ?);", -1, &stmt, nil) == SQLITE_OK {
                        sqlite3_bind_text(stmt, 1, (k as NSString).utf8String, -1, nil)
                        if let uid = uId, !uid.isEmpty {
                            sqlite3_bind_text(stmt, 2, (uid as NSString).utf8String, -1, nil)
                        } else {
                            sqlite3_bind_null(stmt, 2)
                        }
                        sqlite3_bind_text(stmt, 3, (enc as NSString).utf8String, -1, nil)
                        sqlite3_bind_int64(stmt, 4, now)
                        sqlite3_step(stmt)
                        sqlite3_finalize(stmt)
                    }
                }
            }

            var jnlStmt: OpaquePointer?
            if sqlite3_prepare_v2(db, "INSERT INTO attendance_migration_journal (action, records_count, created_at) VALUES (?, ?, ?);", -1, &jnlStmt, nil) == SQLITE_OK {
                sqlite3_bind_text(jnlStmt, 1, "legacy_indexeddb_migration", -1, nil)
                sqlite3_bind_int64(jnlStmt, 2, Int64(count))
                sqlite3_bind_int64(jnlStmt, 3, now)
                sqlite3_step(jnlStmt)
                sqlite3_finalize(jnlStmt)
            }

            sqlite3_exec(db, "COMMIT;", nil, nil, nil)
            call.resolve(["migratedCount": count])
        }
    }
}
