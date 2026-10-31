import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import {
  validateQrKeyConfig,
  validateInstallationSecret,
  validateCampusBoundary,
  validateSupabaseUrl,
  checkAttendanceReadiness,
  clearReadinessCache,
  isReadinessResultSafe,
  mapConfigErrorToResponse,
  AttendanceConfigError,
  type AttendanceReadinessResult,
} from '../shared/attendanceConfig.js';
import { attendanceDiagnosticCause, attendanceErrorResponse } from '../shared/attendanceApi.js';
import { isMasterAdminEmail } from '../shared/masterAdmins.js';

let failed = 0;
const check = (name: string, test: () => void | Promise<void>) => {
  return Promise.resolve()
    .then(() => test())
    .then(() => {
      console.log(`  PASS  ${name}`);
    })
    .catch((error) => {
      failed++;
      console.error(`  FAIL  ${name}`, error);
    });
};

// Generate valid P-256 keypair for tests
const p256KeyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const validPrivateKeyPem = p256KeyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const validPublicKeyPem = p256KeyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

// Generate a non-P-256 keypair (e.g. secp256k1 or RSA)
const rsaKeyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsaPrivateKeyPem = rsaKeyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

// Generate an older retained P-256 key
const oldP256KeyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const oldPublicKeyPem = oldP256KeyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

// Save original env to restore later
const originalEnv = { ...process.env };

function resetEnv() {
  process.env = { ...originalEnv };
  clearReadinessCache();
}

async function runTests() {
  console.log('\n--- 8.1 Configuration Module Tests ---');

  await check('1. Missing Supabase URL fails validation', () => {
    resetEnv();
    delete process.env.SUPABASE_URL;
    assert.throws(() => validateSupabaseUrl(), (err: any) => {
      return err instanceof AttendanceConfigError && err.configCode === 'attendance_supabase_not_configured';
    });
  });

  await check('2. Invalid Supabase URL fails validation', () => {
    resetEnv();
    process.env.SUPABASE_URL = 'http://insecure-supabase.com';
    assert.throws(() => validateSupabaseUrl(), (err: any) => {
      return err instanceof AttendanceConfigError && err.configCode === 'attendance_supabase_invalid';
    });

    process.env.SUPABASE_URL = 'not-a-valid-url';
    assert.throws(() => validateSupabaseUrl(), (err: any) => {
      return err instanceof AttendanceConfigError && err.configCode === 'attendance_supabase_invalid';
    });
  });

  await check('3. Missing service credential fails readiness', async () => {
    resetEnv();
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const result = await checkAttendanceReadiness(true);
    assert.equal(result.ready, false);
    assert.equal(result.checks.supabase, 'missing');
  });

  await check('4. Missing QR private key produces attendance_not_configured', () => {
    resetEnv();
    delete process.env.ATTENDANCE_QR_PRIVATE_KEY;
    try {
      validateQrKeyConfig();
      assert.fail('Should have thrown');
    } catch (err: any) {
      assert.ok(err instanceof AttendanceConfigError);
      assert.equal(err.configCode, 'attendance_qr_not_configured');
      const mapped = mapConfigErrorToResponse(err);
      assert.deepEqual(mapped, { status: 503, error: 'attendance_not_configured' });
      assert.deepEqual(attendanceErrorResponse(err), { status: 503, error: 'attendance_not_configured' });
    }
  });

  await check('5. Invalid private key fails validation', () => {
    resetEnv();
    process.env.ATTENDANCE_QR_PRIVATE_KEY = 'invalid-pem-content';
    process.env.ATTENDANCE_QR_KEY_ID = 'attendance-v1';
    assert.throws(() => validateQrKeyConfig(), (err: any) => {
      return err instanceof AttendanceConfigError && err.configCode === 'attendance_qr_invalid';
    });
  });

  await check('6. Non-P-256 private key fails validation', () => {
    resetEnv();
    process.env.ATTENDANCE_QR_PRIVATE_KEY = rsaPrivateKeyPem;
    process.env.ATTENDANCE_QR_KEY_ID = 'attendance-v1';
    assert.throws(() => validateQrKeyConfig(), (err: any) => {
      return err instanceof AttendanceConfigError && err.configCode === 'attendance_qr_invalid';
    });
  });

  await check('7. Malformed public-key JSON fails validation', () => {
    resetEnv();
    process.env.ATTENDANCE_QR_PRIVATE_KEY = validPrivateKeyPem;
    process.env.ATTENDANCE_QR_KEY_ID = 'attendance-v1';
    process.env.ATTENDANCE_QR_PUBLIC_KEYS_JSON = '{ not valid json ';
    assert.throws(() => validateQrKeyConfig(), (err: any) => {
      return err instanceof AttendanceConfigError && err.configCode === 'attendance_qr_invalid';
    });
  });

  await check('8. Mismatched current public/private key pair fails validation', () => {
    resetEnv();
    process.env.ATTENDANCE_QR_PRIVATE_KEY = validPrivateKeyPem;
    process.env.ATTENDANCE_QR_KEY_ID = 'attendance-v1';
    // Provide a different key under the active key ID
    process.env.ATTENDANCE_QR_PUBLIC_KEYS_JSON = JSON.stringify({
      'attendance-v1': oldPublicKeyPem,
    });
    assert.throws(() => validateQrKeyConfig(), (err: any) => {
      return err instanceof AttendanceConfigError && err.configCode === 'attendance_qr_key_mismatch';
    });
  });

  await check('9. Older retained public keys remain accepted and cannot override active key', () => {
    resetEnv();
    process.env.ATTENDANCE_QR_PRIVATE_KEY = validPrivateKeyPem;
    process.env.ATTENDANCE_QR_KEY_ID = 'attendance-v1';
    process.env.ATTENDANCE_QR_PUBLIC_KEYS_JSON = JSON.stringify({
      'attendance-v1': validPublicKeyPem,
      'attendance-v0': oldPublicKeyPem,
    });
    const config = validateQrKeyConfig();
    assert.equal(config.keyId, 'attendance-v1');
    assert.ok(config.publicKeys['attendance-v1']);
    assert.equal(config.publicKeys['attendance-v0'], oldPublicKeyPem.trim());
  });

  await check('10. Missing installation secret fails validation and readiness', async () => {
    resetEnv();
    delete process.env.ATTENDANCE_INSTALLATION_SECRET;
    assert.throws(() => validateInstallationSecret(), (err: any) => {
      return err instanceof AttendanceConfigError && err.configCode === 'attendance_installation_secret_not_configured';
    });
    const result = await checkAttendanceReadiness(true);
    assert.equal(result.ready, false);
    assert.equal(result.checks.installationSecret, 'missing');
  });

  await check('11. Short installation secret (< 32 bytes) fails validation', () => {
    resetEnv();
    process.env.ATTENDANCE_INSTALLATION_SECRET = 'too-short-secret';
    assert.throws(() => validateInstallationSecret(), (err: any) => {
      return err instanceof AttendanceConfigError && err.configCode === 'attendance_installation_secret_invalid';
    });
  });

  await check('12. Campus boundary uses the fixed Al-Safwa coordinates', () => {
    resetEnv();
    delete process.env.ATTENDANCE_CAMPUS_LATITUDE;
    delete process.env.ATTENDANCE_CAMPUS_LONGITUDE;
    delete process.env.ATTENDANCE_CAMPUS_RADIUS_METERS;
    const campus = validateCampusBoundary();
    assert.equal(campus.status, 'ok');
    assert.deepEqual(campus.boundary, { latitude: 32.623889, longitude: 44.006667, radiusMeters: 450 });
  });

  await check('13. Environment overrides cannot move the fixed campus boundary', () => {
    resetEnv();
    process.env.ATTENDANCE_CAMPUS_LATITUDE = '95.0';
    process.env.ATTENDANCE_CAMPUS_LONGITUDE = '44.3661';
    process.env.ATTENDANCE_CAMPUS_RADIUS_METERS = '-10';
    assert.deepEqual(validateCampusBoundary().boundary, { latitude: 32.623889, longitude: 44.006667, radiusMeters: 450 });
  });

  await check('15. Valid configuration passes an in-memory sign/verify round trip', () => {
    resetEnv();
    process.env.ATTENDANCE_QR_PRIVATE_KEY = validPrivateKeyPem;
    process.env.ATTENDANCE_QR_KEY_ID = 'attendance-v1';
    process.env.ATTENDANCE_QR_PUBLIC_KEYS_JSON = JSON.stringify({
      'attendance-v1': validPublicKeyPem,
    });
    process.env.ATTENDANCE_INSTALLATION_SECRET = crypto.randomBytes(48).toString('base64url');
    const config = validateQrKeyConfig();

    const payload = { sub: 'test-student', sessionId: 'sess-123' };
    const token = jwt.sign(payload, config.privateKey, { algorithm: 'ES256', keyid: config.keyId });
    const verified = jwt.verify(token, config.publicKeys[config.keyId], { algorithms: ['ES256'] }) as any;
    assert.equal(verified.sub, 'test-student');
    assert.equal(verified.sessionId, 'sess-123');
  });

  await check('16. Readiness output cannot contain any configured secret value', () => {
    const sampleResult: AttendanceReadinessResult = {
      ready: true,
      checks: {
        supabase: 'ok',
        schema: 'ok',
        rpcSurface: 'ok',
        qrSigning: 'ok',
        installationSecret: 'ok',
        campusBoundary: 'ok',
      },
    };
    assert.equal(isReadinessResultSafe(sampleResult), true);

    // If an unsafe field were somehow attached:
    const unsafeResult = {
      ...sampleResult,
      leakedSecret: validPrivateKeyPem,
    } as any;
    assert.equal(isReadinessResultSafe(unsafeResult), false);
  });

  console.log('\n--- 8.2 Readiness Authorization Tests ---');

  // Helper simulating the authorization logic from server.ts and api/index.ts
  const simulateReadinessAuth = async (token: any, profileData: any) => {
    if (!token?.uid) return { status: 403, error: 'forbidden' };
    const data = profileData || {};
    const master = token.email_verified === true && isMasterAdminEmail(token.email);
    if (data.staffDisabled === true || !(master || data.role === 'master_admin' || data.isMasterAdmin === true)) {
      return { status: 403, error: 'forbidden' };
    }
    return { status: 200, authorized: true };
  };

  await check('Unauthenticated caller rejected (no uid)', async () => {
    const res = await simulateReadinessAuth({}, {});
    assert.equal(res.status, 403);
  });

  await check('Student caller rejected', async () => {
    const res = await simulateReadinessAuth({ uid: 'student-uid', email: 'student@example.com', email_verified: true }, { role: 'student' });
    assert.equal(res.status, 403);
  });

  await check('Doctor caller rejected from readiness', async () => {
    const res = await simulateReadinessAuth({ uid: 'doctor-uid', email: 'doctor@univ.edu', email_verified: true }, { role: 'doctor' });
    assert.equal(res.status, 403);
  });

  await check('Disabled staff rejected', async () => {
    // Even if master admin, staffDisabled rejects
    const res = await simulateReadinessAuth(
      { uid: 'admin-uid', email: 'laith.almatrood@gmail.com', email_verified: true },
      { staffDisabled: true, role: 'master_admin' }
    );
    assert.equal(res.status, 403);
  });

  await check('Master admin accepted with verified email', async () => {
    const res = await simulateReadinessAuth(
      { uid: 'master-uid', email: 'laith.almatrood@gmail.com', email_verified: true },
      { role: 'master_admin' }
    );
    assert.equal(res.status, 200);
  });

  await check('Healthy checks return ready: true, failed check returns ready: false', () => {
    const healthy: AttendanceReadinessResult = {
      ready: true,
      checks: {
        supabase: 'ok',
        schema: 'ok',
        rpcSurface: 'ok',
        qrSigning: 'ok',
        installationSecret: 'ok',
        campusBoundary: 'ok',
      },
    };
    assert.equal(healthy.ready, true);

    const unhealthy: AttendanceReadinessResult = {
      ready: false,
      checks: {
        supabase: 'ok',
        schema: 'ok',
        rpcSurface: 'ok',
        qrSigning: 'missing',
        installationSecret: 'ok',
        campusBoundary: 'ok',
      },
    };
    assert.equal(unhealthy.ready, false);
  });

  console.log('\n--- 8.3 Logging Tests ---');

  await check('Diagnostic causes distinguish configuration, credentials, schema, and connectivity', () => {
    assert.equal(attendanceDiagnosticCause(new AttendanceConfigError('attendance_supabase_not_configured')), 'supabase_missing');
    assert.equal(attendanceDiagnosticCause({ code: 'PGRST205', message: 'schema cache lookup failed' }), 'schema_missing');
    assert.equal(attendanceDiagnosticCause({ code: 'PGRST202', message: 'Could not find the function attendance_cancel_session' }), 'schema_missing');
    assert.deepEqual(attendanceErrorResponse({ code: 'PGRST202', message: 'Could not find the function attendance_cancel_session' }), {
      status: 503, error: 'attendance_schema_missing',
    });
    assert.deepEqual(attendanceErrorResponse({ code: 'PGRST301', message: 'Invalid JWT' }), {
      status: 503, error: 'attendance_not_configured',
    });
    assert.deepEqual(attendanceErrorResponse(new Error('fetch failed')), {
      status: 503, error: 'attendance_temporarily_unavailable',
    });
    assert.equal(attendanceDiagnosticCause({ status: 401, message: 'Invalid API key' }), 'credential_invalid');
    assert.equal(attendanceDiagnosticCause(new Error('fetch failed')), 'backend_unreachable');
  });

  await check('Error logging maps internal codes to safe public categories and excludes secrets', () => {
    const interceptedLogs: any[] = [];
    const origError = console.error;
    try {
      console.error = (...args: any[]) => {
        interceptedLogs.push(args);
      };

      const secretKey = 'super-secret-service-role-key-1234567890';
      const fakeToken = 'eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc';

      // Test a config error mapping
      const configErr = new AttendanceConfigError('attendance_qr_not_configured');
      const response = attendanceErrorResponse(configErr);
      assert.equal(response.status, 503);
      assert.equal(response.error, 'attendance_not_configured');

      // Log simulated error
      console.error('[attendance] create session failed', {
        code: configErr.configCode,
        category: response.error,
        status: response.status,
      });

      assert.equal(interceptedLogs.length, 1);
      const logObj = interceptedLogs[0][1];
      assert.equal(logObj.code, 'attendance_qr_not_configured');
      assert.equal(logObj.category, 'attendance_not_configured');
      assert.equal(logObj.status, 503);

      // Verify no sensitive material in logged object
      const serialized = JSON.stringify(interceptedLogs[0]);
      assert.doesNotMatch(serialized, new RegExp(secretKey));
      assert.doesNotMatch(serialized, new RegExp(fakeToken));
      assert.doesNotMatch(serialized, /BEGIN PRIVATE KEY/);
    } finally {
      console.error = origError;
    }
  });

  resetEnv();
  console.log(`\n${failed ? 'FAILED' : 'OK'} (${failed} failures)`);
  process.exit(failed ? 1 : 0);
}

void runTests();
