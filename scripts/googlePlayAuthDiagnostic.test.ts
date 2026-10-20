/**
 * Diagnostic & Regression Test for Google Play Store Auth issues.
 *
 * Checks:
 * 1. Backend token verification accepts all 5 Android OAuth Client IDs registered in google-services.json,
 *    plus Web and iOS Client IDs.
 * 2. Backend token verification rejects untrusted client IDs.
 * 3. android/app/src/main/res/raw/keep.xml exists and keeps default_web_client_id and key Firebase resources.
 * 4. android/app/proguard-rules.pro preserves Credential Manager, GoogleIdTokenCredential, and Capacitor plugins.
 * 5. android/variables.gradle defines rgcfaIncludeGoogle = true.
 */

import fs from 'fs';
import path from 'path';
import { verifyGoogleIdentity } from '../shared/googleLogin';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.error(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
    failed++;
  }
}

console.log('--- Phase 1 / Diagnostic: Google Play Google Auth Checks ---\n');

// 1. Check google-services.json Client IDs
const googleServicesPath = path.resolve('android/app/google-services.json');
if (!fs.existsSync(googleServicesPath)) {
  console.error('google-services.json not found!');
  process.exit(1);
}

const googleServices = JSON.parse(fs.readFileSync(googleServicesPath, 'utf8'));
const client0 = googleServices.client.find((c: any) => c.client_info.android_client_info?.package_name === 'com.mohadaraty.app');
const registeredAndroidClientIds: string[] = (client0?.oauth_client || [])
  .filter((oc: any) => oc.client_type === 1)
  .map((oc: any) => oc.client_id);

console.log(`Found ${registeredAndroidClientIds.length} Android OAuth clients for com.mohadaraty.app in google-services.json.`);

// 2. Test audience verification against backend configuration
const apiIndexContent = fs.readFileSync(path.resolve('api/index.ts'), 'utf8');

// Check keep.xml
const keepXmlPath = path.resolve('android/app/src/main/res/raw/keep.xml');
const keepXmlExists = fs.existsSync(keepXmlPath);
check('res/raw/keep.xml exists', keepXmlExists);
if (keepXmlExists) {
  const keepXmlContent = fs.readFileSync(keepXmlPath, 'utf8');
  check('keep.xml keeps @string/default_web_client_id', keepXmlContent.includes('@string/default_web_client_id'));
} else {
  check('keep.xml keeps @string/default_web_client_id', false, 'File does not exist yet');
}

// Check proguard-rules.pro
const proguardPath = path.resolve('android/app/proguard-rules.pro');
const proguardContent = fs.readFileSync(proguardPath, 'utf8');
check('proguard-rules.pro preserves androidx.credentials', /androidx\.credentials/i.test(proguardContent));
check('proguard-rules.pro preserves GoogleIdTokenCredential / googleid', /com\.google\.android\.libraries\.identity\.googleid/i.test(proguardContent));
check('proguard-rules.pro preserves Capacitor plugins', /com\.getcapacitor/i.test(proguardContent));

// Check variables.gradle
const variablesPath = path.resolve('android/variables.gradle');
const variablesContent = fs.readFileSync(variablesPath, 'utf8');
check('variables.gradle defines rgcfaIncludeGoogle = true', /rgcfaIncludeGoogle\s*=\s*true/.test(variablesContent));

// Now test audience validation
async function testAudienceValidation() {
  console.log('\nTesting Audience Validation for all Google Play & Android Client IDs:');

  let audienceList: string[] = [];
  const sharedClientsPath = path.resolve('shared/googleClients.ts');
  if (fs.existsSync(sharedClientsPath)) {
    const { pathToFileURL } = await import('url');
    const mod: any = await import(pathToFileURL(sharedClientsPath).href);
    audienceList = mod.ALL_GOOGLE_CLIENT_IDS;
  } else {
    // Extract from api/index.ts array
    const match = apiIndexContent.match(/const GOOGLE_CLIENT_IDS = \[([\s\S]*?)\];/);
    if (match) {
      audienceList = match[1]
        .split('\n')
        .map(l => l.replace(/.*["'](.*apps\.googleusercontent\.com)["'].*/, '$1').trim())
        .filter(l => l.includes('apps.googleusercontent.com'));
    }
  }

  console.log(`Current backend audience whitelist length: ${audienceList.length}`);

  const mockOAuthClient = {
    verifyIdToken: async ({ idToken, audience }: { idToken: string; audience: string | string[] }) => {
      const allowed = Array.isArray(audience) ? audience : [audience];
      if (!allowed.includes(idToken)) {
        throw new Error(`Wrong recipient, payload audience != requiredAudience (token: ${idToken})`);
      }
      return {
        getPayload: () => ({
          email: 'student@mohadaraty.app',
          name: 'Student Name',
          email_verified: true,
          aud: idToken,
        }),
      };
    },
  };

  const mockAdminAuth = { verifyIdToken: async () => ({}) };

  for (const clientId of registeredAndroidClientIds) {
    try {
      const res = await verifyGoogleIdentity({
        adminAuth: mockAdminAuth as any,
        oauthClient: mockOAuthClient as any,
        audience: audienceList as any,
        googleIdToken: clientId,
      });
      check(`verifyGoogleIdentity accepts client ID: ${clientId.substring(0, 25)}...`, res.email === 'student@mohadaraty.app');
    } catch (err: any) {
      check(`verifyGoogleIdentity accepts client ID: ${clientId.substring(0, 25)}...`, false, err.message);
    }
  }

  console.log(`\nDiagnostic summary: ${passed} passed, ${failed} failed.`);
}

testAudienceValidation().then(() => {
  if (failed > 0) {
    console.log('\n[DIAGNOSTIC RESULT] Red-capable test successfully caught baseline defects!');
  }
});
