import XCTest
@testable import Mohadaraty

final class MohadaratyMacTests: XCTestCase {
    func testBridgeErrorCarriesStableCode() {
        let error = NativeBridgeFailure("invalid_request", retryable: false)
        XCTAssertEqual(error.code, "invalid_request")
        XCTAssertFalse(error.retryable)
    }

    func testSchemeHandlerCanBeConstructed() {
        XCTAssertNotNil(BundleSchemeHandler())
    }

    func testEncryptedAttendanceRoundTripAndOwnerIsolation() throws {
        let store = AttendanceStore()
        _ = try invoke(store, "initialize", ["ownerUid": "test-owner"])
        let session = "test-session-\(UUID().uuidString)"
        let request = "test-request-\(UUID().uuidString)"
        let receipt: [String: Any] = [
            "requestId": request, "ownerUid": "test-owner", "sessionId": session,
            "occurrenceId": "occurrence", "status": "pending"
        ]
        let captured = try XCTUnwrap(try invoke(store, "capture", ["receipt": receipt]) as? [String: Any])
        XCTAssertEqual(captured["alreadySaved"] as? Bool, false)

        let duplicate = try XCTUnwrap(try invoke(store, "capture", ["receipt": receipt]) as? [String: Any])
        XCTAssertEqual(duplicate["alreadySaved"] as? Bool, true)

        let listed = try XCTUnwrap(try invoke(store, "listReceipts", ["ownerUid": "test-owner"]) as? [[String: Any]])
        XCTAssertTrue(listed.contains { $0["requestId"] as? String == request })
        let other = try XCTUnwrap(try invoke(store, "listReceipts", ["ownerUid": "another-owner"]) as? [[String: Any]])
        XCTAssertFalse(other.contains { $0["requestId"] as? String == request })
    }

    func testCrossAccountSessionLockIsPersisted() throws {
        let store = AttendanceStore()
        _ = try invoke(store, "initialize", ["ownerUid": "owner-a"])
        let session = "locked-session-\(UUID().uuidString)"
        func receipt(_ owner: String) -> [String: Any] {
            ["requestId": UUID().uuidString, "ownerUid": owner, "sessionId": session, "occurrenceId": "occ", "status": "pending"]
        }
        _ = try invoke(store, "capture", ["receipt": receipt("owner-a")])
        let second = try XCTUnwrap(try invoke(store, "capture", ["receipt": receipt("owner-b"), "conflictSignature": "test-signature"]) as? [String: Any])
        let saved = try XCTUnwrap(second["receipt"] as? [String: Any])
        XCTAssertEqual(saved["localDeviceConflict"] as? Bool, true)
        XCTAssertEqual(saved["deviceSignature"] as? String, "test-signature")
    }

    func testMetadataAndSigningIdentityPersist() throws {
        let store = AttendanceStore()
        _ = try invoke(store, "initialize", ["ownerUid": "meta-owner"])
        try invokeVoid(store, "setMetadata", ["key": "offline-pack", "ownerUid": "meta-owner", "data": ["permit": "fixture"]])
        let value = try XCTUnwrap(try invoke(store, "getMetadata", ["key": "offline-pack", "ownerUid": "meta-owner"]) as? [String: Any])
        XCTAssertEqual(value["permit"] as? String, "fixture")
        XCTAssertTrue(try invoke(store, "getMetadata", ["key": "offline-pack", "ownerUid": "different-owner"]) is NSNull)

        let identity = try XCTUnwrap(try invoke(store, "getPublicIdentity", [:]) as? [String: Any])
        XCTAssertFalse((identity["installationId"] as? String ?? "").isEmpty)
        let signed = try XCTUnwrap(try invoke(store, "signRotationMessage", ["message": "fixture-message"]) as? [String: Any])
        XCTAssertFalse((signed["signature"] as? String ?? "").isEmpty)
    }

    private func invoke(_ store: AttendanceStore, _ method: String, _ payload: [String: Any]) throws -> Any {
        let expectation = expectation(description: method)
        var result: Result<Any, Error>?
        store.handle(method: method, payload: payload) { value in result = value; expectation.fulfill() }
        wait(for: [expectation], timeout: 10)
        return try XCTUnwrap(result).get()
    }

    private func invokeVoid(_ store: AttendanceStore, _ method: String, _ payload: [String: Any]) throws {
        _ = try invoke(store, method, payload)
    }
}

