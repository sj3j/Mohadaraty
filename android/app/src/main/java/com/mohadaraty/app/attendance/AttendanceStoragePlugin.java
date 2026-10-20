package com.mohadaraty.app.attendance;

import android.content.Context;
import android.content.SharedPreferences;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

@CapacitorPlugin(name = "AttendanceStorage")
public class AttendanceStoragePlugin extends Plugin {
    private AttendanceDatabaseHelper dbHelper;
    private AttendanceKeyManager keyManager;

    @Override
    public void load() {
        super.load();
        try {
            dbHelper = new AttendanceDatabaseHelper(getContext());
            keyManager = new AttendanceKeyManager();
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    private void ensureInitialized() throws Exception {
        if (dbHelper == null) dbHelper = new AttendanceDatabaseHelper(getContext());
        if (keyManager == null) keyManager = new AttendanceKeyManager();
    }

    private String getOrCreateInstallationId() {
        SharedPreferences prefs = getContext().getSharedPreferences("attendance_device_meta", Context.MODE_PRIVATE);
        String id = prefs.getString("installation_id", null);
        if (id == null) {
            id = UUID.randomUUID().toString();
            prefs.edit().putString("installation_id", id).apply();
        }
        return id;
    }

    @PluginMethod
    public void initialize(PluginCall call) {
        try {
            ensureInitialized();
            String ownerUid = call.getString("ownerUid", "");
            JSONObject health = dbHelper.getHealth(ownerUid, keyManager);
            JSObject res = new JSObject();
            res.put("storageType", health.optString("storageType", "native_sqlite"));
            res.put("isDurable", health.optBoolean("isDurable", true));
            res.put("healthState", health.optString("healthState", "ready"));
            res.put("unresolvedReceiptsCount", health.optInt("unresolvedReceiptsCount", 0));
            res.put("unresolvedCommandsCount", health.optInt("unresolvedCommandsCount", 0));
            res.put("unreadableRecordsCount", health.optInt("unreadableRecordsCount", 0));
            res.put("oldestPendingAgeMs", health.optLong("oldestPendingAgeMs", 0));
            res.put("legacyMigrationPending", health.optBoolean("legacyMigrationPending", false));
            call.resolve(res);
        } catch (Exception e) {
            call.reject("Failed to initialize native storage: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void capture(PluginCall call) {
        try {
            ensureInitialized();
            String receiptStr = call.getString("receipt");
            String conflictSignature = call.getString("conflictSignature");
            if (receiptStr == null) {
                call.reject("receipt parameter is required");
                return;
            }
            JSONObject receipt = new JSONObject(receiptStr);
            JSONObject result = dbHelper.captureAtomic(receipt, conflictSignature, keyManager);
            JSObject jsResult = new JSObject();
            jsResult.put("receipt", result.getString("receipt"));
            jsResult.put("alreadySaved", result.getBoolean("alreadySaved"));
            call.resolve(jsResult);
        } catch (Exception e) {
            call.reject("capture failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void listReceipts(PluginCall call) {
        try {
            ensureInitialized();
            String ownerUid = call.getString("ownerUid", "");
            List<JSONObject> list = dbHelper.listReceipts(ownerUid, keyManager);
            JSArray arr = new JSArray();
            for (JSONObject o : list) arr.put(o.toString());
            JSObject res = new JSObject();
            res.put("receipts", arr);
            call.resolve(res);
        } catch (Exception e) {
            call.reject("listReceipts failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void getReceipt(PluginCall call) {
        try {
            ensureInitialized();
            String requestId = call.getString("requestId");
            if (requestId == null) {
                call.reject("requestId required");
                return;
            }
            JSONObject o = dbHelper.getReceipt(requestId, keyManager);
            JSObject res = new JSObject();
            if (o != null) res.put("receipt", o.toString());
            call.resolve(res);
        } catch (Exception e) {
            call.reject("getReceipt failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void commitDoctorSession(PluginCall call) {
        try {
            ensureInitialized();
            String metaKey = call.getString("metaKey");
            String metaData = call.getString("metaData");
            String commandStr = call.getString("command");
            if (metaKey == null || metaData == null || commandStr == null) {
                call.reject("invalid_commit_parameters");
                return;
            }
            dbHelper.commitDoctorSession(metaKey, metaData, new JSONObject(commandStr), keyManager);
            call.resolve();
        } catch (Exception e) {
            call.reject("commitDoctorSession failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void enqueueDoctorCommand(PluginCall call) {
        try {
            ensureInitialized();
            String cmdStr = call.getString("command");
            if (cmdStr == null) {
                call.reject("command parameter required");
                return;
            }
            dbHelper.enqueueDoctorCommand(new JSONObject(cmdStr), keyManager);
            call.resolve();
        } catch (Exception e) {
            call.reject("enqueueDoctorCommand failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void listDoctorCommands(PluginCall call) {
        try {
            ensureInitialized();
            String ownerUid = call.getString("ownerUid", "");
            List<JSONObject> list = dbHelper.listDoctorCommands(ownerUid, keyManager);
            JSArray arr = new JSArray();
            for (JSONObject o : list) arr.put(o.toString());
            JSObject res = new JSObject();
            res.put("commands", arr);
            call.resolve(res);
        } catch (Exception e) {
            call.reject("listDoctorCommands failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void updateDoctorCommand(PluginCall call) {
        try {
            ensureInitialized();
            String cmdStr = call.getString("command");
            if (cmdStr == null) {
                call.reject("command parameter required");
                return;
            }
            dbHelper.enqueueDoctorCommand(new JSONObject(cmdStr), keyManager);
            call.resolve();
        } catch (Exception e) {
            call.reject("updateDoctorCommand failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void updateReceipt(PluginCall call) {
        try {
            ensureInitialized();
            String requestId = call.getString("requestId");
            String receiptStr = call.getString("receipt");
            if (requestId == null || receiptStr == null) {
                call.reject("invalid_update_parameters");
                return;
            }
            dbHelper.updateReceipt(requestId, new JSONObject(receiptStr), keyManager);
            call.resolve();
        } catch (Exception e) {
            call.reject("updateReceipt failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void transitionReceipt(PluginCall call) {
        try {
            ensureInitialized();
            String requestId = call.getString("requestId");
            String status = call.getString("status");
            if (requestId == null || status == null) {
                call.reject("requestId and status required");
                return;
            }
            String resolution = call.getString("resolution");
            String reason = call.getString("reason");
            Integer recordRevision = call.getInt("recordRevision");
            JSONObject updated = dbHelper.transitionReceipt(requestId, status, resolution, reason, recordRevision, keyManager);
            JSObject res = new JSObject();
            if (updated != null) res.put("receipt", updated.toString());
            call.resolve(res);
        } catch (Exception e) {
            call.reject("transitionReceipt failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void acquireUploadLease(PluginCall call) {
        try {
            ensureInitialized();
            String ownerUid = call.getString("ownerUid", "");
            int limit = call.getInt("limit", 25);
            long durationMs = call.getInt("leaseDurationMs", 60000);
            JSONObject result = dbHelper.acquireUploadLease(ownerUid, limit, durationMs, keyManager);
            JSObject res = new JSObject();
            res.put("leaseId", result.getString("leaseId"));
            res.put("receipts", result.getJSONArray("receipts"));
            call.resolve(res);
        } catch (Exception e) {
            call.reject("acquireUploadLease failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void acknowledgeBatch(PluginCall call) {
        try {
            ensureInitialized();
            JSArray acksArr = call.getArray("acknowledgements");
            if (acksArr == null) {
                call.reject("acknowledgements parameter required");
                return;
            }
            JSONArray acks = new JSONArray();
            for (int i = 0; i < acksArr.length(); i++) {
                acks.put(acksArr.getJSONObject(i));
            }
            dbHelper.acknowledgeBatch(acks, keyManager);
            call.resolve();
        } catch (Exception e) {
            call.reject("acknowledgeBatch failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void releaseUploadLease(PluginCall call) {
        try {
            ensureInitialized();
            String leaseId = call.getString("leaseId");
            if (leaseId != null) {
                dbHelper.releaseUploadLease(leaseId);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("releaseUploadLease failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void getMetadata(PluginCall call) {
        try {
            ensureInitialized();
            String key = call.getString("key");
            String ownerUid = call.getString("ownerUid");
            if (key == null) {
                call.reject("key parameter required");
                return;
            }
            String value = dbHelper.getMetadata(key, ownerUid, keyManager);
            JSObject res = new JSObject();
            res.put("value", value);
            call.resolve(res);
        } catch (Exception e) {
            call.reject("getMetadata failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void setMetadata(PluginCall call) {
        try {
            ensureInitialized();
            String key = call.getString("key");
            String value = call.getString("value");
            String ownerUid = call.getString("ownerUid");
            if (key == null || value == null) {
                call.reject("invalid_metadata_parameters");
                return;
            }
            dbHelper.setMetadata(key, value, ownerUid, keyManager);
            call.resolve();
        } catch (Exception e) {
            call.reject("setMetadata failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void deleteMetadata(PluginCall call) {
        try {
            ensureInitialized();
            String key = call.getString("key");
            String ownerUid = call.getString("ownerUid");
            if (key == null) {
                call.reject("key parameter required");
                return;
            }
            dbHelper.deleteMetadata(key, ownerUid);
            call.resolve();
        } catch (Exception e) {
            call.reject("deleteMetadata failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void recoverInterruptedWork(PluginCall call) {
        try {
            ensureInitialized();
            dbHelper.recoverInterruptedWork();
            call.resolve();
        } catch (Exception e) {
            call.reject("recoverInterruptedWork failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void getHealth(PluginCall call) {
        try {
            ensureInitialized();
            String ownerUid = call.getString("ownerUid", "");
            JSONObject health = dbHelper.getHealth(ownerUid, keyManager);
            JSObject res = new JSObject();
            res.put("storageType", health.optString("storageType", "native_sqlite"));
            res.put("isDurable", health.optBoolean("isDurable", true));
            res.put("healthState", health.optString("healthState", "ready"));
            res.put("unresolvedReceiptsCount", health.optInt("unresolvedReceiptsCount", 0));
            res.put("unresolvedCommandsCount", health.optInt("unresolvedCommandsCount", 0));
            res.put("unreadableRecordsCount", health.optInt("unreadableRecordsCount", 0));
            res.put("oldestPendingAgeMs", health.optLong("oldestPendingAgeMs", 0));
            res.put("legacyMigrationPending", health.optBoolean("legacyMigrationPending", false));
            call.resolve(res);
        } catch (Exception e) {
            call.reject("getHealth failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void getPublicIdentity(PluginCall call) {
        try {
            ensureInitialized();
            JSObject res = new JSObject();
            res.put("fingerprint", keyManager.getFingerprint());
            res.put("publicKey", keyManager.getPublicJwk().toString());
            res.put("installationId", getOrCreateInstallationId());
            call.resolve(res);
        } catch (Exception e) {
            call.reject("getPublicIdentity failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void signReceipt(PluginCall call) {
        try {
            ensureInitialized();
            String message = call.getString("message");
            if (message == null) {
                String receiptStr = call.getString("receipt");
                if (receiptStr == null) {
                    call.reject("receipt or message parameter required");
                    return;
                }
                JSONObject receipt = new JSONObject(receiptStr);
                message = buildDeviceMessage(receipt);
            }
            String signature = keyManager.signMessage(message);
            JSObject res = new JSObject();
            res.put("signature", signature);
            call.resolve(res);
        } catch (Exception e) {
            call.reject("signReceipt failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void signDoctorQr(PluginCall call) {
        try {
            ensureInitialized();
            String permit = call.getString("permit");
            String claimsStr = call.getString("claims");
            if (claimsStr == null) {
                call.reject("claims parameter required");
                return;
            }
            JSONObject claims = new JSONObject(claimsStr);
            if (permit == null || permit.isEmpty()) {
                permit = claims.optString("permit", "");
            }
            claims.remove("permit");

            JSONObject header = new JSONObject();
            header.put("alg", "ES256");
            header.put("typ", "JWT");
            header.put("permit", permit);

            String encodedHeader = base64Url(header.toString().getBytes(StandardCharsets.UTF_8));
            String encodedClaims = base64Url(claims.toString().getBytes(StandardCharsets.UTF_8));
            String message = encodedHeader + "." + encodedClaims;

            String sig = keyManager.signMessage(message);
            String token = message + "." + sig;

            if (token.getBytes(StandardCharsets.UTF_8).length > 2330) {
                call.reject("doctor_qr_payload_exceeds_limit");
                return;
            }

            JSObject res = new JSObject();
            res.put("signature", token);
            call.resolve(res);
        } catch (Exception e) {
            call.reject("signDoctorQr failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void signRotationMessage(PluginCall call) {
        try {
            ensureInitialized();
            String message = call.getString("message");
            if (message == null) {
                call.reject("message parameter required");
                return;
            }
            String signature = keyManager.signMessage(message);
            JSObject res = new JSObject();
            res.put("signature", signature);
            call.resolve(res);
        } catch (Exception e) {
            call.reject("signRotationMessage failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void migrateLegacyData(PluginCall call) {
        try {
            ensureInitialized();
            JSArray receiptsArr = call.getArray("receipts");
            JSArray locksArr = call.getArray("locks");
            JSArray commandsArr = call.getArray("commands");
            JSArray metaArr = call.getArray("meta");

            List<String> rList = toStringList(receiptsArr);
            List<String> lList = toStringList(locksArr);
            List<String> cList = toStringList(commandsArr);
            List<String> mList = toStringList(metaArr);

            int migrated = dbHelper.migrateLegacyData(rList, lList, cList, mList, keyManager);
            JSObject res = new JSObject();
            res.put("migratedCount", migrated);
            call.resolve(res);
        } catch (Exception e) {
            call.reject("migrateLegacyData failed: " + e.getMessage(), e);
        }
    }

    private static String buildDeviceMessage(JSONObject receipt) {
        JSONArray arr = new JSONArray();
        arr.put(receipt.optString("requestId", ""));
        arr.put(receipt.optString("ownerUid", ""));
        arr.put(receipt.optString("sessionId", ""));
        arr.put(receipt.optString("occurrenceId", ""));
        arr.put(receipt.optString("qrToken", ""));
        arr.put(receipt.optString("installationId", ""));
        arr.put(receipt.optBoolean("localDeviceConflict", false));
        return arr.toString();
    }

    private static List<String> toStringList(JSArray arr) {
        List<String> list = new ArrayList<>();
        if (arr == null) return list;
        for (int i = 0; i < arr.length(); i++) {
            try {
                list.add(arr.getString(i));
            } catch (Exception ignored) {}
        }
        return list;
    }

    private static String base64Url(byte[] bytes) {
        return android.util.Base64.encodeToString(bytes, android.util.Base64.URL_SAFE | android.util.Base64.NO_PADDING | android.util.Base64.NO_WRAP);
    }
}
