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

public class AttendanceDatabaseHelper extends SQLiteOpenHelper {
    private static final String DATABASE_NAME = "attendance_native.db";
    private static final int DATABASE_VERSION = 1;

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
            "value TEXT NOT NULL" +
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
        // Forward schema migrations preserve data
    }

    public JSONObject captureAtomic(JSONObject receipt, String conflictSignature, AttendanceKeyManager km) throws Exception {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            String sessionId = receipt.getString("sessionId");
            String ownerUid = receipt.getString("ownerUid");
            String requestId = receipt.getString("requestId");
            String occurrenceId = receipt.optString("occurrenceId", "");

            // 1. Check same-account duplicate
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

    public void commitDoctorSession(String metaKey, String metaData, JSONObject command, AttendanceKeyManager km) throws Exception {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            // Get sequence
            int sequence = 1;
            Cursor cursor = db.query("attendance_meta", new String[]{"value"}, "key = 'attendance-command-sequence'", null, null, null, null);
            if (cursor.moveToFirst()) {
                sequence = Integer.parseInt(cursor.getString(0)) + 1;
            }
            cursor.close();

            ContentValues seqCv = new ContentValues();
            seqCv.put("key", "attendance-command-sequence");
            seqCv.put("value", String.valueOf(sequence));
            db.insertWithOnConflict("attendance_meta", null, seqCv, SQLiteDatabase.CONFLICT_REPLACE);

            ContentValues metaCv = new ContentValues();
            metaCv.put("key", metaKey);
            metaCv.put("value", metaData);
            db.insertWithOnConflict("attendance_meta", null, metaCv, SQLiteDatabase.CONFLICT_REPLACE);

            command.put("localOrder", sequence);
            ContentValues cmdCv = new ContentValues();
            cmdCv.put("request_id", command.getString("requestId"));
            cmdCv.put("owner_uid", command.getString("ownerUid"));
            cmdCv.put("status", command.optString("status", "pending"));
            cmdCv.put("local_order", sequence);
            cmdCv.put("encrypted_payload", km.encryptPayload(command.toString()));
            cmdCv.put("created_at", System.currentTimeMillis());
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

    public int getUnresolvedReceiptsCount(String ownerUid) {
        SQLiteDatabase db = getReadableDatabase();
        String selection = ownerUid != null && !ownerUid.isEmpty() ? "owner_uid = ? AND status = 'pending'" : "status = 'pending'";
        String[] args = ownerUid != null && !ownerUid.isEmpty() ? new String[]{ownerUid} : null;
        Cursor cursor = db.rawQuery("SELECT count(*) FROM attendance_receipts WHERE " + selection, args);
        int count = 0;
        if (cursor.moveToFirst()) count = cursor.getInt(0);
        cursor.close();
        return count;
    }

    public int getUnresolvedCommandsCount(String ownerUid) {
        SQLiteDatabase db = getReadableDatabase();
        String selection = ownerUid != null && !ownerUid.isEmpty() ? "owner_uid = ? AND status != 'synced'" : "status != 'synced'";
        String[] args = ownerUid != null && !ownerUid.isEmpty() ? new String[]{ownerUid} : null;
        Cursor cursor = db.rawQuery("SELECT count(*) FROM attendance_commands WHERE " + selection, args);
        int count = 0;
        if (cursor.moveToFirst()) count = cursor.getInt(0);
        cursor.close();
        return count;
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
                cv.put("value", mStr);
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
