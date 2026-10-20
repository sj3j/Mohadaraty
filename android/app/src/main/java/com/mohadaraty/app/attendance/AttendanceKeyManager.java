package com.mohadaraty.app.attendance;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECPoint;
import java.util.UUID;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public class AttendanceKeyManager {
    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final String SIGNING_KEY_ALIAS = "AttendanceStorageSigningKey";
    private static final String PAYLOAD_KEY_ALIAS = "AttendanceStoragePayloadKey";

    private final KeyStore keyStore;

    public AttendanceKeyManager() throws Exception {
        keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
        keyStore.load(null);
        ensureSigningKey();
        ensurePayloadKey();
    }

    private void ensureSigningKey() throws Exception {
        if (!keyStore.containsAlias(SIGNING_KEY_ALIAS)) {
            KeyPairGenerator kpg = KeyPairGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE
            );
            KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
                SIGNING_KEY_ALIAS,
                KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY
            )
            .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .build();
            kpg.initialize(spec);
            kpg.generateKeyPair();
        }
    }

    private void ensurePayloadKey() throws Exception {
        if (!keyStore.containsAlias(PAYLOAD_KEY_ALIAS)) {
            KeyGenerator kg = KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE
            );
            KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
                PAYLOAD_KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
            )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build();
            kg.init(spec);
            kg.generateKey();
        }
    }

    public JSONObject getPublicJwk() throws Exception {
        CertificateHolder cert = getPublicKey();
        ECPublicKey ecPubKey = (ECPublicKey) cert.publicKey;
        ECPoint w = ecPubKey.getW();

        byte[] xBytes = toFixed32(w.getAffineX());
        byte[] yBytes = toFixed32(w.getAffineY());

        String xB64 = base64Url(xBytes);
        String yB64 = base64Url(yBytes);

        JSONObject jwk = new JSONObject();
        jwk.put("kty", "EC");
        jwk.put("crv", "P-256");
        jwk.put("x", xB64);
        jwk.put("y", yB64);
        return jwk;
    }

    public String getFingerprint() throws Exception {
        JSONObject jwk = getPublicJwk();
        JSONArray arr = new JSONArray();
        arr.put("P-256");
        arr.put(jwk.getString("x"));
        arr.put(jwk.getString("y"));
        return arr.toString();
    }

    private static class CertificateHolder {
        PublicKey publicKey;
    }

    private CertificateHolder getPublicKey() throws Exception {
        CertificateHolder h = new CertificateHolder();
        java.security.cert.Certificate cert = keyStore.getCertificate(SIGNING_KEY_ALIAS);
        if (cert == null) throw new IllegalStateException("Signing certificate missing");
        h.publicKey = cert.getPublicKey();
        return h;
    }

    public String signMessage(String message) throws Exception {
        PrivateKey privateKey = (PrivateKey) keyStore.getKey(SIGNING_KEY_ALIAS, null);
        Signature s = Signature.getInstance("SHA256withECDSA");
        s.initSign(privateKey);
        s.update(message.getBytes(StandardCharsets.UTF_8));
        byte[] derSignature = s.sign();
        byte[] p1363 = derToP1363(derSignature);
        return base64Url(p1363);
    }

    public String encryptPayload(String plaintext) throws Exception {
        if (plaintext == null) return null;
        SecretKey key = (SecretKey) keyStore.getKey(PAYLOAD_KEY_ALIAS, null);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] iv = cipher.getIV();
        byte[] ciphertext = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
        byte[] combined = new byte[iv.length + ciphertext.length];
        System.arraycopy(iv, 0, combined, 0, iv.length);
        System.arraycopy(ciphertext, 0, combined, iv.length, ciphertext.length);
        return Base64.encodeToString(combined, Base64.NO_WRAP);
    }

    public String decryptPayload(String encryptedBase64) throws Exception {
        if (encryptedBase64 == null) return null;
        byte[] combined = Base64.decode(encryptedBase64, Base64.NO_WRAP);
        if (combined.length < 12) throw new IllegalArgumentException("Payload too short");
        byte[] iv = new byte[12];
        System.arraycopy(combined, 0, iv, 0, 12);
        byte[] ciphertext = new byte[combined.length - 12];
        System.arraycopy(combined, 12, ciphertext, 0, ciphertext.length);

        SecretKey key = (SecretKey) keyStore.getKey(PAYLOAD_KEY_ALIAS, null);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
        byte[] decrypted = cipher.doFinal(ciphertext);
        return new String(decrypted, StandardCharsets.UTF_8);
    }

    public static byte[] derToP1363(byte[] der) {
        if (der == null || der.length < 8 || der[0] != 0x30) {
            throw new IllegalArgumentException("Invalid DER sequence");
        }
        int offset = 2;
        if ((der[1] & 0x80) != 0) {
            int lenBytes = der[1] & 0x7F;
            offset = 2 + lenBytes;
        }

        if (der[offset++] != 0x02) throw new IllegalArgumentException("Invalid r marker in DER");
        int rLen = der[offset++];
        byte[] rBytes = new byte[rLen];
        System.arraycopy(der, offset, rBytes, 0, rLen);
        offset += rLen;

        if (der[offset++] != 0x02) throw new IllegalArgumentException("Invalid s marker in DER");
        int sLen = der[offset++];
        byte[] sBytes = new byte[sLen];
        System.arraycopy(der, offset, sBytes, 0, sLen);

        byte[] p1363 = new byte[64];
        copyPadded(rBytes, p1363, 0);
        copyPadded(sBytes, p1363, 32);
        return p1363;
    }

    private static void copyPadded(byte[] src, byte[] dest, int destOffset) {
        int srcOffset = 0;
        int srcLen = src.length;
        while (srcLen > 32 && src[srcOffset] == 0) {
            srcOffset++;
            srcLen--;
        }
        if (srcLen > 32) throw new IllegalArgumentException("Integer component too large for P-256");
        int pad = 32 - srcLen;
        System.arraycopy(src, srcOffset, dest, destOffset + pad, srcLen);
    }

    private static byte[] toFixed32(BigInteger bi) {
        byte[] raw = bi.toByteArray();
        byte[] fixed = new byte[32];
        if (raw.length > 32) {
            System.arraycopy(raw, raw.length - 32, fixed, 0, 32);
        } else if (raw.length < 32) {
            System.arraycopy(raw, 0, fixed, 32 - raw.length, raw.length);
        } else {
            System.arraycopy(raw, 0, fixed, 0, 32);
        }
        return fixed;
    }

    private static String base64Url(byte[] bytes) {
        return Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }
}
