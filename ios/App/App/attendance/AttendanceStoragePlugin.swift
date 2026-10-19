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

    public override func load() {
        super.load()
        setupDatabase()
    }

    private func setupDatabase() {
        guard let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return }
        try? FileManager.default.createDirectory(at: appSupport, withIntermediateDirectories: true, attributes: [
            FileAttributeKey.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication
        ])
        let dbPath = appSupport.appendingPathComponent("attendance_native.sqlite").path

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
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS attendance_migration_journal (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                action TEXT NOT NULL,
                records_count INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            );
            """
            sqlite3_exec(db, createTables, nil, nil, nil)
        }
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

        let key = P256.Signing.PrivateKey()
        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: signingKeyAccount,
            kSecValueData as String: key.rawRepresentation,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        SecItemAdd(addQuery as CFDictionary, nil)
        return key
    }

    private func getPayloadKey() -> SymmetricKey {
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

        let key = SymmetricKey(size: .bits256)
        let keyData = key.withUnsafeBytes { Data($0) }
        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: payloadKeyAccount,
            kSecValueData as String: keyData,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        SecItemAdd(addQuery as CFDictionary, nil)
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
        let key = getPayloadKey()
        let sealed = try AES.GCM.seal(Data(plaintext.utf8), using: key)
        guard let combined = sealed.combined else { throw NSError(domain: "attendance", code: -1) }
        return combined.base64EncodedString()
    }

    private func decryptPayload(_ ciphertextBase64: String) throws -> String {
        guard let data = Data(base64Encoded: ciphertextBase64) else { throw NSError(domain: "attendance", code: -1) }
        let key = getPayloadKey()
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
        setupDatabase()
        call.resolve([
            "storageType": "native_sqlite",
            "isDurable": true,
            "unresolvedReceiptsCount": 0,
            "unresolvedCommandsCount": 0
        ])
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

        sqlite3_exec(db, "BEGIN EXCLUSIVE TRANSACTION;", nil, nil, nil)

        // 1. Check duplicate
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

        // 2. Check lock
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
                    sqlite3_step(insertLock)
                    sqlite3_finalize(insertLock)
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
            call.reject("encryption failed")
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
            sqlite3_step(insertStmt)
            sqlite3_finalize(insertStmt)
        }

        sqlite3_exec(db, "COMMIT;", nil, nil, nil)
        call.resolve([
            "receipt": updatedStr,
            "alreadySaved": false
        ])
    }

    @objc func listReceipts(_ call: CAPPluginCall) {
        let ownerUid = call.getString("ownerUid") ?? ""
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

    @objc func getReceipt(_ call: CAPPluginCall) {
        guard let reqId = call.getString("requestId") else {
            call.reject("requestId required")
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

    @objc func commitDoctorSession(_ call: CAPPluginCall) {
        guard let metaKey = call.getString("metaKey"),
              let metaData = call.getString("metaData"),
              let cmdStr = call.getString("command"),
              let cmdData = cmdStr.data(using: .utf8),
              var cmdObj = try? JSONSerialization.jsonObject(with: cmdData) as? [String: Any] else {
            call.reject("invalid_commit_parameters")
            return
        }

        sqlite3_exec(db, "BEGIN EXCLUSIVE TRANSACTION;", nil, nil, nil)
        var seq: Int64 = 1
        var stmt: OpaquePointer?
        if sqlite3_prepare_v2(db, "SELECT value FROM attendance_meta WHERE key = 'attendance-command-sequence' LIMIT 1;", -1, &stmt, nil) == SQLITE_OK {
            if sqlite3_step(stmt) == SQLITE_ROW, let textPtr = sqlite3_column_text(stmt, 0) {
                seq = (Int64(String(cString: textPtr)) ?? 0) + 1
            }
            sqlite3_finalize(stmt)
        }

        var metaStmt: OpaquePointer?
        if sqlite3_prepare_v2(db, "INSERT OR REPLACE INTO attendance_meta (key, value) VALUES (?, ?);", -1, &metaStmt, nil) == SQLITE_OK {
            sqlite3_bind_text(metaStmt, 1, "attendance-command-sequence", -1, nil)
            sqlite3_bind_text(metaStmt, 2, String(seq), -1, nil)
            sqlite3_step(metaStmt)
            sqlite3_finalize(metaStmt)
        }

        if sqlite3_prepare_v2(db, "INSERT OR REPLACE INTO attendance_meta (key, value) VALUES (?, ?);", -1, &metaStmt, nil) == SQLITE_OK {
            sqlite3_bind_text(metaStmt, 1, (metaKey as NSString).utf8String, -1, nil)
            sqlite3_bind_text(metaStmt, 2, (metaData as NSString).utf8String, -1, nil)
            sqlite3_step(metaStmt)
            sqlite3_finalize(metaStmt)
        }

        cmdObj["localOrder"] = seq
        guard let updatedCmdData = try? JSONSerialization.data(withJSONObject: cmdObj),
              let updatedCmdStr = String(data: updatedCmdData, encoding: .utf8),
              let enc = try? encryptPayload(updatedCmdStr) else {
            sqlite3_exec(db, "ROLLBACK;", nil, nil, nil)
            call.reject("encryption failed")
            return
        }

        let reqId = cmdObj["requestId"] as? String ?? ""
        let ownerUid = cmdObj["ownerUid"] as? String ?? ""
        let status = cmdObj["status"] as? String ?? "pending"
        let now = Int64(Date().timeIntervalSince1970 * 1000)

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

    @objc func listDoctorCommands(_ call: CAPPluginCall) {
        let ownerUid = call.getString("ownerUid") ?? ""
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

    @objc func updateDoctorCommand(_ call: CAPPluginCall) {
        enqueueDoctorCommand(call)
    }

    @objc func updateReceipt(_ call: CAPPluginCall) {
        guard let reqId = call.getString("requestId"),
              let receiptStr = call.getString("receipt"),
              let enc = try? encryptPayload(receiptStr) else {
            call.reject("invalid_update_parameters")
            return
        }

        var stmt: OpaquePointer?
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        if sqlite3_prepare_v2(db, "UPDATE attendance_receipts SET encrypted_payload = ?, updated_at = ? WHERE request_id = ?;", -1, &stmt, nil) == SQLITE_OK {
            sqlite3_bind_text(stmt, 1, (enc as NSString).utf8String, -1, nil)
            sqlite3_bind_int64(stmt, 2, now)
            sqlite3_bind_text(stmt, 3, (reqId as NSString).utf8String, -1, nil)
            sqlite3_step(stmt)
            sqlite3_finalize(stmt)
        }
        call.resolve()
    }

    @objc func recoverInterruptedWork(_ call: CAPPluginCall) {
        call.resolve()
    }

    @objc func getHealth(_ call: CAPPluginCall) {
        call.resolve([
            "storageType": "native_sqlite",
            "isDurable": true,
            "unresolvedReceiptsCount": 0,
            "unresolvedCommandsCount": 0
        ])
    }

    @objc func getPublicIdentity(_ call: CAPPluginCall) {
        do {
            let key = try getSigningPrivateKey()
            let rawPubKey = key.publicKey.rawRepresentation
            let xData = rawPubKey.subdata(in: 1..<33)
            let yData = rawPubKey.subdata(in: 33..<65)
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
        guard let receiptStr = call.getString("receipt"),
              let receiptData = receiptStr.data(using: .utf8),
              let receipt = try? JSONSerialization.jsonObject(with: receiptData) as? [String: Any] else {
            call.reject("receipt parameter required")
            return
        }

        let message = [
            "MYLECTURE_ATTENDANCE_RECEIPT_V1",
            receipt["ownerUid"] as? String ?? "",
            receipt["qrToken"] as? String ?? "",
            receipt["sessionId"] as? String ?? "",
            receipt["occurrenceId"] as? String ?? "",
            receipt["installationId"] as? String ?? "",
            receipt["capturedAtClient"] as? String ?? ""
        ].joined(separator: "\n")

        do {
            let key = try getSigningPrivateKey()
            let sig = try key.signature(for: SHA256.hash(data: Data(message.utf8)))
            call.resolve(["signature": base64Url(sig.rawRepresentation)])
        } catch {
            call.reject("signReceipt failed: \(error.localizedDescription)")
        }
    }

    @objc func signDoctorQr(_ call: CAPPluginCall) {
        guard let claimsStr = call.getString("claims"),
              let claimsData = claimsStr.data(using: .utf8),
              let claims = try? JSONSerialization.jsonObject(with: claimsData) as? [String: Any] else {
            call.reject("claims parameter required")
            return
        }

        let permit = claims["permit"] as? String ?? ""
        let headerObj: [String: Any] = ["alg": "ES256", "typ": "JWT", "permit": permit]
        guard let headerData = try? JSONSerialization.data(withJSONObject: headerObj) else {
            call.reject("failed header encoding")
            return
        }

        let encodedHeader = base64Url(headerData)
        let encodedClaims = base64Url(claimsData)
        let message = "\(encodedHeader).\(encodedClaims)"

        do {
            let key = try getSigningPrivateKey()
            let sig = try key.signature(for: SHA256.hash(data: Data(message.utf8)))
            let token = "\(message).\(base64Url(sig.rawRepresentation))"
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
                    sqlite3_step(stmt)
                    sqlite3_finalize(stmt)
                    count += 1
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
               let m = try? JSONSerialization.jsonObject(with: mData) as? [String: Any] {
                let k = m["key"] as? String ?? ""
                var stmt: OpaquePointer?
                if sqlite3_prepare_v2(db, "INSERT OR REPLACE INTO attendance_meta (key, value) VALUES (?, ?);", -1, &stmt, nil) == SQLITE_OK {
                    sqlite3_bind_text(stmt, 1, (k as NSString).utf8String, -1, nil)
                    sqlite3_bind_text(stmt, 2, (mStr as NSString).utf8String, -1, nil)
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
