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
            JSObject res = new JSObject();
            res.put("storageType", "native_sqlite");
            res.put("isDurable", true);
            res.put("unresolvedReceiptsCount", dbHelper.getUnresolvedReceiptsCount(null));
            res.put("unresolvedCommandsCount", dbHelper.getUnresolvedCommandsCount(null));
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
    public void recoverInterruptedWork(PluginCall call) {
        call.resolve();
    }

    @PluginMethod
    public void getHealth(PluginCall call) {
        try {
            ensureInitialized();
            String ownerUid = call.getString("ownerUid", "");
            JSObject res = new JSObject();
            res.put("storageType", "native_sqlite");
            res.put("isDurable", true);
            res.put("unresolvedReceiptsCount", dbHelper.getUnresolvedReceiptsCount(ownerUid));
            res.put("unresolvedCommandsCount", dbHelper.getUnresolvedCommandsCount(ownerUid));
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
            String receiptStr = call.getString("receipt");
            if (receiptStr == null) {
                call.reject("receipt parameter required");
                return;
            }
            JSONObject receipt = new JSONObject(receiptStr);
            String message = buildDeviceMessage(receipt);
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
            String claimsStr = call.getString("claims");
            if (claimsStr == null) {
                call.reject("claims parameter required");
                return;
            }
            JSONObject claims = new JSONObject(claimsStr);
            String permit = claims.optString("permit", "");

            JSONObject header = new JSONObject();
            header.put("alg", "ES256");
            header.put("typ", "JWT");
            header.put("permit", permit);

            String encodedHeader = base64Url(header.toString().getBytes("UTF-8"));
            String encodedClaims = base64Url(claims.toString().getBytes("UTF-8"));
            String message = encodedHeader + "." + encodedClaims;

            String sig = keyManager.signMessage(message);
            String token = message + "." + sig;

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
        return "MYLECTURE_ATTENDANCE_RECEIPT_V1\n" +
            receipt.optString("ownerUid", "") + "\n" +
            receipt.optString("qrToken", "") + "\n" +
            receipt.optString("sessionId", "") + "\n" +
            receipt.optString("occurrenceId", "") + "\n" +
            receipt.optString("installationId", "") + "\n" +
            receipt.optString("capturedAtClient", "");
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
