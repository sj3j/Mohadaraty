package com.mohadaraty.app.attendance;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

public class AttendanceDatabaseHelper extends SQLiteOpenHelper {
    private static final String DATABASE_NAME = "attendance_native.db";
    private static final int DATABASE_VERSION = 2;

    public AttendanceDatabaseHelper(Context context) {
        super(context, DATABASE_NAME, null, DATABASE_VERSION);
    }

    @Override
    public void onConfigure(SQLiteDatabase db) {
        super.onConfigure(db);
        db.setForeignKeyConstraintsEnabled(true);
        db.enableWriteAheadLogging();
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE attendance_receipts (" +
            "request_id TEXT PRIMARY KEY, " +
            "session_id TEXT NOT NULL, " +
            "occurrence_id TEXT NOT NULL, " +
            "owner_uid TEXT NOT NULL, " +
            "status TEXT NOT NULL, " +
            "encrypted_payload TEXT NOT NULL, " +
            "local_device_conflict INTEGER NOT NULL DEFAULT 0, " +
            "lease_id TEXT, " +
            "lease_expires_at INTEGER, " +
            "created_at INTEGER NOT NULL, " +
            "updated_at INTEGER NOT NULL" +
            ");");
        db.execSQL("CREATE INDEX idx_receipts_session ON attendance_receipts (session_id);");
        db.execSQL("CREATE INDEX idx_receipts_owner ON attendance_receipts (owner_uid);");
        db.execSQL("CREATE INDEX idx_receipts_owner_status ON attendance_receipts (owner_uid, status);");

        db.execSQL("CREATE TABLE attendance_locks (" +
            "session_id TEXT PRIMARY KEY, " +
            "owner_uid TEXT NOT NULL, " +
            "created_at INTEGER NOT NULL" +
            ");");

        db.execSQL("CREATE TABLE attendance_commands (" +
            "request_id TEXT PRIMARY KEY, " +
            "owner_uid TEXT NOT NULL, " +
            "status TEXT NOT NULL, " +
            "local_order INTEGER NOT NULL DEFAULT 0, " +
            "encrypted_payload TEXT NOT NULL, " +
            "created_at INTEGER NOT NULL" +
            ");");
        db.execSQL("CREATE INDEX idx_commands_owner ON attendance_commands (owner_uid);");

        db.execSQL("CREATE TABLE attendance_meta (" +
            "key TEXT PRIMARY KEY, " +
            "owner_uid TEXT, " +
            "encrypted_value TEXT NOT NULL, " +
            "updated_at INTEGER NOT NULL" +
            ");");

        db.execSQL("CREATE TABLE attendance_migration_journal (" +
            "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
            "action TEXT NOT NULL, " +
            "records_count INTEGER NOT NULL, " +
            "created_at INTEGER NOT NULL" +
            ");");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        if (oldVersion < 2) {
            try { db.execSQL("ALTER TABLE attendance_receipts ADD COLUMN lease_id TEXT;"); } catch (Exception ignored) {}
            try { db.execSQL("ALTER TABLE attendance_receipts ADD COLUMN lease_expires_at INTEGER;"); } catch (Exception ignored) {}
            try { db.execSQL("ALTER TABLE attendance_meta ADD COLUMN owner_uid TEXT;"); } catch (Exception ignored) {}
            try { db.execSQL("ALTER TABLE attendance_meta ADD COLUMN encrypted_value TEXT;"); } catch (Exception ignored) {}
            try { db.execSQL("ALTER TABLE attendance_meta ADD COLUMN updated_at INTEGER;"); } catch (Exception ignored) {}
        }
    }

    public JSONObject captureAtomic(JSONObject receipt, String conflictSignature, AttendanceKeyManager km) throws Exception {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            String sessionId = receipt.getString("sessionId");
            String ownerUid = receipt.getString("ownerUid");
            String requestId = receipt.getString("requestId");
            String occurrenceId = receipt.optString("occurrenceId", "");

            // 1. Check duplicate under same account
            Cursor cursor = db.query("attendance_receipts",
                new String[]{"encrypted_payload"},
                "session_id = ? AND owner_uid = ? AND status != 'invalid'",
                new String[]{sessionId, ownerUid}, null, null, null, "1");
            if (cursor.moveToFirst()) {
                String enc = cursor.getString(0);
                cursor.close();
                db.setTransactionSuccessful();
                JSONObject saved = new JSONObject(km.decryptPayload(enc));
                JSONObject res = new JSONObject();
                res.put("receipt", saved.toString());
                res.put("alreadySaved", true);
                return res;
            }
            cursor.close();

            // 2. Check cross-account session lock
            boolean localDeviceConflict = false;
            Cursor lockCursor = db.query("attendance_locks",
                new String[]{"owner_uid"},
                "session_id = ?",
                new String[]{sessionId}, null, null, null, "1");
            if (lockCursor.moveToFirst()) {
                String lockOwner = lockCursor.getString(0);
                if (!lockOwner.equals(ownerUid)) {
                    localDeviceConflict = true;
                }
            } else {
                ContentValues cvLock = new ContentValues();
                cvLock.put("session_id", sessionId);
                cvLock.put("owner_uid", ownerUid);
                cvLock.put("created_at", System.currentTimeMillis());
                db.insertWithOnConflict("attendance_locks", null, cvLock, SQLiteDatabase.CONFLICT_IGNORE);
            }
            lockCursor.close();

            // 3. Update receipt conflict state
            receipt.put("localDeviceConflict", localDeviceConflict);
            if (localDeviceConflict && conflictSignature != null) {
                receipt.put("deviceSignature", conflictSignature);
            }

            long now = System.currentTimeMillis();
            String encrypted = km.encryptPayload(receipt.toString());
            ContentValues cv = new ContentValues();
            cv.put("request_id", requestId);
            cv.put("session_id", sessionId);
            cv.put("occurrence_id", occurrenceId);
            cv.put("owner_uid", ownerUid);
            cv.put("status", receipt.optString("status", "pending"));
            cv.put("encrypted_payload", encrypted);
            cv.put("local_device_conflict", localDeviceConflict ? 1 : 0);
            cv.put("created_at", now);
            cv.put("updated_at", now);

            db.insertWithOnConflict("attendance_receipts", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
            db.setTransactionSuccessful();

            JSONObject res = new JSONObject();
            res.put("receipt", receipt.toString());
            res.put("alreadySaved", false);
            return res;
        } finally {
            db.endTransaction();
        }
    }

    public List<JSONObject> listReceipts(String ownerUid, AttendanceKeyManager km) throws Exception {
        List<JSONObject> list = new ArrayList<>();
        SQLiteDatabase db = getReadableDatabase();
        Cursor cursor = db.query("attendance_receipts",
            new String[]{"encrypted_payload"},
            "owner_uid = ?",
            new String[]{ownerUid}, null, null, "created_at DESC");
        while (cursor.moveToNext()) {
            String enc = cursor.getString(0);
            try {
                list.add(new JSONObject(km.decryptPayload(enc)));
            } catch (Exception ignored) {}
        }
        cursor.close();
        return list;
    }

    public JSONObject getReceipt(String requestId, AttendanceKeyManager km) throws Exception {
        SQLiteDatabase db = getReadableDatabase();
        Cursor cursor = db.query("attendance_receipts",
            new String[]{"encrypted_payload"},
            "request_id = ?",
            new String[]{requestId}, null, null, null, "1");
        if (cursor.moveToFirst()) {
            String enc = cursor.getString(0);
            cursor.close();
            return new JSONObject(km.decryptPayload(enc));
        }
        cursor.close();
        return null;
    }

    public void updateReceipt(String requestId, JSONObject updated, AttendanceKeyManager km) throws Exception {
        SQLiteDatabase db = getWritableDatabase();
        ContentValues cv = new ContentValues();
        cv.put("status", updated.optString("status", "pending"));
        cv.put("encrypted_payload", km.encryptPayload(updated.toString()));
        cv.put("updated_at", System.currentTimeMillis());
        db.update("attendance_receipts", cv, "request_id = ?", new String[]{requestId});
    }

    public JSONObject transitionReceipt(String requestId, String newStatus, String resolution, String reason, Integer recordRevision, AttendanceKeyManager km) throws Exception {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            Cursor cursor = db.query("attendance_receipts",
                new String[]{"encrypted_payload"},
                "request_id = ?",
                new String[]{requestId}, null, null, null, "1");
            if (!cursor.moveToFirst()) {
                cursor.close();
                return null;
            }
            String enc = cursor.getString(0);
            cursor.close();

            JSONObject receipt = new JSONObject(km.decryptPayload(enc));
            int curRev = receipt.optInt("recordRevision", 0);
            if (recordRevision != null && curRev > recordRevision) {
                // Reject revision regression
                db.setTransactionSuccessful();
                return receipt;
            }

            receipt.put("status", newStatus);
            if (resolution != null) receipt.put("resolution", resolution);
            if (reason != null) receipt.put("reason", reason);
            if (recordRevision != null) receipt.put("recordRevision", recordRevision);
            long now = System.currentTimeMillis();
            receipt.put("updatedAt", now);

            ContentValues cv = new ContentValues();
            cv.put("status", newStatus);
            cv.put("encrypted_payload", km.encryptPayload(receipt.toString()));
            cv.put("updated_at", now);
            db.update("attendance_receipts", cv, "request_id = ?", new String[]{requestId});
            db.setTransactionSuccessful();
            return receipt;
        } finally {
            db.endTransaction();
        }
    }

    public JSONObject acquireUploadLease(String ownerUid, int limit, long durationMs, AttendanceKeyManager km) throws Exception {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            long now = System.currentTimeMillis();
            long expiresAt = now + durationMs;
            String leaseId = UUID.randomUUID().toString();

            String selection = (ownerUid != null && !ownerUid.isEmpty())
                ? "owner_uid = ? AND status IN ('pending', 'syncing', 'waiting_for_login') AND (lease_id IS NULL OR lease_expires_at < ?)"
                : "status IN ('pending', 'syncing', 'waiting_for_login') AND (lease_id IS NULL OR lease_expires_at < ?)";

            String[] selectionArgs = (ownerUid != null && !ownerUid.isEmpty())
                ? new String[]{ownerUid, String.valueOf(now)}
                : new String[]{String.valueOf(now)};

            Cursor cursor = db.query("attendance_receipts",
                new String[]{"request_id", "encrypted_payload"},
                selection, selectionArgs, null, null, "created_at ASC", String.valueOf(limit));

            List<String> requestIds = new ArrayList<>();
            JSONArray receiptsArr = new JSONArray();

            while (cursor.moveToNext()) {
                String reqId = cursor.getString(0);
                String enc = cursor.getString(1);
                try {
                    JSONObject obj = new JSONObject(km.decryptPayload(enc));
                    requestIds.add(reqId);
                    receiptsArr.put(obj.toString());
                } catch (Exception ignored) {}
            }
            cursor.close();

            for (String reqId : requestIds) {
                ContentValues cv = new ContentValues();
                cv.put("lease_id", leaseId);
                cv.put("lease_expires_at", expiresAt);
                cv.put("status", "syncing");
                cv.put("updated_at", now);
                db.update("attendance_receipts", cv, "request_id = ?", new String[]{reqId});
            }

            db.setTransactionSuccessful();
            JSONObject res = new JSONObject();
            res.put("leaseId", leaseId);
            res.put("receipts", receiptsArr);
            return res;
        } finally {
            db.endTransaction();
        }
    }

    public void acknowledgeBatch(JSONArray acks, AttendanceKeyManager km) throws Exception {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            long now = System.currentTimeMillis();
            for (int i = 0; i < acks.length(); i++) {
                JSONObject ack = acks.getJSONObject(i);
                String reqId = ack.getString("requestId");
                String resolution = ack.getString("resolution");
                String reason = ack.optString("reason", null);
                String recordId = ack.optString("recordId", null);
                int recordRevision = ack.optInt("recordRevision", -1);

                String newStatus = ("confirmed".equals(resolution) || "already_recorded".equals(resolution)) ? "confirmed"
                    : "needs_review".equals(resolution) ? "review"
                    : "invalid_evidence".equals(resolution) ? "invalid" : "pending";

                Cursor cursor = db.query("attendance_receipts",
                    new String[]{"encrypted_payload"},
                    "request_id = ?",
                    new String[]{reqId}, null, null, null, "1");

                if (cursor.moveToFirst()) {
                    String enc = cursor.getString(0);
                    cursor.close();
                    JSONObject receipt = new JSONObject(km.decryptPayload(enc));
                    int curRev = receipt.optInt("recordRevision", 0);
                    if (recordRevision >= 0 && curRev > recordRevision) {
                        continue;
                    }
                    receipt.put("status", newStatus);
                    receipt.put("resolution", resolution);
                    if (reason != null) receipt.put("reason", reason);
                    if (recordId != null) receipt.put("recordId", recordId);
                    if (recordRevision >= 0) receipt.put("recordRevision", recordRevision);
                    receipt.put("updatedAt", now);

                    ContentValues cv = new ContentValues();
                    cv.put("status", newStatus);
                    cv.put("encrypted_payload", km.encryptPayload(receipt.toString()));
                    cv.put("lease_id", (String) null);
                    cv.put("lease_expires_at", (Long) null);
                    cv.put("updated_at", now);
                    db.update("attendance_receipts", cv, "request_id = ?", new String[]{reqId});
                } else {
                    cursor.close();
                }
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    public void releaseUploadLease(String leaseId) {
        SQLiteDatabase db = getWritableDatabase();
        ContentValues cv = new ContentValues();
        cv.put("lease_id", (String) null);
        cv.put("lease_expires_at", (Long) null);
        cv.put("status", "pending");
        db.update("attendance_receipts", cv, "lease_id = ?", new String[]{leaseId});
    }

    public void recoverInterruptedWork() {
        SQLiteDatabase db = getWritableDatabase();
        long now = System.currentTimeMillis();
        ContentValues cv = new ContentValues();
        cv.put("lease_id", (String) null);
        cv.put("lease_expires_at", (Long) null);
        cv.put("status", "pending");
        db.update("attendance_receipts", cv, "lease_expires_at < ?", new String[]{String.valueOf(now)});
    }

    public String getMetadata(String key, String ownerUid, AttendanceKeyManager km) throws Exception {
        SQLiteDatabase db = getReadableDatabase();
        String selection = (ownerUid != null && !ownerUid.isEmpty())
            ? "key = ? AND (owner_uid = ? OR owner_uid IS NULL)"
            : "key = ?";
        String[] args = (ownerUid != null && !ownerUid.isEmpty())
            ? new String[]{key, ownerUid}
            : new String[]{key};

        Cursor cursor = db.query("attendance_meta",
            new String[]{"encrypted_value"},
            selection, args, null, null, null, "1");
        if (cursor.moveToFirst()) {
            String enc = cursor.getString(0);
            cursor.close();
            return km.decryptPayload(enc);
        }
        cursor.close();
        return null;
    }

    public void setMetadata(String key, String value, String ownerUid, AttendanceKeyManager km) throws Exception {
        SQLiteDatabase db = getWritableDatabase();
        long now = System.currentTimeMillis();
        String enc = km.encryptPayload(value);
        ContentValues cv = new ContentValues();
        cv.put("key", key);
        cv.put("owner_uid", (ownerUid != null && !ownerUid.isEmpty()) ? ownerUid : null);
        cv.put("encrypted_value", enc);
        cv.put("updated_at", now);
        db.insertWithOnConflict("attendance_meta", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
    }

    public void deleteMetadata(String key, String ownerUid) {
        SQLiteDatabase db = getWritableDatabase();
        String selection = (ownerUid != null && !ownerUid.isEmpty())
            ? "key = ? AND (owner_uid = ? OR owner_uid IS NULL)"
            : "key = ?";
        String[] args = (ownerUid != null && !ownerUid.isEmpty())
            ? new String[]{key, ownerUid}
            : new String[]{key};
        db.delete("attendance_meta", selection, args);
    }

    public void commitDoctorSession(String metaKey, String metaData, JSONObject command, AttendanceKeyManager km) throws Exception {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            int sequence = 1;
            Cursor cursor = db.query("attendance_meta", new String[]{"encrypted_value"}, "key = 'attendance-command-sequence'", null, null, null, null);
            if (cursor.moveToFirst()) {
                String enc = cursor.getString(0);
                try {
                    sequence = Integer.parseInt(km.decryptPayload(enc)) + 1;
                } catch (Exception ignored) {}
            }
            cursor.close();

            long now = System.currentTimeMillis();
            ContentValues seqCv = new ContentValues();
            seqCv.put("key", "attendance-command-sequence");
            seqCv.put("encrypted_value", km.encryptPayload(String.valueOf(sequence)));
            seqCv.put("updated_at", now);
            db.insertWithOnConflict("attendance_meta", null, seqCv, SQLiteDatabase.CONFLICT_REPLACE);

            String ownerUid = command.getString("ownerUid");
            ContentValues metaCv = new ContentValues();
            metaCv.put("key", metaKey);
            metaCv.put("owner_uid", ownerUid);
            metaCv.put("encrypted_value", km.encryptPayload(metaData));
            metaCv.put("updated_at", now);
            db.insertWithOnConflict("attendance_meta", null, metaCv, SQLiteDatabase.CONFLICT_REPLACE);

            command.put("localOrder", sequence);
            ContentValues cmdCv = new ContentValues();
            cmdCv.put("request_id", command.getString("requestId"));
            cmdCv.put("owner_uid", ownerUid);
            cmdCv.put("status", command.optString("status", "pending"));
            cmdCv.put("local_order", sequence);
            cmdCv.put("encrypted_payload", km.encryptPayload(command.toString()));
            cmdCv.put("created_at", now);
            db.insertWithOnConflict("attendance_commands", null, cmdCv, SQLiteDatabase.CONFLICT_REPLACE);

            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    public void enqueueDoctorCommand(JSONObject command, AttendanceKeyManager km) throws Exception {
        SQLiteDatabase db = getWritableDatabase();
        ContentValues cmdCv = new ContentValues();
        cmdCv.put("request_id", command.getString("requestId"));
        cmdCv.put("owner_uid", command.getString("ownerUid"));
        cmdCv.put("status", command.optString("status", "pending"));
        cmdCv.put("local_order", command.optInt("localOrder", 0));
        cmdCv.put("encrypted_payload", km.encryptPayload(command.toString()));
        cmdCv.put("created_at", System.currentTimeMillis());
        db.insertWithOnConflict("attendance_commands", null, cmdCv, SQLiteDatabase.CONFLICT_REPLACE);
    }

    public List<JSONObject> listDoctorCommands(String ownerUid, AttendanceKeyManager km) throws Exception {
        List<JSONObject> list = new ArrayList<>();
        SQLiteDatabase db = getReadableDatabase();
        Cursor cursor = db.query("attendance_commands",
            new String[]{"encrypted_payload"},
            "owner_uid = ?",
            new String[]{ownerUid}, null, null, "local_order ASC");
        while (cursor.moveToNext()) {
            String enc = cursor.getString(0);
            try {
                list.add(new JSONObject(km.decryptPayload(enc)));
            } catch (Exception ignored) {}
        }
        cursor.close();
        return list;
    }

    public JSONObject getHealth(String ownerUid, AttendanceKeyManager km) {
        JSONObject res = new JSONObject();
        try {
            SQLiteDatabase db = getReadableDatabase();
            int unresolvedReceipts = 0;
            int unresolvedCommands = 0;
            int unreadableCount = 0;
            long oldestPendingAgeMs = 0;
            long now = System.currentTimeMillis();

            String selection = (ownerUid != null && !ownerUid.isEmpty())
                ? "owner_uid = ? AND status = 'pending'"
                : "status = 'pending'";
            String[] args = (ownerUid != null && !ownerUid.isEmpty())
                ? new String[]{ownerUid}
                : null;

            Cursor cursor = db.query("attendance_receipts",
                new String[]{"created_at", "encrypted_payload"},
                selection, args, null, null, "created_at ASC");
            while (cursor.moveToNext()) {
                unresolvedReceipts++;
                long createdAt = cursor.getLong(0);
                if (oldestPendingAgeMs == 0 && createdAt > 0) {
                    oldestPendingAgeMs = Math.max(0, now - createdAt);
                }
                String enc = cursor.getString(1);
                try {
                    km.decryptPayload(enc);
                } catch (Exception e) {
                    unreadableCount++;
                }
            }
            cursor.close();

            String cmdSelection = (ownerUid != null && !ownerUid.isEmpty())
                ? "owner_uid = ? AND status != 'synced'"
                : "status != 'synced'";
            String[] cmdArgs = (ownerUid != null && !ownerUid.isEmpty())
                ? new String[]{ownerUid}
                : null;
            Cursor cmdCursor = db.rawQuery("SELECT count(*) FROM attendance_commands WHERE " + cmdSelection, cmdArgs);
            if (cmdCursor.moveToFirst()) {
                unresolvedCommands = cmdCursor.getInt(0);
            }
            cmdCursor.close();

            boolean migrationCompleted = false;
            Cursor jnlCursor = db.rawQuery("SELECT count(*) FROM attendance_migration_journal WHERE action = 'legacy_indexeddb_migration'", null);
            if (jnlCursor.moveToFirst()) {
                migrationCompleted = jnlCursor.getInt(0) > 0;
            }
            jnlCursor.close();

            res.put("storageType", "native_sqlite");
            res.put("isDurable", true);
            res.put("healthState", unreadableCount > 0 ? "corrupt" : "ready");
            res.put("unresolvedReceiptsCount", unresolvedReceipts);
            res.put("unresolvedCommandsCount", unresolvedCommands);
            res.put("unreadableRecordsCount", unreadableCount);
            res.put("oldestPendingAgeMs", oldestPendingAgeMs);
            res.put("legacyMigrationPending", !migrationCompleted);
        } catch (Exception e) {
            try {
                res.put("storageType", "native_sqlite");
                res.put("isDurable", false);
                res.put("healthState", "unavailable");
            } catch (Exception ignored) {}
        }
        return res;
    }

    public int migrateLegacyData(List<String> receipts, List<String> locks, List<String> commands, List<String> metaList, AttendanceKeyManager km) throws Exception {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        int total = 0;
        try {
            long now = System.currentTimeMillis();
            for (String rStr : receipts) {
                JSONObject r = new JSONObject(rStr);
                String reqId = r.getString("requestId");
                String sId = r.getString("sessionId");
                String oId = r.optString("occurrenceId", "");
                String uId = r.getString("ownerUid");
                String status = r.optString("status", "pending");
                boolean conflict = r.optBoolean("localDeviceConflict", false);

                ContentValues cv = new ContentValues();
                cv.put("request_id", reqId);
                cv.put("session_id", sId);
                cv.put("occurrence_id", oId);
                cv.put("owner_uid", uId);
                cv.put("status", status);
                cv.put("encrypted_payload", km.encryptPayload(rStr));
                cv.put("local_device_conflict", conflict ? 1 : 0);
                cv.put("created_at", now);
                cv.put("updated_at", now);
                db.insertWithOnConflict("attendance_receipts", null, cv, SQLiteDatabase.CONFLICT_IGNORE);
                total++;
            }

            for (String lStr : locks) {
                JSONObject l = new JSONObject(lStr);
                ContentValues cv = new ContentValues();
                cv.put("session_id", l.getString("sessionId"));
                cv.put("owner_uid", l.getString("ownerUid"));
                cv.put("created_at", now);
                db.insertWithOnConflict("attendance_locks", null, cv, SQLiteDatabase.CONFLICT_IGNORE);
            }

            for (String cStr : commands) {
                JSONObject c = new JSONObject(cStr);
                ContentValues cv = new ContentValues();
                cv.put("request_id", c.getString("requestId"));
                cv.put("owner_uid", c.getString("ownerUid"));
                cv.put("status", c.optString("status", "pending"));
                cv.put("local_order", c.optInt("localOrder", 0));
                cv.put("encrypted_payload", km.encryptPayload(cStr));
                cv.put("created_at", now);
                db.insertWithOnConflict("attendance_commands", null, cv, SQLiteDatabase.CONFLICT_IGNORE);
            }

            for (String mStr : metaList) {
                JSONObject m = new JSONObject(mStr);
                ContentValues cv = new ContentValues();
                cv.put("key", m.getString("key"));
                cv.put("owner_uid", m.optString("ownerUid", null));
                cv.put("encrypted_value", km.encryptPayload(mStr));
                cv.put("updated_at", now);
                db.insertWithOnConflict("attendance_meta", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
            }

            ContentValues jnl = new ContentValues();
            jnl.put("action", "legacy_indexeddb_migration");
            jnl.put("records_count", total);
            jnl.put("created_at", now);
            db.insert("attendance_migration_journal", null, jnl);

            db.setTransactionSuccessful();
            return total;
        } finally {
            db.endTransaction();
        }
    }
}
