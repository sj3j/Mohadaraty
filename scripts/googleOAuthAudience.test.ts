/**
 * TDD Test for Google OAuth iOS configuration & audience verification.
 *
 * Verifies:
 * 1. ios/App/Podfile includes CapacitorFirebaseAuthentication/Google.
 * 2. verifyGoogleIdentity accepts string[] audience and validates tokens matching iOS or Web client IDs.
 * 3. verifyGoogleIdentity rejects tokens with untrusted audience.
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

console.log('Testing Google OAuth iOS Configuration & Audience Handling:\n');

// Test 1: ios/App/Podfile must declare CapacitorFirebaseAuthentication/Google subspec
const podfilePath = path.resolve('ios/App/Podfile');
const podfileContent = fs.readFileSync(podfilePath, 'utf8');
const hasGoogleSubspec = /pod\s+['"]CapacitorFirebaseAuthentication\/Google['"]/.test(podfileContent);
check('ios/App/Podfile specifies CapacitorFirebaseAuthentication/Google subspec', hasGoogleSubspec);

// Test 2: verifyGoogleIdentity accepts an array of audiences (Web + iOS)
const WEB_CLIENT_ID = '449403914422-jhmo0djasbes2584jg3ue8dcv48cd62i.apps.googleusercontent.com';
const IOS_CLIENT_ID = '449403914422-hu2lvvhvoeumim6tupbnrpf9cv7c6106.apps.googleusercontent.com';
const TRUSTED_AUDIENCES = [WEB_CLIENT_ID, IOS_CLIENT_ID];

const mockOAuthClient = {
  verifyIdToken: async ({ idToken, audience }: { idToken: string; audience: string | string[] }) => {
    const allowed = Array.isArray(audience) ? audience : [audience];
    // In our mock, 'tok_ios' has aud IOS_CLIENT_ID, 'tok_web' has aud WEB_CLIENT_ID, 'tok_bad' has aud 'bad_client'
    const tokenAud = idToken === 'tok_ios' ? IOS_CLIENT_ID : idToken === 'tok_web' ? WEB_CLIENT_ID : 'bad_client';
    if (!allowed.includes(tokenAud)) {
      throw new Error(`Wrong recipient, payload audience != ${audience}`);
    }
    return {
      getPayload: () => ({
        email: 'test@student.edu',
        name: 'Test Student',
        email_verified: true,
        aud: tokenAud,
      }),
    };
  },
};

const mockAdminAuth = {
  verifyIdToken: async () => ({}),
};

// Test 2a: Valid iOS token against multi-audience array
async function runAudienceTests() {
  try {
    const identityIos = await verifyGoogleIdentity({
      adminAuth: mockAdminAuth as any,
      oauthClient: mockOAuthClient as any,
      audience: TRUSTED_AUDIENCES as any,
      googleIdToken: 'tok_ios',
    });
    check('verifyGoogleIdentity accepts token with iOS client ID audience', identityIos.email === 'test@student.edu');
  } catch (err: any) {
    check('verifyGoogleIdentity accepts token with iOS client ID audience', false, err.message);
  }

  // Test 2b: Valid Web token against multi-audience array
  try {
    const identityWeb = await verifyGoogleIdentity({
      adminAuth: mockAdminAuth as any,
      oauthClient: mockOAuthClient as any,
      audience: TRUSTED_AUDIENCES as any,
      googleIdToken: 'tok_web',
    });
    check('verifyGoogleIdentity accepts token with Web client ID audience', identityWeb.email === 'test@student.edu');
  } catch (err: any) {
    check('verifyGoogleIdentity accepts token with Web client ID audience', false, err.message);
  }

  // Test 2c: Untrusted token is rejected
  try {
    await verifyGoogleIdentity({
      adminAuth: mockAdminAuth as any,
      oauthClient: mockOAuthClient as any,
      audience: TRUSTED_AUDIENCES as any,
      googleIdToken: 'tok_bad',
    });
    check('verifyGoogleIdentity rejects token with untrusted audience', false, 'Should have thrown');
  } catch (err: any) {
    check('verifyGoogleIdentity rejects token with untrusted audience', err.message.includes('Wrong recipient'));
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    process.exit(1);
  }
}

await runAudienceTests();
