package com.mohadaraty.app;

import android.Manifest;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(
    name = "NativeFiles",
    permissions = {
        @Permission(
            strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE },
            alias = "legacyStorage"
        )
    }
)
public class NativeFilesPlugin extends Plugin {
    private static final String MIME_PDF = "application/pdf";
    private static final int BUFFER_SIZE = 64 * 1024;
    private final ExecutorService ioExecutor = Executors.newCachedThreadPool();

    @PluginMethod
    public void getRuntimeInfo(PluginCall call) {
        JSObject result = new JSObject();
        result.put("platform", "android");
        result.put("sdkInt", Build.VERSION.SDK_INT);
        call.resolve(result);
    }

    @PluginMethod
    public void downloadPrivate(PluginCall call) {
        final String source = call.getString("url");
        final String destination = call.getString("path");
        final String transferId = call.getString("transferId", "pdf");
        if (source == null || destination == null) {
            reject(call, "NATIVE_TRANSFER_INVALID", "url and path are required", null);
            return;
        }

        ioExecutor.execute(() -> {
            HttpURLConnection connection = null;
            File partial = null;
            try {
                File target = privateDestination(destination);
                File parent = target.getParentFile();
                if (parent == null || (!parent.exists() && !parent.mkdirs())) {
                    throw new IOException("Could not create destination directory");
                }
                partial = new File(parent, target.getName() + ".part");
                if (partial.exists() && !partial.delete()) {
                    throw new IOException("Could not clear partial download");
                }

                URL url = new URL(source);
                if (!"https".equalsIgnoreCase(url.getProtocol())) {
                    reject(call, "NATIVE_TRANSFER_INVALID", "Only HTTPS downloads are allowed", null);
                    return;
                }
                connection = (HttpURLConnection) url.openConnection();
                connection.setInstanceFollowRedirects(true);
                connection.setConnectTimeout(60_000);
                connection.setReadTimeout(60_000);
                connection.setRequestMethod("GET");
                connection.connect();

                int status = connection.getResponseCode();
                if (status < 200 || status >= 300) {
                    JSObject data = new JSObject();
                    data.put("httpStatus", status);
                    data.put("transient", status == 408 || status == 425 || status == 429 || status >= 500);
                    reject(call, "NATIVE_TRANSFER_HTTP", "Download server returned HTTP " + status, data);
                    return;
                }

                long total = connection.getContentLengthLong();
                long copied;
                try (InputStream input = new BufferedInputStream(connection.getInputStream());
                     OutputStream output = new BufferedOutputStream(new FileOutputStream(partial))) {
                    copied = copy(input, output, (bytes) -> {
                        JSObject progress = new JSObject();
                        progress.put("transferId", transferId);
                        progress.put("bytes", bytes);
                        progress.put("contentLength", Math.max(total, 0));
                        notifyListeners("downloadProgress", progress);
                    });
                }

                if (copied <= 0 || partial.length() <= 0) {
                    throw new IOException("Downloaded file is empty");
                }
                if (target.exists() && !target.delete()) {
                    throw new IOException("Could not replace destination file");
                }
                if (!partial.renameTo(target)) {
                    throw new IOException("Could not publish downloaded file");
                }

                JSObject result = new JSObject();
                result.put("path", Uri.fromFile(target).toString());
                result.put("bytes", copied);
                call.resolve(result);
            } catch (SocketTimeoutException | UnknownHostException error) {
                reject(call, "NATIVE_TRANSFER_NETWORK", error.getLocalizedMessage(), null);
            } catch (IOException error) {
                reject(call, "NATIVE_TRANSFER_IO", error.getLocalizedMessage(), null);
            } catch (Exception error) {
                reject(call, "NATIVE_TRANSFER_UNKNOWN", error.getLocalizedMessage(), null);
            } finally {
                if (connection != null) connection.disconnect();
                if (partial != null && partial.exists()) partial.delete();
            }
        });
    }

    @PluginMethod
    public void savePdf(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            saveWithMediaStore(call);
            return;
        }
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.WRITE_EXTERNAL_STORAGE)
            == PackageManager.PERMISSION_GRANTED) {
            saveLegacyDownload(call);
            return;
        }
        requestPermissionForAlias("legacyStorage", call, "legacyStoragePermissionResult");
    }

    @PermissionCallback
    private void legacyStoragePermissionResult(PluginCall call) {
        if (getPermissionState("legacyStorage") == PermissionState.GRANTED) {
            saveLegacyDownload(call);
        } else {
            openSavePicker(call);
        }
    }

    private void saveWithMediaStore(PluginCall call) {
        ioExecutor.execute(() -> {
            Uri inserted = null;
            try {
                File source = validatedPdf(call.getString("sourceUri"));
                String filename = requiredFilename(call);
                ContentResolver resolver = getContext().getContentResolver();
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
                values.put(MediaStore.MediaColumns.MIME_TYPE, MIME_PDF);
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Mohadaraty");
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                inserted = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (inserted == null) throw new IOException("Could not create Downloads entry");

                long bytes;
                try (InputStream input = new BufferedInputStream(new FileInputStream(source));
                     OutputStream output = new BufferedOutputStream(requireOutput(resolver, inserted))) {
                    bytes = copy(input, output, null);
                }
                long storedSize = contentSize(resolver, inserted);
                if (bytes <= 0 || storedSize == 0) throw new IOException("Saved PDF is empty");

                ContentValues publish = new ContentValues();
                publish.put(MediaStore.MediaColumns.IS_PENDING, 0);
                resolver.update(inserted, publish, null, null);
                resolveSaved(call, inserted.toString(), "Downloads/Mohadaraty", bytes);
            } catch (Exception error) {
                if (inserted != null) getContext().getContentResolver().delete(inserted, null, null);
                reject(call, "FILE_SAVE_FAILED", error.getLocalizedMessage(), null);
            }
        });
    }

    private void saveLegacyDownload(PluginCall call) {
        ioExecutor.execute(() -> {
            File destination = null;
            try {
                File source = validatedPdf(call.getString("sourceUri"));
                File folder = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Mohadaraty");
                if (!folder.exists() && !folder.mkdirs()) throw new IOException("Could not create Downloads folder");
                destination = uniqueFile(folder, requiredFilename(call));
                long bytes;
                try (InputStream input = new BufferedInputStream(new FileInputStream(source));
                     OutputStream output = new BufferedOutputStream(new FileOutputStream(destination))) {
                    bytes = copy(input, output, null);
                }
                if (bytes <= 0 || destination.length() <= 0) {
                    destination.delete();
                    throw new IOException("Saved PDF is empty");
                }
                MediaScannerConnection.scanFile(getContext(), new String[] { destination.getAbsolutePath() }, new String[] { MIME_PDF }, null);
                resolveSaved(call, Uri.fromFile(destination).toString(), "Downloads/Mohadaraty", bytes);
            } catch (Exception error) {
                if (destination != null && destination.exists()) destination.delete();
                reject(call, "FILE_SAVE_FAILED", error.getLocalizedMessage(), null);
            }
        });
    }

    private void openSavePicker(PluginCall call) {
        try {
            validatedPdf(call.getString("sourceUri"));
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType(MIME_PDF);
            intent.putExtra(Intent.EXTRA_TITLE, requiredFilename(call));
            startActivityForResult(call, intent, "savePickerResult");
        } catch (Exception error) {
            reject(call, "FILE_SAVE_FAILED", error.getLocalizedMessage(), null);
        }
    }

    @ActivityCallback
    private void savePickerResult(PluginCall call, ActivityResult activityResult) {
        if (activityResult.getResultCode() != Activity.RESULT_OK || activityResult.getData() == null
            || activityResult.getData().getData() == null) {
            reject(call, "FILE_CANCELLED", "Save cancelled", null);
            return;
        }
        Uri destination = activityResult.getData().getData();
        ioExecutor.execute(() -> {
            try {
                File source = validatedPdf(call.getString("sourceUri"));
                long bytes;
                try (InputStream input = new BufferedInputStream(new FileInputStream(source));
                     OutputStream output = new BufferedOutputStream(requireOutput(getContext().getContentResolver(), destination))) {
                    bytes = copy(input, output, null);
                }
                if (bytes <= 0) throw new IOException("Saved PDF is empty");
                resolveSaved(call, destination.toString(), "Selected folder", bytes);
            } catch (Exception error) {
                reject(call, "FILE_SAVE_FAILED", error.getLocalizedMessage(), null);
            }
        });
    }

    private File privateDestination(String value) throws IOException {
        Uri uri = Uri.parse(value);
        if (!"file".equalsIgnoreCase(uri.getScheme()) || uri.getPath() == null) {
            throw new IOException("Destination must be an app-private file URI");
        }
        File file = new File(uri.getPath()).getCanonicalFile();
        if (!inside(file, getContext().getFilesDir()) && !inside(file, getContext().getCacheDir())
            && !inside(file, getContext().getExternalFilesDir(null)) && !inside(file, getContext().getExternalCacheDir())) {
            throw new IOException("Destination is outside app-private storage");
        }
        return file;
    }

    private File validatedPdf(String value) throws IOException {
        if (value == null) throw new IOException("sourceUri is required");
        File source = privateDestination(value);
        if (!source.isFile() || source.length() <= 0) throw new IOException("Source PDF is missing or empty");
        byte[] probe = new byte[(int) Math.min(1024, source.length())];
        int count;
        try (InputStream input = new FileInputStream(source)) {
            count = input.read(probe);
        }
        boolean header = false;
        for (int i = 0; i <= count - 5; i++) {
            if (probe[i] == '%' && probe[i + 1] == 'P' && probe[i + 2] == 'D' && probe[i + 3] == 'F' && probe[i + 4] == '-') {
                header = true;
                break;
            }
        }
        if (!header) throw new IOException("Source is not a PDF");
        return source;
    }

    private boolean inside(File child, File parent) throws IOException {
        if (parent == null) return false;
        String parentPath = parent.getCanonicalPath() + File.separator;
        return child.getCanonicalPath().startsWith(parentPath);
    }

    private String requiredFilename(PluginCall call) throws IOException {
        String filename = call.getString("filename");
        if (filename == null || filename.trim().isEmpty() || filename.contains("/") || filename.contains("\\")) {
            throw new IOException("Invalid filename");
        }
        return filename;
    }

    private OutputStream requireOutput(ContentResolver resolver, Uri uri) throws IOException {
        OutputStream output = resolver.openOutputStream(uri, "w");
        if (output == null) throw new IOException("Could not open destination");
        return output;
    }

    private long contentSize(ContentResolver resolver, Uri uri) {
        try (android.database.Cursor cursor = resolver.query(
            uri,
            new String[] { MediaStore.MediaColumns.SIZE },
            null,
            null,
            null
        )) {
            if (cursor != null && cursor.moveToFirst()) return cursor.getLong(0);
        } catch (Exception ignored) {
            // The byte counter remains the fallback for providers without SIZE.
        }
        return -1;
    }

    private File uniqueFile(File folder, String filename) {
        File candidate = new File(folder, filename);
        if (!candidate.exists()) return candidate;
        int dot = filename.lastIndexOf('.');
        String base = dot > 0 ? filename.substring(0, dot) : filename;
        String extension = dot > 0 ? filename.substring(dot) : "";
        for (int i = 1; i < 10_000; i++) {
            candidate = new File(folder, base + " (" + i + ")" + extension);
            if (!candidate.exists()) return candidate;
        }
        return new File(folder, System.currentTimeMillis() + "_" + filename);
    }

    private interface ProgressSink { void update(long bytes); }

    private long copy(InputStream input, OutputStream output, ProgressSink progress) throws IOException {
        byte[] buffer = new byte[BUFFER_SIZE];
        long copied = 0;
        int read;
        while ((read = input.read(buffer)) != -1) {
            output.write(buffer, 0, read);
            copied += read;
            if (progress != null) progress.update(copied);
        }
        output.flush();
        return copied;
    }

    private void resolveSaved(PluginCall call, String uri, String location, long bytes) {
        JSObject result = new JSObject();
        result.put("status", "saved");
        result.put("uri", uri);
        result.put("location", location);
        result.put("bytes", bytes);
        call.resolve(result);
    }

    private void reject(PluginCall call, String code, String message, JSObject extra) {
        JSObject data = extra == null ? new JSObject() : extra;
        data.put("code", code);
        call.reject(message == null ? code : message, code, data);
    }

    @Override
    protected void handleOnDestroy() {
        ioExecutor.shutdownNow();
        super.handleOnDestroy();
    }
}
